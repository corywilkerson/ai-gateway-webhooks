import { describe, expect, it } from "vitest";
import { isWebhookEnvelope, parseWebhook } from "../src/worker/parsing";
import { signWebhook } from "../src/worker/signing";
import type { WebhookEnvelope } from "../src/worker/types";

const secret = "whsec_c3VwZXItc2VjcmV0LWtleQ==";
const now = Date.parse("2026-07-14T20:00:00Z");
const timestamp = String(Math.floor(now / 1000));

function envelope(): WebhookEnvelope {
  return {
    id: "evt_123_completed",
    type: "prediction.succeeded",
    created_at: "2026-07-14T20:00:00.000Z",
    data: {
      prediction: {
        id: "pred_123",
        model: "openai/gpt-4.1-mini",
        context: { orderId: "ord_123" },
        status: "succeeded",
        created_at: "2026-07-14T19:59:00.000Z",
        started_at: "2026-07-14T19:59:01.000Z",
        completed_at: "2026-07-14T20:00:00.000Z",
        output: { response: "Hello" },
        error: null,
        gateway_log_id: "log_123",
      },
    },
  };
}

async function signedRequest(body: string): Promise<Request> {
  const headers = await signWebhook(
    secret,
    "evt_123_completed",
    timestamp,
    body,
  );
  return new Request("https://receiver.example/hooks", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("parseWebhook", () => {
  it("verifies, parses, and returns a typed event", async () => {
    const body = JSON.stringify(envelope());
    const event = await parseWebhook(await signedRequest(body), secret, {
      now,
    });
    expect(event.type).toBe("prediction.succeeded");
    expect(event.data.prediction.output).toEqual({ response: "Hello" });
    expect(event.data.prediction.context).toEqual({ orderId: "ord_123" });
    expect(isWebhookEnvelope(event)).toBe(true);
  });

  it("rejects a bad signature before parsing", async () => {
    const request = await signedRequest("not-json");
    request.headers.set("webhook-signature", "v1,tampered");
    await expect(parseWebhook(request, secret, { now })).rejects.toMatchObject({
      name: "WebhookVerificationError",
      code: "invalid_signature",
    });
  });

  it("rejects signed malformed JSON", async () => {
    await expect(
      parseWebhook(await signedRequest("not-json"), secret, { now }),
    ).rejects.toMatchObject({ code: "invalid_json" });
  });

  it("rejects a signed body with the wrong event shape", async () => {
    const body = JSON.stringify({
      id: "evt_123",
      type: "prediction.succeeded",
    });
    await expect(
      parseWebhook(await signedRequest(body), secret, { now }),
    ).rejects.toMatchObject({
      code: "invalid_event",
    });
  });

  it("bounds streamed request bodies", async () => {
    const request = await signedRequest(JSON.stringify(envelope()));
    await expect(
      parseWebhook(request, secret, { now, maxBodyBytes: 10 }),
    ).rejects.toMatchObject({ code: "payload_too_large" });
  });

  it("rejects bodies that have already been consumed", async () => {
    const request = await signedRequest(JSON.stringify(envelope()));
    await request.text();
    await expect(parseWebhook(request, secret, { now })).rejects.toMatchObject({
      code: "body_already_read",
    });
  });
});
