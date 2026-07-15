import { describe, expect, it } from "vitest";
import { createAsyncAI } from "../src/worker/async-ai";
import { deliverWebhookAttempt } from "../src/worker/workflows/delivery";
import { runPrediction } from "../src/worker/workflows/prediction";
import type {
  AsyncAIEnv,
  PredictionWorkflowEnv,
  PredictionWorkflowParams,
  WebhookDeliveryParams,
  WebhookDeliveryWorkflowEnv,
} from "../src/worker/types";

class InstantStep {
  readonly names: string[] = [];

  async do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  async do<T>(
    name: string,
    config: { retries: { limit: number; delay: number; backoff?: "constant" } },
    callback: () => Promise<T>,
  ): Promise<T>;
  async do<T>(
    name: string,
    configOrCallback:
      | { retries: { limit: number; delay: number; backoff?: "constant" } }
      | (() => Promise<T>),
    callback?: () => Promise<T>,
  ): Promise<T> {
    this.names.push(name);
    return typeof configOrCallback === "function"
      ? configOrCallback()
      : required(callback)();
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing test callback");
  return value;
}

function workflowParams(
  events: ("started" | "completed")[] = ["completed"],
): PredictionWorkflowParams {
  return {
    predictionId: "pred_1234567890",
    model: "openai/gpt-4.1-mini",
    input: { messages: [{ role: "user", content: "Hello" }] },
    context: null,
    aiOptions: { gateway: { id: "default" } },
    webhook: { url: "https://receiver.example/hooks", events },
    createdAt: "2026-07-14T19:59:00.000Z",
  };
}

function workflowRecorder(options?: {
  failInference?: boolean;
  duplicateDeliveries?: boolean;
}): {
  env: AsyncAIEnv & PredictionWorkflowEnv & WebhookDeliveryWorkflowEnv;
  deliveries: WebhookDeliveryParams[];
} {
  const deliveries: WebhookDeliveryParams[] = [];
  const instance = {
    id: "delivery",
    async pause() {},
    async resume() {},
    async terminate() {},
    async restart() {},
    async status() {
      return { status: "complete" as const };
    },
    async sendEvent() {},
  } satisfies WorkflowInstance;
  const deliveryWorkflow = {
    async create(value?: WorkflowInstanceCreateOptions<WebhookDeliveryParams>) {
      if (value?.params) deliveries.push(value.params);
      if (options?.duplicateDeliveries)
        throw new Error("instance already exists");
      return instance;
    },
    async get() {
      return instance;
    },
    async createBatch() {
      return [];
    },
  } satisfies Workflow<WebhookDeliveryParams>;
  const predictionWorkflow = {
    async create() {
      return instance;
    },
    async get() {
      return instance;
    },
    async createBatch() {
      return [];
    },
  } satisfies Workflow<PredictionWorkflowParams>;
  const ai = {
    aiGatewayLogId: "gateway-log-1",
    async run() {
      if (options?.failInference) {
        throw new Error("provider said api_key=super-secret");
      }
      return { response: "Hello" };
    },
  };
  return {
    env: {
      AI: ai,
      AI_PREDICTIONS: predictionWorkflow,
      AI_WEBHOOK_DELIVERIES: deliveryWorkflow,
      AI_WEBHOOK_SECRET: "whsec_c2VjcmV0",
    },
    deliveries,
  };
}

describe("prediction Workflow", () => {
  it("returns a queued handle immediately after creating a stable Workflow instance", async () => {
    let createdId: string | undefined;
    let createdParams: PredictionWorkflowParams | undefined;
    const { env } = workflowRecorder();
    env.AI_PREDICTIONS = {
      async create(value) {
        createdId = value?.id;
        createdParams = value?.params;
        return env.AI_WEBHOOK_DELIVERIES.get("instance");
      },
      async get(id) {
        return env.AI_WEBHOOK_DELIVERIES.get(id);
      },
      async createBatch() {
        return [];
      },
    } satisfies Workflow<PredictionWorkflowParams>;

    const result = await createAsyncAI(env).run(
      "openai/gpt-4.1-mini",
      { messages: [{ role: "user", content: "Hello" }] },
      {
        webhook: { url: "https://receiver.example/hooks" },
        context: { orderId: "ord_123", customerId: "cus_456" },
      },
    );
    expect(result).toMatchObject({ status: "queued" });
    expect(result.id).toMatch(/^pred_[a-f0-9]{32}$/);
    expect(createdId).toBe(result.id);
    expect(createdParams?.aiOptions.gateway.id).toBe("default");
    expect(createdParams?.context).toEqual({
      orderId: "ord_123",
      customerId: "cus_456",
    });
  });

  it("emits started and succeeded events through separate delivery Workflows", async () => {
    const { env, deliveries } = workflowRecorder();
    const params = workflowParams(["started", "completed"]);
    params.context = { orderId: "ord_123" };
    const result = await runPrediction(env, params, new InstantStep());
    expect(result).toMatchObject({
      status: "succeeded",
      output: { response: "Hello" },
      gateway_log_id: "gateway-log-1",
    });
    expect(deliveries.map((delivery) => delivery.envelope.type)).toEqual([
      "prediction.started",
      "prediction.succeeded",
    ]);
    expect(
      deliveries.map((delivery) => delivery.envelope.data.prediction.context),
    ).toEqual([{ orderId: "ord_123" }, { orderId: "ord_123" }]);
  });

  it("defaults to completed-only behavior", async () => {
    const { env, deliveries } = workflowRecorder();
    await runPrediction(env, workflowParams(), new InstantStep());
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.envelope.type).toBe("prediction.succeeded");
  });

  it("honors a started-only event filter", async () => {
    const { env, deliveries } = workflowRecorder();
    await runPrediction(env, workflowParams(["started"]), new InstantStep());
    expect(deliveries.map((delivery) => delivery.envelope.type)).toEqual([
      "prediction.started",
    ]);
  });

  it("turns inference exceptions into one signed, redacted failed event", async () => {
    const { env, deliveries } = workflowRecorder({ failInference: true });
    const result = await runPrediction(
      env,
      workflowParams(),
      new InstantStep(),
    );
    expect(result.error).toEqual({
      code: "inference_error",
      message: "AI inference failed.",
    });
    expect(deliveries).toHaveLength(1);
    const delivery = required(deliveries[0]);
    expect(delivery.envelope.type).toBe("prediction.failed");
    expect(JSON.stringify(delivery)).not.toContain("super-secret");

    let headers = new Headers();
    await deliverWebhookAttempt(
      env,
      delivery,
      async (_input, init) => {
        headers = new Headers(init?.headers);
        return new Response(null, { status: 204 });
      },
      new Date("2026-07-14T20:00:00Z"),
    );
    expect(headers.get("webhook-id")).toBe(delivery.envelope.id);
    expect(headers.get("webhook-signature")).toMatch(/^v1,/);
  });

  it("treats existing child Workflow IDs as replay-safe duplicates", async () => {
    const { env } = workflowRecorder({ duplicateDeliveries: true });
    await expect(
      runPrediction(env, workflowParams(), new InstantStep()),
    ).resolves.toMatchObject({
      status: "succeeded",
    });
  });
});
