/**
 * 仓库凭据与地址的分离。
 *
 * 私有仓库的通行写法是 `https://<token>@host/org/repo.git`,但**凭据不能出现在
 * clone 的 URL 里**:git 会把它原样记进 `.git/config` 的 remote origin,
 * 而 `.git/config` 就在 checkout 内——L0 的 `cat .git/config` 一读即得,
 * 仓库里的一段 prompt injection 就能把 token 送到模型侧。
 * (同理还有 `.git/FETCH_HEAD`,它也会记录抓取用的 URL。)
 *
 * 所以对外只用脱敏地址,凭据改走 HTTP Authorization 头:
 * - 本地 git:`git -c http.extraHeader=... clone <脱敏地址>`
 * - CF Worker:`ws.git.clone({ url: <脱敏地址>, headers })`
 *
 * 头部只存在于进程参数与请求中,不落入任何 agent 可读的持久介质。
 */

export interface RepoCredentials {
  /** 去掉 userinfo 的地址,用于 clone/pull 与一切持久化 */
  url: string;
  /** 需要随请求发送的认证头(无凭据时为 undefined) */
  headers?: Record<string, string>;
}

/** 去掉 URL 里的 user:password@,只留可比较的仓库标识 */
export function redactRepoUrl(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]*@/i, "$1");
}

/** base64(标准实现在 Node/Workers/Bun 下都可用) */
function toBase64(input: string): string {
  if (typeof btoa === "function") {
    // btoa 只接受 latin1;先按 UTF-8 编码再逐字节转换
    const bytes = new TextEncoder().encode(input);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }
  return Buffer.from(input, "utf8").toString("base64");
}

/**
 * 把 `https://user:pass@host/x.git` 拆成脱敏地址 + Basic 认证头。
 *
 * 只有 userinfo 的地址(`https://<token>@host/...`,GitHub PAT 的常见写法)
 * 按 `token:` 处理——git 对这种形态就是把 token 当用户名、密码留空。
 */
export function splitRepoCredentials(rawUrl: string): RepoCredentials {
  const match = rawUrl.match(/^(https?:\/\/)([^/@]*)@(.*)$/i);
  if (!match) return { url: rawUrl };

  const [, scheme, userinfo, rest] = match;
  const url = `${scheme}${rest}`;
  if (!userinfo) return { url };

  // userinfo 在 URL 里是百分号编码的
  const decoded = userinfo
    .split(":")
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    })
    .join(":");
  const pair = decoded.includes(":") ? decoded : `${decoded}:`;
  return { url, headers: { Authorization: `Basic ${toBase64(pair)}` } };
}
