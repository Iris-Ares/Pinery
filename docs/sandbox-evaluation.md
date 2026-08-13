# 沙箱方案选型(2026-08)

> 决策记录:为 Pinery 的 L1+ 写能力(隔离工作区执行)选择沙箱方案,并确定
> `@cloudflare/computer` 的接入优先级。调研时点 **2026-08-06**——恰逢
> Cloudflare 第二届 Agents Week(08-03 起),多项相关产品状态在本周发生变化,
> 本文对 PRD v0.2 §8-Q7 的结论做出修订。

## 1. 决策问题

PRD 对沙箱层的硬需求(§3.3 工作区模型 / §5 威胁模型):

| # | 需求 | 来源 |
|---|---|---|
| R1 | 任务级隔离:L1 跑脚本 = 任意代码执行,必须容器/VM 级边界 | §5 供应链 |
| R2 | **网络出口白名单**:包管理器 + git 远端之外全部拒绝——「数据出不去,注入的价值就塌了」 | §5 / §8-Q9 |
| R3 | 凭证不入沙箱:deploy key / 模型 key 的爆炸半径控制 | §5 凭证 |
| R4 | git 工作流:clone / worktree 语义 / push 限 `pinery/*` | §3.3 / §3.6 |
| R5 | 会话生命周期:任务态(分钟级,用完即毁)+ 会话态(小时级,封存/唤醒) | §3.4 |
| R6 | 成本:PM 高频问答场景,空闲不付费 | §2.3 |

约束:主部署路径是**国内内网 Docker 自托管**(§8-Q7 结论不变——内网仓库任何
SaaS 沙箱都够不着);云沙箱服务的是海外 Lark 用户、公开 demo、以及仓库本就在
GitHub/GitLab SaaS 上的团队。

## 2. Cloudflare 生态(优先深挖)

### 2.1 背景:Agents Week 2026(本周)改变了前提

PRD v0.2(08-06 定稿)写下「`@cloudflare/computer`(early preview)持续观察不采用」
时依据的是旧状态。本周实际发生:

- **08-03:`@cloudflare/computer` 0.1.x 发布 early preview**(开源,MIT)
- **Sandboxes(Sandbox SDK)GA**,并新增**沙箱出站流量控制**(零信任代理、
  动态策略、凭证注入)——这直接命中 R2/R3
- **Artifacts GA**(为 agent 设计的 git 兼容版本化存储,可开千万级仓库)
- Project Think(下一代 Agents SDK,preview)、Managed OAuth、Agent Memory 等

### 2.2 `@cloudflare/computer`(0.1.1,preview)

**定位**:不是又一个「容器沙箱」,而是 **agent 的持久工作区抽象**——
Durable Object 里一个 SQLite 虚拟文件系统作为事实源,外挂可插拔执行后端。

架构(源自 npm 包 README 与官方 changelog):

```
Durable Object(每 agent/会话一个,天然串行)
 ├─ workspace.fs      SQLite VFS,类 node:fs/promises + grep;跨重启持久;~10GB
 ├─ workspace.git     isomorphic-git 直跑在 VFS 上(clone/add/commit,无需容器)
 ├─ workspace.runtime.exec()  统一执行面,三种后端:
 │    ├─ worker-shell       just-bash,免容器、毫秒级,内置文本命令 + git
 │    ├─ worker-javascript  隔离 JS isolate,结构化输入输出
 │    └─ container          真 Linux(computerd 守护进程,FUSE 挂 VFS,capnweb 同步)
 ├─ R2 只读挂载(EROFS 拒写)· Assets 预签名分享 · Artifacts 会话隔离仓库
 └─ AI SDK tools 内置(read/write/edit/ls/exec)· observability span
```

**与 Pinery 架构的同构度(高得罕见)**:

| Pinery(PRD) | @cloudflare/computer |
|---|---|
| session_key 串行(§3.1) | DO 每会话一实例,天然串行 |
| thread 封存/唤醒(§3.4) | VFS 跨 DO 重启持久,休眠不计费 |
| L0 共享只读 checkout(§3.3) | R2 只读挂载(内核级 EROFS) |
| L0 bash 白名单只读命令 | worker-shell:免容器、只有内置文本命令,天然收窄 |
| L1 跑测试/脚本 | container 后端按需拨号 |
| 工具策略引擎按 level 装配 | 多后端注册 + 按调用路由(`backend: "sandbox"`) |
| 审计日志每工具调用落库 | observer span 每操作一条 |
| 交付物(PR/文件) | Artifacts / Assets |

**限制(诚实清单)**:

- **PREVIEW ONLY**,官方明示不可生产;0.1.x,API 不稳定(`using` 显式 stub
  管理;Worker Loader 通过 `worker_loaders` 绑定启用)
- **不适合大仓库**:容器侧 FS 驻内存 + FUSE 转发,重 I/O(大 `node_modules`
  安装、整仓 clone)明显慢;官方措辞「agent-scale workspaces, not full
  monorepos」;~10GB/workspace 上限
- isomorphic-git ≠ 完整 git(worktree 等高级语义缺失;浅克隆可用)
- 运行在 Cloudflare 上 → 国内可达性与内网仓库两个老问题原样存在(§8-Q7)

### 2.3 Sandbox SDK(`@cloudflare/sandbox` 0.12.x,GA)

「每任务一容器」的经典形态,构建在 Cloudflare Containers 上:

- **exec/文件/后台进程/preview URL/code interpreter**;git 工作流指南齐备
- **出站控制(新 GA,决策级能力)**:`enableInternet = false` +
  `allowedHosts` 白名单 → 默认拒绝;`outboundByHost` handler 跑在 **Worker 侧**,
  转发前注入凭证——沙箱内永远拿不到 secret(R2/R3 同时满足,且强于自建
  Docker egress:自建要自己搭代理/iptables,这里是平台原语)。非 HTTP 端口
  一律不通(DNS 仅限 CF 解析器)
- 生命周期:懒启动、`sleepAfter` 空闲休眠(默认 10 分钟)、休眠不计费;
  备份/恢复指南;S3/R2 桶挂载
- 规格与价:lite(1/16 vCPU/256MiB)→ standard-4(4 vCPU/12GiB);
  active 计费 $0.000020/vCPU-s + $0.0000025/GiB-s。
  **估算:一次 10 分钟 L1 任务(standard-1,0.5 vCPU/4GiB)≈ $0.012;
  一次 30 秒 L0 调查 ≈ $0.001**(R6 满足)

### 2.4 两者分工与组合

- Computer = **工作区层**(持久 FS + 多后端编排 + git + 工具),容器只是它的
  后端之一;Sandbox SDK = **执行层**(成熟的容器沙箱)。
- 合理组合:**会话态用 Computer(VFS 持久 + worker-shell 快查),任务态重执行
  进容器(Sandbox SDK 或 Computer 的 container 后端),出站白名单在容器层收口**。

## 3. 市场横评(新兴方案)

> 调研方法:官方文档/定价页 + 第三方横评(rywalker 2026-06、Northflank 2026-05、
> AgenticWire 2026-07),全部为 2026-05~08 时点信息;「国内内网」为架构推断非实测。
> 市场大盘:每个大云都有了 agent 沙箱(Vercel/CF/AWS/Google 一个季度内到齐),
> snapshot/checkpoint 已成 table stakes。

| 方案 | 隔离 | 形态 | 出口控制 | 快照/唤醒 | TS SDK | 价格锚点 | 国内内网 | 一句话判断 |
|---|---|---|---|---|---|---|---|---|
| **E2B** | Firecracker | SaaS(infra 名义开源) | 域名/IP/CIDR 白名单,最细 | pause/resume(~4s/GiB),无 fork | 一流 | $0.05/vCPU-h + Pro $150/月 | ✗ 自托管仅 GCP/AWS Terraform,不支持普通 Linux | SaaS 里生态最厚 |
| **Vercel Sandbox** | Firecracker | SaaS(仅 iad1) | 三模式防火墙(allowlist/deny-all),可动态切换 | persistent 默认 + snapshot(30 天) | 一流 + 原生 git source(私仓凭证) | Active CPU $0.128/h,I/O 等待不计费 | ✗ 单区+域名受扰 | **SaaS 写代码场景第一名** |
| **Daytona** | 容器(共享内核) | SaaS + AGPL 自托管 | CIDR 白名单(仅 5 条)+ 域名 | stop/start,无内存快照 | 成熟 | ≈$0.05/vCPU-h 纯用量 | △ 纯容器本可内网跑,**但 2026-06 开源仓库停止维护** | 押注自托管 = 接手冻结代码库,回避 |
| **Modal** | gVisor | SaaS | block + CIDR(粗) | memory snapshot 仍 Alpha | Beta(Python-first) | ≈$0.071/vCPU-h(沙箱费率 3x) | ✗ | JS 生态非主场 |
| **Morph Cloud** | 自研 microVM | SaaS | 未见细粒度 | **snapshot 分支(Infinibranch)最强** | 中等 | $0.05/MCU | ✗ | 多路并行探索特化,非本案主需求 |
| **Fly Sprites**(2026-01) | Firecracker | SaaS | DNS 级 allow/deny | 100GB 持久盘 + 300ms checkpoint,闲置零费 | 年轻(2026-01) | $0.07/CPU-h,4h 会话≈$0.45 | ✗ | 「每仓库一台长活小电脑」,与 worktree 心智同构,值得跟踪 |
| **Together Code Sandbox** | 自研 microVM | SaaS(收购过渡态) | 未见细粒度 | memory snapshot 招牌,fork <1s | 成熟 | Nano ≈$0.074/h | △ 过渡期账号双轨 | 平台整合期,观望 |
| **Anthropic srt** | 进程级(Seatbelt/bubblewrap+seccomp) | **开源免费,本地运行** | **默认全拒 + 代理强制白名单(绕过即断网)**;dotfiles/.git/hooks 写保护 | 不适用(包裹现有进程) | CLI/配置型 | $0 | **✓ 完全可用** | **主路径 Docker 上的正解加固层** |
| **microsandbox** | libkrun microVM | 开源自托管(云 beta) | 有,粒度待实测 | snapshot/fork 已落地 | 一般 | 本地免费 | △ **强依赖 KVM**(虚机无嵌套虚拟化即出局) | 隔离最强的自托管,受宿主条件制约 |
| **OpenSandbox(阿里,2026-03)** | 容器/gVisor/Kata/FC 可配 | **Apache 2.0,Docker/K8s 双形态** | per-sandbox 网络策略 | 有(非内存级) | 多语言(JS 含) | 免费自托管 | **✓ 国内背景,K8s 原生** | 主路径将来平台化的头号候选(项目仅 5 个月,成熟度待验) |

其他:AWS AgentCore Code Interpreter(托管 microVM,2026-03 被披露 DNS 外带漏洞后修复;AWS 中国区无 Bedrock)、GKE Agent Sandbox(gVisor,preview,Python 为主)、Runloop / Blaxel / Beam / Northflank(BYOC Kata/gVisor,$0.0167/vCPU-h 全场最低)。

**按 Pinery 四硬条件(自托管可行 + TS SDK + 出口白名单 + 快照唤醒)筛选:四项全满足的一家都没有。** 筛选结论(优先级按 4.1 决策):

1. **主路径:Docker + git worktree + 自建 egress 加固**——不引入沙箱平台;
   出口白名单以 compose internal 网络 + 自建代理实现,快照/唤醒由 worktree
   持久态与容器 stop/start 承担。
2. 主路径规模化(多租户/K8s)时:评估 **OpenSandbox**。
3. 云路径对照组(如需第三方 SaaS 验证):**Vercel Sandbox**(git source 原生 +
   egress 三模式)> E2B;Fly Sprites 跟踪观察。
4. 留档不进优先级:srt(进程级出口白名单 + dotfiles 写保护,免费开源;
   若将来主路径需要容器内第二层网络围栏,可复评)。

## 4. 结论与 Pinery 集成设计

### 4.1 结论(三句话)

> **决策(2026-08-06,项目负责人)**:优先级定为 **CF 云路径 + 自建 Docker
> 加固**;srt(@anthropic-ai/sandbox-runtime)不进优先级,仅留档
> (事实备注:srt 本身为免费开源本地工具,不涉及 Anthropic 付费服务;
> 留档供将来复评)。

1. **主路径 = Docker + git worktree + 自建加固**:出口白名单用自建 egress
   代理实现(compose internal 网络收口,仅代理可出网,域名白名单默认拒绝),
   叠加容器安全参数(cap_drop/no-new-privileges/资源限额/只读挂载)。
   不为内网主路径引入任何沙箱平台(四硬条件全满足的产品不存在,§3)。
2. **云路径升格,CF 优先**:Sandboxes GA + 出站控制 GA + Artifacts GA 之后,
   PRD「CF 实验路径」的两块最大短板(网络白名单、凭证注入)已由平台原语补齐;
   `@cloudflare/computer` 与 Pinery 会话模型高度同构,**作为第一个云沙箱后端接入**,
   但因 preview 状态只进实验通道,pin 版本跟进;云路径的生产件是 GA 的
   Sandbox SDK,Computer 是其上的工作区抽象实验件。纯论今天的成熟度,
   Vercel Sandbox/E2B 更「能上生产」,但不具备 CF 的会话同构与生态协同,
   保留为对照组。
3. **接口先行**:沙箱选型进架构的方式与 AgentRunner 同构——一个窄接口,
   多个可替换实现(PRD §8-Q1 哲学的第二次应用)。

### 4.2 集成设计:WorkspaceProvider 窄接口

现状:workspace 概念已存在(`RunnerWorkspace { repo, dir, readOnly, branch }`),
L0 共享 checkout 与 L1 worktree 由 adapter/runner 本地实现。引入:

```ts
// @pinery/core(与 AgentRunner 并列的第二个窄接口)
interface WorkspaceProvider {
  readonly kind: string;                        // "local" | "cf-computer" | ...
  /** 会话工作区(L0 调查):可复用、可封存唤醒 */
  acquireSession(repo: RepoConfig, sessionKey: string): Promise<ProvidedWorkspace>;
  /** 任务工作区(L1+):隔离、用完即毁,失败保留 */
  acquireTask(repo: RepoConfig, taskId: string): Promise<ProvidedWorkspace>;
  release(ws: ProvidedWorkspace, opts?: { keep?: boolean }): Promise<void>;
}

interface ProvidedWorkspace extends RunnerWorkspace {
  /** 存在则 runner 用它替换 pi 工具的本地实现(远程委托) */
  operations?: ToolOperationsBundle;   // read/write/edit/grep/find/ls/bash
}
```

**关键联结点(已验证的代码事实)**:pi 的七个内置工具全部暴露 `Operations`
注入口(`ReadOperations.readFile`、`BashOperations.exec`、`GrepOperations`、
`FindOperations.glob`…官方注释明示「Override these to delegate execution to
remote systems」),而 `@cloudflare/computer` 的 `workspace.fs`(readFile/
writeFile/mkdir/readdir/rm/grep)与 `runtime.exec()` 恰好一一对应。因此:

- **runner-pi 不需要为云沙箱重写**——`buildToolset()` 接受 operations 参数,
  本地时用默认实现,云上时委托 Computer;
- **策略引擎位置不变**:bash 分级策略、路径围栏仍在 adapter 进程内先行判定
  (spawnHook 在 exec 之前),沙箱只是执行面——纵深防御变成
  「进程内策略 → 平台出站白名单 → 容器隔离」三层;
- **模型 key 永不进沙箱**:pi 会话跑在 adapter 进程,沙箱只见文件与命令
  (R3 的最强形态)。

### 4.3 CF Computer 后端映射(runner 侧 `workspace-cf-computer`)

| Pinery 概念 | 实现 |
|---|---|
| L0 会话工作区 | DO(以 session_key 命名)+ VFS;repo 经 R2 只读挂载或浅克隆入 VFS |
| L0 检索执行 | worker-shell 后端(免容器,毫秒级;rg/cat 类内置命令) |
| L1 任务工作区 | 同 DO 下 container 后端按需拨号,或独立 Sandbox SDK 容器 |
| 网络白名单(R2) | 容器 `enableInternet=false` + `allowedHosts=[git 远端, registry]` |
| 凭证注入(R3) | `outboundByHost` Worker 侧注入 deploy token,沙箱无凭证 |
| push 限 `pinery/*`(R4) | 注入凭证的代理层按 ref 过滤 + Git 平台保护分支兜底 |
| 封存/唤醒(R5) | DO 休眠即封存(不计费),消息到达自动唤醒,VFS 原状 |
| 审计 | observer span → 回传 adapter 审计表 |
| 交付物 | Artifacts 会话隔离仓库 / Assets 预签名 URL |

已知折衷:大仓库(FUSE + 10GB + isomorphic-git)——对策为**浅克隆 +
sparse-checkout 白名单目录**(Computer 的 `clone({ paths })` 原生支持),
并把重 I/O(依赖安装)留在容器原生盘的非 VFS 路径;超出该包线的仓库继续
走自托管主路径。

**实现中发现的两个硬约束(已在代码与文档中处理)**:

1. **pi 的 grep 不能远程化**:pi 内置 grep 无条件在本地 spawn ripgrep,注入的
   `GrepOperations` 只用于取上下文行——远程工作区上它会去搜宿主机目录。
   处理:远程后端提供 `grepSearch` 时,`buildToolset` 整体替换为 Pinery 自建的
   grep 工具,搜索走 Computer 的服务端 VFS grep(顺带只回传命中行,不搬运仓库)。
   其余六个工具(read/write/edit/find/ls/bash)完整走 Operations,无需改造。
2. **CF 路径只支持 HTTPS 仓库**:Computer 的 git 是 isomorphic-git,无 SSH 传输。
   provider 在 clone 前就地校验并给出可操作错误(私仓用 `https://<token>@host/...`)。

### 4.4 分期落地

| 阶段 | 内容 | 前置 |
|---|---|---|
| S1(现在) | `WorkspaceProvider` 接口进 core;本地实现(现状代码重组,行为不变);`buildToolset` 打开 operations 注入口 | 无 |
| S1.5(现在,主路径) | 自建 Docker 加固:egress 白名单代理(internal 网络收口,域名白名单默认拒绝)+ 容器安全参数(cap_drop/no-new-privileges/pids/mem 限额) | 无 |
| ~~S2~~ ✅ 已完成 | `@pinery/workspace-cf-computer`(线协议 + 客户端 + 远程 operations + provider)与 deploy/cloudflare Worker(DO + Computer 工作区);L0 全链路端到端测试通过 | — |
| S3(M4) | L1 云路径:container 后端 + 出站白名单 + 凭证注入代理;20 题盲评在云路径复跑 | Sandbox SDK 出站控制实测 |

> 整机 CF 形态(飞书 webhook + Agents SDK + Fiber + AI Gateway)的设计与实施见
> [cloudflare-architecture.md](cloudflare-architecture.md) —— 其分期 C1 已交付
> L0 云闭环,C3 承接本表 S3。本文保持为工作区层的选型决策记录。

### 4.5 对 PRD 的修订建议(§8-Q7 增补)

> ⚡修订(2026-08-06):CF 路径维持「不服务国内内网核心用户」的判断,但其
> 工程状态已从「观察」转为「优先接入的云后端」——Sandboxes/出站控制/Artifacts
> GA 补齐了威胁模型两块短板,`@cloudflare/computer` 与会话模型同构使接入成本
> 一次抽象即可。风险敞口控制在:preview 版本 pin 死、窄接口隔离、
> 主路径永远可独立运行。同时主路径威胁模型增补 srt 进程级出口白名单层。

---

## 附:主要信息源

- Cloudflare:`@cloudflare/computer` [npm 0.1.1 README](https://www.npmjs.com/package/@cloudflare/computer)(2026-08-03)· [官方 changelog](https://developers.cloudflare.com/changelog/post/2026-08-03-cloudflare-computer/) · [Agents Week 总览](https://blog.cloudflare.com/agents-week-in-review/) · [Sandbox 出站控制](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/) · [Containers 定价](https://developers.cloudflare.com/containers/pricing/)
- E2B:[定价](https://e2b.dev/pricing) · [持久化](https://e2b.dev/docs/sandbox/persistence) · [出网控制](https://e2b.dev/docs/sandbox/internet-access) · [infra 自托管](https://github.com/e2b-dev/infra)
- Vercel Sandbox:[docs](https://vercel.com/docs/sandbox)(2026-08-04)· [定价](https://vercel.com/docs/sandbox/pricing) · [egress 防火墙 changelog](https://vercel.com/changelog/advanced-egress-firewall-filtering-for-vercel-sandbox)
- Daytona:[定价](https://www.daytona.io/pricing) · [网络限制](https://www.daytona.io/docs/en/network-limits/)(开源仓库 2026-06 起停止维护)
- Modal:[定价](https://modal.com/pricing) · [JS/Go SDK](https://modal.com/blog/sdk-javascript-go)
- Fly Sprites:[产品页](https://fly.io/sprites) · [Simon Willison 评测](https://simonwillison.net/2026/Jan/9/sprites-dev/)(2026-01-09)
- Anthropic srt:[github.com/anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- microsandbox:[repo](https://github.com/zerocore-ai/microsandbox)(v0.6.8,2026-07-29)
- OpenSandbox(阿里):[repo](https://github.com/opensandbox-group/OpenSandbox)(2026-03 开源)· [Northflank 解读](https://northflank.com/blog/alibaba-opensandbox-architecture-use-cases)
- 横评:[rywalker AI Agent Sandboxes](https://rywalker.com/research/ai-agent-sandboxes)(2026-06-11)· [Northflank 定价对比](https://northflank.com/blog/ai-sandbox-pricing)(2026-05-05)· [AgenticWire E2B vs Daytona](https://www.agenticwire.news/article/e2b-vs-daytona)(2026-07-01)
