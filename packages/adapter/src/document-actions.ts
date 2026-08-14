import {
  LarkApiError,
  parseLarkDocumentRef,
  type LarkDocumentService,
  type LarkDomain,
} from "@pinery/lark-fetch";
import { filterSecrets } from "@pinery/core";
import { documentConfirmationCard, documentResultCard, type Card } from "./lark/cards.js";
import type { IncomingMessage } from "./lark/events.js";
import { sessionKeyFor } from "./sessions.js";
import type { DocumentActionRow, Storage } from "./storage.js";

export type DocumentInteraction =
  | { kind: "create"; title: string; content: string }
  | { kind: "append"; target: string; content: string }
  | { kind: "replace"; target: string; oldText: string; newText: string }
  | { kind: "confirm"; code: string }
  | { kind: "cancel"; code: string };

const ACTION_CODE_RE = /^(?:DOC-)?([A-Z0-9]{8})$/i;

export function parseDocumentInteraction(text: string): DocumentInteraction | undefined {
  const normalized = text.trim();
  const confirmation = normalized.match(/^(?:确认|confirm)\s+([^\s]+)$/i);
  if (confirmation) {
    const code = normalizeCode(confirmation[1]!);
    return code ? { kind: "confirm", code } : undefined;
  }
  const cancellation = normalized.match(/^(?:取消|cancel)\s+([^\s]+)$/i);
  if (cancellation) {
    const code = normalizeCode(cancellation[1]!);
    return code ? { kind: "cancel", code } : undefined;
  }

  const lines = normalized.split(/\r?\n/);
  const header = lines.shift() ?? "";
  const command = header.match(/^\/doc\s+(create|append|replace)\s+(.+)$/i);
  if (!command) return undefined;
  const operation = command[1]!.toLowerCase();
  const argument = command[2]!.trim();
  const body = lines.join("\n").trim();
  if (operation === "create") return { kind: "create", title: argument, content: body };
  if (operation === "append") return { kind: "append", target: argument, content: body };
  const separator = lines.findIndex((line) => line.trim() === "---");
  if (separator < 0) return undefined;
  const oldText = lines.slice(0, separator).join("\n").trim();
  const newText = lines.slice(separator + 1).join("\n").trim();
  return { kind: "replace", target: argument, oldText, newText };
}

function normalizeCode(value: string): string | undefined {
  const match = value.match(ACTION_CODE_RE);
  return match ? `DOC-${match[1]!.toUpperCase()}` : undefined;
}

export class DocumentActionController {
  constructor(
    private readonly deps: {
      storage: Storage;
      documents: LarkDocumentService;
      domain?: LarkDomain;
      maxWriteChars: number;
      confirmationTimeoutMin: number;
      reply: (card: Card) => Promise<unknown>;
      log?: (line: string) => void;
    },
  ) {}

  async handle(msg: IncomingMessage, interaction: DocumentInteraction): Promise<void> {
    try {
      this.deps.storage.expireDocumentActions();
      if (interaction.kind === "confirm" || interaction.kind === "cancel") {
        await this.finish(msg, interaction.kind, interaction.code);
        return;
      }
      await this.prepare(msg, interaction);
    } catch (error) {
      const detail = filterSecrets(error instanceof Error ? error.message : String(error)).text;
      this.deps.log?.(`[document] request failed:${detail}`);
      await this.deps.reply(
        documentResultCard({ ok: false, title: "文档操作未执行", detail }),
      );
    }
  }

  private async prepare(
    msg: IncomingMessage,
    input: Exclude<DocumentInteraction, { kind: "confirm" | "cancel" }>,
  ): Promise<void> {
    const contentLength =
      input.kind === "replace" ? input.oldText.length + input.newText.length : input.content.length;
    if (contentLength < 1 || contentLength > this.deps.maxWriteChars) {
      await this.deps.reply(
        documentResultCard({
          ok: false,
          title: "文档写入命令无效",
          detail: `内容长度必须在 1..${this.deps.maxWriteChars} 字符之间。`,
        }),
      );
      return;
    }

    const id = crypto.randomUUID();
    const code = `DOC-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    let targetToken: string | undefined;
    let targetUrl: string | undefined;
    let targetLabel: string;
    let baseRevision = 0;
    if (input.kind === "create") {
      targetLabel = `新文档「${input.title}」`;
    } else {
      const ref = parseLarkDocumentRef(input.target, this.deps.domain);
      if (!ref) {
        await this.deps.reply(
          documentResultCard({ ok: false, title: "文档链接无效", detail: "请使用 docx/wiki HTTPS 链接。" }),
        );
        return;
      }
      const resolved = await this.deps.documents.resolve(ref);
      const meta = await this.deps.documents.metadata(resolved.documentId);
      targetToken = meta.documentId;
      targetUrl = ref.url;
      targetLabel = `「${meta.title}」`;
      baseRevision = meta.revision;
    }

    const payload = input.kind === "create"
      ? { title: input.title, content: input.content }
      : input.kind === "append"
        ? { content: input.content }
        : { oldText: input.oldText, newText: input.newText };
    const expiresAt = Date.now() + this.deps.confirmationTimeoutMin * 60_000;
    this.deps.storage.createDocumentAction({
      id,
      code,
      sessionKey: sessionKeyFor(msg),
      chatId: msg.chatId,
      userId: msg.senderOpenId,
      operation: input.kind,
      targetToken,
      targetUrl,
      payloadJson: JSON.stringify(payload),
      baseRevision,
      expiresAt,
    });
    const docHash = targetToken ? await shortHash(targetToken) : "new";
    this.deps.storage.audit({
      sessionKey: sessionKeyFor(msg),
      taskId: id,
      userId: msg.senderOpenId,
      kind: "document_prepare",
      detail: `op=${input.kind} doc=${docHash} base_revision=${baseRevision}`,
    });
    await this.deps.reply(
      documentConfirmationCard({
        code,
        operation: input.kind,
        target: filterSecrets(targetLabel).text,
        preview: filterSecrets(preview(input)).text,
        baseRevision,
        expiresInMin: this.deps.confirmationTimeoutMin,
      }),
    );
  }

  private async finish(msg: IncomingMessage, kind: "confirm" | "cancel", code: string): Promise<void> {
    const row = this.deps.storage.getDocumentActionByCode(code);
    if (!row || row.chat_id !== msg.chatId || row.user_id !== msg.senderOpenId) {
      await this.deps.reply(
        documentResultCard({ ok: false, title: "无法处理确认", detail: "确认码不存在,或不属于当前用户与会话。" }),
      );
      return;
    }
    if (row.status !== "pending") {
      await this.deps.reply(
        documentResultCard({ ok: row.status === "completed", title: "该操作已处理", detail: `当前状态:${row.status}` }),
      );
      return;
    }
    if (row.expires_at < Date.now()) {
      this.deps.storage.finishDocumentAction(row.id, "expired", { reason: "confirmation timeout" });
      await this.deps.reply(documentResultCard({ ok: false, title: "确认已过期", detail: "未执行任何文档写入,请重新发起。" }));
      return;
    }
    if (kind === "cancel") {
      this.deps.storage.cancelDocumentAction(row.id);
      this.deps.storage.audit({ taskId: row.id, userId: msg.senderOpenId, kind: "document_cancel", detail: `op=${row.operation}` });
      await this.deps.reply(documentResultCard({ ok: true, title: "已取消文档写入", detail: "未修改文档。" }));
      return;
    }

    if (row.target_token) {
      const current = await this.deps.documents.metadata(row.target_token);
      if (current.revision !== row.base_revision) {
        this.deps.storage.finishDocumentAction(row.id, "failed", { reason: "stale revision" });
        await this.deps.reply(
          documentResultCard({
            ok: false,
            title: "文档已发生变化",
            detail: `基准修订为 ${row.base_revision},当前为 ${current.revision};未执行写入,请重新发起。`,
          }),
        );
        return;
      }
    }
    if (!this.deps.storage.claimDocumentAction(row.id)) {
      await this.deps.reply(documentResultCard({ ok: false, title: "操作未执行", detail: "确认状态已变化,请查看上一条结果。" }));
      return;
    }

    try {
      const result = await this.execute(row);
      this.deps.storage.finishDocumentAction(row.id, "completed", result);
      const docHash = await shortHash(result.documentId);
      this.deps.storage.audit({
        sessionKey: row.session_key,
        taskId: row.id,
        userId: row.user_id,
        kind: "document_execute",
        detail: `op=${row.operation} doc=${docHash} outcome=completed revision=${result.revision}`,
      });
      await this.deps.reply(
        documentResultCard({ ok: true, title: "文档写入已完成", detail: `新修订:${result.revision}`, url: result.url }),
      );
    } catch (error) {
      const stale = error instanceof LarkApiError && error.code === 1770021;
      const detail = filterSecrets(error instanceof Error ? error.message : String(error)).text;
      this.deps.storage.finishDocumentAction(row.id, "failed", { reason: stale ? "stale revision" : detail });
      this.deps.storage.audit({
        sessionKey: row.session_key,
        taskId: row.id,
        userId: row.user_id,
        kind: "document_execute",
        detail: `op=${row.operation} outcome=failed${stale ? " stale_revision=true" : ""}`,
      });
      this.deps.log?.(`[document] action ${row.id} failed:${detail}`);
      await this.deps.reply(
        documentResultCard({
          ok: false,
          title: stale ? "文档修订已过期" : "文档写入失败",
          detail: stale ? "未执行写入,请基于最新文档重新发起。" : detail,
        }),
      );
    }
  }

  private async execute(row: DocumentActionRow): Promise<{ documentId: string; revision: number; url: string }> {
    const payload = JSON.parse(row.payload_json) as Record<string, string>;
    if (row.operation === "create") {
      const created = await this.deps.documents.create(payload.title ?? "");
      const revision = payload.content
        ? await this.deps.documents.append(created.documentId, payload.content, created.revision, row.id)
        : created.revision;
      return {
        documentId: created.documentId,
        revision,
        url: `https://${this.deps.domain === "lark" ? "larksuite.com" : "feishu.cn"}/docx/${created.documentId}`,
      };
    }
    if (!row.target_token || !row.target_url) throw new Error("文档操作缺少目标");
    const revision = row.operation === "append"
      ? await this.deps.documents.append(row.target_token, payload.content ?? "", row.base_revision, row.id)
      : await this.deps.documents.replaceExact(
          row.target_token,
          payload.oldText ?? "",
          payload.newText ?? "",
          row.base_revision,
          row.id,
        );
    return { documentId: row.target_token, revision, url: row.target_url };
  }
}

function preview(input: Exclude<DocumentInteraction, { kind: "confirm" | "cancel" }>): string {
  const text = input.kind === "replace"
    ? `- ${input.oldText}\n+ ${input.newText}`
    : input.content;
  return text.length > 800 ? `${text.slice(0, 799)}…` : text;
}

async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
