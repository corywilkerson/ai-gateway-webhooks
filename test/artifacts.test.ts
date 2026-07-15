import { describe, expect, it } from "vitest";
import { handleArtifactRequest } from "../src/worker/artifact-request";
import { ARTIFACT_PATH_PREFIX, storeArtifact } from "../src/worker/artifacts";
import { detectContentType } from "../src/worker/content-types";
import { normalizeInferenceOutput } from "../src/worker/normalize";
import { signArtifactPath } from "../src/worker/signing";

function r2Object(key: string, size: number, contentType: string): R2Object {
  return {
    key,
    version: "v1",
    size,
    etag: "etag",
    httpEtag: '"etag"',
    uploaded: new Date(),
    httpMetadata: { contentType },
    customMetadata: {},
    checksums: {
      toJSON() {
        return {};
      },
    },
    storageClass: "Standard",
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", contentType);
    },
  };
}

describe("artifact normalization and downloads", () => {
  it.each([
    ["PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    ["JPEG", [0xff, 0xd8, 0xff], "image/jpeg"],
    ["MP3", [0x49, 0x44, 0x33], "audio/mpeg"],
  ])("detects %s magic bytes", (_name, bytes, expected) => {
    expect(detectContentType(new Uint8Array(bytes))).toBe(expected);
  });

  it("keeps small JSON inline", async () => {
    await expect(
      normalizeInferenceOutput(
        {},
        "pred_small",
        { response: "ok" },
        new Date(),
      ),
    ).resolves.toEqual({ ok: true, output: { response: "ok" } });
  });

  it("fails oversized JSON with setup guidance when R2 is missing", async () => {
    const result = await normalizeInferenceOutput(
      {},
      "pred_large",
      { response: "x".repeat(256 * 1024) },
      new Date(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "artifact_storage_required",
        guidance: expect.stringContaining("AI_ARTIFACTS"),
      },
    });
  });

  it("streams binary to R2, detects PNG, and returns a one-hour URL", async () => {
    let storedContentType: string | undefined;
    const bucket = {
      async put(key: string, _value: unknown, options?: R2PutOptions) {
        storedContentType =
          options?.httpMetadata instanceof Headers
            ? (options.httpMetadata.get("content-type") ?? undefined)
            : options?.httpMetadata?.contentType;
        return r2Object(
          key,
          12,
          storedContentType ?? "application/octet-stream",
        );
      },
    } as R2Bucket;
    const now = new Date("2026-07-14T20:00:00Z");
    const output = await storeArtifact(
      {
        AI_ARTIFACTS: bucket,
        AI_ARTIFACT_SECRET: "artifact-secret",
        AI_WEBHOOK_PUBLIC_URL: "https://worker.example",
      },
      "pred_png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      null,
      now,
    );
    expect(storedContentType).toBe("image/png");
    expect(output).toMatchObject({
      type: "artifact",
      content_type: "image/png",
      size: 12,
      expires_at: "2026-07-14T21:00:00.000Z",
    });
    expect(new URL(output.url).pathname).toContain(ARTIFACT_PATH_PREFIX);
  });

  it("keeps a ReadableStream streaming while detecting its content type", async () => {
    let storedBody: unknown;
    const bucket = {
      async put(key: string, value: unknown) {
        storedBody = value;
        return r2Object(key, 8, "image/png");
      },
    } as R2Bucket;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );
        controller.close();
      },
    });
    const output = await storeArtifact(
      {
        AI_ARTIFACTS: bucket,
        AI_ARTIFACT_SECRET: "artifact-secret",
        AI_WEBHOOK_PUBLIC_URL: "https://worker.example",
      },
      "pred_stream",
      stream,
      null,
      new Date(),
    );
    expect(storedBody).toBeInstanceOf(ReadableStream);
    expect(output.content_type).toBe("image/png");
  });

  it("rejects tampering and expired artifact URLs", async () => {
    const bucket = {
      async get(key: string) {
        const metadata = r2Object(key, 2, "text/plain");
        return {
          ...metadata,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("ok"));
              controller.close();
            },
          }),
          bodyUsed: false,
          async arrayBuffer() {
            return new ArrayBuffer(0);
          },
          async text() {
            return "ok";
          },
          async json<T>() {
            return {} as T;
          },
          async blob() {
            return new Blob(["ok"]);
          },
        };
      },
    } as R2Bucket;
    const env = { AI_ARTIFACTS: bucket, AI_ARTIFACT_SECRET: "artifact-secret" };
    const pathname = `${ARTIFACT_PATH_PREFIX}${encodeURIComponent("predictions/pred_safe/output")}`;
    const expires = Math.floor(Date.now() / 1000) + 60;
    const signature = await signArtifactPath(
      env.AI_ARTIFACT_SECRET,
      pathname,
      expires,
    );

    const valid = await handleArtifactRequest(
      new Request(
        `https://worker.example${pathname}?expires=${expires}&signature=${signature}`,
      ),
      env,
    );
    expect(valid.status).toBe(200);
    await expect(valid.text()).resolves.toBe("ok");

    const tampered = await handleArtifactRequest(
      new Request(
        `https://worker.example${pathname}?expires=${expires}&signature=${signature}x`,
      ),
      env,
    );
    expect(tampered.status).toBe(403);

    const oldExpires = Math.floor(Date.now() / 1000) - 1;
    const oldSignature = await signArtifactPath(
      env.AI_ARTIFACT_SECRET,
      pathname,
      oldExpires,
    );
    const expired = await handleArtifactRequest(
      new Request(
        `https://worker.example${pathname}?expires=${oldExpires}&signature=${oldSignature}`,
      ),
      env,
    );
    expect(expired.status).toBe(403);
  });
});
