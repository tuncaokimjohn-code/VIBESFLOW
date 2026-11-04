import "server-only";
import { z } from "zod";
import { ALLOWED_CLAIMS, PUBLIC_MUSE_MODEL, PUBLIC_MUSE_LIMITS as LIMITS, BindingSchema,
  VerifiedFactsSchema, evidenceId, validModelOutput, type PublicMuseBinding, type VerifiedFacts } from "@/lib/public-muse-contract";
import { settleIndependently } from "@/lib/github-intake";
import { readRequestBody } from "@/lib/intake-api";
import { strictJson } from "@/lib/public-muse-runtime-guards";

export const GATEWAY_ENDPOINT = "https://ai-gateway.vercel.sh/v1/chat/completions" as const;
export const HTTPS_REQUEST_BYTES = 4096;
/** UNQUALIFIED candidate wire semantics. Neither an echoed medium setting nor
 * strict mock responses establish provider reasoning, attempts or billing caps.
 * Transport and credentials are mandatory injections; no env/global fetch use. */
export type GatewayFetch = (endpoint: typeof GATEWAY_ENDPOINT, init: RequestInit) => Promise<Response>;
export type GatewayCredentialProvider = (signal: AbortSignal) => Promise<{
  kind: "gateway-api-key" | "vercel-oidc"; bearer: string;
} | null>;

export function sanitizedGatewayBody(binding: PublicMuseBinding, rawFacts: VerifiedFacts): string {
  const b = BindingSchema.parse(binding), facts = VerifiedFactsSchema.parse(rawFacts);
  if (facts.evidenceId !== evidenceId(b) || facts.rule !== b.rule) throw new Error("GATEWAY_REJECTED");
  const outputSchema = { type: "object", additionalProperties: false,
    properties: { evidenceId: { type: "string", enum: [facts.evidenceId] }, rule: { type: "string", enum: [b.rule] },
      assessment: { type: "string", enum: ["potential"] },
      claims: { type: "array", minItems: 2, maxItems: 3, items: { type: "string", enum: ALLOWED_CLAIMS[b.rule] } },
      citations: { type: "array", minItems: 1, maxItems: 1, items: { type: "string", enum: ["E1"] } } },
    required: ["evidenceId", "rule", "assessment", "claims", "citations"] };
  const body = JSON.stringify({ model: PUBLIC_MUSE_MODEL, reasoning: { effort: "medium" }, max_tokens: LIMITS.maxOutputTokens,
    stream: false, response_format: { type: "json_schema", json_schema: { name: "static_claims", strict: true, schema: outputSchema } },
    messages: [{ role: "system", content: "Select supplied allowed claims only, including the first two, without duplicates. Cite E1 only. Static patterns establish potential concerns, not vulnerabilities. Return only the required JSON." },
      { role: "user", content: JSON.stringify({ facts, allowedClaims: ALLOWED_CLAIMS[b.rule] }) }] });
  // A conservative local byte surrogate, NOT verified provider token accounting.
  if (Buffer.byteLength(body) > HTTPS_REQUEST_BYTES || /[^\x00-\x7f]/.test(body)) throw new Error("GATEWAY_REJECTED");
  return body;
}
const tokens = (max: number) => z.number().int().min(1).max(max);
const Envelope = z.object({ id: z.string().min(1).max(128).optional(), object: z.literal("chat.completion").optional(),
  created: z.number().int().nonnegative().optional(), model: z.literal(PUBLIC_MUSE_MODEL),
  choices: z.tuple([z.object({ index: z.literal(0), finish_reason: z.literal("stop"),
    message: z.object({ role: z.literal("assistant"), content: z.string().min(1).max(LIMITS.gatewayBytes) }).strict(),
  }).strict()]),
  usage: z.object({ prompt_tokens: tokens(LIMITS.maxInputTokens), completion_tokens: tokens(LIMITS.maxOutputTokens),
    total_tokens: tokens(LIMITS.maxInputTokens + LIMITS.maxOutputTokens) }).strict(),
}).strict().refine(w => w.usage.total_tokens === w.usage.prompt_tokens + w.usage.completion_tokens);

export function createBoundedGatewayAdapter(deps: { fetch: GatewayFetch; credentials: GatewayCredentialProvider }) {
  if (typeof deps?.fetch !== "function" || typeof deps.credentials !== "function") throw new Error("GATEWAY_UNAVAILABLE");
  // Copy trusted providers so later config mutation cannot replace them.
  const fetchOnce = deps.fetch, credentials = deps.credentials;
  return { async invokeOnce(binding: PublicMuseBinding, facts: VerifiedFacts, signal: AbortSignal) {
    const ctrl = new AbortController(), combined = AbortSignal.any([signal, ctrl.signal]);
    const work = (async () => {
      combined.throwIfAborted();
      const body = sanitizedGatewayBody(binding, facts);
      const credential = await credentials(combined);
      combined.throwIfAborted();
      if (!credential || !["gateway-api-key", "vercel-oidc"].includes(credential.kind) ||
        !/^[A-Za-z0-9._~-]{16,4096}$/.test(credential.bearer)) throw new Error("GATEWAY_REJECTED");
      const response = await fetchOnce(GATEWAY_ENDPOINT, { method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
        referrerPolicy: "no-referrer", signal: combined,
        headers: { authorization: `Bearer ${credential.bearer}`, "content-type": "application/json", accept: "application/json" }, body });
      combined.throwIfAborted();
      if (response.status !== 200 || response.redirected || (response.url && response.url !== GATEWAY_ENDPOINT) ||
        response.headers.has("set-cookie") || response.headers.has("content-encoding") ||
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) {
        void response.body?.cancel().catch(() => undefined); throw new Error("GATEWAY_REJECTED");
      }
      const bounded = await readRequestBody(new Request("https://offline.invalid/response", {
        method: "POST", body: response.body, signal: combined, duplex: "half",
      } as RequestInit), LIMITS.gatewayBytes, LIMITS.gatewayDeadlineMs);
      if (!bounded.ok) throw new Error("GATEWAY_REJECTED");
      const wire = Envelope.parse(strictJson(bounded.text));
      const output = validModelOutput(strictJson(wire.choices[0].message.content), binding);
      if (!output) throw new Error("GATEWAY_REJECTED");
      combined.throwIfAborted();
      return { output, returnedModel: wire.model, usage: { inputTokens: wire.usage.prompt_tokens, outputTokens: wire.usage.completion_tokens },
        requestedReasoning: "medium" as const, reasoningVerified: false as const, wireQualified: false as const };
    })();
    try { return await settleIndependently(work, { signal, deadlineMs: LIMITS.gatewayDeadlineMs, onDeadline: () => ctrl.abort() }); }
    catch { throw new Error("GATEWAY_REJECTED"); }
    finally { ctrl.abort(); }
  } };
}
