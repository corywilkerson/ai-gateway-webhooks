import { describe, expect, it } from "vitest";
import {
  DELIVERY_DELAYS_MS,
  deliverWebhookAttempt,
  runWebhookDelivery,
  type DeliveryStep,
} from "../src/worker/workflows/delivery";
import type { WebhookDeliveryParams } from "../src/worker/types";

const secret = "whsec_c3VwZXItc2VjcmV0LWtleQ==";

function params(): WebhookDeliveryParams {
  return {
    url: "https://receiver.example/hooks?tenant=private",
    envelope: {
      id: "evt_stable",
      type: "prediction.succeeded",
      created_at: "2026-07-14T20:00:00.000Z",
      data: {
        prediction: {
          id: "pred_1",
          model: "model",
          context: null,
          status: "succeeded",
          created_at: "2026-07-14T19:59:00.000Z",
          started_at: "2026-07-14T19:59:01.000Z",
          completed_at: "2026-07-14T20:00:00.000Z",
          output: { ok: true },
          error: null,
          gateway_log_id: "log_1",
        },
      },
    },
  };
}

class FakeStep implements DeliveryStep {
  readonly sleeps: number[] = [];
  readonly names: string[] = [];

  async do<T>(
    name: string,
    _config: {
      retries: { limit: number; delay: number; backoff?: "constant" };
      timeout?: number;
    },
    callback: () => Promise<T>,
  ): Promise<T> {
    this.names.push(name);
    return callback();
  }

  async sleep(name: string, duration: number): Promise<void> {
    this.names.push(name);
    this.sleeps.push(duration);
  }
}

describe("webhook delivery Workflow", () => {
  it("accepts any 2xx immediately", async () => {
    const step = new FakeStep();
    const fetcher = async (): Promise<Response> =>
      new Response(null, { status: 202 });
    await expect(
      runWebhookDelivery(
        { AI_WEBHOOK_SECRET: secret },
        params(),
        step,
        fetcher,
      ),
    ).resolves.toEqual({
      delivered: true,
      attempts: 1,
    });
    expect(step.sleeps).toEqual([]);
  });

  it("retries redirects, errors, and non-2xx responses on the durable schedule", async () => {
    const step = new FakeStep();
    let count = 0;
    const fetcher = async (): Promise<Response> => {
      count += 1;
      if (count === 1) return new Response(null, { status: 302 });
      if (count === 2) throw new Error("timeout");
      return new Response(null, { status: 204 });
    };
    await expect(
      runWebhookDelivery(
        { AI_WEBHOOK_SECRET: secret },
        params(),
        step,
        fetcher,
      ),
    ).resolves.toEqual({
      delivered: true,
      attempts: 3,
    });
    expect(step.sleeps).toEqual([DELIVERY_DELAYS_MS[1], DELIVERY_DELAYS_MS[2]]);
  });

  it("exhausts all eight attempts", async () => {
    const step = new FakeStep();
    const fetcher = async (): Promise<Response> =>
      new Response(null, { status: 500 });
    await expect(
      runWebhookDelivery(
        { AI_WEBHOOK_SECRET: secret },
        params(),
        step,
        fetcher,
      ),
    ).resolves.toEqual({
      delivered: false,
      attempts: 8,
    });
    expect(step.sleeps).toEqual(DELIVERY_DELAYS_MS.slice(1));
  });

  it("keeps the event ID stable while refreshing timestamp and signature", async () => {
    const seen: Headers[] = [];
    const fetcher = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      seen.push(new Headers(init?.headers));
      return new Response(null, { status: 500 });
    };
    await deliverWebhookAttempt(
      { AI_WEBHOOK_SECRET: secret },
      params(),
      fetcher,
      new Date("2026-07-14T20:00:00Z"),
    );
    await deliverWebhookAttempt(
      { AI_WEBHOOK_SECRET: secret },
      params(),
      fetcher,
      new Date("2026-07-14T20:00:10Z"),
    );
    expect(seen[0]?.get("webhook-id")).toBe("evt_stable");
    expect(seen[1]?.get("webhook-id")).toBe("evt_stable");
    expect(seen[0]?.get("webhook-timestamp")).not.toBe(
      seen[1]?.get("webhook-timestamp"),
    );
    expect(seen[0]?.get("webhook-signature")).not.toBe(
      seen[1]?.get("webhook-signature"),
    );
  });
});
