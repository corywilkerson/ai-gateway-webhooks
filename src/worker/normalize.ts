import {
  ArtifactStorageRequiredError,
  storeArtifact,
  type ArtifactStorageEnv,
} from "./artifacts";
import {
  INLINE_OUTPUT_LIMIT,
  type JsonValue,
  type PredictionError,
} from "./types";

export type NormalizedInference =
  | {
      ok: true;
      output: JsonValue | Awaited<ReturnType<typeof storeArtifact>>;
    }
  | {
      ok: false;
      error: PredictionError;
    };

/**
 * Convert whatever the AI binding returned into something safe to embed in a
 * webhook payload. Binary and streaming outputs are always stored as
 * artifacts; JSON outputs are inlined when small enough and stored as
 * artifacts otherwise.
 */
export async function normalizeInferenceOutput(
  env: ArtifactStorageEnv,
  predictionId: string,
  output: unknown,
  now: Date,
): Promise<NormalizedInference> {
  try {
    // Raw HTTP response (e.g. returnRawResponse: true): store its body,
    // trusting the response's own content-type header.
    if (output instanceof Response) {
      if (!output.body) {
        return {
          ok: true,
          output: await storeArtifact(
            env,
            predictionId,
            new ArrayBuffer(0),
            output.headers.get("content-type"),
            now,
          ),
        };
      }
      return {
        ok: true,
        output: await storeArtifact(
          env,
          predictionId,
          output.body,
          output.headers.get("content-type"),
          now,
        ),
      };
    }

    // Bare stream: no content type is available here, so storeArtifact
    // sniffs one from the leading bytes.
    if (output instanceof ReadableStream) {
      return {
        ok: true,
        output: await storeArtifact(env, predictionId, output, null, now),
      };
    }

    // Binary output. Typed arrays are re-wrapped as a Uint8Array over the
    // same memory so only the view's own bytes are stored, not its whole
    // backing buffer.
    if (
      output instanceof ArrayBuffer ||
      ArrayBuffer.isView(output) ||
      output instanceof Blob
    ) {
      const body = ArrayBuffer.isView(output)
        ? new Uint8Array(output.buffer, output.byteOffset, output.byteLength)
        : output;
      return {
        ok: true,
        output: await storeArtifact(
          env,
          predictionId,
          body,
          output instanceof Blob ? output.type : null,
          now,
        ),
      };
    }

    // Everything else must survive a JSON round-trip. The round-trip also
    // strips values JSON cannot represent (undefined, functions, etc.).
    const encoded = JSON.stringify(output);
    if (encoded === undefined) {
      return invalidOutput("The AI model returned a non-JSON value.");
    }

    const size = new TextEncoder().encode(encoded).byteLength;
    if (size <= INLINE_OUTPUT_LIMIT) {
      return { ok: true, output: JSON.parse(encoded) as JsonValue };
    }

    // Too large to inline in the webhook payload; store it as an artifact.
    return {
      ok: true,
      output: await storeArtifact(
        env,
        predictionId,
        encoded,
        "application/json",
        now,
      ),
    };
  } catch (error) {
    if (error instanceof ArtifactStorageRequiredError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: "This output requires artifact storage.",
          guidance: error.guidance,
        },
      };
    }
    return invalidOutput("The AI output could not be normalized safely.");
  }
}

function invalidOutput(message: string): NormalizedInference {
  return {
    ok: false,
    error: {
      code: "invalid_output",
      message,
    },
  };
}
