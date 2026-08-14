import { ConfigError, parseConfig, type PineryConfig } from "@pinery/core";

/**
 * CF 形态的配置装载:pinery.yaml 全文放在 wrangler var `PINERY_CONFIG`,
 * secret 以 ${VAR} 引用、由 Worker secrets 提供(parseConfig 的 env 插值
 * 直接吃 env binding 对象,不依赖 process.env populate)。
 */

export interface PineryWorkerEnv {
  WORKSPACE: DurableObjectNamespace;
  AGENT: DurableObjectNamespace;
  LOADER: unknown;
  /** /v1/ws HTTP 入口的共享密钥(混合形态:本地 adapter + CF 工作区) */
  PINERY_TOKEN?: string;
  /** pinery.yaml 全文(YAML 字符串) */
  PINERY_CONFIG?: string;
  /** 固定 R2 快照前缀;Agent 冒烟从末段取得预期 commit */
  PINERY_SOURCE_PREFIX?: string;
  [key: string]: unknown;
}

/** env binding → 插值用的字符串记录(丢弃非字符串 binding) */
export function envStrings(env: PineryWorkerEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function loadWorkerConfig(env: PineryWorkerEnv): PineryConfig {
  if (!env.PINERY_CONFIG) {
    throw new ConfigError(
      "缺少 PINERY_CONFIG(wrangler.jsonc vars 里的 pinery.yaml 全文;secret 用 ${VAR} 引用并以 wrangler secret 提供)",
    );
  }
  const cfg = parseConfig(env.PINERY_CONFIG, envStrings(env));
  if (!cfg.lark.encrypt_key) {
    throw new ConfigError(
      "CF 形态要求配置 lark.encrypt_key(飞书后台「加密策略」的 Encrypt Key;webhook 验签与解密依赖它)",
    );
  }
  return cfg;
}
