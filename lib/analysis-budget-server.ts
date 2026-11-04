import { Script } from "node:vm";
import { AST_LIMITS } from "@/lib/github-ast-contract";

// Only this constant trusted entrypoint is evaluated. Repository text is DATA
// passed to the TypeScript parser, never a script or an interpolated expression.
// V8's synchronous timeout covers the trusted callback and its nested JS calls.
// This is a deadline mechanism, not a security sandbox or a peak-memory bound.
const entry = new Script("analyze()", { filename: "vibeflow-trusted-analysis-entrypoint" });
export function withAnalysisDeadline<T>(analyze: () => T, timeoutMs: number = AST_LIMITS.analysisDeadlineMs): T {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AST_LIMITS.analysisDeadlineMs) {
    throw new RangeError("Analysis deadline must remain within the production budget");
  }
  return entry.runInNewContext({ analyze }, { timeout: timeoutMs }) as T;
}

export function serializeAstResponse(value: unknown): string {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > AST_LIMITS.maxResponseBytes) {
    throw Object.assign(new Error("Serialized analysis response exceeds the response budget."), { code: "RESPONSE_LIMIT" });
  }
  return body;
}
