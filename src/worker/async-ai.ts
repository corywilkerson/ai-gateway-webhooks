import { createPredictionId } from "./ids";
import { validateRunArguments, ValidationError } from "./validation";
import type {
  AsyncAI,
  AsyncAIEnv,
  AsyncAIRunOptions,
  PersistedAIOptions,
  PredictionWorkflowParams,
} from "./types";

/**
 * The main entry point: an async counterpart to env.AI.run(). Instead of
 * awaiting inference, it validates the request, queues a prediction
 * Workflow, and returns immediately; results arrive via webhook.
 */
export function createAsyncAI(env: AsyncAIEnv): AsyncAI {
  return {
    async run(model, input, options) {
      assertRequiredBindings(env);

      const webhook = validateRunArguments(
        model,
        input,
        options,
        env.AI_WEBHOOK_PUBLIC_URL,
      );
      const predictionId = createPredictionId();
      const createdAt = new Date().toISOString();
      const params: PredictionWorkflowParams = {
        predictionId,
        model,
        input,
        context: options.context ?? null,
        aiOptions: createPersistedAIOptions(options),
        webhook,
        createdAt,
      };

      await env.AI_PREDICTIONS.create({ id: predictionId, params });

      return {
        id: predictionId,
        status: "queued",
        createdAt,
      };
    },
  };
}

function assertRequiredBindings(env: AsyncAIEnv): void {
  if (!env.AI || !env.AI_PREDICTIONS) {
    throw new ValidationError("AI and AI_PREDICTIONS bindings are required");
  }
}

/**
 * Copy only the options that should reach env.AI.run() inside the Workflow.
 * Fields are copied individually (rather than spread) so nothing new added
 * to AsyncAIRunOptions is persisted by accident.
 */
function createPersistedAIOptions(
  options: AsyncAIRunOptions,
): PersistedAIOptions {
  const aiOptions: PersistedAIOptions = {
    gateway: {
      ...options.gateway,
      id: options.gateway?.id ?? "default",
    },
  };

  if (options.tags !== undefined) {
    aiOptions.tags = options.tags;
  }

  if (options.returnRawResponse !== undefined) {
    aiOptions.returnRawResponse = options.returnRawResponse;
  }

  if (options.prefix !== undefined) {
    aiOptions.prefix = options.prefix;
  }

  if (options.extraHeaders !== undefined) {
    aiOptions.extraHeaders = options.extraHeaders;
  }

  return aiOptions;
}
