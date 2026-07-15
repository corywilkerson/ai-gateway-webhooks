import type { WebhookSignatureHeaders } from "./types";

const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return base64ToBytes(padded);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Decode a webhook secret into HMAC key bytes. Standard Webhooks secrets are
 * base64 with a `whsec_` prefix; anything that isn't valid base64 is treated
 * as a raw string key.
 */
function webhookSecretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const encoded = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  try {
    return base64ToBytes(encoded);
  } catch {
    return encoder.encode(encoded);
  }
}

async function hmac(
  keyBytes: Uint8Array<ArrayBuffer>,
  content: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(content)),
  );
}

/**
 * Produce Standard Webhooks (https://www.standardwebhooks.com) signature
 * headers: an HMAC-SHA256 over `{id}.{timestamp}.{body}`.
 */
export async function signWebhook(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string,
): Promise<WebhookSignatureHeaders> {
  const signature = await hmac(
    webhookSecretBytes(secret),
    `${id}.${timestamp}.${rawBody}`,
  );
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${bytesToBase64(signature)}`,
  };
}

async function fixedLengthDigest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

/**
 * Compare two strings without leaking where they differ. Both sides are
 * hashed first so the comparison always runs over equal-length inputs,
 * which also hides any length difference.
 */
export async function timingSafeStringEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    fixedLengthDigest(left),
    fixedLengthDigest(right),
  ]);

  // Workers exposes a non-standard crypto.subtle.timingSafeEqual; prefer it.
  if (hasTimingSafeEqual(crypto.subtle)) {
    return crypto.subtle.timingSafeEqual(leftDigest, rightDigest);
  }

  // Fallback constant-time comparison for other runtimes.
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function hasTimingSafeEqual(subtle: SubtleCrypto): subtle is SubtleCrypto & {
  timingSafeEqual(left: ArrayBuffer, right: ArrayBuffer): boolean;
} {
  return typeof Reflect.get(subtle, "timingSafeEqual") === "function";
}

export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  headers: Headers | WebhookSignatureHeaders | Record<string, string>,
  toleranceSeconds = 5 * 60,
  now = Date.now(),
): Promise<boolean> {
  const id = webhookHeader(headers, "webhook-id");
  const timestamp = webhookHeader(headers, "webhook-timestamp");
  const provided = webhookHeader(headers, "webhook-signature");

  if (!id || !timestamp || !provided) {
    return false;
  }

  // Reject timestamps outside the tolerance window to limit replay attacks.
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds)) {
    return false;
  }
  if (Math.abs(Math.floor(now / 1000) - seconds) > toleranceSeconds) {
    return false;
  }

  // Re-sign the payload with the shared secret and compare.
  const expected = await signWebhook(secret, id, timestamp, rawBody);
  return timingSafeStringEqual(provided, expected["webhook-signature"]);
}

function webhookHeader(
  headers: Headers | WebhookSignatureHeaders | Record<string, string>,
  name: keyof WebhookSignatureHeaders,
): string | null {
  if (headers instanceof Headers) {
    return headers.get(name);
  }

  return headers[name] ?? null;
}

export async function signArtifactPath(
  secret: string,
  pathname: string,
  expires: number,
): Promise<string> {
  const signature = await hmac(
    encoder.encode(secret),
    `${pathname}.${expires}`,
  );

  return bytesToBase64Url(signature);
}

export async function verifyArtifactPathSignature(
  secret: string,
  pathname: string,
  expires: number,
  provided: string,
): Promise<boolean> {
  const expected = await signArtifactPath(secret, pathname, expires);
  return timingSafeStringEqual(provided, expected);
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return base64UrlToBytes(value);
}
