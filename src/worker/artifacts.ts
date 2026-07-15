import { detectContentType } from "./content-types";
import { signArtifactPath } from "./signing";
import {
  ARTIFACT_TTL_SECONDS,
  type ArtifactOutput,
  type ArtifactRequestEnv,
} from "./types";

export const ARTIFACT_PATH_PREFIX = "/_ai-gateway-webhooks/artifacts/";

export class ArtifactStorageRequiredError extends Error {
  override readonly name = "ArtifactStorageRequiredError";
  readonly code = "artifact_storage_required";
  readonly guidance =
    "Configure the AI_ARTIFACTS, AI_ARTIFACT_SECRET, and AI_WEBHOOK_PUBLIC_URL " +
    "bindings; see the Artifacts section of the ai-gateway-webhooks README.";
}

export interface ArtifactStorageEnv extends ArtifactRequestEnv {
  AI_WEBHOOK_PUBLIC_URL?: string;
}

type ArtifactBody =
  ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | Blob | string;

/**
 * Write an inference output to R2 and return a time-limited, signed URL that
 * points back at this Worker's artifact route (see artifact-request.ts).
 *
 * When no content type is supplied, one is sniffed from the first bytes of
 * the body; failing that, it falls back to application/octet-stream.
 */
export async function storeArtifact(
  env: ArtifactStorageEnv,
  predictionId: string,
  body: ArtifactBody,
  suppliedContentType: string | null,
  now: Date,
): Promise<ArtifactOutput> {
  if (
    !env.AI_ARTIFACTS ||
    !env.AI_ARTIFACT_SECRET ||
    !env.AI_WEBHOOK_PUBLIC_URL
  ) {
    throw new ArtifactStorageRequiredError();
  }

  const key = `predictions/${predictionId}/output`;
  let value: ReadableStream<Uint8Array> | ArrayBuffer | Blob | string;
  let contentType = normalizeContentType(suppliedContentType);

  if (body instanceof ReadableStream) {
    // Streams can only be read once, so peek at the first chunk for content
    // sniffing and hand R2 a replacement stream that replays it.
    const peeked = await peekAndReplayStream(body);
    value = peeked.stream;
    contentType ??= detectContentType(peeked.prefix);
  } else if (typeof body === "string") {
    // Strings only arrive here as JSON that was too large to inline.
    value = body;
    contentType ??= "application/json";
  } else if (body instanceof Blob) {
    const prefix = new Uint8Array(await body.slice(0, 16).arrayBuffer());
    value = body;
    contentType ??=
      normalizeContentType(body.type) ?? detectContentType(prefix);
  } else {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    value = new Uint8Array(bytes).buffer;
    contentType ??= detectContentType(bytes.subarray(0, 16));
  }

  contentType ??= "application/octet-stream";

  const stored = await env.AI_ARTIFACTS.put(key, value, {
    httpMetadata: {
      contentType,
      cacheControl: "private, no-store",
    },
  });

  if (!stored) {
    throw new Error("R2 did not return artifact metadata");
  }

  // Build the signed download URL. The signature covers the pathname and
  // expiry, so neither can be tampered with (verified in artifact-request.ts).
  const expires = Math.floor(now.getTime() / 1000) + ARTIFACT_TTL_SECONDS;
  const publicUrl = new URL(env.AI_WEBHOOK_PUBLIC_URL);
  publicUrl.pathname = `${ARTIFACT_PATH_PREFIX}${encodeURIComponent(key)}`;
  publicUrl.search = "";
  publicUrl.hash = "";
  publicUrl.searchParams.set("expires", String(expires));
  publicUrl.searchParams.set(
    "signature",
    await signArtifactPath(env.AI_ARTIFACT_SECRET, publicUrl.pathname, expires),
  );

  return {
    type: "artifact",
    url: publicUrl.toString(),
    content_type: contentType,
    size: stored.size,
    expires_at: new Date(expires * 1000).toISOString(),
  };
}

function normalizeContentType(value: string | null): string | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized || null;
}

/**
 * Read the first chunk of a stream (for content-type sniffing) and return a
 * new stream that yields that chunk first, then the rest of the source —
 * so the caller still sees the complete body.
 */
async function peekAndReplayStream(
  source: ReadableStream<Uint8Array>,
): Promise<{ prefix: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = source.getReader();
  const first = await reader.read();
  const prefix = first.done ? new Uint8Array() : first.value.subarray(0, 16);

  let firstPending = !first.done;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (firstPending && !first.done) {
          firstPending = false;
          controller.enqueue(first.value);
          return;
        }

        const chunk = await reader.read();

        if (chunk.done) {
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return { prefix, stream };
}
