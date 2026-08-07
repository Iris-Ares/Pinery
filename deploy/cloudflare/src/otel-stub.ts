/**
 * @opentelemetry/api 的空 stub:pi-ai 的 mistral provider 静态 import 了
 * @mistralai/mistralai,后者引用 otel(未安装的 optional 依赖)。Pinery 不使用
 * mistral provider,该代码路径永不执行,alias 到本 stub 仅为满足 bundle 解析。
 */
export const trace: unknown = undefined;
export const propagation: unknown = undefined;
export const context: unknown = undefined;
export const metrics: unknown = undefined;
export const diag: unknown = undefined;
export const api: unknown = undefined;
export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;
export const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 } as const;
export default undefined;
