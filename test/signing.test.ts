import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhookSignature } from "../src/worker/signing";

const secret = "whsec_c3VwZXItc2VjcmV0LWtleQ==";

describe("Standard Webhooks signing", () => {
  it("signs and verifies the exact raw body", async () => {
    const body = '{"ok":true,"spacing":"exact"}';
    const timestamp = "1784073600";
    const headers = await signWebhook(secret, "evt_123", timestamp, body);

    expect(headers["webhook-id"]).toBe("evt_123");
    expect(headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    await expect(
      verifyWebhookSignature(secret, body, headers, 300, 1_784_073_600_000),
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature(
        secret,
        `${body} `,
        headers,
        300,
        1_784_073_600_000,
      ),
    ).resolves.toBe(false);
  });

  it("rejects stale timestamps", async () => {
    const headers = await signWebhook(secret, "evt_123", "100", "{}");
    await expect(
      verifyWebhookSignature(secret, "{}", headers, 300, 1_000_000),
    ).resolves.toBe(false);
  });
});
