# Cloudflare 云原生形态(CF Agents + CF Computer + CF AI Gateway)

> 设计与决策记录(2026-08)。CF 形态是 Pinery 首要支持的部署环境之一:
> **整机跑在 Cloudflare 上** —— 事件接入进 Worker,会话与 agent loop 进
> Agents SDK(Durable Objects),工作区用 `@cloudflare/computer`,模型默认走
> AI Gateway。本地 Docker 长连接形态同等支持,两者共用同一套核心代码。
>
> ⚠️ 依赖的 `@cloudflare/computer` 为 0.1.1 **PREVIEW**(官方标注不建议生产),
> CF 形态整体定位为「可用的实验路径」,生产稳态仍以 [Docker 主路径](../deploy/docker/)为准。

## 1. 目标与非目标

| | 本地 Docker 形态 | CF 云形态 |
|---|---|---|
| 事件接入 | 飞书**长连接**(免公网回调) | 飞书 **webhook**(Worker 天生公网 HTTPS) |
| 会话宿主 | 常驻进程 Orchestrator(内存队列) | PineryAgent DO(每 session_key 一实例,单线程天然串行) |
| 工作区 | 本地 checkout / 远程 CF Computer | CF Computer(同 Worker 内 DO 直连) |
| 模型 | 任意(pi-ai 26+ provider) | 同左;推荐经 AI Gateway 改道(形态 B,零代码) |
| 存储 | 本地 SQLite(WAL) | Agent DO SQLite(同一 `Storage` 类与 DDL) |
| 适用 | 内网仓库、大 monorepo、生产稳态 | 海外 Lark、公开 demo、仓库在 GitHub SaaS、免运维 |

非目标(当前显式裁剪,见 §9):golden 跨会话导出、卡片按钮回调、
L1+ 写任务(container 后端)。

## 2. 为什么必须 webhook(长连接在 CF 不可行)

三重否决,全部有官方依据:

1. **出站 WebSocket 不支持 hibernation**:DO 的 `ctx.acceptWebSocket()` 只对
   入站(server-accepted)连接有效;workerd 上游的出站 WS hibernation 是
   open issue([workerd#4864](https://github.com/cloudflare/workerd/issues/4864))。
2. **出站连接保活硬上限 15 分钟**(官方 2026-06-19 changelog),之后回到
   70–140 秒无入站流量即驱逐;驱逐 = isolate 销毁 = 连接与 listener 一起消失。
   alarm 高频自唤醒等于 7×24 持续计费,且运行时每周多次更新必然断连。
3. **飞书长连接协议闭源**:只能经官方 SDK,而该 SDK 依赖 `ws`/`protobufjs`,
   workerd 加载不了;且每应用 ≤50 连接、集群模式随机单点投递,与 Workers
   多实例模型冲突。

因此:CF 形态用飞书「将事件发送至开发者服务器」;长连接保留给本地形态。
事件源是一条**抽象缝**(§4),两种接入共用 `normalizeMessage` 之后的一切。

## 3. 拓扑与事件链路

```
飞书 ── POST /lark/events(AES-256-CBC 加密 envelope + X-Lark-Signature)
  ▼ Worker fetch(无状态路由;challenge 1s 预算不经 DO)
  验签(原始密文体)→ 解密 → normalizeMessage → idFromName(session_key)
  ▼ PineryAgent DO(handleEvent 只做轻活,<100ms 返回,保住 3s ack 预算)
  event_id 幂等(INSERT OR IGNORE)→ 取消 → gate(鉴权/限流/意图)→ 入 pending
  ▼ Fiber(runFiber:keepAlive 保活;驱逐后 onFiberRecovered 收敛错误卡片)
  ack 进度卡 → 每次 @ 动态分页检索群历史 + acquireSession → planSession(绑定校验)
    ├─ DirectWorkspaceClient → PineryWorkspace DO(VFS/grep/exec;git 见 §7)
    ├─ WorkersPiRunner(pi loop 就地跑;LLM fetch → AI Gateway)
    └─ 进度节流 patch(1.5s)→ 分层答案卡 patch → audit/qa/session 落库
```

- **session_key = `p2p:<chat_id>` / `group:<chat_id>` / `thread:<thread_id>`**,
  群聊主消息流是共享 Agent room,显式话题才隔离;同 key 恒同 DO 实例,
  Orchestrator 的内存队列在 DO 形态整段消失(单线程免费提供串行)。
- 群聊每次真正 @ Bot 都从飞书分页读取历史,按当前问题、回复链与邻接消息
  动态筛选;不使用固定“最近 N 条”窗口。用户只直接回复 Bot 时不重复拉取,
  由已经恢复的 runner 会话承接上下文。
- 工作区 id 沿用 `s-<repo>-<hash(sessionKey)>`(会话)/`t-<repo>-<task>`(任务),
  与 Agent 实例事实上 1:1(chat→repo 由配置唯一确定)。
  若配置 `shared_snapshot_id`,L0 物理工作区改为共享不可变快照;runner 会话仍
  分开持久化并绑定该 workspace id。L1 worktree 不复用共享只读快照。
- **Agent 与 Workspace 分离为两个 DO 类**(不用官方单 DO 合体):既有 12-op
  线协议层原样复用;`/v1/ws` HTTP 入口继续服务「本地 adapter + CF 工作区」的
  混合形态;L1 任务工作区与 Agent 生命周期不同构;工作区(可整体重建)与
  会话记忆(sessions/audit/qa)分仓。代价仅一跳 DO-to-DO RPC。
- **调查用 Fiber 不用 Workflows**:官方定位 Fiber 为「agent 自身执行的一部分」
  (keepAlive + SQLite checkpoint + 驱逐恢复);Workflows 留给 L1+ 的独立多步长任务。

## 4. 抽象缝与双实现(「薄抽象」的可审计面)

每条缝恰好两个实现,无插件体系:

| # | 缝 | 接口归属 | 本地实现 | CF 实现 |
|---|---|---|---|---|
| 1 | 事件源 | `(msg)=>void` + `normalizeMessage` 纯函数 | LarkService 长连接 | lark-fetch 验签解密 + `lark-route.ts` |
| 2 | 出站 Messenger | `LarkMessenger`(adapter/lark/messenger) | LarkService(node-sdk) | `WorkersLarkMessenger`(lark-fetch) |
| 3 | 存储驱动 | `SqliteDriver` | bun:sqlite / node:sqlite | `doSqliteDriver`(DO SQLite,同为同步 API) |
| 4 | runner 存储层 | `RunnerResult.sessionRef` | PiRunner(JSONL 文件) | `WorkersPiRunner`(Pi 上下文快照 → Agent DO SQLite,绑定 workspace/worktree) |
| 5 | workspace provider | `WorkspaceProvider` | LocalWorkspaceProvider | CfComputerWorkspaceProvider(client 注入) |
| 6 | workspace 传输 | `WorkspaceRpc { call }` | CfComputerClient(HTTP+Bearer) | `DirectWorkspaceClient`(DO stub 直连) |
| 7 | 配置加载 | `parseConfig(rawYaml, env)` 纯函数 | loadConfig(readFileSync) | `env.PINERY_CONFIG`(wrangler var)+ secrets 插值 |
| 8 | 装配 | 每形态一个 bootstrap | cli/start.ts | `agent.ts` 静态 new(workerd 无动态 import) |

**一行不改直接进 Workers 的代码**:packages/core 全部(secret-filter/answer/
levels/bash-policy/两窄接口/config 纯函数);adapter 的 gateway/sessions/
investigation(调查流水线本体,两形态共用)/lark/cards/lark/events;runner-pi 的
toolset/remote-grep/prompt;workspace-cf-computer 的 protocol/operations;
deploy/cloudflare 的 exec-deadline/repo-marker/search;packages/skills(内置
skills 经构建期内联,磁盘读取失败自动回退,见 §6)。

## 5. 存储模型

Agent DO SQLite 里七张业务表:`sessions` / `runner_sessions` / `bot_messages` /
`audit_log` / `qa_log`(经同一个 `Storage` 类)+ `lark_events`(event_id 幂等,
飞书 at-least-once 重试 15s/5m/1h/6h,行保留 24h)+ `pending_msgs`(调查队列,
fiber 逐条 drain);另有 `_pinery_schema_migrations` 记录增量迁移。

- **runner resume 不是摘要续聊**:`runner_sessions.state_json` 保存 Pi 当前已解析
  对话上下文。恢复前,`sessions` 路由行和 runner 快照都会校验 runner kind、repo、
  workspace handle、dir、branch、readOnly;任一不一致都拒绝旧 resume。快照缺失
  可以安全 fresh,绑定错配不能跨工作区降级恢复。

- **幂等去重放 per-DO 而非全局存储**:同 event_id 的重试 payload 相同 →
  session_key 相同 → 必然路由到同一 DO,per-DO 去重即全局完备。
- **audit/qa 一期只落 DO SQL**:DO SQLite 与 SqliteDriver 同为同步 API,
  Storage 不需异步化;golden 跨会话导出后置二期(fire-and-forget 镜像写 D1
  —— 选 D1 因运营侧有现成查询工具链;sessions 表永不出 Agent DO)。

## 6. 模型与 pi SDK 在 workerd

**AI Gateway(推荐姿势 = 既有「形态 B」,零代码改动)**:

```yaml
model:
  provider: anthropic
  id: claude-sonnet-4-5
  base_url: https://gateway.ai.cloudflare.com/v1/<acct>/<gateway>/anthropic
  headers: { cf-aig-authorization: CF_AIG_HEADER }   # 值可写 Worker secret 名
```

- 用 **provider-native 端点 + BYOK**(密钥存 CF Secrets Store,或直接把
  provider key 配成 Worker secret 透传)。
- **不要用 `env.AI.run` binding**:官方明确其对第三方模型不支持 BYOK
  (强制 Unified Billing + 5% 费用)。Universal Endpoint 已废弃。
- WorkersPiRunner 把 models.json 落盘机制换成 `ModelRegistry.registerProvider()`
  内存注册:内置 provider 改道走 override-only(id 须在 pi-ai 内置目录);
  自定义 provider(自建网关/本地模型)完整注册。headers 值在注册时按 env
  变量名就地解析(不依赖 workerd 的 process.env)。

**pi SDK 无盘化**(S0a spike 实证,两回合对话在 workerd 内跑通):

- pi-agent-core(loop)与 pi-ai(fetch-based)无硬阻塞;AuthStorage/
  ModelRegistry/SessionManager/SettingsManager 全用官方 `inMemory()` 工厂;
  每轮结束把 `SessionManager.buildSessionContext()` 的完整消息上下文写入 DO SQL,
  下一轮重建 SessionManager 后再运行,因此不依赖 workerd 本地文件系统。
- 桶文件的 TUI 死代码进 bundle 但不执行(生产 bundle ≈3.7MB gzip,限额 10MB);
  两个顶层雷用构建配置排掉:`define: import.meta.url` 常量 + mistral→otel
  幽灵依赖 alias 到空 stub(src/otel-stub.ts)。
- **一处最小 patch**(patches/,bun patchedDependencies 固定):pi 的 config.js
  顶层读自身 package.json,无盘环境 try-catch 回退静态元数据。待提上游 PR
  增加原生兼容后移除。
- 内置 skills(*.md)经 `packages/skills/scripts/embed.mjs` 构建期内联为
  embedded.ts(测试锁两者同步),磁盘读取失败自动回退 —— 本地行为不变。

## 7. 安全模型(映射 threat-model.md)

- **入站**:X-Lark-Signature 验签(sha256(timestamp+nonce+encrypt_key+body),
  常量时间比较)→ AES-256-CBC 解密(key=sha256(encrypt_key),IV=密文前 16B,
  WebCrypto)→ 可选 Verification Token 弱校验。CF 形态强制配置 encrypt_key。
- **出站**:与本地形态同一收口 —— agent 没有发消息工具,一切出站经
  LarkMessenger,secret 过滤(gitleaks 子集)在流水线层,两形态共用。
- **工作区围栏**:双层纵深不变(客户端 normalize + Worker 侧 guardPath);
  repo-marker 存 `/.pinery-state/`(围栏外,agent 工具不可达)。
- **git 凭据**:`https://<token>@host` 形式的凭据拆成 Authorization 头传给
  isomorphic-git,**不进 URL**(否则会被写进 `.git/config`,agent 读得到);
  marker 只记脱敏地址。由于 computer 0.1.1 跨 RPC 边界的 git stub 只暴露
  `cli(argv)`(argv 形式凭据只能进 URL),clone/pull 实现为 PineryWorkspace 的
  **DO 自有 RPC 方法**(本地 typed API,headers 语义保留)。
- **模型 key**:Worker secrets → `parseConfig(raw, env)` 插值/`WorkersPiRunner`
  显式注入,不落盘、不进配置 var。
- bash 策略引擎、工具白名单、路径守卫与本地形态完全同一份代码。

## 8. 平台限制对照

| 约束 | 值 | Pinery 对策 |
|---|---|---|
| 飞书 challenge 响应 | 1s | 路由内直接回显,不经 DO |
| 飞书事件 ack | 3s(重试 15s/5m/1h/6h) | handleEvent 只做去重+入列(<100ms) |
| DO 请求期 wall-time | 无上限(caller 在连) | fiber keepAlive 承载分钟级调查 |
| CPU / 请求 | 默认 30s,配至 300s | `limits.cpu_ms=300000`;pi loop 大头是 I/O await |
| waitUntil | 仅 30s | 不用于承载调查 |
| 同时出站连接 | 6 | L0 串行调用远够 |
| 卡片 patch | 5 QPS/条,≤30KB,14 天内 | 1.5s 节流 + truncateAnswer(既有) |
| 消息发送 | 1000/min·50/s;同用户 5 QPS | RateLimiter(per-DO)+ 低频场景 |
| DO SQLite | 10GB/实例 | 会话数据千行级;工作区另库 |
| Computer 工作区 | ~10GB,FUSE 慢 I/O | depth=1 浅克隆;非 monorepo 场景 |
| isomorphic-git | HTTPS-only,无 partial clone | 仓库 URL 校验前置;文档写明 |
| bundle | 10MB gzip(付费) | 当前 ≈3.7MB gzip |

## 9. 分期

- **C1(本次)**:L0 只读调查全链路云化 —— webhook 接入、PineryAgent、
  WorkersPiRunner、DirectWorkspaceClient、DO 存储、e2e 模拟器。
  已验收:challenge 回显 / 坏签名 401 / event_id 幂等 / p2p 全链路
  (真实 clone + pi 两回合 + 分层答案卡)/ 群聊主流共享 room /
  混合形态 `/v1/ws` 回归。
- **C1.1**:群聊每次 @ 动态分页检索相关上下文;runner 完整会话快照进入 DO SQL,
  并与 sandbox/worktree 身份双重绑定后 resume。
- **C2**:golden D1 镜像与导出、
  卡片按钮回调(card.action.trigger 已支持 webhook)、
  status 卡 HEAD 显示(经 exec `git log`)、@cloudflare/vitest-pool-workers
  测试基建(当前 deploy/cloudflare 由 e2e 模拟器覆盖)。
- **C3(承接 sandbox-evaluation.md §4.4 的 S3)**:L1 写任务 —— container
  后端、Sandbox SDK 出站白名单 + 凭证注入、任务工作区生命周期。

## 10. 部署与运维

```bash
cd deploy/cloudflare
bun install

# 1. 配置:pinery.yaml 全文放进 wrangler.jsonc 的 vars.PINERY_CONFIG
#    (secret 一律写 ${VAR} 引用,不要明文进 vars)

# 2. secrets
bunx wrangler secret put LARK_APP_SECRET
bunx wrangler secret put LARK_ENCRYPT_KEY        # 飞书后台「加密策略」的 Encrypt Key
bunx wrangler secret put ANTHROPIC_API_KEY       # 或你的 provider key / CF_AIG_HEADER
bunx wrangler secret put PINERY_TOKEN            # 仅混合形态 /v1/ws 需要

# 3. 部署与自检
bunx wrangler deploy
curl https://pinery-computer.<你的子域>.workers.dev/health
```

- 飞书后台:事件订阅选「**将事件发送至开发者服务器**」,请求网址
  `https://<worker>/lark/events`,订阅 `im.message.receive_v1`,并在
  「加密策略」启用 Encrypt Key(CF 形态必需)。详见
  [feishu-setup.md](feishu-setup.md) 的 webhook 一节。
- 本地端到端(无需真实飞书):`wrangler dev -c wrangler.e2e.jsonc` +
  [scripts/simulate-lark-event.ts](../scripts/simulate-lark-event.ts)
  (构造加密+签名 envelope;`--tamper` 验证 401)。
- 观测:`wrangler tail`;observability 已开启。
- **回滚 = 切回本地长连接形态**:同一份 pinery.yaml 在本地 `pinery start`
  即恢复服务(事件源双模,互不依赖)。
