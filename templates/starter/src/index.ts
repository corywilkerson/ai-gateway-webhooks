import { createAsyncAI } from "ai-gateway-webhooks";

export {
  PredictionWorkflow,
  WebhookDeliveryWorkflow,
} from "ai-gateway-webhooks";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/predictions") {
      return new Response("Not found", { status: 404 });
    }

    return queueExamplePrediction(env);
  },
} satisfies ExportedHandler<Env>;

async function queueExamplePrediction(env: Env): Promise<Response> {
  const ai = createAsyncAI(env);
  const prediction = await ai.run(
    "openai/gpt-4.1-mini",
    { messages: [{ role: "user", content: "Hello" }] },
    {
      webhook: {
        url: "https://example.com/hooks/ai",
      },
    },
  );

  return Response.json(prediction, { status: 202 });
}
