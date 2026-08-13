# 飞书开放平台配置教程

> 飞书后台配置是接入 Pinery 最大的摩擦源(PRD §8-Q10)。本页把每一步说清;
> 全程约 10 分钟,需要企业管理员或有创建应用权限的账号。
> Pinery 默认使用**长连接模式**接收事件——不需要公网回调地址、不需要内网穿透、不需要证书。

## 1. 创建应用

1. 打开开发者后台:飞书 [open.feishu.cn/app](https://open.feishu.cn/app) / Lark [open.larksuite.com/app](https://open.larksuite.com/app)
2. 「创建企业自建应用」,名称建议就叫 `Pinery`(或团队习惯的名字),头像随意
3. 进入应用详情页 →「凭证与基础信息」,记下 **App ID** 和 **App Secret**
   - App ID 填进 `pinery.yaml` 的 `lark.app_id`
   - App Secret 填进 `.env` 的 `LARK_APP_SECRET`(不要写进 yaml)

## 2. 开通机器人能力

「应用能力」→「添加应用能力」→ 勾选**机器人**。

## 3. 申请权限

「权限管理」→ 搜索并开通:

| 权限 | 用途 | 必需 |
|---|---|---|
| `im:message` | 接收消息事件 | ✅ |
| `im:message:send_as_bot` | 以应用身份发送/更新卡片 | ✅ |
| `im:message.p2p_msg:readonly` | 读取用户发给机器人的单聊消息 | ✅ |
| `im:message.group_at_msg:readonly` | 读取群内 @ 机器人的消息 | ✅(群聊场景) |
| `im:message.group_msg` | 每次 @ 时分页读取群历史并动态检索相关上下文 | 复杂群聊体验必需(旧版控制台可能显示为 `group_msg:readonly`) |

> 不开群组全部消息权限时仍可被 @ 后回答,但无法在每次 @ 时动态检索此前群聊背景;
> 后续追问需要再次 @,或直接引用回复 Bot 的上一张卡片。

## 4. 事件订阅(按部署形态二选一)

「事件与回调」→「事件配置」,**订阅方式取决于 Pinery 跑在哪**:

### 4A. 本地 / Docker 形态 → 长连接

1. 订阅方式选择 **「使用长连接接收事件」**(免公网回调地址、免内网穿透)
2. 「添加事件」→ 搜索并添加:**接收消息 `im.message.receive_v1`**

### 4B. Cloudflare 云形态 → webhook

1. 先完成 Worker 部署(见 [deploy/cloudflare/README.md](../deploy/cloudflare/README.md)),
   拿到 `https://<worker>.workers.dev`
2. 「加密策略」→ 生成并启用 **Encrypt Key**(CF 形态必需:webhook 验签与
   事件解密都依赖它),填进 Worker secret `LARK_ENCRYPT_KEY`;
   Verification Token 可选(配了则 Pinery 会做二次校验)
3. 订阅方式选择 **「将事件发送至开发者服务器」**,请求网址填
   `https://<worker>.workers.dev/lark/events` —— 保存时飞书会发 challenge
   验证,Worker 部署且 secrets 配好后即自动通过
4. 「添加事件」→ **接收消息 `im.message.receive_v1`**

## 5. 发布应用

「版本管理与发布」→「创建版本」→ 填版本号(如 1.0.0)→ 提交发布。
企业自建应用发布后企业内即可用(部分企业需要管理员在管理后台审核通过)。

## 6. 把机器人拉进群

在目标群 → 设置 → 群机器人 → 添加机器人 → 选择 Pinery。

Pinery 默认不要求绑定群聊:单项目直接使用;多项目优先按问题中的项目名/别名判断,
无法确定时会主动给出项目选择卡片。

如果希望某个群默认指向特定项目,可选获取群的 chat_id,填进
`pinery.yaml` 的 `repos[].chats`(它只是路由提示,不是访问白名单):

- 方式 A:先不填 chats 启动 Pinery,在群里 @ 它,从事件日志查看 chat_id(`oc_` 开头)
- 方式 B:用[开放平台 API 调试台](https://open.feishu.cn/api-explorer)调 `im.v1.chat.list`

## 7. 校验

```bash
pinery doctor --online
```

看到 `✓ 飞书凭据(bot 信息)` 即接入成功。之后:

```bash
pinery bootstrap   # agent 自扫仓库生成术语表草稿(需要模型 key)
pinery start       # 启动长连接服务
```

## 常见问题

- **doctor 提示凭据失败**:检查 App Secret 是否复制完整;应用是否已发布;网络能否到达 open.feishu.cn。
- **群里 @ 没反应**:确认 ③ 中群消息权限已开通、④ 中事件已添加、应用已发布新版本,并确认 Bot 已加入该群。
- **单聊没反应**:确认 `im:message.p2p_msg:readonly` 已开通;查看 `pinery start` 日志。
- **海外 Lark**:`pinery.yaml` 中 `lark.endpoint: lark`。
