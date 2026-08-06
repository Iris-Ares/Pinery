/**
 * 仓库标记的位置与脱敏,刻意不依赖 `cloudflare:workers`,以便在 Workers
 * 运行时之外单测(与 search.ts / exec-deadline.ts 同一约定)。
 *
 * 标记存在**工作区之外**:guardPath 把一切访问围栏在 WORKSPACE_ROOT 内,
 * 所以 agent 的读工具够不到这里。这很重要,因为私有仓库的推荐写法是
 * `https://<token>@host/org/repo.git`——标记若落在 checkout 里,仓库中的
 * prompt injection 就能诱导 agent 读出它,而无前缀特征的 token 未必被出站
 * secret 过滤识别,凭据会先一步到达模型侧。
 */

export const REPO_MARKER = "/.pinery-state/repo.json";

export interface RepoMarker {
  /** 已脱敏的仓库地址(去掉 userinfo);凭据只存在于请求中,不落盘 */
  url: string;
  ref?: string;
  /** 上次 clone/pull 时间戳,provider 据此决定是否刷新 */
  syncedAt?: number;
}

// 脱敏实现放在协议包里:客户端比对与服务端持久化必须用同一个函数,
// 两份定义一旦漂移,私有仓库就会永远被判成「不同仓库」。
export { redactRepoUrl } from "@pinery/workspace-cf-computer/protocol";
