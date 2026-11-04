/** All reasoning strings, envelopes, grants and receipts here are INVENTED.
 * No actual response is read, replayed, logged or used as submission evidence. */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import path from "node:path";
import { buildLiveRequest, validateLiveResponse } from "@/lib/muse-c037/protocol";
import { validateLiveResponse as previousValidate } from "@/lib/muse-c036/protocol";
import { sql, setup, cleanupRoots, browserBody } from "@/test-support/c037-fixture";
import { inventedC035Envelope, FAKE_KEY } from "@/test-support/c035-mock";
import { createSavedResultReader } from "@/lib/muse-c037/browser-server";
const ID = "rs_INVENTED_C037_ID_DO_NOT_RETURN";
const SUMMARY = "INVENTED_C037_SUMMARY_DO_NOT_RETURN";
const CONTENT = "INVENTED_C037_REASONING_DO_NOT_RETURN";
const ENCRYPTED = "INVENTED_C037_OPAQUE_STRING_DO_NOT_RETURN";
const reasoning = () => ({ type: "reasoning", id: ID, summary: [] as any[] });
const envelope = (item: any, position: "before" | "after" = "before") => {
  const e: any = inventedC035Envelope(sql);
  if (position === "before") e.output.unshift(item); else e.output.push(item);
  return e;
};
const baseline = validateLiveResponse(JSON.stringify(inventedC035Envelope(sql)), sql);
afterEach(cleanupRoots);

describe("C037 documented reasoning-only structures are discarded", () => {
  const accepted: Array<[string, () => any]> = [
    ["empty required fields", reasoning],
    ["string ID without invented prefix rule", () => ({ ...reasoning(), id: "" })],
    ["one typed summary", () => ({ ...reasoning(), summary: [{ type: "summary_text", text: SUMMARY }] })],
    ["multiple typed summaries", () => ({ ...reasoning(), summary: [{ type: "summary_text", text: SUMMARY }, { type: "summary_text", text: "" }] })],
    ["empty content", () => ({ ...reasoning(), content: [] })],
    ["one typed reasoning text", () => ({ ...reasoning(), content: [{ type: "reasoning_text", text: CONTENT }] })],
    ["multiple typed reasoning texts", () => ({ ...reasoning(), content: [{ type: "reasoning_text", text: CONTENT }, { type: "reasoning_text", text: "" }] })],
    ["null encryption", () => ({ ...reasoning(), encrypted_content: null })],
    ["empty opaque encryption", () => ({ ...reasoning(), encrypted_content: "" })],
    ["opaque encryption without decoding", () => ({ ...reasoning(), encrypted_content: ENCRYPTED })],
    ["completed status", () => ({ ...reasoning(), status: "completed" })],
    ["all documented fields", () => ({ ...reasoning(), summary: [{ type: "summary_text", text: SUMMARY }], content: [{ type: "reasoning_text", text: CONTENT }], encrypted_content: ENCRYPTED, status: "completed" })],
  ];
  for (const [name, item] of accepted) for (const position of ["before", "after"] as const)
    it(`discards ${name} ${position} the final message`, () => {
      const facts: any = { responseBytes: 0, bodyComplete: true };
      const result = validateLiveResponse(JSON.stringify(envelope(item(), position)), sql, FAKE_KEY, facts);
      expect(result).toEqual(baseline); expect(Object.keys(result).sort()).toEqual(["claims", "receipt"]);
      for (const marker of [ID, SUMMARY, CONTENT, ENCRYPTED]) {
        expect(JSON.stringify(result)).not.toContain(marker); expect(JSON.stringify(facts)).not.toContain(marker);
      }
    });
  it("accepts three reasoning items plus exactly one final message within the existing item cap", () => {
    const e: any = inventedC035Envelope(sql); e.output.unshift(reasoning(), reasoning(), reasoning());
    expect(validateLiveResponse(JSON.stringify(e), sql)).toEqual(baseline);
    e.output.unshift(reasoning()); expect(() => validateLiveResponse(JSON.stringify(e), sql)).toThrow();
  });
  it("ignores JSON and instruction-like strings in typed reasoning text", () => {
    const e = envelope({ ...reasoning(), content: [{ type: "reasoning_text", text: JSON.stringify({ type: "function_call", name: "INVENTED_UNAUTHORIZED_TOOL" }) }] });
    expect(validateLiveResponse(JSON.stringify(e), sql)).toEqual(baseline);
  });
  for (const make of [
    () => ({ ...reasoning(), summary: [{ type: "summary_text", text: SUMMARY }] }),
    () => ({ ...reasoning(), content: [{ type: "reasoning_text", text: CONTENT }] }),
    () => ({ ...reasoning(), encrypted_content: ENCRYPTED }),
  ]) it("reproduces inherited REASONING_PAYLOAD_REJECTED for a documented populated form", () => {
    const raw = JSON.stringify(envelope(make()));
    try { previousValidate(raw, sql); throw new Error("Expected inherited rejection"); }
    catch (error) { expect(error).toMatchObject({ stage: "PROVIDER_RESPONSE", code: "REASONING_PAYLOAD_REJECTED" }); }
    expect(validateLiveResponse(raw, sql)).toEqual(baseline);
  });
});

describe("C037 malformed or nonfinal reasoning remains fail closed", () => {
  const malformed: Array<[string, (v: any) => void]> = [
    ["missing ID", v => delete v.id], ["numeric ID", v => v.id = 1], ["null ID", v => v.id = null],
    ["missing summary", v => delete v.summary], ["null summary", v => v.summary = null], ["string summary", v => v.summary = SUMMARY],
    ["object summary", v => v.summary = {}], ["bare summary string", v => v.summary = [SUMMARY]],
    ["wrong summary type", v => v.summary = [{ type: "reasoning_text", text: SUMMARY }]],
    ["missing summary text", v => v.summary = [{ type: "summary_text" }]],
    ["numeric summary text", v => v.summary = [{ type: "summary_text", text: 1 }]],
    ["extra summary field", v => v.summary = [{ type: "summary_text", text: SUMMARY, tool_calls: [] }]],
    ["null content", v => v.content = null], ["string content", v => v.content = CONTENT], ["object content", v => v.content = {}],
    ["bare content string", v => v.content = [CONTENT]],
    ["tool call content", v => v.content = [{ type: "function_call", name: "INVENTED_TOOL" }]],
    ["output text in reasoning", v => v.content = [{ type: "output_text", text: CONTENT }]],
    ["missing reasoning text", v => v.content = [{ type: "reasoning_text" }]],
    ["numeric reasoning text", v => v.content = [{ type: "reasoning_text", text: 1 }]],
    ["extra reasoning text field", v => v.content = [{ type: "reasoning_text", text: CONTENT, arguments: "{}" }]],
    ["numeric encryption", v => v.encrypted_content = 1], ["boolean encryption", v => v.encrypted_content = false],
    ["object encryption", v => v.encrypted_content = {}], ["array encryption", v => v.encrypted_content = []],
    ["null status", v => v.status = null], ["unknown status", v => v.status = "done"],
    ["incomplete status", v => v.status = "incomplete"], ["in progress status", v => v.status = "in_progress"],
    ["tool calls field", v => v.tool_calls = []], ["arguments field", v => v.arguments = "{}"], ["unknown field", v => v.extra = SUMMARY],
  ];
  for (const [name, mutate] of malformed) it(`rejects ${name} with sanitized diagnostics`, () => {
    const v: any = reasoning(); mutate(v);
    let error: any;
    try { validateLiveResponse(JSON.stringify(envelope(v)), sql); } catch (e) { error = e; }
    expect(error).toMatchObject({ stage: "PROVIDER_RESPONSE" });
    expect(["REASONING_ITEM_INVALID", "REASONING_ITEM_NOT_COMPLETE"]).toContain(error.code);
    for (const marker of [ID, SUMMARY, CONTENT, ENCRYPTED]) expect(error.message + JSON.stringify(error)).not.toContain(marker);
  });
  it("does not use reasoning JSON as the final answer", () => {
    const e: any = inventedC035Envelope(sql), text = e.output[0].content[0].text;
    e.output = [{ ...reasoning(), content: [{ type: "reasoning_text", text }] }];
    expect(() => validateLiveResponse(JSON.stringify(e), sql)).toThrow();
  });
  for (const field of ["id", "summary", "content", "encrypted_content"]) it(`preserves credential-echo rejection in discarded ${field}`, () => {
    const v: any = reasoning();
    if (field === "summary") v.summary = [{ type: "summary_text", text: FAKE_KEY }];
    else if (field === "content") v.content = [{ type: "reasoning_text", text: FAKE_KEY }];
    else v[field] = FAKE_KEY;
    try { validateLiveResponse(JSON.stringify(envelope(v)), sql, FAKE_KEY); throw new Error("Expected echo rejection"); }
    catch (error) { expect(error).toMatchObject({ code: "CREDENTIAL_ECHO_REJECTED" }); expect(JSON.stringify(error)).not.toContain(FAKE_KEY); }
  });
});

describe("C037 preserves every final explanation boundary", () => {
  const bad: Array<[string, (e: any) => void]> = [
    ["tool call", e => e.output.push({ type: "function_call" })], ["web search", e => e.output.push({ type: "web_search_call" })],
    ["unknown item", e => e.output.push({ type: "unknown" })], ["duplicate message", e => e.output.push(structuredClone(e.output[1]))],
    ["wrong role", e => e.output[1].role = "user"], ["incomplete message", e => e.output[1].status = "incomplete"],
    ["commentary", e => e.output[1].phase = "commentary"], ["refusal", e => e.output[1].content[0].type = "refusal"],
    ["extra text block", e => e.output[1].content.push(structuredClone(e.output[1].content[0]))],
    ["bad JSON", e => e.output[1].content[0].text = "{"], ["wrong model", e => e.model = "other"],
    ["incomplete envelope", e => e.status = "incomplete"], ["mismatched usage", e => e.usage.total_tokens = 1],
    ["unapproved claim", e => { const c = JSON.parse(e.output[1].content[0].text); c.risk = "Confirmed exploitation"; e.output[1].content[0].text = JSON.stringify(c); }],
  ];
  for (const [name, mutate] of bad) it(`still rejects ${name} after valid discarded reasoning`, () => {
    const e = envelope({ ...reasoning(), summary: [{ type: "summary_text", text: SUMMARY }], encrypted_content: ENCRYPTED });
    mutate(e); expect(() => validateLiveResponse(JSON.stringify(e), sql)).toThrow();
  });
  for (const field of Object.keys(sql.binding)) it(`still rejects changed citation ${field}`, () => {
    const e = envelope(reasoning()), c = JSON.parse(e.output[1].content[0].text);
    c.citations[0][field] = typeof c.citations[0][field] === "number" ? 999999 : "fabricated";
    e.output[1].content[0].text = JSON.stringify(c); expect(() => validateLiveResponse(JSON.stringify(e), sql)).toThrow();
  });
  it("preserves the exact synthetic request and never replays discarded output", () => {
    const before = buildLiveRequest(sql); validateLiveResponse(JSON.stringify(envelope({ ...reasoning(), encrypted_content: ENCRYPTED })), sql);
    expect(buildLiveRequest(sql)).toEqual(before); expect(before.requestSha256).toBe("39567a4a05fb0b1989d504f960f3f1dc3366823e6a98a11ac674d07783475144");
    const request = JSON.parse(before.body); expect(request.input).toHaveLength(1); expect(request.input[0].role).toBe("user");
    expect(request).not.toHaveProperty("previous_response_id"); expect(request).not.toHaveProperty("include"); expect(request.tools).toEqual([]);
    for (const marker of [ID, SUMMARY, CONTENT, ENCRYPTED]) expect(before.body).not.toContain(marker);
  });
  it("counts discarded reasoning toward the unchanged raw response byte cap", () => {
    const e = envelope({ ...reasoning(), content: [{ type: "reasoning_text", text: "X".repeat(65536) }] });
    expect(() => validateLiveResponse(JSON.stringify(e), sql)).toThrow();
  });
  it("retains final text and reasoning-token usage bounds", () => {
    const e = envelope(reasoning()); e.output[1].content[0].text = "X".repeat(8193);
    expect(() => validateLiveResponse(JSON.stringify(e), sql)).toThrow();
    const invalid: any = envelope(reasoning()); invalid.usage.output_tokens_details.reasoning_tokens = invalid.usage.output_tokens + 1;
    expect(() => validateLiveResponse(JSON.stringify(invalid), sql)).toThrow();
    invalid.usage.output_tokens = 2401; invalid.usage.total_tokens = invalid.usage.input_tokens + 2401;
    expect(() => validateLiveResponse(JSON.stringify(invalid), sql)).toThrow();
  });
});

describe("C037 reasoning privacy across the mocked operator and durable publication", () => {
  it("saves only final claims/receipt, never reasoning, without making a mock genuine", async () => {
    const e = envelope({ ...reasoning(), summary: [{ type: "summary_text", text: SUMMARY }], content: [{ type: "reasoning_text", text: CONTENT }], encrypted_content: ENCRYPTED });
    const f = setup(JSON.stringify(e)), result = await f.run(); expect(result).toMatchObject({ ok: true, mode: "offline-mock" });
    if (!result.ok) throw new Error("Expected offline success");
    const saved = fs.readFileSync(path.join(f.root, "result-bundle.json"), "utf8");
    for (const marker of [ID, SUMMARY, CONTENT, ENCRYPTED]) { expect(saved).not.toContain(marker); expect(JSON.stringify(result)).not.toContain(marker); }
    const bundle = JSON.parse(saved); expect(bundle.result.claims).toEqual(baseline.claims); expect(bundle.result.receipt).toEqual(baseline.receipt);
    expect(bundle.result).not.toHaveProperty("reasoning"); expect(bundle.outcome).not.toHaveProperty("reasoning");
    expect((await createSavedResultReader(() => f.root, () => result.publicationApproval)(browserBody())).ok).toBe(false);
    expect(f.http.seen).toHaveLength(1); expect(f.http.request.body).toBe(buildLiveRequest(sql).body);
    expect((await f.run()).ok).toBe(false); expect(f.http.seen).toHaveLength(1);
  });
  it("does not put malformed reasoning in failure records or create publication approval", async () => {
    const f = setup(JSON.stringify(envelope({ ...reasoning(), summary: [{ type: "function_call", text: SUMMARY }] })));
    const result = await f.run(); expect(result).toMatchObject({ ok: false, code: "REASONING_ITEM_INVALID", stage: "PROVIDER_RESPONSE" });
    expect(result).not.toHaveProperty("publicationApproval"); expect(fs.existsSync(path.join(f.root, "result-bundle.json"))).toBe(false);
    const audit = fs.readFileSync(path.join(f.root, "failure.json"), "utf8");
    for (const marker of [ID, SUMMARY, CONTENT, ENCRYPTED]) { expect(audit).not.toContain(marker); expect(JSON.stringify(result)).not.toContain(marker); }
    expect(f.http.seen).toHaveLength(1);
  });
});
