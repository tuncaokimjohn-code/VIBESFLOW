/** Invented offline envelopes and HTTP emitters. Never a provider receipt. */
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { C034_CLAIMS, C034_LIMITATION, C034_MODEL } from "@/lib/muse-c034-contract";
import type { PreparedFinding } from "@/lib/muse-c034/fixture";
import type { RequestFactory } from "@/lib/muse-c034/transport";
export const FAKE_KEY = "C034_OFFLINE_TEST_ONLY_NOT_A_CREDENTIAL";
export function inventedC034Envelope(p: PreparedFinding) {
  const allowed = C034_CLAIMS[p.finding.ruleId];
  return { object: "response", id: "resp_C034_OFFLINE_TEST_FIXTURE", status: "completed", model: C034_MODEL, store: false,
    reasoning: { effort: "medium" }, tools: [], parallel_tool_calls: false, max_output_tokens: 2400,
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", annotations: [],
      text: JSON.stringify({ observation: allowed.observation[0], risk: allowed.risk[0], remediation: allowed.remediation[0],
        limitations: C034_LIMITATION, citations: [p.binding] }) }] }],
    usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300, output_tokens_details: { reasoning_tokens: 100 } },
  }; // All usage values and IDs are made-up test data.
}
export class MockResponse extends EventEmitter {
  statusCode = 200; complete = true; destroyed = false; closed = false; autoClose = true;
  headers: Record<string, string> = { "content-type": "application/json" };
  destroy() { if (!this.destroyed) { this.destroyed = true; if (this.autoClose) { this.closed = true; this.emit("close"); } } return this; }
}
export class MockRequest extends EventEmitter {
  destroyed = false; closed = false; autoClose = true; body: string | undefined;
  end(body: string) { this.body = body; return this; }
  destroy() { if (!this.destroyed) { this.destroyed = true; if (this.autoClose) { this.closed = true; this.emit("close"); } } return this; }
}
export function mockExchange(action: (r: MockResponse) => void = r => { r.emit("data", Buffer.from("{}")); r.emit("end"); }) {
  const request = new MockRequest(), response = new MockResponse(), seen: RequestOptions[] = [];
  const factory: RequestFactory = (options, callback) => {
    seen.push(options); queueMicrotask(() => { callback(response as unknown as IncomingMessage); action(response); });
    return request as unknown as ClientRequest;
  };
  return { factory, request, response, seen };
}
