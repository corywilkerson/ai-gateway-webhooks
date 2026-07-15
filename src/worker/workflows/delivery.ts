import { signWebhook } from "../signing";
import type {
  DeliveryAttemptResult,
  WebhookDeliveryParams,
  WebhookDeliveryWorkflowEnv,
} from "../types";

/**
 * Wait before each delivery attempt: immediately, then 10s, 1m, 5m, 30m,
 * 2h, 8h, and 24h — eight attempts spread over roughly 34 hours.
 */
export const DELIVERY_DELAYS_MS = [
  0,
  10_000,
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  8 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;

const DELIVERY_TIMEOUT_MS = 15_000;

export interface DeliveryStep {
  do<T>(
    name: string,
    config: {
      retries: { limit: number; delay: number; backoff?: "constant" };
      timeout?: number;
    },
    callback: () => Promise<T>,
  ): Promise<T>;
  sleep(name: string, duration: number): Promise<void>;
}

export async function runWebhookDelivery(
  env: WebhookDeliveryWorkflowEnv,
  params: Readonly<WebhookDeliveryParams>,
  step: DeliveryStep,
  fetcher: typeof fetch = fetch,
): Promise<{ delivered: boolean; attempts: number }> {
  for (let index = 0; index < DELIVERY_DELAYS_MS.length; index += 1) {
    const delay = DELIVERY_DELAYS_MS[index] ?? 0;
    if (delay > 0) {
      await step.sleep(`wait before webhook attempt ${index + 1}`, delay);
    }

    // Each attempt is its own step with retries disabled: an ambiguous
    // failure (timeout after the receiver got the request) must not be
    // retried transparently, or the receiver could see duplicates without
    // a new webhook-timestamp.
    const result = await step.do(
      `deliver webhook attempt ${index + 1}`,
      {
        retries: { limit: 0, delay: 0, backoff: "constant" },
        timeout: DELIVERY_TIMEOUT_MS + 1_000,
      },
      async () => deliverWebhookAttempt(env, params, fetcher),
    );

    if (result.accepted) {
      return { delivered: true, attempts: index + 1 };
    }
  }

  return { delivered: false, attempts: DELIVERY_DELAYS_MS.length };
}

export async function deliverWebhookAttempt(
  env: WebhookDeliveryWorkflowEnv,
  params: Readonly<WebhookDeliveryParams>,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<DeliveryAttemptResult> {
  const rawBody = JSON.stringify(params.envelope);
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signatureHeaders = await signWebhook(
    env.AI_WEBHOOK_SECRET,
    params.envelope.id,
    timestamp,
    rawBody,
  );

  try {
    const response = await fetcher(params.url, {
      method: "POST",
      // Don't follow redirects: a redirect would re-send the signed body to
      // a URL the caller never validated.
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": "ai-gateway-webhooks/0.1",
        ...signatureHeaders,
      },
      body: rawBody,
    });
    return {
      accepted: response.status >= 200 && response.status < 300,
      status: response.status,
      attemptedAt: now.toISOString(),
    };
  } catch {
    return {
      accepted: false,
      status: null,
      attemptedAt: now.toISOString(),
    };
  }
}
