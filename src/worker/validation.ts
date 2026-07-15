import type {
  AsyncAIRunOptions,
  PredictionContext,
  WebhookEventFilter,
  WebhookOptions,
} from "./types";

const INPUT_LIMIT_BYTES = 900 * 1024;
export const PREDICTION_CONTEXT_LIMIT = 16 * 1024;
const ALLOWED_EVENTS = new Set<WebhookEventFilter>(["started", "completed"]);

export class ValidationError extends Error {
  override readonly name = "ValidationError";
}

/**
 * Validate a webhook destination URL. HTTPS only, no embedded credentials
 * or fragments, and it must not point back at this deployment (which would
 * let a prediction trigger itself in a loop).
 */
export function validateWebhookUrl(
  value: string,
  ownPublicUrl?: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("webhook.url must be a valid absolute URL");
  }

  if (url.protocol !== "https:") {
    throw new ValidationError("webhook.url must use HTTPS");
  }
  if (url.username || url.password) {
    throw new ValidationError("webhook.url must not contain credentials");
  }
  if (url.hash) {
    throw new ValidationError("webhook.url must not contain a URL fragment");
  }

  if (ownPublicUrl) {
    let own: URL;
    try {
      own = new URL(ownPublicUrl);
    } catch {
      throw new ValidationError(
        "AI_WEBHOOK_PUBLIC_URL must be a valid absolute URL",
      );
    }
    if (url.origin === own.origin) {
      throw new ValidationError("webhook.url must not target this deployment");
    }
  }

  return url.toString();
}

export function normalizeWebhookEvents(
  events: WebhookOptions["events"],
): WebhookEventFilter[] {
  if (events === undefined) {
    return ["completed"];
  }

  if (!Array.isArray(events) || events.length === 0) {
    throw new ValidationError("webhook.events must contain at least one event");
  }

  const normalized: WebhookEventFilter[] = [];
  for (const event of events) {
    if (!ALLOWED_EVENTS.has(event)) {
      throw new ValidationError(`unsupported webhook event: ${String(event)}`);
    }

    if (!normalized.includes(event)) {
      normalized.push(event);
    }
  }

  return normalized;
}

export function validateRunArguments(
  model: string,
  input: Record<string, unknown>,
  options: AsyncAIRunOptions,
  ownPublicUrl?: string,
): { url: string; events: WebhookEventFilter[] } {
  validateModel(model);
  validateInput(input);
  validateOptions(options);

  validateWorkflowSerializable(input, "input");
  validateWorkflowSerializable(options, "options");
  validatePredictionContext(options.context);

  const size = serializedSizeInBytes({ model, input, options });
  if (size > INPUT_LIMIT_BYTES) {
    throw new ValidationError(
      `prediction parameters exceed the ${INPUT_LIMIT_BYTES}-byte safety limit`,
    );
  }

  return {
    url: validateWebhookUrl(options.webhook.url, ownPublicUrl),
    events: normalizeWebhookEvents(options.webhook.events),
  };
}

function validateModel(model: string): void {
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new ValidationError("model must be a non-empty string");
  }
}

function validateInput(input: Record<string, unknown>): void {
  if (!isPlainObject(input)) {
    throw new ValidationError("input must be an object");
  }
}

function validateOptions(options: AsyncAIRunOptions): void {
  if (!options || !options.webhook) {
    throw new ValidationError("webhook options are required");
  }

  if (
    options.gateway?.id !== undefined &&
    options.gateway.id.trim().length === 0
  ) {
    throw new ValidationError("gateway.id must be a non-empty string");
  }

  if (
    "signal" in options ||
    "websocket" in options ||
    "queueRequest" in options
  ) {
    throw new ValidationError(
      "signal, websocket, and queueRequest cannot cross a Workflow boundary",
    );
  }
}

export function validatePredictionContext(
  context: PredictionContext | null | undefined,
): void {
  if (context === undefined || context === null) {
    return;
  }

  if (!isPlainObject(context)) {
    throw new ValidationError("context must be a JSON object");
  }

  validateJsonValue(context, "context", new Set<object>());
  const size = new TextEncoder().encode(JSON.stringify(context)).byteLength;

  if (size > PREDICTION_CONTEXT_LIMIT) {
    throw new ValidationError(
      `context exceeds the ${PREDICTION_CONTEXT_LIMIT}-byte limit`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reject values that cannot survive the structured-clone serialization
 * Cloudflare Workflows applies to step parameters, so callers get a clear
 * error at run() time instead of a Workflow failure later. `path` tracks
 * the location (e.g. "input.messages[0]") for the error message.
 */
function validateWorkflowSerializable(
  value: unknown,
  path: string,
  seen = new Set<object>(),
): void {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return;
  }

  if (typeof value === "function" || typeof value === "symbol") {
    throw new ValidationError(`${path} is not Workflow-serializable`);
  }

  // Binary data and Dates survive structured clone as-is.
  if (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Date
  ) {
    return;
  }

  if (
    value instanceof ReadableStream ||
    value instanceof Request ||
    value instanceof Response
  ) {
    throw new ValidationError(`${path} cannot contain streams or HTTP objects`);
  }

  if (typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    throw new ValidationError(`${path} must not contain cycles`);
  }

  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateWorkflowSerializable(item, `${path}[${index}]`, seen),
    );
  } else {
    for (const [key, item] of Object.entries(value)) {
      validateWorkflowSerializable(item, `${path}.${key}`, seen);
    }
  }

  seen.delete(value);
}

function validateJsonValue(
  value: unknown,
  path: string,
  seen: Set<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }

  if (value === undefined || typeof value !== "object") {
    throw new ValidationError(`${path} must contain only JSON values`);
  }

  if (seen.has(value)) {
    throw new ValidationError(`${path} must not contain cycles`);
  }

  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateJsonValue(item, `${path}[${index}]`, seen),
    );
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      validateJsonValue(item, `${path}.${key}`, seen);
    }
  } else {
    throw new ValidationError(`${path} must contain only JSON values`);
  }

  seen.delete(value);
}

/**
 * Estimate the serialized size of the prediction parameters. Binary values
 * are counted by byte length and replaced with null in the JSON, since
 * JSON.stringify would otherwise misrepresent them (or drop them entirely).
 */
function serializedSizeInBytes(value: unknown): number {
  let binaryBytes = 0;
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") {
      return item.toString();
    }

    if (item instanceof ArrayBuffer) {
      binaryBytes += item.byteLength;
      return null;
    }

    if (ArrayBuffer.isView(item)) {
      binaryBytes += item.byteLength;
      return null;
    }

    return item;
  });

  return new TextEncoder().encode(json ?? "").byteLength + binaryBytes;
}
