import { cardJson, type Card } from "@pinery/adapter/lark/cards";
import { extractText } from "@pinery/adapter/lark/events";
import type {
	ConversationMessagePage,
	LarkMessenger,
} from "@pinery/adapter/lark/messenger";
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

	async listMessagesPage(
		container: { type: "chat" | "thread"; id: string },
		options: { pageSize: number; pageToken?: string },
	): Promise<ConversationMessagePage> {
		const page = await this.client.listMessagesPage(container, options);
		const messages: ConversationMessagePage["messages"] = [];
		for (const item of page.items) {
			if (item.deleted || item.sender?.sender_type !== "user") continue;
			const text = extractText(item.msg_type ?? "", item.body?.content ?? "");
			if (!item.message_id || !item.sender?.id || text === undefined) continue;
			messages.push({
				messageId: item.message_id,
				senderId: item.sender.id,
				...(item.sender.sender_name
					? { senderName: item.sender.sender_name }
					: {}),
				text,
				...(item.create_time ? { createTime: item.create_time } : {}),
				...(item.parent_id ? { parentId: item.parent_id } : {}),
				...(item.root_id ? { rootId: item.root_id } : {}),
				...(item.thread_id ? { threadId: item.thread_id } : {}),
			});
		}
		return {
			messages,
			hasMore: page.hasMore,
			...(page.pageToken ? { pageToken: page.pageToken } : {}),
		};
	}
}
