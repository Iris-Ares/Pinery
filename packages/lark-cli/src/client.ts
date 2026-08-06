import * as Lark from "@larksuiteoapi/node-sdk";

export interface LarkEnv {
  appId: string;
  appSecret: string;
  endpoint: "feishu" | "lark";
}

/** 从环境变量读取凭据(由 adapter 在 spawn agent CLI 时注入受限凭据) */
export function larkEnvFromProcess(env: NodeJS.ProcessEnv = process.env): LarkEnv {
  const appId = env["LARK_APP_ID"];
  const appSecret = env["LARK_APP_SECRET"];
  if (!appId || !appSecret) {
    throw new Error("缺少 LARK_APP_ID / LARK_APP_SECRET 环境变量");
  }
  const endpoint = env["LARK_ENDPOINT"] === "lark" ? "lark" : "feishu";
  return { appId, appSecret, endpoint };
}

export function createLarkClient(cfg: LarkEnv): Lark.Client {
  return new Lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.endpoint === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.error,
  });
}

/** 读取文档纯文本(docx 直读;wiki 先解析节点拿 obj_token) */
export async function fetchDocRawText(
  client: Lark.Client,
  ref: { kind: "docx" | "wiki"; token: string },
): Promise<string> {
  let documentId = ref.token;
  if (ref.kind === "wiki") {
    const node = await client.wiki.v2.space.getNode({ params: { token: ref.token } });
    const objToken = node.data?.node?.obj_token;
    const objType = node.data?.node?.obj_type;
    if (!objToken) throw new Error(`wiki 节点解析失败:${node.msg ?? "无 obj_token"}`);
    if (objType !== "docx" && objType !== "doc") {
      throw new Error(`wiki 节点不是文档(obj_type=${objType}),暂不支持`);
    }
    documentId = objToken;
  }
  const res = await client.docx.v1.document.rawContent({ path: { document_id: documentId } });
  if (res.code !== 0 || res.data?.content === undefined) {
    throw new Error(`拉取文档失败:code=${res.code} msg=${res.msg}`);
  }
  return res.data.content;
}
