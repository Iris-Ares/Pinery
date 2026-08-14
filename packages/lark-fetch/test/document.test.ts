import { describe, expect, it, vi } from "vitest";
import {
  LarkDocumentService,
  extractLarkDocumentRefs,
  parseLarkDocumentRef,
} from "../src/document.js";
import type { LarkFetchClient } from "../src/client.js";

function fakeClient(handler: (method: string, path: string, body?: unknown) => unknown): LarkFetchClient {
  return { requestApi: vi.fn(handler) } as unknown as LarkFetchClient;
}

describe("LarkDocumentService", () => {
  it("extracts bounded docx/wiki references", () => {
    expect(parseLarkDocumentRef("https://acme.feishu.cn/docx/Abcdef12")?.token).toBe("Abcdef12");
    expect(parseLarkDocumentRef("https://acme.feishu.cn/wiki/WikiToken9")?.kind).toBe("wiki");
    expect(parseLarkDocumentRef("https://evil.example/docx/Abcdef12")).toBeUndefined();
    expect(
      extractLarkDocumentRefs(
        "see https://acme.feishu.cn/docx/Abcdef12 and https://acme.feishu.cn/docx/Abcdef12",
      ),
    ).toHaveLength(1);
  });

  it("reads a pinned revision, renders headings, citations and embedded refs", async () => {
    const client = fakeClient((_method, path) => {
      if (path === "/open-apis/docx/v1/documents/Abcdef12") {
        return { document: { document_id: "Abcdef12", revision_id: 7, title: "Design" } };
      }
      if (path.includes("/blocks?")) {
        expect(path).toContain("document_revision_id=7");
        return {
          items: [
            { block_id: "b1", block_type: 3, heading1: { elements: [{ text_run: { content: "Overview" } }] } },
            { block_id: "b2", block_type: 2, text: { elements: [{ text_run: { content: "Trusted facts" } }] } },
            { block_id: "b3", block_type: 30 },
          ],
          has_more: false,
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    const service = new LarkDocumentService(client);
    const ref = parseLarkDocumentRef("https://acme.feishu.cn/docx/Abcdef12")!;
    const result = await service.read(ref);
    expect(result.revision).toBe(7);
    expect(result.text).toContain("# Overview");
    expect(result.text).toContain("Trusted facts");
    expect(result.citations[0]?.url).toContain("#b1");
    expect(result.embedded).toEqual(["sheet:b3"]);
  });

  it("resolves a wiki node to docx without exposing credentials", async () => {
    const client = fakeClient((_method, path) => {
      expect(path).toContain("/wiki/v2/spaces/get_node?token=WikiToken9");
      return { node: { obj_type: "docx", obj_token: "DocToken99" } };
    });
    const result = await new LarkDocumentService(client).resolve(
      parseLarkDocumentRef("https://acme.feishu.cn/wiki/WikiToken9")!,
    );
    expect(result.documentId).toBe("DocToken99");
  });

  it("uses revision and client_token for append and exact replacement", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = fakeClient((method, path, body) => {
      calls.push({ method, path, body });
      if (method === "GET") {
        return {
          items: [
            {
              block_id: "b1",
              text: {
                elements: [
                  { text_run: { content: "old value", text_element_style: { bold: true } } },
                ],
              },
            },
          ],
          has_more: false,
        };
      }
      return { document_revision_id: 8 };
    });
    const service = new LarkDocumentService(client);
    await expect(service.append("DocToken99", "hello", 7, "action-1")).resolves.toBe(8);
    await expect(service.replaceExact("DocToken99", "old", "new", 7, "action-2")).resolves.toBe(8);
    expect(calls[0]?.path).toContain("document_revision_id=7");
    expect(calls[0]?.path).toContain("client_token=action-1");
    const patch = calls.find((call) => call.method === "PATCH")!;
    expect(patch.path).toContain("client_token=action-2");
    expect(JSON.stringify(patch.body)).toContain("new value");
    expect(JSON.stringify(patch.body)).toContain('"bold":true');
  });

  it("does not split an astral Unicode character across document blocks", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const client = fakeClient((method, path, body) => {
      calls.push({ method, path, body });
      return { document_revision_id: 8 };
    });
    const content = `${"a".repeat(1_999)}\ud83d\ude80tail`;

    await new LarkDocumentService(client).append("DocToken99", content, 7, "action-unicode");

    const body = calls[0]!.body as {
      children: Array<{ text: { elements: Array<{ text_run: { content: string } }> } }>;
    };
    const chunks = body.children.map((child) => child.text.elements[0]!.text_run.content);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.join("")).toBe(content);
    expect(chunks[0]!.endsWith("\ud83d")).toBe(false);
    expect(chunks[1]!.startsWith("\ude80")).toBe(false);
  });
});
