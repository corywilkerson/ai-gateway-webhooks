import { verifyWebhookSignature } from "./signing";
import type {
  PredictionError,
  PredictionEventType,
  PredictionSnapshot,
  WebhookEnvelope,
} from "./types";

export const DEFAULT_WEBHOOK_BODY_LIMIT = 1024 * 1024;

export type WebhookVerificationErrorCode =
  | "body_already_read"
  | "payload_too_large"
  | "invalid_signature"
  | "invalid_json"
  | "invalid_event";

export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError";

  constructor(
    readonly code: WebhookVerificationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ParseWebhookOptions {
  /** Signature timestamp tolerance. Defaults to five minutes. */
  toleranceSeconds?: number;
  /** Maximum accepted raw request body. Defaults to 1 MiB. */
  maxBodyBytes?: number;
  /** Current time in milliseconds. Intended for deterministic tests. */
  now?: number;
}

/**
 * Read, verify, and parse an incoming webhook request. Throws
 * WebhookVerificationError (with a machine-readable `code`) when the request
 * is oversized, unsigned, tampered with, or not a prediction event.
 */
export async function parseWebhook(
  request: Request,
  secret: string,
  options: ParseWebhookOptions = {},
): Promise<WebhookEnvelope> {
  const toleranceSeconds = options.toleranceSeconds ?? 5 * 60;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_WEBHOOK_BODY_LIMIT;
  if (!Number.isFinite(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new RangeError("maxBodyBytes must be a positive number");
  }

  const rawBody = await readBoundedBody(request, maxBodyBytes);
  const valid = await verifyWebhookSignature(
    secret,
    rawBody,
    request.headers,
    toleranceSeconds,
    options.now ?? Date.now(),
  );
  if (!valid) {
    throw new WebhookVerificationError(
      "invalid_signature",
      "Webhook signature verification failed.",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new WebhookVerificationError(
      "invalid_json",
      "Webhook body is not valid JSON.",
    );
  }
  if (!isWebhookEnvelope(value)) {
    throw new WebhookVerificationError(
      "invalid_event",
      "Webhook body is not a valid prediction event.",
    );
  }
  return value;
}

export function isWebhookEnvelope(value: unknown): value is WebhookEnvelope {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.id !== "string" ||
    !isPredictionEventType(value.type) ||
    typeof value.created_at !== "string" ||
    !isRecord(value.data) ||
    !isPredictionSnapshot(value.data.prediction)
  ) {
    return false;
  }

  // The event type must agree with the prediction's status.
  const status = value.data.prediction.status;
  return (
    (value.type === "prediction.started" && status === "running") ||
    (value.type === "prediction.succeeded" && status === "succeeded") ||
    (value.type === "prediction.failed" && status === "failed")
  );
}

/**
 * Read the request body as text, refusing anything larger than maxBytes.
 * The declared content-length is checked first as a fast path, but the
 * stream is still counted byte-by-byte since the header can lie.
 */
async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<string> {
  if (request.bodyUsed) {
    throw new WebhookVerificationError(
      "body_already_read",
      "Webhook request body has already been read.",
    );
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);

    if (Number.isFinite(length) && length > maxBytes) {
      throw new WebhookVerificationError(
        "payload_too_large",
        "Webhook request body exceeds the configured limit.",
      );
    }
  }

  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      total += chunk.value.byteLength;

      if (total > maxBytes) {
        await reader.cancel();
        throw new WebhookVerificationError(
          "payload_too_large",
          "Webhook request body exceeds the configured limit.",
        );
      }

      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  // Stitch the chunks back together into a single string.
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

function isPredictionSnapshot(value: unknown): value is PredictionSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.model === "string" &&
    (value.context === null || isRecord(value.context)) &&
    (value.status === "running" ||
      value.status === "succeeded" ||
      value.status === "failed") &&
    typeof value.created_at === "string" &&
    typeof value.started_at === "string" &&
    (value.completed_at === null || typeof value.completed_at === "string") &&
    Object.hasOwn(value, "output") &&
    (value.error === null || isPredictionError(value.error)) &&
    (value.gateway_log_id === null || typeof value.gateway_log_id === "string")
  );
}

function isPredictionError(value: unknown): value is PredictionError {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.guidance === undefined || typeof value.guidance === "string")
  );
}

function isPredictionEventType(value: unknown): value is PredictionEventType {
  return (
    value === "prediction.started" ||
    value === "prediction.succeeded" ||
    value === "prediction.failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
