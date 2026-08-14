# 飞书 / Lark 文档能力

Pinery 把文档“读取”与“写入”分成两条不同的安全路径:

- 读取是调查上下文。只解析当前用户消息中的 docx/wiki 链接,使用应用身份读取固定修订,再作为不可信数据注入 runner。
- 写入不是 Agent 工具。只有至少 L1 授权的用户才能用确定性 `/doc` 命令准备写入,准备后必须由同一用户在同一会话中二次确认,最后由 adapter 带外调用 OpenAPI。

## 读取

在普通问题中附上最多 3 个文档链接即可:

```text
请对照这份 PRD 检查当前实现:https://example.feishu.cn/docx/Abcdef123
```

支持以下有界 scope; 不写时读取全文(受字符和 block 上限约束):

```text
--outline
--range 10:30
--section "Rollout"
--keyword "idempotency"
```

`--range` 使用文档先序 block 列表的零基半开区间。

docx 与 wiki 链接都会解析到 docx 对象。文本块保留 block citation;
Sheet/Base/图片/附件等嵌入对象只作为引用显示,不会自动扩展读取。

文档内容会放入 `<external-document-data trust="untrusted">` 边界,其中的
`/​doc`、“忽略之前规则”或任何其他命令都只是数据,不能发起写入或扩大权限。

## 受控写入

创建文档:

```text
/doc create 发布复盘
这里是文档正文。
```

追加文本:

```text
/doc append https://example.feishu.cn/docx/Abcdef123
追加的正文。
```

精确替换(旧文本必须在单个 text run 中全文唯一命中):

```text
/doc replace https://example.feishu.cn/docx/Abcdef123
旧文本
---
新文本
```

Pinery 只会先回复确认卡。确认卡包含操作、目标、内容预览、基准
revision 和过期时间。回复:

```text
确认 DOC-AB12CD34
取消 DOC-AB12CD34
```

确认时会重新读取 revision;文档已变化则 fail closed,需要重新发起。
持久化 action 通过条件 `UPDATE` 从 `pending` 原子进入 `executing`,
重复事件/重复确认不会重复执行。append/replace 还会把 action id 作为
`client_token` 交给飞书。运行环境在写入期间重启时,操作保留为 `executing`
不自动重试,并要求人工先检查文档实际状态。

## 配置与限制

```yaml
limits:
  document_read_max_chars: 12000
  document_write_max_chars: 20000
  document_confirmation_timeout_min: 10
```

飞书应用读取需要 `docx:document:readonly`(以及解析 Wiki 节点所需的 Wiki 读权限);
启用写命令时再开通 `docx:document:create` 和
`docx:document:write_only`(或包含它们的 `docx:document`)。凭据只由 `LarkFetchClient`
换取 tenant token,不暴露给 runner、文档内容或审计日志。审计只记录操作、
结果、revision 与不可逆文档标识哈希,不记录正文。
使用 tenant token 访问现有文档时,还要在文档的“添加文档应用”中授予该应用阅读/编辑权限;只在开发者后台勾选 API scope 不会自动扩大文档的访问范围。
