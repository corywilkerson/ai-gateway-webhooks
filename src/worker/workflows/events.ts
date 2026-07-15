import { eventIdFor } from "../ids";
import type {
  PredictionSnapshot,
  PredictionWorkflowParams,
  WebhookEnvelope,
} from "../types";

export function createStartedEnvelope(
  params: Readonly<PredictionWorkflowParams>,
  startedAt: string,
): WebhookEnvelope {
  return createEnvelope(params, "started", {
    id: params.predictionId,
    model: params.model,
    context: params.context,
    status: "running",
    created_at: params.createdAt,
    started_at: startedAt,
    completed_at: null,
    output: null,
    error: null,
    gateway_log_id: null,
  });
}

export function createCompletedEnvelope(
  params: Readonly<PredictionWorkflowParams>,
  prediction: PredictionSnapshot,
): WebhookEnvelope {
  return createEnvelope(params, "completed", prediction);
}

function createEnvelope(
  params: Readonly<PredictionWorkflowParams>,
  phase: "started" | "completed",
  prediction: PredictionSnapshot,
): WebhookEnvelope {
  return {
    id: eventIdFor(params.predictionId, phase),
    type: eventTypeFor(phase, prediction.status),
    created_at: prediction.completed_at ?? prediction.started_at,
    data: { prediction },
  };
}

function eventTypeFor(
  phase: "started" | "completed",
  status: PredictionSnapshot["status"],
): WebhookEnvelope["type"] {
  if (phase === "started") {
    return "prediction.started";
  }

  return status === "succeeded" ? "prediction.succeeded" : "prediction.failed";
}
