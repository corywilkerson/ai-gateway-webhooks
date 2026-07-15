export const INLINE_OUTPUT_LIMIT = 256 * 1024;
export const ARTIFACT_TTL_SECONDS = 60 * 60;

export type WebhookEventFilter = "started" | "completed";
export type PredictionStatus = "queued" | "running" | "succeeded" | "failed";
export type PredictionEventType =
  "prediction.started" | "prediction.succeeded" | "prediction.failed";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type PredictionContext = { [key: string]: JsonValue };

export interface AsyncGatewayOptions {
  id?: string;
  cacheKey?: string;
  cacheTtl?: number;
  skipCache?: boolean;
  collectLog?: boolean;
  metadata?: Record<string, string | number | boolean | null | bigint>;
  eventId?: string;
  requestTimeoutMs?: number;
  retries?: {
    maxAttempts?: 1 | 2 | 3 | 4 | 5;
    retryDelayMs?: number;
    backoff?: "constant" | "linear" | "exponential";
  };
}

export interface WebhookOptions {
  url: string;
  events?: WebhookEventFilter[];
}

export interface AsyncAIRunOptions {
  gateway?: AsyncGatewayOptions;
  webhook: WebhookOptions;
  context?: PredictionContext;
  tags?: string[];
  returnRawResponse?: boolean;
  prefix?: string;
  extraHeaders?: Record<string, string>;
}

export interface AsyncAI {
  run<Input extends Record<string, unknown>>(
    model: string,
    input: Input,
    options: AsyncAIRunOptions,
  ): Promise<QueuedPrediction>;
}

export interface PersistedAIOptions extends Omit<
  AsyncAIRunOptions,
  "webhook" | "gateway" | "context"
> {
  gateway: AsyncGatewayOptions & { id: string };
}

export interface QueuedPrediction {
  id: string;
  status: "queued";
  createdAt: string;
}

export interface PredictionError {
  code: string;
  message: string;
  guidance?: string;
}

export interface ArtifactOutput {
  type: "artifact";
  url: string;
  content_type: string;
  size: number;
  expires_at: string;
}

export interface PredictionSnapshot {
  id: string;
  model: string;
  context: PredictionContext | null;
  status: Exclude<PredictionStatus, "queued">;
  created_at: string;
  started_at: string;
  completed_at: string | null;
  output: JsonValue | ArtifactOutput | null;
  error: PredictionError | null;
  gateway_log_id: string | null;
}

export interface WebhookEnvelope {
  id: string;
  type: PredictionEventType;
  created_at: string;
  data: {
    prediction: PredictionSnapshot;
  };
}

export interface PredictionWorkflowParams {
  predictionId: string;
  model: string;
  input: Record<string, unknown>;
  context: PredictionContext | null;
  aiOptions: PersistedAIOptions;
  webhook: {
    url: string;
    events: WebhookEventFilter[];
  };
  createdAt: string;
}

export interface WebhookDeliveryParams {
  url: string;
  envelope: WebhookEnvelope;
}

export interface AIInferenceBinding {
  aiGatewayLogId: string | null;
  run(
    model: string,
    input: Record<string, unknown>,
    options?: PersistedAIOptions,
  ): Promise<unknown>;
}

export interface PredictionWorkflowEnv {
  AI: AIInferenceBinding;
  AI_WEBHOOK_DELIVERIES: Workflow<WebhookDeliveryParams>;
  AI_ARTIFACTS?: R2Bucket;
  AI_ARTIFACT_SECRET?: string;
  AI_WEBHOOK_PUBLIC_URL?: string;
}

export interface WebhookDeliveryWorkflowEnv {
  AI_WEBHOOK_SECRET: string;
}

export interface AsyncAIEnv {
  AI: AIInferenceBinding;
  AI_PREDICTIONS: Workflow<PredictionWorkflowParams>;
  AI_WEBHOOK_PUBLIC_URL?: string;
}

export interface ArtifactRequestEnv {
  AI_ARTIFACTS?: R2Bucket;
  AI_ARTIFACT_SECRET?: string;
}

export interface WebhookSignatureHeaders {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
}

export interface DeliveryAttemptResult {
  accepted: boolean;
  status: number | null;
  attemptedAt: string;
}
