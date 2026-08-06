import * as Lark from "@larksuiteoapi/node-sdk";
import type { PineryConfig } from "@pinery/core";
import { cardJson, type Card } from "./cards.js";
import { normalizeMessage, type IncomingMessage, type RawReceiveEvent } from "./events.js";

/**
 * 飞书服务封装:长连接事件接入(PRD §8-Q10:默认 WebSocket,免公网回调)
 * 与卡片收发。回复通道收口于此(PRD §3.1 原则)。
 */

export interface BotIdentity {
  openId?: string;
  name?: string;
}

export class LarkService {
  readonly client: Lark.Client;
  private ws?: Lark.WSClient;
  private readonly base: { appId: string; appSecret: string; domain: Lark.Domain };

  constructor(cfg: PineryConfig["lark"]) {
    this.base = {
      appId: cfg.app_id,
      appSecret: cfg.app_secret,
      domain: cfg.endpoint === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
    };
    this.client = new Lark.Client({ ...this.base, loggerLevel: Lark.LoggerLevel.error });
  }

  /** 应用机器人身份(用于识别 @ 提及与防回环) */
  async fetchBotIdentity(): Promise<BotIdentity> {
    try {
      const res = await this.client.request<{
        code: number;
        bot?: { app_name?: string; open_id?: string };
      }>({ method: "GET", url: "/open-apis/bot/v3/info" });
      return { openId: res.bot?.open_id, name: res.bot?.app_name };
    } catch {
      return {};
    }
  }

  /** 启动长连接,逐条归一化后交给 handler(内部串行语义由编排层负责) */
  async listen(bot: BotIdentity, handler: (msg: IncomingMessage) => void): Promise<void> {
    this.ws = new Lark.WSClient({ ...this.base, loggerLevel: Lark.LoggerLevel.info });
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data) => {
        const msg = normalizeMessage(data as RawReceiveEvent, bot);
        if (msg) handler(msg);
        return Promise.resolve();
      },
    });
    await this.ws.start({ eventDispatcher: dispatcher });
  }

  /** 发送卡片;群聊场景用 replyCard 收敛到话题 */
  async sendCard(chatId: string, card: Card): Promise<string | undefined> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content: cardJson(card) },
    });
    return res.data?.message_id;
  }

  /** 回复消息(inThread=true 时开话题/回话题,PRD §3.5 一切收敛到话题) */
  async replyCard(messageId: string, card: Card, inThread: boolean): Promise<string | undefined> {
    const res = await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: cardJson(card),
        reply_in_thread: inThread,
      },
    });
    return res.data?.message_id;
  }

  /** 更新已发出的卡片(进度流 → 最终答案共用一张卡) */
  async patchCard(messageId: string, card: Card): Promise<void> {
    await this.client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: cardJson(card) },
    });
  }
}
