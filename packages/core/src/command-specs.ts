/**
 * L0 命令参数规格表(白名单语义)。
 *
 * 为什么是这个形状:前几轮用「命令名白名单 + 危险选项黑名单」,结果每个
 * Unix 命令都是自带 DSL 的小语言,黑名单永远追不上——`rg --pre <cmd>` 执行
 * 外部程序、`rg --files` 让路径变成位置参数、`sort -o` / `iconv -o` 写文件、
 * `xargs -a` / `env --chdir` 读工作区外……都是逐个被发现的。
 *
 * 现在翻转方向:**未在此表声明的标志一律拒绝**。新增危险选项不再需要我们
 * 事先知道它危险;代价是常用标志要显式列出(可用性回归由测试兜底)。
 *
 * 同一个 `-o` 在不同命令里含义相反,正是需要 per-command 规格的原因:
 *   grep -o   → --only-matching(安全)
 *   join -o   → 输出格式串(安全)
 *   sort -o   → 输出文件(写盘,故不声明 ⇒ 拒绝)
 *   iconv -o  → 输出文件(同上)
 */

export interface CommandSpec {
  /** 布尔标志;短标志可组合(-la) */
  flags?: string[];
  /** 带值标志,值**不是**路径(-n 20、-d ,);值形态可分离或紧贴 */
  valueFlags?: string[];
  /** 带值标志,值是路径,需过工作区围栏(jq --rawfile、grep -f) */
  pathFlags?: string[];
  /**
   * 位置参数语义:
   * - paths:全部按路径校验
   * - pattern-then-paths:首个是模式(不校验),其余按路径校验
   * - opaque:不是路径(字符集、格式串),不校验
   */
  positional: "paths" | "pattern-then-paths" | "opaque";
  /** 允许 -<数字> 形态(head -50) */
  numeric?: boolean;
}

const READ_FLAGS = ["-L", "-H", "-P"]; // symlink 处理类,读方向无害

export const L0_COMMAND_SPECS: Record<string, CommandSpec> = {
  ls: {
    flags: ["-l", "-a", "-A", "-h", "-R", "-t", "-r", "-S", "-1", "-d", "-F", "-i", "-p", "-u", "-c", "-n", "-G", ...READ_FLAGS,
      "--all", "--almost-all", "--human-readable", "--reverse", "--recursive", "--classify", "--directory", "--inode"],
    valueFlags: ["--sort", "--time", "--color", "--format"],
    positional: "paths",
  },
  cat: {
    flags: ["-n", "-b", "-s", "-A", "-v", "-e", "-t", "-E", "-T", "--number", "--squeeze-blank", "--show-all", "--show-ends", "--show-tabs"],
    positional: "paths",
  },
  head: {
    flags: ["-q", "-v", "--quiet", "--verbose", "--silent"],
    valueFlags: ["-n", "-c", "--lines", "--bytes"],
    numeric: true,
    positional: "paths",
  },
  tail: {
    // 不声明 -f/-F:follow 会挂住工具调用直到超时
    flags: ["-q", "-v", "--quiet", "--verbose", "--silent"],
    valueFlags: ["-n", "-c", "--lines", "--bytes"],
    numeric: true,
    positional: "paths",
  },
  wc: {
    flags: ["-l", "-w", "-c", "-m", "-L", "--lines", "--words", "--bytes", "--chars", "--max-line-length"],
    positional: "paths",
  },
  sort: {
    // -o = 输出文件,不声明 ⇒ 拒绝;-T = 临时目录,同理
    flags: ["-n", "-r", "-u", "-f", "-b", "-h", "-V", "-g", "-M", "-s", "-c", "-z", "-i", "-d",
      "--numeric-sort", "--reverse", "--unique", "--ignore-case", "--version-sort", "--human-numeric-sort", "--stable", "--check"],
    valueFlags: ["-k", "-t", "--key", "--field-separator"],
    positional: "paths",
  },
  uniq: {
    flags: ["-c", "-d", "-u", "-i", "-z", "--count", "--repeated", "--unique", "--ignore-case"],
    valueFlags: ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"],
    positional: "paths",
  },
  cut: {
    flags: ["-s", "-n", "-z", "--only-delimited", "--complement", "--zero-terminated"],
    valueFlags: ["-d", "-f", "-c", "-b", "--delimiter", "--fields", "--characters", "--bytes", "--output-delimiter"],
    positional: "paths",
  },
  tr: {
    flags: ["-d", "-s", "-c", "-t", "-C", "--delete", "--squeeze-repeats", "--complement", "--truncate-set1"],
    positional: "opaque",
  },
  nl: {
    flags: ["-p", "--no-renumber"],
    valueFlags: ["-b", "-n", "-w", "-s", "-v", "-i", "-d", "-f", "-h", "--body-numbering", "--number-format", "--number-width", "--number-separator"],
    positional: "paths",
  },
  grep: {
    // grep -o = --only-matching(安全)
    flags: ["-n", "-i", "-r", "-R", "-l", "-L", "-v", "-w", "-x", "-c", "-h", "-H", "-o", "-q", "-s", "-a", "-I", "-F", "-E", "-G", "-P", "-z", "-b", "-U",
      "--line-number", "--ignore-case", "--recursive", "--dereference-recursive", "--files-with-matches", "--files-without-match",
      "--invert-match", "--word-regexp", "--line-regexp", "--count", "--only-matching", "--fixed-strings", "--extended-regexp",
      "--basic-regexp", "--perl-regexp", "--no-filename", "--with-filename", "--no-messages", "--byte-offset", "--null"],
    valueFlags: ["-m", "-A", "-B", "-C", "-e", "-D", "-d", "--max-count", "--after-context", "--before-context", "--context",
      "--regexp", "--color", "--colour", "--binary-files", "--include", "--exclude", "--exclude-dir", "--devices", "--directories", "--label"],
    pathFlags: ["-f", "--file"], // pattern 文件
    positional: "pattern-then-paths",
  },
  rg: {
    // 不声明 --pre / --pre-glob(执行外部程序)、--files / --files-with-matches 之外的模式切换,
    // 以及 --hostname-bin;它们会改变位置参数语义或直接执行命令
    flags: ["-n", "-N", "-i", "-l", "-v", "-w", "-x", "-c", "-h", "-H", "-o", "-q", "-a", "-F", "-p", "-S", "-s", "-U", "-z", "-u", "-uu", "-L", "-.", "-0",
      "--line-number", "--no-line-number", "--ignore-case", "--smart-case", "--case-sensitive", "--files-with-matches", "--files-without-match",
      "--invert-match", "--word-regexp", "--line-regexp", "--count", "--count-matches", "--only-matching", "--fixed-strings", "--multiline",
      "--hidden", "--no-ignore", "--no-ignore-vcs", "--heading", "--no-heading", "--vimgrep", "--stats", "--trim", "--null", "--text",
      "--follow", "--json", "--no-messages", "--pretty", "--column", "--byte-offset", "--with-filename", "--no-filename", "--crlf"],
    valueFlags: ["-m", "-A", "-B", "-C", "-e", "-t", "-T", "-g", "-M", "-j",
      "--max-count", "--after-context", "--before-context", "--context", "--regexp", "--type", "--type-not", "--type-add",
      "--glob", "--iglob", "--max-depth", "--maxdepth", "--max-filesize", "--max-columns", "--color", "--colors",
      "--sort", "--sortr", "--encoding", "--engine", "--threads", "--context-separator", "--field-match-separator"],
    pathFlags: ["-f", "--file", "--ignore-file"],
    positional: "pattern-then-paths",
  },
  find: {
    // -exec/-delete 等由 findHasExec 单独拦截;-o/-a 是逻辑操作符
    flags: ["-print", "-print0", "-depth", "-empty", "-not", "-o", "-a", "-or", "-and", "-true", "-false", "-nouser", "-nogroup", "-xdev", "-ls", ...READ_FLAGS],
    valueFlags: ["-name", "-iname", "-type", "-maxdepth", "-mindepth", "-size", "-path", "-ipath", "-regex", "-iregex",
      "-perm", "-user", "-group", "-mtime", "-ctime", "-atime", "-mmin", "-cmin", "-amin", "-inum", "-links", "-regextype", "-printf"],
    pathFlags: ["-newer", "-anewer", "-cnewer"],
    positional: "paths",
  },
  fd: {
    flags: ["-H", "-I", "-a", "-l", "-p", "-u", "-s", "-i", "-0", "-L", "--hidden", "--no-ignore", "--absolute-path", "--full-path",
      "--case-sensitive", "--ignore-case", "--follow", "--print0", "--list-details"],
    valueFlags: ["-t", "-e", "-d", "-E", "-S", "--type", "--extension", "--max-depth", "--exclude", "--size", "--changed-within", "--changed-before", "--color"],
    positional: "pattern-then-paths",
  },
  tree: {
    flags: ["-a", "-d", "-f", "-i", "-C", "-n", "-q", "-p", "-s", "-h", "--dirsfirst", "--noreport"],
    valueFlags: ["-L", "-I", "-P", "--filelimit"],
    positional: "paths",
  },
  file: { flags: ["-b", "-i", "-L", "--brief", "--mime", "--mime-type"], positional: "paths" },
  stat: { flags: ["-L", "-t", "--terse", "--dereference"], valueFlags: ["-c", "-f", "--format", "--printf"], positional: "paths" },
  du: {
    flags: ["-h", "-s", "-a", "-c", "-k", "-m", "-b", "-x", "--human-readable", "--summarize", "--all", "--total"],
    valueFlags: ["-d", "--max-depth", "--exclude", "--block-size"],
    positional: "paths",
  },
  df: { flags: ["-h", "-k", "-m", "-i", "-a", "-T", "--human-readable", "--inodes"], positional: "paths" },
  diff: {
    flags: ["-u", "-r", "-w", "-b", "-i", "-q", "-N", "-c", "-y", "-a", "-s", "-B", "-E", "-Z",
      "--unified", "--recursive", "--brief", "--new-file", "--ignore-all-space", "--ignore-blank-lines", "--side-by-side", "--report-identical-files"],
    valueFlags: ["-U", "-C", "--unified", "--context", "--label"],
    positional: "paths",
  },
  comm: { flags: ["-1", "-2", "-3", "--check-order", "--nocheck-order"], valueFlags: ["--output-delimiter"], positional: "paths" },
  join: { flags: ["-i", "-a", "-v", "--ignore-case"], valueFlags: ["-1", "-2", "-j", "-t", "-o", "-e"], positional: "paths" },
  paste: { flags: ["-s", "-z", "--serial"], valueFlags: ["-d", "--delimiters"], positional: "paths" },
  column: { flags: ["-t", "-x", "-e", "--table"], valueFlags: ["-s", "-c", "-o", "-N", "--separator", "--output-separator"], positional: "paths" },
  jq: {
    flags: ["-r", "-c", "-n", "-e", "-s", "-S", "-j", "-a", "-M", "-C", "-R", "-z",
      "--raw-output", "--compact-output", "--null-input", "--exit-status", "--slurp", "--sort-keys", "--tab",
      "--monochrome-output", "--color-output", "--raw-input", "--join-output", "--ascii-output", "--seq"],
    valueFlags: ["--arg", "--argjson", "--indent", "--jsonargs", "--args"],
    // --rawfile/--slurpfile 取两个值(变量名 + 路径),-f 从文件读程序。
    // 不声明 ⇒ 拒绝:与其为 2-arity 选项写特例,不如让 L0 用不到它们
    // (调查场景写不出这种用法),把规格表保持在「每个选项只有一种解读」。
    positional: "pattern-then-paths",
  },
  strings: { flags: ["-a", "-f", "--all", "--print-file-name"], valueFlags: ["-n", "-t", "-e", "--bytes", "--radix", "--encoding"], positional: "paths" },
  od: { flags: ["-c", "-b", "-x", "-d", "-o", "-a", "-v"], valueFlags: ["-A", "-t", "-N", "-j", "-w", "--address-radix", "--format", "--read-bytes", "--skip-bytes"], positional: "paths" },
  hexdump: { flags: ["-C", "-b", "-c", "-d", "-o", "-x", "-v"], valueFlags: ["-n", "-s", "-e"], positional: "paths" },
  zcat: { flags: ["-f", "-q"], positional: "paths" },
  iconv: {
    // -o = 输出文件,不声明 ⇒ 拒绝
    flags: ["-c", "-s", "--silent"],
    valueFlags: ["-f", "-t", "--from-code", "--to-code"],
    positional: "paths",
  },
  md5sum: { flags: ["-b", "-t", "-c", "--binary", "--text", "--check"], positional: "paths" },
  md5: { flags: ["-q", "-r"], positional: "paths" },
  shasum: { flags: ["-b", "-t", "-c", "-p"], valueFlags: ["-a", "--algorithm"], positional: "paths" },
  sha256sum: { flags: ["-b", "-t", "-c", "--binary", "--text", "--check"], positional: "paths" },
  cksum: { flags: [], positional: "paths" },
  basename: { flags: ["-a", "-z", "--multiple", "--zero"], valueFlags: ["-s", "--suffix"], positional: "paths" },
  dirname: { flags: ["-z", "--zero"], positional: "paths" },
  realpath: { flags: ["-e", "-m", "-q", "-s", "-z", "--canonicalize-existing", "--canonicalize-missing", "--quiet", "--no-symlinks"], positional: "paths" },
  readlink: { flags: ["-f", "-e", "-m", "-n", "-q", "-s", "-z", "--canonicalize", "--no-newline"], positional: "paths" },
  pwd: { flags: ["-L", "-P"], positional: "opaque" },
  echo: { flags: ["-n", "-e", "-E"], positional: "opaque" },
  printf: { flags: [], positional: "opaque" },
  date: { flags: ["-u", "-R", "-I", "--utc"], valueFlags: ["-d", "--date", "-f", "+%s"], positional: "opaque" },
  seq: { flags: ["-w", "-s"], valueFlags: ["-f", "--format", "--separator"], positional: "opaque" },
  expr: { flags: [], positional: "opaque" },
  test: { flags: [], positional: "opaque" },
  "[": { flags: [], positional: "opaque" },
  true: { flags: [], positional: "opaque" },
  false: { flags: [], positional: "opaque" },
  which: { flags: ["-a", "-s"], positional: "opaque" },
  type: { flags: ["-a", "-t", "-P"], positional: "opaque" },
};

/** L0 允许的命令 = 规格表的键 + git(子命令语义特殊,单独处理) */
export const L0_ALLOWED_COMMANDS = new Set([...Object.keys(L0_COMMAND_SPECS), "git", "egrep", "fgrep"]);

/** egrep/fgrep 共用 grep 规格 */
export function specFor(cmd: string): CommandSpec | undefined {
  if (cmd === "egrep" || cmd === "fgrep") return L0_COMMAND_SPECS["grep"];
  return L0_COMMAND_SPECS[cmd];
}
