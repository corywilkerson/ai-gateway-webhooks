# ai-gateway-webhooks

Durable, signed lifecycle webhooks for Cloudflare AI Gateway.

`env.AI.run()` holds a request open until inference finishes — painful for slow models, long generations, or any caller that doesn't want to wait. This package makes inference fire-and-forget while keeping the familiar `run()` shape: queue a prediction, respond immediately, and have the result delivered to your webhook.

How it works:

1. `ai.run(model, input, { webhook })` validates the request, queues a Cloudflare Workflow, and immediately returns `{ id, status: "queued", createdAt }`.
2. The Workflow runs inference through AI Gateway, optionally announcing `prediction.started` first.
3. A separate delivery Workflow POSTs the signed `prediction.succeeded` or `prediction.failed` event to your URL, retrying for up to ~34 hours if your receiver is down.

```ts
import { createAsyncAI } from "ai-gateway-webhooks";

const ai = createAsyncAI(env);
const prediction = await ai.run(
  "openai/gpt-4.1-mini",
  { messages: [{ role: "user", content: "Hello" }] },
  {
    gateway: { id: "default" },
    webhook: {
      url: "https://example.com/hooks/ai",
      events: ["started", "completed"],
    },
    context: {
      orderId: "ord_123",
      customerId: "cus_456",
    },
  },
);

// { id: "pred_…", status: "queued", createdAt: "…" }
```

The default gateway is `"default"`; Cloudflare creates it on first authenticated use. Third-party models use AI Gateway Unified Billing, so provider API keys are not needed. Provider-native BYOK proxying is outside this package's scope.

## Get started

Scaffold a new Worker from the [starter template](./templates/starter) with `create-cloudflare`:

```sh
npm create cloudflare@latest my-worker -- --template=corywilkerson/ai-gateway-webhooks/templates/starter
cd my-worker
npm run secrets
```

The template is a complete Worker: an example route that queues a prediction, the Workflow bindings already configured, and scripts for `dev`, `deploy`, and `secrets`. Its README covers the optional R2 artifact setup.

`npm run secrets` (a thin wrapper around `npx ai-gateway-webhooks secrets`) generates the `whsec_…` webhook signing secret, writes it to `.dev.vars` for local development, and uploads it with `wrangler secret put`. Add `--with-artifacts` to also generate the artifact URL signing secret, or `--local-only` to skip the upload.

Already have a Worker? `npm install ai-gateway-webhooks`, re-export the two Workflow classes from your entrypoint —

```ts
export {
  PredictionWorkflow,
  WebhookDeliveryWorkflow,
} from "ai-gateway-webhooks";
```

— copy the `ai` and `workflows` bindings from the [starter's `wrangler.jsonc`](./templates/starter/wrangler.jsonc) into yours, rerun `wrangler types`, and run `npx ai-gateway-webhooks secrets`.

## Bindings

The package finds its resources by conventional binding names:

- `AI`: Workers AI binding.
- `AI_PREDICTIONS`: Workflow bound to `PredictionWorkflow`.
- `AI_WEBHOOK_DELIVERIES`: Workflow bound to `WebhookDeliveryWorkflow`.
- `AI_WEBHOOK_SECRET`: secret generated as `whsec_<base64>`.

Optional, for artifact storage:

- `AI_ARTIFACTS`: R2 bucket.
- `AI_ARTIFACT_SECRET`: independent artifact URL signing secret.
- `AI_WEBHOOK_PUBLIC_URL`: public base URL of the Worker that serves downloads.

## Events

`events` accepts `"started"` and `"completed"`. It defaults to `["completed"]`.

- `started` sends `prediction.started` when inference begins.
- `completed` sends `prediction.succeeded` or `prediction.failed`.

An event has this envelope:

```json
{
  "id": "evt_…_completed",
  "type": "prediction.succeeded",
  "created_at": "2026-07-14T20:00:00.000Z",
  "data": {
    "prediction": {
      "id": "pred_…",
      "model": "openai/gpt-4.1-mini",
      "context": {
        "orderId": "ord_123",
        "customerId": "cus_456"
      },
      "status": "succeeded",
      "created_at": "…",
      "started_at": "…",
      "completed_at": "…",
      "output": {},
      "error": null,
      "gateway_log_id": "…"
    }
  }
}
```

Event IDs and the `webhook-id` header remain stable across retries. The request timestamp and signature are regenerated for every attempt.

### Correlate events with your application

Pass an optional `context` object to associate a prediction with your own records:

```ts
const prediction = await ai.run(model, input, {
  webhook: { url: "https://example.com/hooks/ai" },
  context: {
    orderId: "ord_123",
    customerId: "cus_456",
  },
});
```

Context is echoed unchanged in started, succeeded, and failed events. It is not sent to the model or AI Gateway. It must contain only JSON values and is limited to 16 KiB; omit it when no correlation data is needed, in which case events contain `"context": null`.

## Receive and verify webhooks

`parseWebhook()` safely reads the exact raw body, verifies its signature and timestamp, validates the event shape, and returns a typed envelope. Invalid requests throw `WebhookVerificationError`.

```ts
import { parseWebhook, WebhookVerificationError } from "ai-gateway-webhooks";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const event = await parseWebhook(request, env.AI_WEBHOOK_SECRET);
      // Atomically deduplicate on request.headers.get("webhook-id") before work.
      await processEvent(event);
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return new Response("Invalid webhook", { status: 401 });
      }
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;
```

The helper accepts at most 1 MiB by default, preventing an unbounded public request from consuming Worker memory. `verifyWebhookSignature()` remains available when a framework has already provided the exact raw body.

Verifying signatures on your receiver is technically optional — events arrive whether or not you check them. But your webhook URL is a public, unauthenticated endpoint: without verification, anyone who discovers it can forge a `prediction.succeeded` event with any payload they like. Use `parseWebhook()` unless you have a specific reason not to.

Signatures follow the Standard Webhooks shape. The signed content is `{webhook-id}.{webhook-timestamp}.{exact raw body}`, using HMAC-SHA256.

Receivers must deduplicate by `webhook-id`. Delivery is at least once, not exactly once; duplicates and rare out-of-order events are possible. Return any `2xx` only after the event is durably accepted.

The delivery Workflow does not follow redirects and does not read or log response bodies. Connection errors, timeouts, `3xx`, `4xx`, and `5xx` are retried at approximately 0 seconds, 10 seconds, 1 minute, 5 minutes, 30 minutes, 2 hours, 8 hours, and 24 hours.

## Artifacts

JSON-serializable output up to 256 KiB is included directly. Binary output and larger JSON are stored in R2 when the optional artifact storage is configured. Streamed outputs are buffered in Worker memory before storage (R2 requires a known length) and are capped at 64 MiB; larger streams fail the prediction. Common PNG, JPEG, GIF, WebP, WAV, MP3, Ogg, FLAC, and MP4 types are detected from headers or magic bytes. Other binary data uses `application/octet-stream`.

Artifact output looks like:

```json
{
  "type": "artifact",
  "url": "https://worker.example.com/_ai-gateway-webhooks/artifacts/…?expires=…&signature=…",
  "content_type": "image/png",
  "size": 12345,
  "expires_at": "…"
}
```

Route artifact requests from your Worker's fetch handler:

```ts
import {
  ARTIFACT_PATH_PREFIX,
  handleArtifactRequest,
} from "ai-gateway-webhooks";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith(ARTIFACT_PATH_PREFIX)) {
      return handleArtifactRequest(request, env);
    }
    // Your other routes…
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

Download URLs use an independent HMAC signature and expire after one hour. Without complete R2 configuration, binary or oversized output becomes a `prediction.failed` event with `error.code = "artifact_storage_required"` and setup guidance.

## Delivery and inference guarantees

Inference is intentionally not automatically retried. A provider call that fails ambiguously could otherwise create duplicate charges. The successful result of a Workflow step is replay-protected once persisted, but exactly-once upstream execution cannot be promised if execution is interrupted between the provider response and durable persistence.

Webhook delivery is isolated in `WebhookDeliveryWorkflow`, so a slow or unavailable receiver never holds up inference. Stable child Workflow IDs make Workflow replay duplicate-safe. The webhook receiver remains the system of record; no database, polling API, list API, dashboard, cancellation, or streaming event API is included in v1.

Webhook URLs must be credential-free HTTPS URLs. URLs on the deployment's own `AI_WEBHOOK_PUBLIC_URL` origin are rejected to prevent loops. Inference errors are converted to a generic public error without stack traces, provider response bodies, credentials, or secret-bearing messages.

Because failure events are sanitized, they intentionally carry no diagnostic detail. To find out why a prediction failed, look up its `gateway_log_id` in your AI Gateway logs (Cloudflare dashboard → AI → AI Gateway → your gateway → Logs), which record the underlying provider request and error.

See Cloudflare's [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/) and [AI Gateway Worker binding methods](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/) for current platform details.

## Repository layout

- `src/worker/` contains the runtime code bundled into a user's Worker.
- `src/worker/workflows/` contains prediction and webhook-delivery orchestration.
- `src/cli/` contains the Node-only `secrets` command.
- `templates/starter/` contains the standalone starter Worker.

The Worker and CLI have separate build entrypoints, preventing Node-only CLI code from entering the deployed Worker bundle.

## License

[MIT](./LICENSE)
