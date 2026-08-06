#!/usr/bin/env node
import { Command } from "commander";
import { createLarkClient, fetchDocRawText, larkEnvFromProcess } from "./client.js";
import { parseDocRef } from "./doc.js";

/**
 * agent 侧只读 CLI(PRD §3.1):仅用于读取飞书开放平台资源(PRD 对照场景 B 的地基)。
 * 回复通道收口在 adapter —— 本 CLI 永远不发消息。
 */
const program = new Command();

program
  .name("lark-cli")
  .description("Pinery agent 侧飞书资源只读 CLI(读文档;不发消息)")
  .version("0.1.0");

program
  .command("doc")
  .argument("<urlOrToken>", "飞书文档链接或 token(支持 docx/wiki)")
  .description("拉取文档纯文本内容并输出到 stdout")
  .action(async (urlOrToken: string) => {
    const ref = parseDocRef(urlOrToken);
    const client = createLarkClient(larkEnvFromProcess());
    const text = await fetchDocRawText(client, ref);
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  });

program
  .command("whoami")
  .description("校验凭据:输出当前应用信息")
  .action(async () => {
    const client = createLarkClient(larkEnvFromProcess());
    const res = await client.request<{ code: number; msg: string; bot?: { app_name?: string; open_id?: string } }>({
      method: "GET",
      url: "/open-apis/bot/v3/info",
    });
    if (res.code !== 0) throw new Error(`凭据校验失败:${res.msg}`);
    process.stdout.write(`${JSON.stringify({ app_name: res.bot?.app_name, open_id: res.bot?.open_id })}\n`);
  });

program.parseAsync().catch((e: unknown) => {
  console.error(`lark-cli 错误:${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
