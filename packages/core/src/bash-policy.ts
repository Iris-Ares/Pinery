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

/** L0 只读命令 allowlist */
const L0_ALLOW = new Set([
  "ls", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "nl",
  "grep", "egrep", "fgrep", "rg", "ag", "fd", "find", "tree", "file", "stat",
  "du", "df", "basename", "dirname", "realpath", "readlink", "pwd", "echo",
  "printf", "date", "diff", "comm", "join", "paste", "seq", "expr", "test", "[",
  "true", "false", "which", "type", "md5", "md5sum", "shasum", "sha256sum",
  "cksum", "strings", "iconv", "zcat", "jq", "yq", "column", "xargs", "awk",
  "sed", "git", "wc", "od", "hexdump",
]);

/** 需要递归判定其目标命令的包装命令 */
const WRAPPERS = new Set(["xargs", "timeout", "nice", "command", "env", "nohup", "stdbuf", "time"]);

/** L0 git 只读子命令 */
const L0_GIT_SUBCOMMANDS = new Set([
  "log", "show", "diff", "blame", "status", "shortlog", "describe",
  "rev-parse", "rev-list", "ls-files", "ls-tree", "cat-file", "grep",
  "count-objects", "whatchanged", "reflog", "version", "help",
]);

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

/** sed 写盘检测 */
function sedIsInPlace(args: string[]): boolean {
  return args.some((a) => a === "-i" || a.startsWith("-i.") || a.startsWith("--in-place"));
}

/** find 的执行/删除动作 */
function findHasExec(args: string[]): boolean {
  return args.some((a) =>
    ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprintf", "-fprint0"].includes(a),
  );
}

function gitVerdict(args: string[], level: PermissionLevel): BashPolicyResult {
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
    // 只读子命令也不许带 pager/hook 注入选项
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

function segmentVerdict(segment: string, level: PermissionLevel): BashPolicyResult {
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
    return segmentVerdict(rest.join(" "), level);
  }

  // shell -c 递归
  if (cmd === "sh" || cmd === "bash" || cmd === "zsh" || cmd === "dash") {
    const cIdx = args.indexOf("-c");
    if (cIdx >= 0 && args[cIdx + 1]) {
      return evaluateBashCommand(args[cIdx + 1]!, level);
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

  if (cmd === "git") return gitVerdict(args, level);

  if (level === 0) {
    if (rawCmd.includes("/")) {
      return { decision: "deny", rule: "l0-path-exec", reason: "L0 禁止按路径执行程序/脚本" };
    }
    if (!L0_ALLOW.has(cmd)) {
      return { decision: "deny", rule: "l0-allowlist", reason: `L0 白名单外命令:${cmd}` };
    }
    if (cmd === "sed" && sedIsInPlace(args)) {
      return { decision: "deny", rule: "sed-in-place", reason: "L0 禁止 sed -i 写文件" };
    }
    if (cmd === "find" && findHasExec(args)) {
      return { decision: "deny", rule: "find-exec", reason: "L0 禁止 find -exec/-delete" };
    }
    if (cmd === "env" || cmd === "printenv") {
      return { decision: "deny", rule: "env-dump", reason: "L0 禁止打印进程环境变量" };
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
export function evaluateBashCommand(command: string, level: PermissionLevel): BashPolicyResult {
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
    const v = segmentVerdict(seg, level);
    if (v.decision === "deny") return v;
    if (v.decision === "confirm") worst = v;
  }
  return worst;
}
