import "server-only";
import { z } from "zod";
import { META_MODEL, META_LIMITS as L, META_CAPS } from "@/lib/meta-direct-contract";
import { META_PRICE } from "@/lib/meta-direct-production-policy.mjs";
import { metaDirectBody, MetaDirectError, type MetaCredentials } from "@/lib/meta-direct-adapter";
import type { VerifiedPublicMuseEvidence } from "@/lib/public-muse-source-server";
import { readRequestBody } from "@/lib/intake-api";
import { strictJson } from "@/lib/public-muse-runtime-guards";
import { settleIndependently } from "@/lib/github-intake";
export const META_COUNT_ENDPOINT = "https://api.meta.ai/v1/responses/input_tokens" as const;
export type MetaCountFetch = (url: typeof META_COUNT_ENDPOINT, init: RequestInit) => Promise<Response>;
const Count = z.object({ object: z.literal("response.input_tokens"), input_tokens: z.number().int().min(1).max(L.maxInputTokens) }).strict();
/** Conservative upper bound, integer arithmetic only. Count includes rendered
 * overhead; pricing excludes injected steering. This inference applies ONLY to
 * this one-turn text request without tools/replay/media/context growth. It is
 * not an assertion that count endpoint context occupancy equals billed usage.
 * Full uncached rates, no cache discount, reasoning included in total output. */
export function maxRequestMicroUsd(input: number) {
  if (!Number.isSafeInteger(input) || input < 1 || input > L.maxInputTokens) throw new MetaDirectError("META_REJECTED");
  const numerator = input * META_PRICE.inputMicroUsdPerMillion + L.maxOutputTokens * META_PRICE.outputMicroUsdPerMillion;
  if (!Number.isSafeInteger(numerator)) throw new MetaDirectError("META_REJECTED");
  return Math.ceil(numerator / 1_000_000);
}
export function createMetaInputQualifier(fetchFn: MetaCountFetch, credentials: MetaCredentials) {
  return async (evidence: VerifiedPublicMuseEvidence, callerSignal: AbortSignal): Promise<void> => {
    const ctrl = new AbortController(), signal = AbortSignal.any([callerSignal, ctrl.signal]);
    const work = (async () => {
      const wire = JSON.parse(metaDirectBody(evidence).body);
      if (wire.model !== META_MODEL || wire.max_output_tokens !== META_PRICE.maxOutputTokens ||
        L.maxInputTokens !== META_PRICE.maxInputTokens || wire.store !== false || wire.reasoning.effort !== "medium" ||
        Object.keys(wire).sort().join() !== "input,instructions,max_output_tokens,model,reasoning,store") throw new MetaDirectError("META_REJECTED");
      const key = await credentials(signal); signal.throwIfAborted();
      if (!key || !/^[\x21-\x7e]{16,4096}$/.test(key)) throw new MetaDirectError("META_REJECTED");
      const response = await fetchFn(META_COUNT_ENDPOINT, { method: "POST", signal, redirect: "error", cache: "no-store",
        credentials: "omit", referrerPolicy: "no-referrer", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model: wire.model, instructions: wire.instructions, input: wire.input }) });
      if (signal.aborted || response.status !== 200 || response.redirected || response.url && response.url !== META_COUNT_ENDPOINT ||
        response.headers.has("set-cookie") || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) {
        void response.body?.cancel().catch(() => undefined); throw new MetaDirectError("META_REJECTED");
      }
      const body = await readRequestBody(new Request("https://bounded.invalid/count", { method: "POST", body: response.body, signal, duplex: "half" } as RequestInit), 2048, 3000);
      signal.throwIfAborted(); if (!body.ok) throw new MetaDirectError("META_REJECTED");
      const count = Count.parse(strictJson(body.text));
      if (maxRequestMicroUsd(count.input_tokens) > META_CAPS.requestMicroUsd) throw new MetaDirectError("META_REJECTED");
    })();
    try { await settleIndependently(work, { signal: callerSignal, deadlineMs: 4000, onDeadline: () => ctrl.abort() }); }
    finally { ctrl.abort(); }
  };
}
