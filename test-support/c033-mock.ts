/** Invented deterministic protocol fixture. NEVER recorded provider output.
 * Imported by tests only. No HTTP route imports or selects this module.
 */
import { buildRequest, MODEL, type BoundContract } from "@/lib/muse-c032/contract";
import type { OfflineTransport } from "@/lib/muse-c032/client";
export function inventedMockEnvelope(c: BoundContract) {
  return { object: "response", id: "resp_C033_OFFLINE_MOCK", model: MODEL,
    status: "completed", store: false, reasoning: { effort: "medium" },
    tools: [], parallel_tool_calls: false, max_output_tokens: 2400,
    output: [{ type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify({ text: c.text, citations: [c.binding] }), annotations: [] }] }],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } },
  }; // Zeroes are fixture placeholders, NOT measured usage or a billing receipt.
}
export function deterministicMock(c: BoundContract): OfflineTransport {
  return { kind: "offline-mock", async send({ body, signal }) {
    if (signal.aborted || body !== JSON.stringify(buildRequest(c))) throw new Error("Offline fixture request mismatch");
    return JSON.stringify(inventedMockEnvelope(c));
  } };
}
