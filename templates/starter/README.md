# ai-gateway-webhooks starter

A minimal Worker that queues async AI predictions and receives results via
signed webhooks, using [ai-gateway-webhooks](https://www.npmjs.com/package/ai-gateway-webhooks).

## Setup

```sh
npm install
npm run secrets   # generates AI_WEBHOOK_SECRET, writes .dev.vars, uploads it
npm run types     # generates worker-configuration.d.ts
```

`npm run secrets` needs an authenticated wrangler (`npx wrangler login`).
Pass `-- --local-only` to skip the upload and only write `.dev.vars`.

## Develop and deploy

```sh
npm run dev
npm run deploy
```

`POST /predictions` queues an example prediction. Point the `webhook.url` in
`src/index.ts` at your receiver, and verify incoming events with
`parseWebhook()` — see the package README.

## Optional: artifact storage for binary or large outputs

Outputs that can't be inlined in a webhook (images, audio, JSON over 256 KiB)
are stored in R2 and delivered as signed, expiring URLs. To enable:

```sh
npx wrangler r2 bucket create <your-worker-name>-ai-artifacts
npm run secrets -- --with-artifacts
```

Then add to `wrangler.jsonc`:

```jsonc
"r2_buckets": [
  { "binding": "AI_ARTIFACTS", "bucket_name": "<your-worker-name>-ai-artifacts" }
],
"vars": { "AI_WEBHOOK_PUBLIC_URL": "https://<your-worker-domain>" }
```

and route artifact downloads in `src/index.ts`:

```ts
import {
  ARTIFACT_PATH_PREFIX,
  handleArtifactRequest,
} from "ai-gateway-webhooks";

if (url.pathname.startsWith(ARTIFACT_PATH_PREFIX)) {
  return handleArtifactRequest(request, env);
}
```
