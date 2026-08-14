# Cloudflare 部署(云原生形态)

Pinery 在 Cloudflare 上有两种形态,同一个 Worker 同时支持:

| 形态 | 组成 | 适合 |
|---|---|---|
| **A. 全云(首要)** | 飞书 webhook → PineryAgent DO(Agents SDK + Fiber)→ PineryWorkspace DO(CF Computer)→ AI Gateway | 免自有服务器;海外 Lark、公开 demo、仓库在 GitHub/GitLab SaaS |
| **B. 混合** | 本地 adapter(长连接)→ `POST /v1/ws/:id/rpc` → CF 工作区 | 想要云工作区但保留本地进程/内网事件接入 |

架构设计、决策记录与平台限制对照:**[docs/cloudflare-architecture.md](../../docs/cloudflare-architecture.md)**。
选型依据:[docs/sandbox-evaluation.md](../../docs/sandbox-evaluation.md)。

## 已知限制(先读这段)

| 限制 | 说明 |
|---|---|
| **preview** | `@cloudflare/computer@0.1.1` 官方标注 PREVIEW,不建议生产;本项目已 pin 版本 |
| **HTTPS-only 仓库** | Computer 的 git 是 isomorphic-git,**无 SSH 传输**。仓库 URL 必须是 `https://`;私有仓库用 `https://<token>@host/org/repo.git`(凭据经 Authorization 头传输,不写入 `.git/config`) |
| **仓库体积** | ~10GB/工作区,浅克隆(depth=1)默认开启;isomorphic-git 解包仍受 DO 内存限制。大型 monorepo 使用下方 R2 只读快照 |
| **执行后端** | 默认 `worker-shell`(免容器、毫秒级文本命令),够 L0 只读调查;L1 写任务需 container 后端(C3,未实施) |
| **尚未启用** | golden 跨会话导出、卡片按钮回调、L1 可写 worktree/container —— 见架构文档 §9 分期 |

## 全云形态部署

```bash
cd deploy/cloudflare
bun install
```

**1. 配置**:把 pinery.yaml 全文放进 [wrangler.jsonc](wrangler.jsonc) 的 `vars.PINERY_CONFIG`
(YAML 字符串;secret 一律写 `${VAR}` 引用)。最小示例:

```yaml
lark:
  app_id: cli_xxx
  app_secret: ${LARK_APP_SECRET}
  encrypt_key: ${LARK_ENCRYPT_KEY}      # CF 形态必需(webhook 验签与解密)
repos:
  - name: order-service
    aliases: [订单, order]
    url: https://github.com/org/order.git
    # chats: [oc_xxx]   # 可选:多项目时为该群指定默认项目;不是访问白名单
model:
  provider: anthropic
  id: claude-sonnet-4-5
  base_url: https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/anthropic   # 推荐:AI Gateway 改道
  headers: { cf-aig-authorization: CF_AIG_HEADER }
workspace:
  provider: "@pinery/workspace-cf-computer"
```

**2. secrets**(与 YAML 里的 `${VAR}` 一一对应):

```bash
bunx wrangler secret put LARK_APP_SECRET
bunx wrangler secret put LARK_ENCRYPT_KEY
bunx wrangler secret put CF_AIG_HEADER        # 或直接 provider key(ANTHROPIC_API_KEY 等)
```

**3. 部署 + 飞书后台**:

```bash
bunx wrangler deploy
curl https://pinery-computer.<你的子域>.workers.dev/health
```

### Dashboard 资源对照(它不是业务验收)

`wrangler deploy` 成功后,先核对本次 deployment 与 binding,再跑下方
端到端检查。Dashboard 中“看到了资源”只证明控制面配置存在,
不证明模型、工作区、飞书凭据或 webhook 真正可用。

| Dashboard / Wrangler 中的资源 | 本项目应有的配置 | 什么时候才会有运行证据 |
|---|---|---|
| Worker | `pinery-computer`,entrypoint `src/worker.ts` | `/health` 或任一路由被请求后 |
| Durable Objects | `AGENT` → `PineryAgent`;`WORKSPACE` → `PineryWorkspace` | 分别在真实 Agent 请求、工作区 RPC/水合后 |
| Agents 页 / traces | `PineryAgent` 由 Agents SDK 导出,observability + traces 已启用 | 至少一次请求路由到 Agent DO 后;空页不能单独用于判定部署失败 |
| R2 | binding `PINERY_SOURCES` → bucket `pinery-sources` | 执行 source upload/hydrate 后才有 objects |
| Worker Loader | binding `LOADER` | `worker-shell` 工具真正执行后;它不一定以独立可点击资源展示 |
| AI Gateway(可选) | `model.base_url` 指向的 gateway | 真实模型调用后才有请求记录 |

建议保留部署证据:

```bash
bunx wrangler deployments list
bunx wrangler tail
```

`wrangler deploy` 输出中的 bindings 必须与上表一致;若使用自定义域名,
还要分别记录 `workers.dev` 与自定义域名的 `/health` 结果,避免把 DNS/
路由问题与 Worker 本身混在一起。

飞书后台「事件与回调」→ 订阅方式选 **「将事件发送至开发者服务器」**,
请求网址 `https://<worker>/lark/events`,订阅 `im.message.receive_v1`;
「加密策略」启用 **Encrypt Key**。逐步截图见 [docs/feishu-setup.md](../../docs/feishu-setup.md)。

之后在飞书单聊或群聊里直接提问即可:🔍 调查中 → 进度流 → ✅ 分层答案卡片。
单项目会直接路由;多项目优先识别名称/`aliases`,无法确定时 Bot 会给出项目选择卡片。
默认开放 L0 只读咨询;只有需要收紧时才配置 `group_open: false`、
`p2p_open: false` 或显式 `permissions`。
群聊每次真正 @ Bot 时都会分页读取飞书历史并动态筛选相关上下文;直接回复 Bot
则复用同一 runner 会话。Cloudflare 上的 Pi 会话快照持久化在当前 Agent DO SQLite,
恢复前同时校验 runner、repo、Computer workspace 句柄、branch 与只读级别。

按以下顺序验收,每一层只代表它自己的证据:

1. `/health`:Worker 路由可达。
2. `/v1/lark/check`:租户 token 与机器人身份可解析。
3. `/v1/agent/smoke`:Agent DO、模型、Computer 工作区和固定 manifest 读取同时可用。
4. `/v1/agent/query`:自定义真实代码问题能完成工具调查。
5. 飞书真实消息:challenge、事件验签/解密、路由、进度卡与最终卡全部通过。

部署后可用 `PINERY_TOKEN` 运行一次固定、只读且有界的真实 Agent 冒烟。该
入口不接受自定义 prompt:它会让正式 Agent 读取快照 manifest 并通过当前
provider 回显 commit,用于同时验证 Agent DO、工作区工具与模型调用。

先验证飞书 App ID/Secret 能否换取 tenant token,以及机器人身份是否已启用。
响应只返回布尔状态,不会回传 token、机器人 open_id 或应用配置:

```bash
curl -X POST https://<worker>.workers.dev/v1/lark/check \
  -H "Authorization: Bearer $PINERY_TOKEN"
```

只有 `ok=true`、`authenticated=true` 且 `botIdentityResolved=true` 才说明应用
凭据与机器人能力均可用;这仍不替代飞书后台的 webhook challenge 和真实消息验收。

```bash
curl -X POST https://<worker>.workers.dev/v1/agent/smoke \
  -H "Authorization: Bearer $PINERY_TOKEN"
```

只有响应中的 `ok=true`、`readManifest=true`、`toolCalls>0`,且
`observedCommit == expectedCommit` 才算通过。`/health` 只证明 Worker 路由存活,
不能替代此验收。

需要进一步确认 Agent 能否回答真实代码问题时,可使用受同一 `PINERY_TOKEN`
保护的只读诊断入口。它只查询配置中的第一个仓库,问题最长 2000 字符,最多
8 轮/120 秒,且拒绝可写工作区。不要把此 Token 或端点暴露给未授权调用方。

```bash
curl -X POST https://<worker>.workers.dev/v1/agent/query \
  -H "Authorization: Bearer $PINERY_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"question":"请求如何通过适配器处理?请引用关键文件和符号。"}'
```

响应必须同时满足 `ok=true`、`runnerOk=true`、`toolCalls>0`,答案才可作为
“模型 + Agent + 代码检索工具 + 只读工作区”链路通过的证据。

### 大仓库:R2 只读快照

大型仓库的浅克隆仍可能在 isomorphic-git 解包 pack 时超过 Durable Object
内存。Cloudflare 形态可把**固定 HEAD 的 Git blob**分块流式同步到 R2,
再用可恢复的小批次水合到一个共享 Workspace DO,最后在数据层锁定为
`EROFS`。所有 L0 会话复用该工作区,仓库内容完整保留,Git 凭据不会进入
Worker 或模型上下文。不同聊天的 runner 会话仍分别持久化,并绑定到该不可变
快照 workspace id;L1 可写 worktree 尚未启用,不与这个共享只读快照混用。

快照格式 v2 对每个文件保留 Git mode/oid,内容按 8 MiB 分块并记录
SHA-256。水合端对每块 checksum、文件长度、总文件数与总字节数全部校验,
并恢复 `100755` 执行位;任一对象缺失/损坏时都不会写入 ready marker。

首次创建 bucket 并部署上传入口:

```bash
bunx wrangler r2 bucket create pinery-sources
bunx wrangler deploy
```

生成一个仅用于工作区 RPC / 快照上传的随机 Token,设置快照归属:

```bash
export PINERY_TOKEN="$(openssl rand -hex 32)"
bunx wrangler secret put PINERY_TOKEN < <(printf '%s' "$PINERY_TOKEN")
bunx wrangler secret put PINERY_SOURCE_PREFIX       # repo/<full-commit-sha>
bunx wrangler secret put PINERY_SOURCE_REPO         # 无凭据 HTTPS URL
bunx wrangler secret put PINERY_SOURCE_WORKSPACE    # 例如 s-repo-<short-sha>

PINERY_TOKEN="$PINERY_TOKEN" bun run source:upload -- \
  --endpoint https://<worker>.workers.dev \
  --repo /absolute/path/to/clean/repo \
  --repo-url https://github.com/org/repo.git \
  --prefix repo/<full-commit-sha> \
  --workspace s-repo-<short-sha>
```

脚本会先写 R2,再循环调用分批 hydrate 端点。完成后,把同一 workspace id
写入 `PINERY_SOURCE_READY`,使工作区从此在 VFS 数据层只读:

```bash
bunx wrangler secret put PINERY_SOURCE_READY        # 与 PINERY_SOURCE_WORKSPACE 同值
```

启用后,`repos[].url` 使用无凭据 URL,并把同一 workspace id 写到该
仓库自己的 `repos[].snapshot_id`:

```yaml
repos:
  - name: order-service
    url: https://github.com/org/order-service.git
    snapshot_id: s-order-service-<short-sha>
```

多仓库必须一仓一个 snapshot workspace,重复绑定会拒绝启动。旧的
`workspace.options.shared_snapshot_id` 只兼容单仓库配置。快照按 commit
不可变;更新代码时使用新 prefix + 新 workspace id 重复步骤,最后再切换
该仓库的 `snapshot_id`。

### 本地端到端(无需真实飞书)

```bash
bunx wrangler dev -c wrangler.e2e.jsonc --port 8787
# 另开终端:构造「AES 加密 + 签名」的事件打进来
bun ../../scripts/simulate-lark-event.ts --mode challenge
bun ../../scripts/simulate-lark-event.ts --mode message --text "README 的第一行是什么?"
bun ../../scripts/simulate-lark-event.ts --mode challenge --tamper   # 期望 401
```

`wrangler.e2e.jsonc` 里的配置指向宿主机上的 fake 飞书/模型端点,适合开发迭代与回归。

## 混合形态(本地 adapter + CF 工作区)

Worker 侧同上部署(额外 `bunx wrangler secret put PINERY_TOKEN`,
值 = `openssl rand -hex 32`)。本地 `pinery.yaml`:

```yaml
workspace:
  provider: "@pinery/workspace-cf-computer"
  options:
    endpoint: https://pinery-computer.<你的子域>.workers.dev
    token: ${PINERY_CF_TOKEN}       # 与 wrangler secret 同一个值
    exec_backend: worker-shell
    clone_depth: "1"
```

`.env` 加 `PINERY_CF_TOKEN=<同一密钥>`,照常 `pinery doctor` → `pinery start`。
切回本地工作区只需把 `workspace.provider` 改回 `local`。

## 协议

单端点 `POST /v1/ws/:workspaceId/rpc`,判别联合(`op` 字段),定义在
[`@pinery/workspace-cf-computer/protocol`](../../packages/workspace-cf-computer/src/protocol.ts)
—— 客户端与 Worker 共用同一份类型。执行点收口在 [src/rpc.ts](src/rpc.ts)
(HTTP 路由与全云形态的 DO 直连共用);`gitClone/gitPull` 由 Workspace DO 的
自有 RPC 方法在本地执行(computer 0.1.1 跨 RPC 的 git stub 只有 argv 入口,
typed API 的凭据语义要求本地调用,见架构文档 §7)。

鉴权:`/lark/events` 走飞书验签;`/v1/ws` 走 `Authorization: Bearer <PINERY_TOKEN>`
(常量时间比较)。路径围栏:客户端与 Worker 各一层,越出 `/workspace` 拒绝。
