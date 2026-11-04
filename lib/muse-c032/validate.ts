/** C032 response-envelope validation, adapted only for C033 bound claims. */
import "server-only";
import { LIMITS, MODEL, type BoundContract, type BoundExplanation } from "./contract";
import { EvidenceBindingSchema, sameBinding } from "@/lib/muse-binding";
import { SafeFailure } from "./errors";
type RecordValue = Record<string, unknown>;
const object = (v: unknown): v is RecordValue => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: RecordValue, names: string[]) => Object.keys(v).sort().join(",") === [...names].sort().join(",");
const valid = (condition: unknown): void => { if (!condition) throw new SafeFailure("OUTPUT_INVALID"); };

export function validateExplanation(raw: unknown, contract: BoundContract): BoundExplanation {
  valid(object(raw)); const v = raw as RecordValue;
  valid(keys(v, ["text", "citations"]) && v.text === contract.text);
  valid(Array.isArray(v.citations) && v.citations.length === 1);
  const parsed = EvidenceBindingSchema.safeParse((v.citations as unknown[])[0]);
  valid(parsed.success && sameBinding(parsed.data!, contract.binding));
  return { text: contract.text, citations: [{ ...contract.binding }] };
}

/** Treat all provider output as untrusted. Unknown output kinds never dispatch tools. */
export function validateResponse(raw: string, contract: BoundContract) {
  if (Buffer.byteLength(raw, "utf8") > LIMITS.responseBytes) throw new SafeFailure("RESPONSE_TOO_LARGE");
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new SafeFailure("PROTOCOL_ERROR"); }
  valid(object(value)); const v = value as RecordValue;
  valid(v.object === "response" && v.status === "completed" && v.model === MODEL);
  valid(typeof v.id === "string" && /^resp_[A-Za-z0-9_-]{1,120}$/.test(v.id));
  valid(v.error == null && v.incomplete_details == null && v.store === false);
  valid(v.background == null || v.background === false);
  valid(v.tools == null || Array.isArray(v.tools) && v.tools.length === 0);
  valid(v.tool_choice == null || v.tool_choice === "auto");
  valid(v.parallel_tool_calls == null || v.parallel_tool_calls === false);
  valid(v.max_output_tokens == null || v.max_output_tokens === LIMITS.maxOutputTokens);
  valid(v.reasoning == null || object(v.reasoning) && v.reasoning.effort === "medium");
  valid(Array.isArray(v.output) && v.output.length >= 1 && v.output.length <= 4);
  let text: string | undefined;
  for (const item of v.output as unknown[]) {
    valid(object(item)); const part = item as RecordValue;
    if (part.type === "reasoning") {
      valid(Array.isArray(part.summary) && part.summary.length === 0);
      valid(part.content == null || Array.isArray(part.content) && part.content.length === 0);
      continue; // Never return, persist, replay or decode reasoning payloads.
    }
    valid(part.type === "message" && part.role === "assistant" && part.status === "completed" && part.phase == null);
    valid(text === undefined && Array.isArray(part.content) && part.content.length === 1);
    const content = (part.content as unknown[])[0]; valid(object(content));
    const block = content as RecordValue;
    valid(block.type === "output_text" && typeof block.text === "string");
    valid(block.annotations == null || Array.isArray(block.annotations) && block.annotations.length === 0);
    text = block.text as string;
  }
  valid(typeof text === "string" && Buffer.byteLength(text!, "utf8") <= LIMITS.outputTextBytes);
  valid(object(v.usage)); const usage = v.usage as RecordValue;
  for (const k of ["input_tokens", "output_tokens", "total_tokens"]) valid(Number.isSafeInteger(usage[k]) && (usage[k] as number) >= 0);
  valid((usage.output_tokens as number) <= LIMITS.maxOutputTokens && usage.total_tokens === (usage.input_tokens as number) + (usage.output_tokens as number));
  let reasoningTokens: number | null = null;
  if (usage.output_tokens_details != null) {
    valid(object(usage.output_tokens_details)); const count = (usage.output_tokens_details as RecordValue).reasoning_tokens;
    valid(Number.isSafeInteger(count) && (count as number) >= 0 && (count as number) <= (usage.output_tokens as number)); reasoningTokens = count as number;
  }
  let parsed: unknown; try { parsed = JSON.parse(text!); } catch { throw new SafeFailure("OUTPUT_INVALID"); }
  const explanation = validateExplanation(parsed, contract);
  // Mock envelopes are NOT provider receipts; no usage/billing claim escapes.
  return explanation;
}
