// Only the prediction ID is random. Event and delivery IDs are derived from
// it deterministically, so Workflow replays regenerate the same IDs — which
// is what makes webhook creation and delivery idempotent.

function compactUuid(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function createPredictionId(): string {
  return `pred_${compactUuid()}`;
}

export function eventIdFor(
  predictionId: string,
  phase: "started" | "completed",
): string {
  const suffix = predictionId.startsWith("pred_")
    ? predictionId.slice(5)
    : predictionId;
  return `evt_${suffix}_${phase}`;
}

export function deliveryIdFor(eventId: string): string {
  return `delivery_${eventId}`;
}
