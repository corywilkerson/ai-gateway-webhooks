import { describe, expect, it } from "vitest";
import {
  normalizeWebhookEvents,
  validatePredictionContext,
  validateRunArguments,
  validateWebhookUrl,
  ValidationError,
} from "../src/worker/validation";
import { sanitizeInferenceError } from "../src/worker/workflows/prediction";

describe("request validation", () => {
  it("defaults to completed events and the default gateway remains available", () => {
    expect(normalizeWebhookEvents(undefined)).toEqual(["completed"]);
    expect(
      validateRunArguments(
        "openai/gpt-4.1-mini",
        { messages: [] },
        { webhook: { url: "https://receiver.example/hooks" } },
      ),
    ).toEqual({
      url: "https://receiver.example/hooks",
      events: ["completed"],
    });
  });

  it("deduplicates supported event filters", () => {
    expect(normalizeWebhookEvents(["started", "completed", "started"])).toEqual(
      ["started", "completed"],
    );
  });

  it.each([
    "http://receiver.example/hooks",
    "https://user:pass@receiver.example/hooks",
    "https://receiver.example/hooks#fragment",
  ])("rejects an unsafe webhook URL: %s", (url) => {
    expect(() => validateWebhookUrl(url)).toThrow(ValidationError);
  });

  it("rejects callbacks to the deployment origin", () => {
    expect(() =>
      validateWebhookUrl(
        "https://worker.example/hooks",
        "https://worker.example",
      ),
    ).toThrow("must not target this deployment");
  });

  it("rejects non-serializable Workflow input", () => {
    expect(() =>
      validateRunArguments(
        "model",
        { callback: () => undefined },
        { webhook: { url: "https://receiver.example/hooks" } },
      ),
    ).toThrow("not Workflow-serializable");
  });

  it("never exposes inference errors or embedded credentials", () => {
    const error = sanitizeInferenceError(
      new Error("Authorization: Bearer sk-super-secret at provider\nstack"),
    );
    expect(error).toEqual({
      code: "inference_error",
      message: "AI inference failed.",
    });
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  it("accepts bounded JSON context and rejects unsafe values", () => {
    expect(() =>
      validatePredictionContext({ orderId: "ord_123", attempt: 1 }),
    ).not.toThrow();
    expect(() => validatePredictionContext({ score: Number.NaN })).toThrow(
      "must contain only JSON values",
    );
    expect(() =>
      validatePredictionContext({ value: "x".repeat(17 * 1024) }),
    ).toThrow("context exceeds");
  });
});
