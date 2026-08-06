# Cloudflare 云路径(实验)

把 Pinery 的**工作区层**放到 Cloudflare:每个会话/任务对应一个 Durable Object,
DO 里是 [`@cloudflare/computer`](https://www.npmjs.com/package/@cloudflare/computer)
的 SQLite 虚拟文件系统 + 可插拔执行后端。adapter 仍在你自己的机器上跑
(飞书长连接、鉴权、策略引擎、模型 key 都不出本地),只把「文件与命令」委托到云端。

```
adapter(本地 Bun/Node 进程)
   │  POST /v1/ws/:workspaceId/rpc   Bearer <PINERY_TOKEN>
   ▼
Worker(本目录)→ DO stub → Workspace(VFS + worker-shell / container 后端)
```

选型依据与取舍见 [`docs/sandbox-evaluation.md`](../../docs/sandbox-evaluation.md)。

## 适用与不适用

**适合**:海外 Lark 用户、公开 demo、仓库本就在 GitHub/GitLab SaaS 上的团队。

**不适合**(仍走 [Docker 主路径](../docker/)):国内网络环境、内网仓库、大型 monorepo。

## 已知限制(先读这段)

| 限制 | 说明 |
|---|---|
| **preview** | `@cloudflare/computer@0.1.1` 官方标注 PREVIEW,不建议生产;本项目已 pin 版本 |
| **HTTPS-only 仓库** | Computer 的 git 是 isomorphic-git,**无 SSH 传输**。`repos[].url` 必须是 `https://`;私有仓库用 `https://<token>@host/org/repo.git` |
| **仓库体积** | 容器侧 FS 驻内存 + FUSE,官方定位 "agent-scale workspaces, not full monorepos",~10GB/工作区上限。默认浅克隆(depth=1) |
| **执行后端** | 默认 `worker-shell`(免容器、毫秒级、内置文本命令),适合 L0 只读调查;L1 写任务需要真 Linux 时另配 container 后端 |
| **grep 走服务端** | pi 内置 grep 会本地 spawn ripgrep,远程工作区上无效;Pinery 已自动替换为经 Computer VFS 的服务端搜索 |

## 部署

```bash
cd deploy/cloudflare
bun install

# 1. 生成一个强随机共享密钥,两端各配一次
openssl rand -hex 32

# 2. 写入 Worker 侧
bunx wrangler secret put PINERY_TOKEN

# 3. 部署
bunx wrangler deploy
```

部署后拿到 `https://pinery-computer.<你的子域>.workers.dev`,自检:

```bash
curl -s https://pinery-computer.<你的子域>.workers.dev/health
```

## 接到 Pinery

`pinery.yaml`:

```yaml
repos:
  - name: order-service
    url: https://github.com/org/order.git   # 必须 HTTPS(见上文限制)
    chats: [oc_xxx]

workspace:
  provider: "@pinery/workspace-cf-computer"
  options:
    endpoint: https://pinery-computer.<你的子域>.workers.dev
    token: ${PINERY_CF_TOKEN}       # 与 wrangler secret 同一个值
    exec_backend: worker-shell      # 或 container(需先配 container 后端)
    clone_depth: "1"
```

`.env` 加 `PINERY_CF_TOKEN=<同一个密钥>`,然后照常 `pinery doctor` → `pinery start`。

切回本地主路径只需把 `workspace.provider` 改回 `local`。

## L1 写任务(container 后端)

`worker-shell` 没有真实 Linux 用户态(装不了依赖、跑不了测试框架)。要跑 L1 任务:

1. 在 `wrangler.jsonc` 取消 `containers` 段注释,提供运行 `computerd` 的镜像
   (见 `@cloudflare/computer` 的 `docs/07_injected_service.md`);
2. `workspace.options.exec_backend` 改为 `container`;
3. 出站控制用 Sandbox SDK 的 `allowedHosts` + `outboundByHost` 凭证注入
   (威胁模型 §5.5 的云端对应物)。

## 协议

单端点 `POST /v1/ws/:workspaceId/rpc`,请求体是判别联合(`op` 字段),
定义在 [`@pinery/workspace-cf-computer/protocol`](../../packages/workspace-cf-computer/src/protocol.ts)——
客户端与 Worker 共用同一份类型,避免两端漂移。

鉴权:`Authorization: Bearer <PINERY_TOKEN>`(常量时间比较)。
路径围栏:客户端与 Worker **各做一次**归一化,越出 `/workspace` 直接拒绝。
