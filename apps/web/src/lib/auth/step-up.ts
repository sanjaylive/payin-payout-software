/**
 * Step-up bridge between the API client and the confirmation dialog: when the API answers
 * `STEP_UP_REQUIRED`, the client asks the mounted dialog to confirm the user's identity and, on
 * success, retries the original request once.
 */
type Handler = () => Promise<boolean>;

let handler: Handler | null = null;
let inFlight: Promise<boolean> | null = null;

export function setStepUpHandler(h: Handler | null) {
  handler = h;
}

/** Single-flight: parallel requests that all need step-up share one dialog. */
export function requestStepUp(): Promise<boolean> {
  if (!handler) return Promise.resolve(false);
  inFlight ??= handler().finally(() => setTimeout(() => (inFlight = null), 0));
  return inFlight;
}
