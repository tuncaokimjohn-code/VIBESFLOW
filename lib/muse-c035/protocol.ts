/** Same exact C034 request; documented optional response metadata normalized. */
import "server-only";
import { z } from "zod";
import { C034_MODEL, ReceiptSchema, validateClaims } from "@/lib/muse-c034-contract";
import { EvidenceBindingSchema, sameBinding } from "@/lib/muse-binding";
import { BOUNDS } from "../muse-c034/protocol";
import { DiagnosticFailure, type ResponseFacts } from "./diagnostics";
import type { PreparedFinding } from "./fixture";
export { buildLiveRequest, BOUNDS, ENDPOINT, sha256 } from "../muse-c034/protocol";
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
function check(value: unknown, code: string, schema = false): asserts value {
  if (!value) throw new DiagnosticFailure(schema ? "SCHEMA_VALIDATION" : "PROVIDER_RESPONSE", code);
}
export function validateLiveResponse(raw: string, p: PreparedFinding, credential?: string, facts?: ResponseFacts) {
  check(Buffer.byteLength(raw) <= BOUNDS.responseBytes, "ENVELOPE_TOO_LARGE");
  let e: Record<string, any>;
  try { const v: unknown = JSON.parse(raw); check(object(v), "ENVELOPE_NOT_OBJECT"); e = v; }
  catch (error) { if (error instanceof DiagnosticFailure) throw error; throw new DiagnosticFailure("PROVIDER_RESPONSE", "ENVELOPE_JSON_INVALID"); }
  // Check raw and decoded strings before retaining even a minimal receipt.
  check(!credential || !raw.includes(credential) && !JSON.stringify(e).includes(credential), "CREDENTIAL_ECHO_REJECTED");
  check(e.object === "response", "ENVELOPE_OBJECT_INVALID");
  check(e.status === "completed", "RESPONSE_NOT_COMPLETED");
  check(e.model === C034_MODEL, "RESPONSE_MODEL_MISMATCH");
  // Official Response.store is optional/nullable. Absence is not a persistence
  // attestation. The pinned request ALWAYS sets store:false; explicit true fails.
  check(e.store == null || e.store === false, "RESPONSE_STORE_CONFLICT");
  check(e.error == null && e.incomplete_details == null, "RESPONSE_ERROR_PRESENT");
  check(e.background == null || e.background === false, "RESPONSE_BACKGROUND_CONFLICT");
  check(e.tools == null || Array.isArray(e.tools) && e.tools.length === 0, "RESPONSE_TOOLS_REJECTED");
  check(e.tool_choice == null || e.tool_choice === "auto", "RESPONSE_TOOL_CHOICE_REJECTED");
  // Meta documents this flag as having no effect with no function tools. Its
  // echoed boolean is NOT tool authorization. Empty tools and output allowlist
  // remain mandatory; this client never executes or follows tool calls.
  check(e.parallel_tool_calls == null || typeof e.parallel_tool_calls === "boolean", "RESPONSE_PARALLEL_FLAG_INVALID");
  check(e.reasoning == null || object(e.reasoning) && e.reasoning.effort === "medium", "RESPONSE_EFFORT_MISMATCH");
  check(e.max_output_tokens == null || e.max_output_tokens === BOUNDS.maxOutputTokens, "RESPONSE_TOKEN_LIMIT_CONFLICT");
  check(object(e.usage), "USAGE_MISSING");
  const receiptCheck = ReceiptSchema.safeParse({ responseId: e.id, model: e.model, requestedEffort: "medium",
    inputTokens: e.usage.input_tokens, outputTokens: e.usage.output_tokens, totalTokens: e.usage.total_tokens,
    reasoningTokens: e.usage.output_tokens_details?.reasoning_tokens ?? null });
  check(receiptCheck.success, "USAGE_OR_RECEIPT_INVALID");
  const receipt = receiptCheck.data;
  if (facts) facts.receipt = receipt; // independently validated; no model prose
  check(Array.isArray(e.output) && e.output.length >= 1 && e.output.length <= 4, "OUTPUT_ITEMS_INVALID");
  let text: string | undefined;
  for (const item of e.output) {
    check(object(item), "OUTPUT_ITEM_INVALID");
    if (item.type === "reasoning") {
      check(Array.isArray(item.summary) && item.summary.length === 0 && (item.content == null || Array.isArray(item.content) && item.content.length === 0)
        && item.encrypted_content == null, "REASONING_PAYLOAD_REJECTED");
      continue;
    }
    check(item.type === "message" && item.role === "assistant" && item.status === "completed" && item.phase == null && text === undefined, "OUTPUT_MESSAGE_REJECTED");
    check(Array.isArray(item.content) && item.content.length === 1, "OUTPUT_CONTENT_REJECTED");
    const block = item.content[0];
    check(object(block) && block.type === "output_text" && typeof block.text === "string", "OUTPUT_TEXT_REJECTED");
    check(block.annotations == null || Array.isArray(block.annotations) && block.annotations.length === 0, "OUTPUT_ANNOTATIONS_REJECTED");
    text = block.text;
  }
  check(typeof text === "string" && Buffer.byteLength(text) <= BOUNDS.textBytes, "OUTPUT_TEXT_BOUNDS", true);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new DiagnosticFailure("SCHEMA_VALIDATION", "OUTPUT_JSON_INVALID"); }
  const shapeCheck = z.strictObject({ observation: z.string(), risk: z.string(), remediation: z.string(), limitations: z.string(),
    citations: z.array(EvidenceBindingSchema).length(1) }).safeParse(parsed);
  check(shapeCheck.success, "OUTPUT_SCHEMA_INVALID", true);
  const shape = shapeCheck.data;
  check(sameBinding(shape.citations[0], p.binding), "EVIDENCE_BINDING_INVALID", true);
  const { citations: _citations, ...fields } = shape;
  let claims;
  try { claims = validateClaims(fields, p.finding.ruleId); }
  catch { throw new DiagnosticFailure("SCHEMA_VALIDATION", "CLAIM_INVALID"); }
  check(!credential || !JSON.stringify({ claims, receipt }).includes(credential), "CREDENTIAL_ECHO_REJECTED");
  return { claims, receipt };
}
