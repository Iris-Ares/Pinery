import type { LarkFetchClient } from "./client.js";
import type { LarkDomain } from "./token.js";

export type LarkDocumentKind = "docx" | "wiki";

export interface LarkDocumentRef {
  kind: LarkDocumentKind;
  token: string;
  url: string;
}

export type LarkDocumentScope =
  | { kind: "full" }
  | { kind: "outline" }
  | { kind: "range"; start: number; end: number }
  | { kind: "section"; heading: string }
  | { kind: "keyword"; keyword: string };

export interface LarkDocumentCitation {
  blockId: string;
  url: string;
}

export interface LarkDocumentReadResult {
  documentId: string;
  title: string;
  revision: number;
  text: string;
  citations: LarkDocumentCitation[];
  truncated: boolean;
  embedded: string[];
  sourceUrl: string;
}

interface TextElement {
  text_run?: { content?: string; text_element_style?: Record<string, unknown> };
  [key: string]: unknown;
}

interface DocumentBlock {
  block_id?: string;
  block_type?: number;
  parent_id?: string;
  children?: string[];
  [key: string]: unknown;
}

interface DocumentMeta {
  document?: { document_id?: string; revision_id?: number; title?: string };
}

const TEXT_FIELDS = [
  "text",
  "heading1",
  "heading2",
  "heading3",
  "heading4",
  "heading5",
  "heading6",
  "heading7",
  "heading8",
  "heading9",
  "bullet",
  "ordered",
  "code",
  "quote",
  "todo",
  "callout",
] as const;

const EMBEDDED_TYPES: Record<number, string> = {
  18: "bitable",
  23: "file",
  27: "image",
  30: "sheet",
  31: "table",
};

function domainHost(domain: LarkDomain | undefined): string {
  return domain === "lark" ? "larksuite.com" : "feishu.cn";
}

function cleanToken(value: string): string | undefined {
  return /^[A-Za-z0-9_-]{6,128}$/.test(value) ? value : undefined;
}

function isLarkDocumentHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "feishu.cn" ||
    host.endsWith(".feishu.cn") ||
    host === "larksuite.com" ||
    host.endsWith(".larksuite.com")
  );
}

export function parseLarkDocumentRef(value: string, domain?: LarkDomain): LarkDocumentRef | undefined {
  const shorthand = value.match(/^(docx|wiki):([A-Za-z0-9_-]{6,128})$/i);
  if (shorthand) {
    const kind = shorthand[1]!.toLowerCase() as LarkDocumentKind;
    const token = shorthand[2]!;
    return { kind, token, url: `https://${domainHost(domain)}/${kind}/${token}` };
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !isLarkDocumentHost(url.hostname)) return undefined;
    const match = url.pathname.match(/\/(docx|wiki)\/([A-Za-z0-9_-]{6,128})(?:\/|$)/i);
    if (!match) return undefined;
    const kind = match[1]!.toLowerCase() as LarkDocumentKind;
    const token = cleanToken(match[2]!);
    return token ? { kind, token, url: `${url.origin}/${kind}/${token}` } : undefined;
  } catch {
    return undefined;
  }
}

export function extractLarkDocumentRefs(text: string, domain?: LarkDomain, max = 3): LarkDocumentRef[] {
  const result: LarkDocumentRef[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/https:\/\/[^\s<>()]+\/(?:docx|wiki)\/[A-Za-z0-9_-]{6,128}/gi)) {
    const ref = parseLarkDocumentRef(match[0]!.replace(/[,.!?;:\u3002，！？；：]+$/u, ""), domain);
    if (!ref) continue;
    const key = `${ref.kind}:${ref.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
    if (result.length >= max) break;
  }
  return result;
}

function textField(block: DocumentBlock): { field: string; elements: TextElement[]; level?: number } | undefined {
  for (const field of TEXT_FIELDS) {
    const value = block[field];
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const elements = (value as { elements?: unknown }).elements;
    if (!Array.isArray(elements)) continue;
    const heading = field.match(/^heading(\d)$/);
    return { field, elements: elements as TextElement[], ...(heading ? { level: Number(heading[1]) } : {}) };
  }
  return undefined;
}

function blockText(block: DocumentBlock): { text: string; level?: number } | undefined {
  const field = textField(block);
  if (!field) return undefined;
  const text = field.elements.map((element) => element.text_run?.content ?? "").join("").trim();
  return text ? { text, ...(field.level ? { level: field.level } : {}) } : undefined;
}

function selectBlocks(blocks: DocumentBlock[], scope: LarkDocumentScope): DocumentBlock[] {
  switch (scope.kind) {
    case "full":
      return blocks;
    case "outline":
      return blocks.filter((block) => blockText(block)?.level !== undefined);
    case "range":
      return blocks.slice(Math.max(0, scope.start), Math.max(scope.start, scope.end));
    case "keyword": {
      const keyword = scope.keyword.trim().toLocaleLowerCase();
      return keyword ? blocks.filter((block) => blockText(block)?.text.toLocaleLowerCase().includes(keyword)) : [];
    }
    case "section": {
      const wanted = scope.heading.trim().toLocaleLowerCase();
      const start = blocks.findIndex((block) => {
        const text = blockText(block);
        return text?.level !== undefined && text.text.toLocaleLowerCase().includes(wanted);
      });
      if (start < 0) return [];
      const level = blockText(blocks[start]!)?.level ?? 9;
      let end = blocks.length;
      for (let index = start + 1; index < blocks.length; index++) {
        const nextLevel = blockText(blocks[index]!)?.level;
        if (nextLevel !== undefined && nextLevel <= level) {
          end = index;
          break;
        }
      }
      return blocks.slice(start, end);
    }
  }
}

export class LarkDocumentService {
  constructor(
    private readonly client: LarkFetchClient,
    private readonly options: { domain?: LarkDomain; maxBlocks?: number; maxChars?: number } = {},
  ) {}

  async resolve(ref: LarkDocumentRef): Promise<{ documentId: string; sourceUrl: string }> {
    if (ref.kind === "docx") return { documentId: ref.token, sourceUrl: ref.url };
    const params = new URLSearchParams({ token: ref.token });
    const data = await this.client.requestApi<{
      node?: { obj_type?: string; obj_token?: string };
    }>("GET", `/open-apis/wiki/v2/spaces/get_node?${params.toString()}`);
    if (data?.node?.obj_type !== "docx" || !data.node.obj_token) {
      throw new Error("该 Wiki 节点不是可读的 docx 文档");
    }
    return { documentId: data.node.obj_token, sourceUrl: ref.url };
  }

  async metadata(documentId: string): Promise<{ documentId: string; title: string; revision: number }> {
    const data = await this.client.requestApi<DocumentMeta>(
      "GET",
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`,
    );
    const document = data?.document;
    if (!document?.document_id || typeof document.revision_id !== "number") {
      throw new Error("飞书文档元数据不完整");
    }
    return { documentId: document.document_id, title: document.title ?? "(无标题)", revision: document.revision_id };
  }

  async blocks(documentId: string, revision: number): Promise<DocumentBlock[]> {
    const maxBlocks = Math.max(1, Math.min(2_000, this.options.maxBlocks ?? 500));
    const result: DocumentBlock[] = [];
    let pageToken: string | undefined;
    while (result.length < maxBlocks) {
      const params = new URLSearchParams({
        page_size: String(Math.min(500, maxBlocks - result.length)),
        document_revision_id: String(revision),
      });
      if (pageToken) params.set("page_token", pageToken);
      const data = await this.client.requestApi<{
        items?: DocumentBlock[];
        has_more?: boolean;
        page_token?: string;
      }>("GET", `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?${params.toString()}`);
      result.push(...(data?.items ?? []));
      if (!data?.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    return result;
  }

  async read(ref: LarkDocumentRef, scope: LarkDocumentScope = { kind: "full" }): Promise<LarkDocumentReadResult> {
    const resolved = await this.resolve(ref);
    const meta = await this.metadata(resolved.documentId);
    const selected = selectBlocks(await this.blocks(meta.documentId, meta.revision), scope);
    const maxChars = Math.max(1, Math.min(100_000, this.options.maxChars ?? 12_000));
    const lines: string[] = [];
    const citations: LarkDocumentCitation[] = [];
    const embedded: string[] = [];
    let length = 0;
    let truncated = false;
    for (const block of selected) {
      const id = block.block_id;
      const content = blockText(block);
      if (!content) {
        const kind = block.block_type === undefined ? undefined : EMBEDDED_TYPES[block.block_type];
        if (kind && id) embedded.push(`${kind}:${id}`);
        continue;
      }
      const prefix = content.level ? `${"#".repeat(content.level)} ` : "";
      const line = `${prefix}${content.text}`;
      if (length + line.length + 1 > maxChars) {
        const remaining = Math.max(0, maxChars - length);
        if (remaining > 0) lines.push(line.slice(0, remaining));
        truncated = true;
        break;
      }
      lines.push(line);
      length += line.length + 1;
      if (id) citations.push({ blockId: id, url: `${resolved.sourceUrl}#${encodeURIComponent(id)}` });
    }
    return {
      documentId: meta.documentId,
      title: meta.title,
      revision: meta.revision,
      text: lines.join("\n"),
      citations,
      truncated,
      embedded,
      sourceUrl: resolved.sourceUrl,
    };
  }

  async create(title: string): Promise<{ documentId: string; title: string; revision: number }> {
    const normalized = title.trim();
    if (!normalized || normalized.length > 256) throw new Error("文档标题必须在 1..256 字符之间");
    const data = await this.client.requestApi<DocumentMeta>("POST", "/open-apis/docx/v1/documents", {
      title: normalized,
    });
    const id = data?.document?.document_id;
    if (!id) throw new Error("创建文档响应缺少 document_id");
    return this.metadata(id);
  }

  async append(documentId: string, content: string, revision: number, actionId: string): Promise<number> {
    const chunks = splitTextBlocks(content);
    const params = new URLSearchParams({
      document_revision_id: String(revision),
      client_token: actionId,
    });
    const data = await this.client.requestApi<{ document_revision_id?: number }>(
      "POST",
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children?${params.toString()}`,
      {
        index: -1,
        children: chunks.map((text) => ({
          block_type: 2,
          text: { elements: [{ text_run: { content: text } }] },
        })),
      },
    );
    return data?.document_revision_id ?? revision + 1;
  }

  async replaceExact(
    documentId: string,
    oldText: string,
    newText: string,
    revision: number,
    actionId: string,
  ): Promise<number> {
    if (!oldText) throw new Error("替换的旧文本不得为空");
    const matches: Array<{ block: DocumentBlock; field: ReturnType<typeof textField>; element: TextElement }> = [];
    for (const block of await this.blocks(documentId, revision)) {
      const field = textField(block);
      if (!field) continue;
      for (const element of field.elements) {
        const content = element.text_run?.content;
        if (!content) continue;
        let index = content.indexOf(oldText);
        while (index >= 0) {
          matches.push({ block, field, element });
          index = content.indexOf(oldText, index + oldText.length);
        }
      }
    }
    if (matches.length !== 1) throw new Error(`精确替换要求全文唯一命中,当前命中 ${matches.length} 处`);
    const match = matches[0]!;
    if (!match.block.block_id || !match.field || !match.element.text_run?.content) {
      throw new Error("命中的文本块结构不完整");
    }
    const elements = match.field.elements.map((element) =>
      element === match.element
        ? {
            ...element,
            text_run: {
              ...element.text_run,
              content: match.element.text_run!.content!.replace(oldText, newText),
            },
          }
        : element,
    );
    const params = new URLSearchParams({
      document_revision_id: String(revision),
      client_token: actionId,
    });
    const data = await this.client.requestApi<{ document_revision_id?: number }>(
      "PATCH",
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(match.block.block_id)}?${params.toString()}`,
      { update_text_elements: { elements } },
    );
    return data?.document_revision_id ?? revision + 1;
  }
}

function splitTextBlocks(content: string): string[] {
  const normalized = content.trim();
  if (!normalized) throw new Error("文档内容不得为空");
  if (normalized.length > 20_000) throw new Error("单次文档写入不得超过 20000 字符");
  const chunks: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += 2_000) {
    chunks.push(normalized.slice(offset, offset + 2_000));
  }
  if (chunks.length > 50) throw new Error("单次文档写入不得超过 50 个文本块");
  return chunks;
}
