import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeLarkSignature } from "../src/crypto.js";
import { parseWebhookBody, verifyLarkWebhookSignature } from "../src/webhook.js";

function encryptLikeLark(encryptKey: string, plaintext: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ct]).toString("base64");
}

const KEY = "webhook-encrypt-key";

describe("parseWebhookBody", () => {
  it("handles plaintext url_verification challenge", async () => {
    const parsed = await parseWebhookBody(
      JSON.stringify({ challenge: "c-123", token: "v-token", type: "url_verification" }),
    );
    expect(parsed).toEqual({ kind: "challenge", challenge: "c-123", token: "v-token" });
  });

  it("handles encrypted challenge (encrypt key configured)", async () => {
    const inner = JSON.stringify({ challenge: "c-enc", token: "v", type: "url_verification" });
    const parsed = await parseWebhookBody(JSON.stringify({ encrypt: encryptLikeLark(KEY, inner) }), KEY);
    expect(parsed).toMatchObject({ kind: "challenge", challenge: "c-enc" });
  });

  it("extracts v2.0 events with header ids", async () => {
    const inner = JSON.stringify({
      schema: "2.0",
      header: { event_id: "evt-1", event_type: "im.message.receive_v1", app_id: "cli_x" },
      event: { message: { message_id: "om_1" } },
    });
    const parsed = await parseWebhookBody(JSON.stringify({ encrypt: encryptLikeLark(KEY, inner) }), KEY);
    expect(parsed).toMatchObject({
      kind: "event",
      eventId: "evt-1",
      eventType: "im.message.receive_v1",
      event: { message: { message_id: "om_1" } },
    });
  });

  it("skips signature headers only for URL challenges", async () => {
    const challengeBody = JSON.stringify({
      encrypt: encryptLikeLark(
        KEY,
        JSON.stringify({ challenge: "c-no-signature", token: "v", type: "url_verification" }),
      ),
    });
    const challenge = await parseWebhookBody(challengeBody, KEY);
    expect(
      await verifyLarkWebhookSignature(challenge, {
        encryptKey: KEY,
        timestamp: "",
        nonce: "",
        rawBody: challengeBody,
        signature: "",
      }),
    ).toBe(true);

    const eventBody = JSON.stringify({
      encrypt: encryptLikeLark(
        KEY,
        JSON.stringify({
          schema: "2.0",
          header: { event_id: "evt-signed", event_type: "im.message.receive_v1" },
          event: {},
        }),
      ),
    });
    const event = await parseWebhookBody(eventBody, KEY);
    const timestamp = "1786000000";
    const nonce = "nonce";
    const signature = await computeLarkSignature(KEY, timestamp, nonce, eventBody);
    expect(
      await verifyLarkWebhookSignature(event, {
        encryptKey: KEY,
        timestamp,
        nonce,
        rawBody: eventBody,
        signature,
      }),
    ).toBe(true);
    expect(
      await verifyLarkWebhookSignature(event, {
        encryptKey: KEY,
        timestamp,
        nonce,
        rawBody: eventBody,
        signature: "",
      }),
    ).toBe(false);
  });

  it("flags encrypted payload without configured key", async () => {
    const parsed = await parseWebhookBody(JSON.stringify({ encrypt: "whatever" }));
    expect(parsed).toMatchObject({ kind: "unsupported" });
  });

  it("flags bad json, bad decrypt, v1 events, unknown shapes", async () => {
    expect(await parseWebhookBody("not-json")).toMatchObject({ kind: "unsupported" });
    expect(await parseWebhookBody(JSON.stringify({ encrypt: "AAAA" }), KEY)).toMatchObject({ kind: "unsupported" });
    const v1 = JSON.stringify({ uuid: "u-1", event: {} });
    expect(await parseWebhookBody(v1)).toMatchObject({ kind: "unsupported", reason: expect.stringContaining("v1.0") });
    expect(await parseWebhookBody(JSON.stringify({ hello: 1 }))).toMatchObject({ kind: "unsupported" });
  });
});
