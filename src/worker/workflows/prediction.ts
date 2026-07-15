import { deliveryIdFor } from "../ids";
import { normalizeInferenceOutput } from "../normalize";
import { validatePredictionContext, ValidationError } from "../validation";
import type {
  PredictionError,
  PredictionSnapshot,
  PredictionWorkflowEnv,
  PredictionWorkflowParams,
  WebhookDeliveryParams,
  WebhookEnvelope,
} from "../types";
import { createCompletedEnvelope, createStartedEnvelope } from "./events";

interface PredictionStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: {
      retries: { limit: number; delay: number; backoff?: "constant" };
    },
    callback: () => Promise<T>,
  ): Promise<T>;
}

type InferenceStepResult = {
  startedAt: string;
  completedAt: string;
  gatewayLogId: string | null;
} & (
  | { ok: true; output: PredictionSnapshot["output"] }
  | { ok: false; error: PredictionError }
);

/**
 * The prediction Workflow: optionally announce the start, run inference
 * exactly once, then hand the result envelope off to the delivery Workflow.
 * Each side effect lives in its own step so a replayed Workflow never
 * repeats work that already committed.
 */
export async function runPrediction(
  env: PredictionWorkflowEnv,
  params: Readonly<PredictionWorkflowParams>,
  step: PredictionStep,
): Promise<PredictionSnapshot> {
  validateWorkflowParams(params);

  // Capture the start time inside a step so replays reuse the same value.
  const startedAt = await step.do("record inference start", async () =>
    new Date().toISOString(),
  );

  if (params.webhook.events.includes("started")) {
    await startDeliveryWorkflow(
      env,
      step,
      params.webhook.url,
      createStartedEnvelope(params, startedAt),
      "started",
    );
  }

  const inference = await runInference(env, params, step, startedAt);
  const prediction = createPredictionSnapshot(params, inference);

  if (params.webhook.events.includes("completed")) {
    await startDeliveryWorkflow(
      env,
      step,
      params.webhook.url,
      createCompletedEnvelope(params, prediction),
      "completed",
    );
  }

  return prediction;
}

async function runInference(
  env: PredictionWorkflowEnv,
  params: Readonly<PredictionWorkflowParams>,
  step: PredictionStep,
  startedAt: string,
): Promise<InferenceStepResult> {
  return step.do(
    "run AI inference",
    // Retrying an ambiguous provider response could duplicate inference charges.
    { retries: { limit: 0, delay: 0, backoff: "constant" } },
    async (): Promise<InferenceStepResult> => {
      try {
        const output = await env.AI.run(
          params.model,
          params.input,
          params.aiOptions,
        );
        const completedAt = new Date().toISOString();
        const normalized = await normalizeInferenceOutput(
          env,
          params.predictionId,
          output,
          new Date(completedAt),
        );

        if (!normalized.ok) {
          return {
            ok: false,
            error: normalized.error,
            startedAt,
            completedAt,
            gatewayLogId: env.AI.aiGatewayLogId,
          };
        }

        return {
          ok: true,
          output: normalized.output,
          startedAt,
          completedAt,
          gatewayLogId: env.AI.aiGatewayLogId,
        };
      } catch (error) {
        return {
          ok: false,
          error: sanitizeInferenceError(error),
          startedAt,
          completedAt: new Date().toISOString(),
          gatewayLogId: env.AI.aiGatewayLogId,
        };
      }
    },
  );
}

function createPredictionSnapshot(
  params: Readonly<PredictionWorkflowParams>,
  inference: InferenceStepResult,
): PredictionSnapshot {
  return inference.ok
    ? {
        id: params.predictionId,
        model: params.model,
        context: params.context,
        status: "succeeded",
        created_at: params.createdAt,
        started_at: inference.startedAt,
        completed_at: inference.completedAt,
        output: inference.output,
        error: null,
        gateway_log_id: inference.gatewayLogId,
      }
    : {
        id: params.predictionId,
        model: params.model,
        context: params.context,
        status: "failed",
        created_at: params.createdAt,
        started_at: inference.startedAt,
        completed_at: inference.completedAt,
        output: null,
        error: inference.error,
        gateway_log_id: inference.gatewayLogId,
      };
}

/**
 * Deliberately discard the provider error: raw messages can carry internal
 * details (prompts, endpoints, account info) that must not leak into
 * outbound webhooks. Use the gateway log ID to investigate failures.
 */
export function sanitizeInferenceError(_error: unknown): PredictionError {
  return {
    code: "inference_error",
    message: "AI inference failed.",
  };
}

function validateWorkflowParams(
  params: Readonly<PredictionWorkflowParams>,
): void {
  validatePredictionContext(params.context);
  if (
    !params.predictionId.startsWith("pred_") ||
    !params.model ||
    !params.createdAt ||
    !params.webhook.url ||
    !params.aiOptions.gateway.id
  ) {
    throw new ValidationError("invalid prediction Workflow parameters");
  }
}

/**
 * Spawn the delivery Workflow for one webhook event. Delivery runs as its
 * own Workflow so its retry schedule (up to ~34 hours) doesn't keep the
 * prediction Workflow alive.
 */
async function startDeliveryWorkflow(
  env: PredictionWorkflowEnv,
  step: PredictionStep,
  url: string,
  envelope: WebhookEnvelope,
  phase: "started" | "completed",
): Promise<void> {
  await step.do(`start ${phase} webhook delivery`, async () => {
    const id = deliveryIdFor(envelope.id);
    const params: WebhookDeliveryParams = { url, envelope };

    try {
      await env.AI_WEBHOOK_DELIVERIES.create({ id, params });
    } catch (createError) {
      // create() rejects duplicate IDs. If a delivery with this ID already
      // exists, a previous attempt of this step got through — treat that as
      // success rather than delivering twice.
      const existing = await env.AI_WEBHOOK_DELIVERIES.get(id);
      const status = await existing.status();

      if (status.status === "unknown") {
        throw createError;
      }
    }

    return { deliveryId: id };
  });
}
