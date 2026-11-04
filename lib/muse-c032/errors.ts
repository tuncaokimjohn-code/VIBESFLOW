import "server-only";
export type FailureCode = "LIVE_DISABLED" | "INVALID_CREDENTIAL" | "INVALID_LIMITS" |
  "ATTEMPT_CONSUMED" | "CANCELLED" | "TIMEOUT" | "NETWORK_ERROR" | "REDIRECT_DENIED" |
  "AUTH_REJECTED" | "RATE_LIMITED" | "HTTP_ERROR" | "RESPONSE_TOO_LARGE" |
  "PROTOCOL_ERROR" | "OUTPUT_INVALID" | "SECRET_ECHO";
export class SafeFailure extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super("C033 request stopped; no automatic retry is permitted."); this.name = "C033Failure"; this.code = code; }
}
export const failed = (code: FailureCode) => ({ ok: false as const, code,
  message: "C033 request stopped; no automatic retry is permitted." });
