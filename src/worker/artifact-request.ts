import { ARTIFACT_PATH_PREFIX } from "./artifacts";
import { verifyArtifactPathSignature } from "./signing";
import type { ArtifactRequestEnv } from "./types";

/**
 * Serve a stored artifact for a signed URL produced by storeArtifact.
 * Requests must be GET/HEAD, name an expected artifact key, carry an
 * unexpired expiry, and have a valid signature over path + expiry.
 */
export async function handleArtifactRequest(
  request: Request,
  env: ArtifactRequestEnv,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }
  if (!env.AI_ARTIFACTS || !env.AI_ARTIFACT_SECRET) {
    return new Response("Artifact storage is not configured", { status: 404 });
  }

  const url = new URL(request.url);
  if (!url.pathname.startsWith(ARTIFACT_PATH_PREFIX)) {
    return new Response("Not found", { status: 404 });
  }

  const key = artifactKeyFrom(url);
  if (!key) {
    return new Response("Invalid artifact URL", { status: 400 });
  }

  const signatureError = await validateSignature(url, env.AI_ARTIFACT_SECRET);

  if (signatureError) {
    return signatureError;
  }

  if (request.method === "HEAD") {
    const object = await env.AI_ARTIFACTS.head(key);
    return object
      ? createArtifactResponse(object, null)
      : new Response("Not found", { status: 404 });
  }

  const object = await env.AI_ARTIFACTS.get(key);
  return object
    ? createArtifactResponse(object, object.body)
    : new Response("Not found", { status: 404 });
}

function artifactKeyFrom(url: URL): string | null {
  const encodedKey = url.pathname.slice(ARTIFACT_PATH_PREFIX.length);

  let key: string;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return null;
  }

  // Only keys that storeArtifact can produce are servable; this blocks
  // traversal into any other objects sharing the bucket.
  const safe =
    key.startsWith("predictions/pred_") &&
    key.endsWith("/output") &&
    !key.includes("..") &&
    !key.includes("\\");
  return safe ? key : null;
}

async function validateSignature(
  url: URL,
  secret: string,
): Promise<Response | null> {
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature");

  if (!Number.isInteger(expires) || !signature) {
    return new Response("Invalid artifact signature", { status: 403 });
  }

  if (Math.floor(Date.now() / 1000) > expires) {
    return new Response("Artifact URL expired", { status: 403 });
  }

  const valid = await verifyArtifactPathSignature(
    secret,
    url.pathname,
    expires,
    signature,
  );
  return valid
    ? null
    : new Response("Invalid artifact signature", { status: 403 });
}

function createArtifactResponse(
  object: R2Object,
  body: ReadableStream | null,
): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-length", String(object.size));
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(body, { status: 200, headers });
}
