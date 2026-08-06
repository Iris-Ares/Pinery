/** 飞书开放平台配置清单(PRD §8-Q10:长连接为默认接入,免公网回调) */
export function larkChecklist(endpoint: "feishu" | "lark"): string {
  const console_ =
    endpoint === "lark" ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app";
  return [
    "┌─ 飞书开放平台配置清单(约 10 分钟,需要管理员权限)",
    `│ 1. 打开开发者后台 ${console_} → 创建企业自建应用`,
    "│ 2. 「应用能力」→ 添加「机器人」能力",
    "│ 3. 「权限管理」→ 开通以下权限:",
    "│      - im:message                        (接收与读取消息)",
    "│      - im:message:send_as_bot            (以应用身份发消息)",
    "│      - im:message.p2p_msg:readonly       (读取单聊消息)",
    "│      - im:message.group_at_msg:readonly  (读取群内 @ 机器人消息)",
    "│      - im:message.group_msg:readonly     (可选:话题内追问免 @,需申请)",
    "│ 4. 「事件与回调」→ 订阅方式选「使用长连接接收事件」→ 添加事件:",
    "│      - im.message.receive_v1(接收消息)",
    "│ 5. 「版本管理与发布」→ 创建版本并发布(企业内可用)",
    "│ 6. 把 App ID / App Secret 填入 .env,把机器人拉进目标群",
    "└─ 完成后运行:pinery doctor 校验 → pinery bootstrap 生成术语表 → pinery start",
  ].join("\n");
}
