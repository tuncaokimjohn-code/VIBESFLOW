/** Invented envelopes only. No actual provider body, key or live grant is used. */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import path from "node:path";
import { validateLiveResponse, buildLiveRequest } from "@/lib/muse-c038/protocol";
import { validateLiveResponse as previousValidate } from "@/lib/muse-c037/protocol";
import { findings, sql, setup, cleanupRoots } from "@/test-support/c038-fixture";
import { inventedC035Envelope, FAKE_KEY } from "@/test-support/c035-mock";
import { readResult } from "@/lib/muse-c038/state";

type Metadata = { name: string; phase?: string | null; status?: string };
const variants: Metadata[] = [
  { name: "absent phase, completed status", status: "completed" },
  { name: "null phase, completed status", phase: null, status: "completed" },
  { name: "final_answer phase, completed status", phase: "final_answer", status: "completed" },
  { name: "absent phase, omitted status" },
  { name: "null phase, omitted status", phase: null },
  { name: "final_answer phase, omitted status", phase: "final_answer" },
];
const marker = "C038_INVENTED_REASONING_NOT_FOR_PUBLICATION";
const reasoning = () => ({ type: "reasoning", id: marker, summary: [{ type: "summary_text", text: marker }],
  content: [{ type: "reasoning_text", text: marker }], encrypted_content: marker, status: "completed" });
function envelope(meta: Metadata, p = sql, withReasoning = false): any {
  const e: any = inventedC035Envelope(p), message = e.output[0];
  if (meta.status === undefined) delete message.status; else message.status = meta.status;
  if (meta.phase === undefined) delete message.phase; else message.phase = meta.phase;
  if (withReasoning) e.output.unshift(reasoning());
  return e;
}
const mostPermissive = variants[5];
afterEach(cleanupRoots);

describe("C038 documented final-answer metadata", () => {
  for (const p of findings) for (const meta of variants)
    it(`accepts ${meta.name} for ${p.finding.ruleId} without changing claims or receipt`, () => {
      const baseline = validateLiveResponse(JSON.stringify(inventedC035Envelope(p)), p);
      expect(validateLiveResponse(JSON.stringify(envelope(meta, p)), p)).toEqual(baseline);
    });
  for (const meta of variants) it(`discards populated reasoning with ${meta.name}`, () => {
    const facts: any = { responseBytes: 0, bodyComplete: true };
    const actual = validateLiveResponse(JSON.stringify(envelope(meta, sql, true)), sql, FAKE_KEY, facts);
    expect(actual).toEqual(validateLiveResponse(JSON.stringify(inventedC035Envelope(sql)), sql));
    expect(JSON.stringify({ actual, facts })).not.toContain(marker);
    expect(Object.keys(actual).sort()).toEqual(["claims", "receipt"]);
  });
  for (const meta of [variants[2], variants[3], variants[5]])
    it(`reproduces the C037 rejection of ${meta.name}`, () => {
      const raw = JSON.stringify(envelope(meta));
      try { previousValidate(raw, sql); throw new Error("Expected C037 rejection"); }
      catch (error) { expect(error).toMatchObject({ stage: "PROVIDER_RESPONSE", code: "OUTPUT_MESSAGE_REJECTED" }); }
      expect(validateLiveResponse(raw, sql).claims).toBeDefined();
    });
});

describe("C038 finality remains fail closed", () => {
  const invalidStatuses = [null, "incomplete", "in_progress", "failed", "", false, 0, {}, []];
  for (const phase of [undefined, null, "final_answer"]) for (const status of invalidStatuses)
    it(`rejects present message status ${JSON.stringify(status)} with phase ${String(phase)}`, () => {
      const e = envelope({ name: "invalid status", phase }); e.output[0].status = status;
      expect(() => validateLiveResponse(JSON.stringify(e), sql)).toThrow();
    });
  const invalidPhases = ["commentary", "unknown", "final_answer ", "", false, 0, {}, []];
  for (const status of [undefined, "completed"]) for (const phase of invalidPhases)
    it(`rejects phase ${JSON.stringify(phase)} with message status ${String(status)}`, () => {
      const e = envelope({ name: "invalid phase", status }); e.output[0].phase = phase;
      expect(() => validateLiveResponse(JSON.stringify(e), sql)).toThrow();
    });
  for (const status of ["incomplete", "in_progress", "failed", "cancelled", "queued", null, undefined])
    for (const meta of variants) it(`rejects envelope status ${String(status)} with ${meta.name}`, () => {
      const e = envelope(meta); e.status = status;
      try { validateLiveResponse(JSON.stringify(e), sql); throw new Error("Expected incomplete envelope rejection"); }
      catch (error) { expect(error).toMatchObject({ code: "RESPONSE_NOT_COMPLETED" }); }
    });
});

describe("C038 accepting metadata never relaxes answer validation", () => {
  const negatives: Array<[string, (e: any) => void]> = [
    ...["function_call", "function_call_output", "web_search_call", "computer_call", "tool_search_call", "unknown"]
      .map(type => [type, (e: any) => e.output.push({ type })] as [string, (e: any) => void]),
    ["wrong author", e => e.output[1].role = "user"],
    ["missing message type", e => delete e.output[1].type],
    ["duplicate assistant", e => e.output.push(structuredClone(e.output[1]))],
    ["missing assistant", e => e.output.pop()],
    ["multiple text blocks", e => e.output[1].content.push(structuredClone(e.output[1].content[0]))],
    ["missing text", e => delete e.output[1].content[0].text],
    ["nonstring text", e => e.output[1].content[0].text = {}],
    ["refusal", e => e.output[1].content[0].type = "refusal"],
    ["annotations", e => e.output[1].content[0].annotations = [{}]],
    ["invalid JSON", e => e.output[1].content[0].text = "{"],
    ["extra structured field", e => { const c = JSON.parse(e.output[1].content[0].text); c.extra = "unapproved"; e.output[1].content[0].text = JSON.stringify(c); }],
    ["unapproved claim", e => { const c = JSON.parse(e.output[1].content[0].text); c.risk = "Confirmed exploitation"; e.output[1].content[0].text = JSON.stringify(c); }],
    ["changed limitation", e => { const c = JSON.parse(e.output[1].content[0].text); c.limitations = "No limitations"; e.output[1].content[0].text = JSON.stringify(c); }],
    ["extra citation", e => { const c = JSON.parse(e.output[1].content[0].text); c.citations.push(c.citations[0]); e.output[1].content[0].text = JSON.stringify(c); }],
    ["wrong model", e => e.model = "unapproved"],
    ["wrong effort", e => e.reasoning.effort = "high"],
    ["tool definitions", e => e.tools = [{ type: "function", name: "unapproved" }]],
    ["inconsistent usage", e => e.usage.total_tokens++],
    ["oversized token usage", e => { e.usage.output_tokens = 2401; e.usage.total_tokens = e.usage.input_tokens + 2401; }],
    ["inconsistent reasoning tokens", e => e.usage.output_tokens_details.reasoning_tokens = e.usage.output_tokens + 1],
    ["malformed reasoning", e => e.output[0].content = [{ type: "function_call", name: "unapproved" }]],
  ];
  for (const [name, mutate] of negatives) it(`rejects ${name} with final_answer and omitted status`, () => {
    const e = envelope(mostPermissive, sql, true); mutate(e);
    expect(() => validateLiveResponse(JSON.stringify(e), sql)).toThrow();
  });
  for (const field of Object.keys(sql.binding)) it(`rejects changed citation ${field} after accepting final metadata`, () => {
    const e = envelope(mostPermissive), c = JSON.parse(e.output[0].content[0].text);
    c.citations[0][field] = typeof c.citations[0][field] === "number" ? 999999 : "fabricated";
    e.output[0].content[0].text = JSON.stringify(c);
    expect(() => validateLiveResponse(JSON.stringify(e), sql)).toThrow();
  });
  it("retains raw response, final text and output item bounds", () => {
    const huge = envelope(mostPermissive, sql, true); huge.output[0].encrypted_content = "X".repeat(65536);
    expect(() => validateLiveResponse(JSON.stringify(huge), sql)).toThrow();
    const text = envelope(mostPermissive); text.output[0].content[0].text = "X".repeat(8193);
    expect(() => validateLiveResponse(JSON.stringify(text), sql)).toThrow();
    const many = envelope(mostPermissive); many.output.unshift(reasoning(), reasoning(), reasoning(), reasoning());
    expect(() => validateLiveResponse(JSON.stringify(many), sql)).toThrow();
  });
  for (const place of ["summary", "encrypted_content", "final text"])
    it(`retains credential-echo rejection in ${place}`, () => {
      const e = envelope(mostPermissive, sql, true);
      if (place === "summary") e.output[0].summary[0].text = FAKE_KEY;
      else if (place === "encrypted_content") e.output[0].encrypted_content = FAKE_KEY;
      else e.output[1].content[0].text = FAKE_KEY;
      try { validateLiveResponse(JSON.stringify(e), sql, FAKE_KEY); throw new Error("Expected echo rejection"); }
      catch (error) { expect(error).toMatchObject({ code: "CREDENTIAL_ECHO_REJECTED" }); expect(JSON.stringify(error)).not.toContain(FAKE_KEY); }
    });
  it("keeps the exact synthetic request, with no assistant or reasoning replay", () => {
    const before = buildLiveRequest(sql);
    validateLiveResponse(JSON.stringify(envelope(mostPermissive, sql, true)), sql);
    expect(buildLiveRequest(sql)).toEqual(before); expect(Buffer.byteLength(before.body)).toBe(3732);
    expect(before.requestSha256).toBe("39567a4a05fb0b1989d504f960f3f1dc3366823e6a98a11ac674d07783475144");
    const request = JSON.parse(before.body); expect(request.model).toBe("muse-spark-1.3-contributor");
    expect(request.reasoning).toEqual({ effort: "medium" }); expect(request.input).toHaveLength(1);
    expect(request.input[0].role).toBe("user"); expect(request.tools).toEqual([]); expect(request.max_output_tokens).toBe(2400);
    expect(request).not.toHaveProperty("previous_response_id"); expect(request).not.toHaveProperty("include");
    expect(before.body).not.toContain(marker);
  });
});

describe("C038 compatible messages through the injected offline operator", () => {
  for (const meta of variants) it(`publishes only offline final claims for ${meta.name}, once`, async () => {
    const f = setup(JSON.stringify(envelope(meta, sql, true))), result = await f.run();
    expect(result).toMatchObject({ ok: true, mode: "offline-mock", code: "RESULT_SAVED" });
    if (!result.ok) throw new Error("Expected offline success");
    const bytes = fs.readFileSync(path.join(f.root, "result-bundle.json"), "utf8");
    expect(bytes).not.toContain(marker); expect(JSON.stringify(result)).not.toContain(marker);
    const bundle = JSON.parse(bytes); expect(bundle.result.mode).toBe("offline-mock");
    expect(bundle.result.claims).toEqual(validateLiveResponse(JSON.stringify(inventedC035Envelope(sql)), sql).claims);
    expect(() => readResult(f.root, sql.binding.evidenceId, result.publicationApproval)).toThrow();
    expect(f.http.seen).toHaveLength(1); expect(f.http.request.body).toBe(buildLiveRequest(sql).body);
    expect((await f.run()).ok).toBe(false); expect(f.http.seen).toHaveLength(1);
  });
  for (const kind of ["commentary", "incomplete", "tool call"]) it(`issues no publication approval for ${kind}`, async () => {
    const e = envelope(mostPermissive, sql, true);
    if (kind === "commentary") e.output[1].phase = "commentary";
    else if (kind === "incomplete") e.output[1].status = "incomplete";
    else e.output.push({ type: "function_call" });
    const f = setup(JSON.stringify(e)), result = await f.run();
    expect(result.ok).toBe(false); expect(result).not.toHaveProperty("publicationApproval");
    expect(fs.existsSync(path.join(f.root, "result-bundle.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.root, "attempt.lock"))).toBe(true);
    expect(fs.readFileSync(path.join(f.root, "failure.json"), "utf8")).not.toContain(marker);
    expect(f.http.seen).toHaveLength(1);
  });
});
