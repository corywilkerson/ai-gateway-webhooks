import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { runWebhookDelivery } from "./delivery";
import { runPrediction } from "./prediction";
import type {
  PredictionWorkflowEnv,
  PredictionWorkflowParams,
  WebhookDeliveryParams,
  WebhookDeliveryWorkflowEnv,
} from "../types";

export class PredictionWorkflow extends WorkflowEntrypoint<
  PredictionWorkflowEnv,
  PredictionWorkflowParams
> {
  override async run(
    event: Readonly<WorkflowEvent<PredictionWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    return runPrediction(this.env, event.payload, step);
  }
}

export class WebhookDeliveryWorkflow extends WorkflowEntrypoint<
  WebhookDeliveryWorkflowEnv,
  WebhookDeliveryParams
> {
  override async run(
    event: Readonly<WorkflowEvent<WebhookDeliveryParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    return runWebhookDelivery(this.env, event.payload, step);
  }
}
