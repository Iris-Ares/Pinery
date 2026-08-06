import { resolve } from "node:path";
import type { PermissionLevel } from "./levels.js";

/**
 * bash 分级策略引擎(PRD §3.2 工具策略引擎,M1 安全地基)。
 *
 * 分级语义:
 * - L0:allowlist,默认拒绝。只读检查类命令;git 仅只读子命令;禁止输出重定向、
 *   命令替换、脚本执行与网络工具。
 * - L1:默认放行(读写与执行),denylist 拦截:push/PR、网络出站工具、包发布、
 *   容器/系统管理、提权。
 * - L2:同 L1,但 git push / gh / glab 返回 confirm(转飞书确认按钮)。
 * - L3:默认 confirm(审批流),仅硬 denylist 直接拒绝。
 *
 * 注意:进程级策略是纵深防御的一层,不是唯一屏障——容器只读挂载、网络出口
 * 白名单、保护分支才是硬边界(PRD §5)。
 */

export type BashDecision = "allow" | "deny" | "confirm";

export interface BashPolicyResult {
  decision: BashDecision;
  /** 命中的规则 id,便于审计 */
  rule?: string;
  /** 面向用户/模型的拒绝原因 */
  reason?: string;
}

export interface BashPolicyOptions {
  /**
   * 工作区绝对路径。提供后对命令的**路径类参数**做围栏校验——
   * 文件工具的路径围栏管不到 bash,`cat /data/pinery.db` 这类命令能读到
   * 应用自身的状态(其他会话、审计日志、问答留痕)。
   * 不提供则跳过该项检查(策略引擎可独立于工作区使用)。
   */
  workspaceDir?: string;
}

// ---------------------------------------------------------------------------
// 命令拆分:把复合命令拆成可独立判定的简单段
// ---------------------------------------------------------------------------

export interface SplitResult {
  /** 顶层与替换内部的所有命令段 */
  segments: string[];
  /** 是否包含命令替换 $(...) 或反引号 */
  hasSubstitution: boolean;
  /** 是否包含输出重定向(> >> 2>file),不含 /dev/null 与 2>&1 */
  hasOutputRedirect: boolean;
}

/**
 * 拆分复合命令。追踪引号状态,按 ; && || | & 与换行切段;
 * $( ... ) 与反引号内部内容递归纳入 segments(内容也要过策略)。
 * 单引号内的一切按字面处理。
 */
export function splitCommand(input: string): SplitResult {
  const segments: string[] = [];
  let hasSubstitution = false;
  let hasOutputRedirect = false;

  // (raw, depth) 待处理队列;depth 防御病态嵌套
  const queue: Array<{ text: string; depth: number }> = [{ text: input, depth: 0 }];

  while (queue.length > 0) {
    const { text, depth } = queue.shift()!;
    if (depth > 8) continue;

    let current = "";
    let inSingle = false;
    let inDouble = false;
    let i = 0;

    const pushSegment = () => {
      const trimmed = current.trim();
      if (trimmed.length > 0) segments.push(trimmed);
      current = "";
    };

    while (i < text.length) {
      const ch = text[i]!;
      const next = text[i + 1];

      if (inSingle) {
        if (ch === "'") inSingle = false;
        current += ch;
        i++;
        continue;
      }

      if (ch === "\\" && next !== undefined) {
        current += ch + next;
        i += 2;
        continue;
      }

      if (ch === "'" && !inDouble) {
        inSingle = true;
        current += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        inDouble = !inDouble;
        current += ch;
        i++;
        continue;
      }

      // 命令替换 $( ... ) —— 双引号内也生效
      if (ch === "$" && next === "(") {
        hasSubstitution = true;
        let level = 1;
        let j = i + 2;
        let inner = "";
        while (j < text.length && level > 0) {
          const c = text[j]!;
          if (c === "(") level++;
          else if (c === ")") level--;
          if (level > 0) inner += c;
          j++;
        }
        queue.push({ text: inner, depth: depth + 1 });
        current += " __SUBST__ ";
        i = j;
        continue;
      }

      // 反引号替换
      if (ch === "`") {
        hasSubstitution = true;
        let j = i + 1;
        let inner = "";
        while (j < text.length && text[j] !== "`") {
          inner += text[j]!;
          j++;
        }
        queue.push({ text: inner, depth: depth + 1 });
        current += " __SUBST__ ";
        i = j + 1;
        continue;
      }

      if (inDouble) {
        current += ch;
        i++;
        continue;
      }

      // 进程替换 <( ... ) / >( ... )
      if ((ch === "<" || ch === ">") && next === "(") {
        hasSubstitution = true;
        let level = 1;
        let j = i + 2;
        let inner = "";
        while (j < text.length && level > 0) {
          const c = text[j]!;
          if (c === "(") level++;
          else if (c === ")") level--;
          if (level > 0) inner += c;
          j++;
        }
        queue.push({ text: inner, depth: depth + 1 });
        current += " __SUBST__ ";
        i = j;
        continue;
      }

      // 输出重定向检测(>&2、2>&1、>/dev/null 豁免)
      if (ch === ">") {
        const rest = text.slice(i).replace(/^>+\s*/, "");
        const isDevNull = rest.startsWith("/dev/null");
        const isFdDup = text.slice(i).match(/^>&\d/) !== null;
        if (!isDevNull && !isFdDup) hasOutputRedirect = true;
        current += ch;
        i++;
        continue;
      }
      if (/\d/.test(ch) && next === ">") {
        // 2>file / 2>&1
        const after = text.slice(i + 2).replace(/^\s*/, "");
        const isFdDup = text[i + 2] === "&";
        const isDevNull = after.startsWith("/dev/null");
        if (!isFdDup && !isDevNull) hasOutputRedirect = true;
        current += ch;
        i++;
        continue;
      }

      // 段分隔符
      if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
        pushSegment();
        // 吞掉 && || 的第二个字符
        if ((ch === "&" || ch === "|") && next === ch) i++;
        i++;
        continue;
      }

      current += ch;
      i++;
    }
    pushSegment();
  }

  return { segments, hasSubstitution, hasOutputRedirect };
}

// ---------------------------------------------------------------------------
// 段级解析
// ---------------------------------------------------------------------------

interface ParsedSegment {
  /** 归一化命令名(basename、去路径) */
  cmd: string;
  /** 原始首 token(含路径,用于识别 ./script.sh) */
  rawCmd: string;
  args: string[];
}

/** 粗粒度 token 化(引号感知,不做展开) */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseSegment(segment: string): ParsedSegment | null {
  let tokens = tokenize(segment);
  // 跳过前置环境变量赋值 FOO=bar cmd
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) {
    tokens = tokens.slice(1);
  }
  if (tokens.length === 0) return null;
  const rawCmd = tokens[0]!;
  const cmd = rawCmd.split("/").pop() ?? rawCmd;
  return { cmd, rawCmd, args: tokens.slice(1) };
}

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------

/**
 * L0 只读命令 allowlist。
 *
 * 刻意排除「图灵完备的文本处理器」——它们的程序文本里带执行与写盘能力,
 * 只看命令名无法判定安全:
 *   awk 'BEGIN { system("curl …") }'      → 任意命令执行
 *   awk '{ print > "/tmp/x" }'            → 任意写文件
 *   sed 's/a/b/w /tmp/x'  /  sed -i       → 写文件(GNU sed 的 e 标志还能执行)
 *   yq -i / yq eval -i                    → 就地改写文件
 * 调查场景用 rg/grep/cut/head/sort 完全够用,故整体移出 L0(L1+ 不受限)。
 */
const L0_ALLOW = new Set([
  "ls", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "nl",
  "grep", "egrep", "fgrep", "rg", "ag", "fd", "find", "tree", "file", "stat",
  "du", "df", "basename", "dirname", "realpath", "readlink", "pwd", "echo",
  "printf", "date", "diff", "comm", "join", "paste", "seq", "expr", "test", "[",
  "true", "false", "which", "type", "md5", "md5sum", "shasum", "sha256sum",
  "cksum", "strings", "iconv", "zcat", "jq", "column", "xargs",
  "git", "od", "hexdump",
]);

/** L0 拒绝时给出可操作的替代方案,避免 agent 反复试探 */
const L0_ALTERNATIVES: Record<string, string> = {
  awk: "awk 程序可执行命令与写文件,L0 不可用;字段提取用 cut,过滤用 rg/grep,计数用 wc",
  sed: "sed 可写文件(w 标志 / -i),L0 不可用;文本查看用 rg/grep/head/tail",
  yq: "yq 可就地改写文件,L0 不可用;读取 YAML 用 rg/grep 或 cat",
  perl: "perl 可执行任意代码,L0 不可用",
  python: "L0 不执行脚本",
  python3: "L0 不执行脚本",
  node: "L0 不执行脚本",
  ruby: "L0 不执行脚本",
};

/** 需要递归判定其目标命令的包装命令 */
const WRAPPERS = new Set(["xargs", "timeout", "nice", "command", "env", "nohup", "stdbuf", "time"]);

/** L0 git 只读子命令 */
const L0_GIT_SUBCOMMANDS = new Set([
  "log", "show", "diff", "blame", "status", "shortlog", "describe",
  "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file", "grep",
  "count-objects", "whatchanged", "reflog", "version", "help",
]);

/**
 * 即使子命令只读,这些选项仍能写盘或执行外部程序 —— L0 一律拒绝:
 *   git show --output=/path      → diff 家族直接写文件(无需 shell 重定向)
 *   git log --ext-diff           → 调用外部 diff 驱动(执行)
 *   git show --textconv          → 调用 textconv filter(执行,且由仓库配置驱动)
 *   git grep --open-files-in-pager → 启动 pager(执行)
 *   git ls-remote --upload-pack= → 远端命令注入
 */
const L0_GIT_UNSAFE_OPTION_PREFIXES = [
  "--no-index", // git diff --no-index /etc/a /etc/b 可读仓库外任意文件
  "--output",
  "--ext-diff",
  "--textconv",
  "--open-files-in-pager",
  "--upload-pack",
  "--receive-pack",
  "--exec",
  "--to-command",
  "--pager",
];

/** 短选项形态(-o file / -O):在只读子命令上同样可能落盘或起 pager */
const L0_GIT_UNSAFE_SHORT_OPTIONS = new Set(["-o", "-O"]);

function gitUnsafeOption(arg: string): boolean {
  if (L0_GIT_UNSAFE_SHORT_OPTIONS.has(arg)) return true;
  // -O<file> / -o<file> 紧贴写法
  if (/^-[oO]./.test(arg)) return true;
  return L0_GIT_UNSAFE_OPTION_PREFIXES.some((p) => arg === p || arg.startsWith(`${p}=`));
}

/** 任何级别都直接拒绝的命令(提权/毁灭性系统操作) */
const HARD_DENY = new Set([
  "sudo", "su", "doas", "shutdown", "reboot", "halt", "poweroff", "mkfs",
  "mount", "umount", "dd", "fdisk", "parted", "iptables", "nft", "sysctl",
  "systemctl", "service", "launchctl", "crontab", "chown",
]);

/** 网络出站工具:L0/L1/L2 拒绝(包管理器是唯一 sanctioned 网络通道,PRD §5/§8-Q9) */
const NETWORK_DENY = new Set([
  "curl", "wget", "nc", "ncat", "netcat", "telnet", "ssh", "scp", "sftp",
  "rsync", "ftp", "dig", "nslookup", "ping", "openssl",
]);

/** 交付面命令:L1 拒绝,L2 confirm,L3 confirm */
const DELIVERY_COMMANDS = new Set(["gh", "glab"]);

/** L1+ 拒绝:容器/编排/发布 */
const L1_DENY = new Set(["docker", "podman", "kubectl", "helm", "nerdctl", "terraform", "pulumi"]);

// ---------------------------------------------------------------------------
// 路径参数围栏
// ---------------------------------------------------------------------------

/**
 * 命令的**第一个非选项参数是 pattern 而非路径**。校验时跳过它,
 * 否则 `rg '/api/users' src` 会被误判为访问 /api/users。
 */
const PATTERN_FIRST_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ag"]);

/** 这些命令的参数不是文件路径(ref/格式串/表达式),跳过路径校验 */
const NO_PATH_ARG_COMMANDS = new Set(["echo", "printf", "seq", "expr", "date", "which", "type", "test", "["]);

/**
 * 判断参数是否指向工作区之外。
 * 只检查「看起来是路径」的参数:绝对路径、~ 开头、含 .. 穿越的相对路径。
 * 普通相对路径(src/a.ts)由 cwd 保证落在工作区内。
 */
export function argEscapesWorkspace(arg: string, workspaceDir: string): boolean {
  if (!arg) return false;
  // 选项:值可能以三种形态携带路径,都要检查
  //   --opt=<path>   分隔符 =
  //   -f<path>       短选项紧贴值(jq -f/etc/passwd)
  //   --opt <path>   分离形态由调用方按下一个 token 处理
  if (arg.startsWith("-")) {
    const eq = arg.indexOf("=");
    if (eq >= 0) return argEscapesWorkspace(arg.slice(eq + 1), workspaceDir);
    const attached = arg.match(/^-{1,2}[A-Za-z]*([/~].*)$/);
    return attached ? argEscapesWorkspace(attached[1] as string, workspaceDir) : false;
  }
  // ~ 会被 shell 展开到 HOME,一律拒绝
  if (arg === "~" || arg.startsWith("~/")) return true;

  const looksAbsolute = arg.startsWith("/");
  const hasTraversal = arg === ".." || arg.startsWith("../") || arg.includes("/../") || arg.endsWith("/..");
  if (!looksAbsolute && !hasTraversal) return false;

  const root = resolve(workspaceDir);
  const target = looksAbsolute ? resolve(arg) : resolve(root, arg);
  if (target === root) return false;
  return !target.startsWith(`${root}/`);
}

/** 逐参数校验路径围栏;越界返回该参数 */
function findEscapingArg(cmd: string, args: string[], workspaceDir: string): string | undefined {
  if (NO_PATH_ARG_COMMANDS.has(cmd)) return undefined;
  const skipFirstPositional = PATTERN_FIRST_COMMANDS.has(cmd);
  let seenPositional = false;
  for (const arg of args) {
    const isPositional = !arg.startsWith("-");
    if (isPositional && skipFirstPositional && !seenPositional) {
      seenPositional = true;
      continue; // pattern,不是路径
    }
    if (isPositional) seenPositional = true;
    if (argEscapesWorkspace(arg, workspaceDir)) return arg;
  }
  return undefined;
}

/** find 的执行/删除动作 */
function findHasExec(args: string[]): boolean {
  return args.some((a) =>
    ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprintf", "-fprint0"].includes(a),
  );
}

function gitVerdict(args: string[], level: PermissionLevel, options: BashPolicyOptions): BashPolicyResult {
  // 跳过 -C <dir> / -c k=v / --no-pager 等前置全局参数,定位子命令
  let i = 0;
  let sawConfigFlag = false;
  let sawChdirFlag = false;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "-c") {
      sawConfigFlag = true;
      i += 2;
      continue;
    }
    if (a === "-C") {
      sawChdirFlag = true;
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      i++;
      continue;
    }
    break;
  }
  const sub = args[i];

  if (level === 0) {
    // -c 可注入 core.fsmonitor/pager 等执行路径;-C 可跳出工作区
    if (sawConfigFlag) {
      return { decision: "deny", rule: "git-config-flag", reason: "L0 禁止 git -c 配置注入" };
    }
    if (sawChdirFlag) {
      return { decision: "deny", rule: "git-chdir-flag", reason: "L0 禁止 git -C 切换目录" };
    }
    if (!sub || !L0_GIT_SUBCOMMANDS.has(sub)) {
      return {
        decision: "deny",
        rule: "git-readonly",
        reason: `L0 仅允许 git 只读子命令(${sub ?? "?"} 不在白名单)`,
      };
    }
    // 只读子命令仍可能带写盘/执行选项(--output= 直接落盘、--ext-diff 执行外部程序、
    // --no-index 让 git diff 读取仓库外任意两个文件)
    const unsafe = args.find((a) => gitUnsafeOption(a));
    if (unsafe) {
      return {
        decision: "deny",
        rule: "git-unsafe-option",
        reason: `L0 禁止 git 写盘/执行类选项:${unsafe}`,
      };
    }
    if (options.workspaceDir) {
      const escaping = args.find((a) => argEscapesWorkspace(a, options.workspaceDir as string));
      if (escaping) {
        return {
          decision: "deny",
          rule: "path-escape",
          reason: `L0 只能访问仓库工作区内的路径(越界参数:${escaping})`,
        };
      }
    }
    return { decision: "allow" };
  }

  // L1+:push 是交付面
  if (sub === "push") {
    if (level === 1) {
      return { decision: "deny", rule: "git-push", reason: "push 需要 L2 交付权限" };
    }
    return { decision: "confirm", rule: "git-push", reason: "push 需要确认(仅 pinery/* 分支)" };
  }
  if (sub === "config" && args.some((a) => a === "--global" || a === "--system")) {
    return { decision: "deny", rule: "git-config-global", reason: "禁止修改全局 git 配置" };
  }
  if (sub === "daemon" || sub === "instaweb" || sub === "svn") {
    return { decision: "deny", rule: "git-daemon", reason: "禁止启动 git 网络服务" };
  }
  return { decision: "allow" };
}

function segmentVerdict(segment: string, level: PermissionLevel, options: BashPolicyOptions): BashPolicyResult {
  const parsed = parseSegment(segment);
  if (!parsed) return { decision: "allow" };
  const { cmd, rawCmd, args } = parsed;

  if (cmd === "__SUBST__") return { decision: "allow" };

  if (HARD_DENY.has(cmd)) {
    return { decision: "deny", rule: `hard-deny:${cmd}`, reason: `禁止执行 ${cmd}(提权/系统级操作)` };
  }

  // 包装命令:递归判定其真实目标
  if (WRAPPERS.has(cmd)) {
    // env/timeout/nice 等:跳过自身参数,找到第一个非选项 token 作为目标命令
    let rest = args;
    if (cmd === "timeout" && rest.length > 0) rest = rest.slice(1); // timeout <dur> cmd
    while (rest.length > 0 && (rest[0]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!))) {
      rest = rest.slice(1);
    }
    if (rest.length === 0) {
      // 裸 env:打印进程环境(可能含密钥),各级别一律拦截(L3 走审批)
      if (cmd === "env") {
        if (level === 3) return { decision: "confirm", rule: "env-dump" };
        return { decision: "deny", rule: "env-dump", reason: "禁止打印进程环境变量" };
      }
      return level === 0 && cmd !== "test" && !L0_ALLOW.has(cmd)
        ? { decision: "deny", rule: "l0-allowlist", reason: `L0 白名单外命令:${cmd}` }
        : { decision: "allow" };
    }
    return segmentVerdict(rest.join(" "), level, options);
  }

  // shell -c 递归
  if (cmd === "sh" || cmd === "bash" || cmd === "zsh" || cmd === "dash") {
    const cIdx = args.indexOf("-c");
    if (cIdx >= 0 && args[cIdx + 1]) {
      return evaluateBashCommand(args[cIdx + 1]!, level, options);
    }
    if (level === 0) {
      return { decision: "deny", rule: "l0-shell-exec", reason: "L0 禁止执行脚本" };
    }
    return { decision: "allow" };
  }

  // 网络出站工具:L0-L2 一律拒绝(数据出不去,注入价值就塌了)
  if (NETWORK_DENY.has(cmd)) {
    if (level <= 2) {
      return { decision: "deny", rule: `network:${cmd}`, reason: `禁止网络出站工具 ${cmd}(包管理器是唯一放行通道)` };
    }
    return { decision: "confirm", rule: `network:${cmd}` };
  }

  // 交付面 CLI
  if (DELIVERY_COMMANDS.has(cmd)) {
    if (level <= 1) {
      return { decision: "deny", rule: `delivery:${cmd}`, reason: `${cmd} 需要 L2 交付权限` };
    }
    return { decision: "confirm", rule: `delivery:${cmd}`, reason: `${cmd} 操作需确认` };
  }

  if (cmd === "git") return gitVerdict(args, level, options);

  if (level === 0) {
    if (rawCmd.includes("/")) {
      return { decision: "deny", rule: "l0-path-exec", reason: "L0 禁止按路径执行程序/脚本" };
    }
    if (!L0_ALLOW.has(cmd)) {
      const hint = L0_ALTERNATIVES[cmd];
      return {
        decision: "deny",
        rule: "l0-allowlist",
        reason: hint ?? `L0 白名单外命令:${cmd}`,
      };
    }
    if (cmd === "find" && findHasExec(args)) {
      return { decision: "deny", rule: "find-exec", reason: "L0 禁止 find -exec/-delete" };
    }
    if (cmd === "env" || cmd === "printenv") {
      return { decision: "deny", rule: "env-dump", reason: "L0 禁止打印进程环境变量" };
    }
    // 路径围栏:文件工具的围栏管不到 bash,`cat /data/pinery.db` 这类命令
    // 能读到应用自身状态(其他会话、审计日志、问答留痕)
    if (options.workspaceDir) {
      const escaping = findEscapingArg(cmd, args, options.workspaceDir);
      if (escaping) {
        return {
          decision: "deny",
          rule: "path-escape",
          reason: `L0 只能访问仓库工作区内的路径(越界参数:${escaping})`,
        };
      }
    }
    return { decision: "allow" };
  }

  // L1/L2:默认放行,denylist 拦截
  if (L1_DENY.has(cmd)) {
    return { decision: "deny", rule: `l1-deny:${cmd}`, reason: `禁止 ${cmd}(容器/发布面)` };
  }
  if ((cmd === "npm" || cmd === "pnpm" || cmd === "yarn") && args[0] === "publish") {
    return { decision: "deny", rule: "pkg-publish", reason: "禁止发布 npm 包" };
  }
  if (cmd === "printenv" || (cmd === "env" && args.length === 0)) {
    return { decision: "deny", rule: "env-dump", reason: "禁止打印进程环境变量" };
  }

  if (level === 3) {
    // L3 默认审批
    return { decision: "confirm", rule: "l3-default-confirm" };
  }
  return { decision: "allow" };
}

/**
 * 判定一条 bash 命令在给定级别下的执行策略。
 * 复合命令取所有段的最严格判定(deny > confirm > allow)。
 */
export function evaluateBashCommand(
  command: string,
  level: PermissionLevel,
  options: BashPolicyOptions = {},
): BashPolicyResult {
  const trimmed = command.trim();
  if (!trimmed) return { decision: "allow" };

  const { segments, hasSubstitution, hasOutputRedirect } = splitCommand(trimmed);

  if (level === 0 && hasOutputRedirect) {
    return { decision: "deny", rule: "l0-redirect", reason: "L0 禁止输出重定向写文件" };
  }
  if (level === 0 && hasSubstitution) {
    // 替换内部命令已并入 segments 逐段判定;L0 直接一刀切拒绝,减小面
    return { decision: "deny", rule: "l0-substitution", reason: "L0 禁止命令替换 $(...) / 反引号" };
  }

  let worst: BashPolicyResult = { decision: "allow" };
  for (const seg of segments) {
    const v = segmentVerdict(seg, level, options);
    if (v.decision === "deny") return v;
    if (v.decision === "confirm") worst = v;
  }
  return worst;
}
