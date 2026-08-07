import type { Card } from "./cards.js";

/**
 * 出站通道抽象(回复收口的唯一形状,PRD §3.1):
 * - 本地形态由 LarkService(官方 node-sdk)实现;
 * - CF 形态由 WorkersLarkMessenger(lark-fetch 裸 fetch)实现;
 * - 测试注入 fake。
 * agent 没有发消息的工具 —— 一切出站经此接口,secret 过滤在调用方完成。
 */
export interface LarkMessenger {
  sendCard(chatId: string, card: Card): Promise<string | undefined>;
  replyCard(messageId: string, card: Card, inThread: boolean): Promise<string | undefined>;
  patchCard(messageId: string, card: Card): Promise<void>;
}
