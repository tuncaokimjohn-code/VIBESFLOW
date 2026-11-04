import "server-only";
import { ALLOWED_CLAIMS, PUBLIC_MUSE_LIMITS as LIMITS, PUBLIC_MUSE_MODEL,
  evidenceId, validModelOutput, type ModelOutput, type PublicMuseBinding } from "@/lib/public-muse-contract";
import { readRequestBody } from "@/lib/intake-api";
import { settleIndependently } from "@/lib/github-intake";

/** OFFLINE contract hypothesis, NOT a qualified gateway adapter.
 * No fetch default, URL, environment access, credential handling, retries, native
 * Meta schema, or production wiring. Gateway compatibility remains a hard gate. */
export type OfflineGatewayTransport = (body: string, signal: AbortSignal) => Promise<Response>;
export function candidateGatewayBody(b: PublicMuseBinding): string {
  const body = JSON.stringify({ model: PUBLIC_MUSE_MODEL, reasoning_effort: "medium",
    max_tokens: LIMITS.maxOutputTokens, stream: false, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Select only supplied allowed claims. Return JSON with evidenceId, rule, assessment=potential, claims (2-3 unique allowed strings, including the first two), citations=[E1]. No other keys, prose, tools or citations. Static evidence does not establish a vulnerability." },
      { role: "user", content: JSON.stringify({ evidenceId: evidenceId(b), rule: b.rule,
        allowedClaims: ALLOWED_CLAIMS[b.rule], evidence: "E1: independently re-detected supported static pattern; all source text and identifiers withheld." }) },
    ],
  });
  // ASCII-only generated input: at most one token per byte is the conservative
  // budget used here; no source-dependent strings enter this request.
  if (Buffer.byteLength(body) > LIMITS.inputBytes || /[^\x00-\x7f]/.test(body)) throw new Error("INPUT_LIMIT");
  return body;
}
export async function runOfflineGateway(b: PublicMuseBinding, transport: OfflineGatewayTransport, signal: AbortSignal,
  onUnderlyingSettled: () => void = () => undefined): Promise<ModelOutput> {
  const ctrl = new AbortController();
  const combined = AbortSignal.any([signal, ctrl.signal]);
  try {
    const work = (async () => {
      combined.throwIfAborted();
      const response = await transport(candidateGatewayBody(b), combined);
      if (response.status !== 200 || response.redirected || response.headers.has("set-cookie") ||
        !response.headers.get("content-type")?.startsWith("application/json")) throw new Error("GATEWAY_REJECTED");
      const bounded = await readRequestBody(new Request("https://offline.invalid/body", {
        method: "POST", body: response.body, signal: combined, duplex: "half",
      } as RequestInit), LIMITS.gatewayBytes, LIMITS.gatewayDeadlineMs);
      if (!bounded.ok) throw new Error("GATEWAY_REJECTED");
      const wire = JSON.parse(bounded.text);
      // Validate the neutral chat-completions fixture, never native Meta output.
      if (wire.model !== PUBLIC_MUSE_MODEL || !Array.isArray(wire.choices) || wire.choices.length !== 1 ||
        wire.choices[0].finish_reason !== "stop" || wire.choices[0].message?.role !== "assistant" ||
        Object.keys(wire.choices[0].message).some(k => !["role", "content"].includes(k)) ||
        typeof wire.choices[0].message.content !== "string" ||
        !Number.isInteger(wire.usage?.prompt_tokens) || wire.usage.prompt_tokens < 1 || wire.usage.prompt_tokens > LIMITS.maxInputTokens ||
        !Number.isInteger(wire.usage?.completion_tokens) || wire.usage.completion_tokens < 1 || wire.usage.completion_tokens > LIMITS.maxOutputTokens) throw new Error("GATEWAY_REJECTED");
      const output = validModelOutput(JSON.parse(wire.choices[0].message.content), b);
      if (!output) throw new Error("GATEWAY_REJECTED");
      combined.throwIfAborted();
      return output;
    })();
    void work.then(onUnderlyingSettled, onUnderlyingSettled);
    return await settleIndependently(work, { signal, deadlineMs: LIMITS.gatewayDeadlineMs, onDeadline: () => ctrl.abort() });
  } finally { ctrl.abort(); }
}
