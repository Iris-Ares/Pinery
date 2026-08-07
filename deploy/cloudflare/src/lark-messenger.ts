import { cardJson, type Card } from "@pinery/adapter/lark/cards";
import type { LarkMessenger } from "@pinery/adapter/lark/messenger";
import type { LarkFetchClient } from "@pinery/lark-fetch";

/**
 * LarkMessenger 的 CF 实现:lark-fetch 裸 fetch 客户端 + 卡片序列化。
 * 与本地 LarkService 行为对齐(同四个 REST 接口),orchestration 层零感知。
 */
export class WorkersLarkMessenger implements LarkMessenger {
  constructor(private readonly client: LarkFetchClient) {}

  sendCard(chatId: string, card: Card): Promise<string | undefined> {
    return this.client.sendCard(chatId, cardJson(card));
  }

  replyCard(messageId: string, card: Card, inThread: boolean): Promise<string | undefined> {
    return this.client.replyCard(messageId, cardJson(card), inThread);
  }

  async patchCard(messageId: string, card: Card): Promise<void> {
    await this.client.patchCard(messageId, cardJson(card));
  }
}
