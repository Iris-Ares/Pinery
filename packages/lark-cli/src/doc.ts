/**
 * 飞书文档 URL / token 解析。
 * 支持:
 * - https://xx.feishu.cn/docx/<token>
 * - https://xx.feishu.cn/wiki/<token>(需再经 wiki 节点解析出 obj_token)
 * - 裸 token(按 docx 处理)
 */

export interface DocRef {
  kind: "docx" | "wiki";
  token: string;
}

export function parseDocRef(input: string): DocRef {
  const trimmed = input.trim();
  const m = trimmed.match(/https?:\/\/[^/]+\/(docx|wiki)\/([A-Za-z0-9]+)/);
  if (m) {
    return { kind: m[1] as "docx" | "wiki", token: m[2]! };
  }
  if (/^[A-Za-z0-9]{10,}$/.test(trimmed)) {
    return { kind: "docx", token: trimmed };
  }
  throw new Error(`无法识别的文档链接或 token:${input}`);
}
