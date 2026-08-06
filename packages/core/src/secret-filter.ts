/**
 * secret 出站过滤管道(PRD §2.2 P0 / §5)。
 *
 * 所有出站文本(答案、进度、摘要、FAQ)统一经过本过滤器。
 * 规则取自 gitleaks 高信号子集 + 通用赋值启发式;宁可误伤,不可漏出。
 */

export interface SecretRule {
  id: string;
  pattern: RegExp;
  /** 只脱敏该捕获组(1-based);缺省整段替换 */
  group?: number;
}

const R = (id: string, pattern: RegExp, group?: number): SecretRule =>
  group === undefined ? { id, pattern } : { id, pattern, group };

export const SECRET_RULES: SecretRule[] = [
  R("private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g),
  R("aws-access-key", /\b(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g),
  R("github-token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g),
  R("github-pat", /\bgithub_pat_[0-9A-Za-z_]{80,}\b/g),
  R("gitlab-pat", /\bglpat-[0-9A-Za-z_-]{20,}\b/g),
  R("slack-token", /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g),
  R("anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g),
  R("openrouter-key", /\bsk-or-[A-Za-z0-9_-]{20,}\b/g),
  R("openai-key", /\bsk-[A-Za-z0-9_-]{20,}\b/g),
  R("google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g),
  R("npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g),
  R("jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g),
  // 通用赋值:api_key = "xxxx" / app_secret: xxxx —— 只脱敏值
  R(
    "generic-assignment",
    /\b(api[_-]?key|apikey|secret|app[_-]?secret|access[_-]?key|auth[_-]?token|token|password|passwd|pwd|credential)\b\s*[:=]\s*["']?([A-Za-z0-9_\-/+=]{16,})["']?/gi,
    2,
  ),
];

export interface SecretFinding {
  rule: string;
  count: number;
}

export interface FilterResult {
  text: string;
  findings: SecretFinding[];
  /** 是否发生过替换 */
  redacted: boolean;
}

const PLACEHOLDER = (rule: string) => `[已脱敏:${rule}]`;

/** 对文本做 secret 脱敏。幂等:占位符本身不会再次命中。 */
export function filterSecrets(input: string): FilterResult {
  let text = input;
  const findings: SecretFinding[] = [];

  for (const rule of SECRET_RULES) {
    let count = 0;
    text = text.replace(rule.pattern, (match, ...rest) => {
      count++;
      if (rule.group !== undefined) {
        // 仅替换指定捕获组,保留上下文(键名等)
        const groups = rest.slice(0, -2) as (string | undefined)[];
        const target = groups[rule.group - 1];
        if (target === undefined) return PLACEHOLDER(rule.id);
        return match.replace(target, PLACEHOLDER(rule.id));
      }
      return PLACEHOLDER(rule.id);
    });
    if (count > 0) findings.push({ rule: rule.id, count });
  }

  return { text, findings, redacted: findings.length > 0 };
}
