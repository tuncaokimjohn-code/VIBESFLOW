/** Builder regressions only; all snippets are parsed, never executed. */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { detectSecurityFindings, DETECTION_LIMITS, type DetectionOptions, type SecurityFinding } from "@/lib/security-findings";
import { SecurityFindings, SecurityFindingInspector } from "@/components/SecurityFindings";
import { WITHHELD_NOTICE } from "@/lib/safer-comparison";
import { securityFixture } from "@/security-test-fixture";
import { sha256Text, SourceSnapshotSchema } from "@/lib/source-snapshot";
import { sourceLines } from "@/lib/source-lines";

async function run(source: string, path = "src/test.ts", options: DetectionOptions = {}) {
  const input = { [path]: source };
  return detectSecurityFindings(securityFixture(input), new Map(Object.entries(input)), sha256Text, options);
}
async function findings(source: string, rule: SecurityFinding["ruleId"], path = "src/test.ts") {
  const result = await run(source, path);
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.message);
  return result.findings.filter(f => f.ruleId === rule);
}

describe("P5-QA-01 credential counterexamples and assignment coverage", () => {
  it.each(["compass", "bypass", "secretary", "passwordLabel", "apiKeyName", "authentication", "passenger"])("rejects non-credential/metadata name %s", async name => {
    expect(await findings(`const ${name} = "synthetic-long-value";`, "VF-SEC-001")).toEqual([]);
  });
  it.each(["", "abc", "1234567", "changeme", "CHANGE_ME", "replace-me", "placeholder", "YOUR_API_KEY_HERE", "<API_KEY>", "${API_KEY}", "xxxxxxxx", "not-a-real-secret"])("rejects placeholder/short value %s consistently", async value => {
    const literal = JSON.stringify(value);
    const source = `const apiKey = ${literal}; let password: string; password = ${literal}; cfg.secret = ${literal}; const obj = { auth_token: ${literal} };`;
    expect(await findings(source, "VF-SEC-001")).toEqual([]);
  });
  it.each([
    'const APIKEY = "synthetic-value-123";', 'const apiKey = "synthetic-value-123";', 'const dbPassword = "synthetic-value-123";',
    'const config = { "api_key": "synthetic-value-123" };', 'let accessToken: string; accessToken = "synthetic-value-123";',
    'config.authToken = "synthetic-value-123";', 'config["password"] = "synthetic-value-123";',
    'class Settings { secret = "synthetic-value-123"; }',
  ])("covers declaration/object/property/element/class assignment: %s", async source => {
    expect(await findings(source, "VF-SEC-001")).toHaveLength(1);
  });
  it("does not inspect comments or execute malicious-looking source", async () => {
    expect(await findings('// const secret = "synthetic-value-123";\nthrow new Error("DO NOT EXECUTE");', "VF-SEC-001")).toEqual([]);
  });
});

describe("P5-QA-02 SQL sink/content discrimination and bounded flow", () => {
  it.each([
    'search.query(`SELECT * FROM users WHERE id=${id}`);', 'query(`SELECT * FROM users WHERE id=${id}`);',
    'shell.execute(`SELECT * FROM users WHERE id=${id}`);', 'db.query(`hello ${name}`);',
    'db.raw("prefix" + id);', 'db.query(1 + 2);', 'db.query("SELECT * FROM users WHERE id=$1", [id]);',
    'db.query("SELECT " + "* FROM users");', 'db.query(`SELECT * FROM users WHERE id=${1}`);',
    'const id = "fixed"; db.query(`SELECT * FROM users WHERE id=${id}`);',
    'let q = `SELECT * FROM users WHERE id=${id}`; db.query(q);',
    'db.query(q); const q = `SELECT * FROM users WHERE id=${id}`;',
    'const q = `SELECT * FROM users WHERE id=${id}`; function f(q: string) { db.query(q); }',
    'const q = `SELECT * FROM users WHERE id=${id}`; const f = (q: string) => db.query(q);',
  ])("rejects irrelevant/static/unsupported flow: %s", async source => {
    expect(await findings(source, "VF-SEC-002")).toEqual([]);
  });
  it.each([
    'db.query(`SELECT * FROM users WHERE id=${id}`);', 'pool.execute("DELETE FROM users WHERE id=" + id);',
    'connection.query(("UPDATE users SET name=" + name));', 'db.raw(`INSERT INTO users VALUES (${name})`);',
    'const q = `SELECT * FROM users WHERE id=${id}`; db.query(q);',
    'function f(id: string) { const q = "SELECT * FROM users WHERE id=" + id; const alias = q; db.query(alias); }',
  ])("flags bounded SQL construction: %s", async source => {
    expect(await findings(source, "VF-SEC-002")).toHaveLength(1);
  });
  it("does not follow aliases beyond the configured bound", async () => {
    const source = 'const a = `SELECT * FROM users WHERE id=${id}`; const b=a; const c=b; const d=c; const e=d; db.query(e);';
    expect(await findings(source, "VF-SEC-002")).toEqual([]);
  });
});

describe("P5-QA-03 inspect the actual __html value", () => {
  it.each([
    '<div dangerouslySetInnerHTML={{ __html: "<b>fixed</b>" }} />;',
    '<div dangerouslySetInnerHTML={{ __html: `fixed` }} />;',
    '<div dangerouslySetInnerHTML={{ __html: "fixed" + " text" }} />;',
    'const html = "fixed"; const attrs = { __html: html }; <div dangerouslySetInnerHTML={attrs} />;',
    '<div dangerouslySetInnerHTML={{ somethingElse: html }} />;',
    '<div dangerouslySetInnerHTML={{ ...attrs, __html: html }} />;',
    '<div dangerouslySetInnerHTML={{ __html: html, __html: "fixed" }} />;',
    '<div dangerouslySetInnerHTML={"fixed"} />;',
  ])("rejects static or unsupported object forms: %s", async source => {
    expect(await findings(source, "VF-SEC-003", "src/view.tsx")).toEqual([]);
  });
  it.each([
    '<div dangerouslySetInnerHTML={{ __html: html }} />;',
    '<div dangerouslySetInnerHTML={{ "__html": sanitize(html) }} />;',
    'const attrs = { __html: html }; <div dangerouslySetInnerHTML={attrs} />;',
    '<div dangerouslySetInnerHTML={{ __html }} />;',
    '<div dangerouslySetInnerHTML={{ __html: `<p>${html}</p>` }} />;',
  ])("flags dynamic __html without claiming exploitability: %s", async source => {
    const f = await findings(source, "VF-SEC-003", "src/view.tsx");
    expect(f).toHaveLength(1); expect(f[0].limitations).toContain("unconfirmed");
  });
});

describe("P5-QA-04 malformed source coverage", () => {
  it.each([['src/a.ts', 'const secret = "synthetic-value-123"; const = ;'], ['src/a.tsx', '<div dangerouslySetInnerHTML={{ __html: html }} >']])("skips recovered AST for %s", async (path, source) => {
    const result = await run(source, path);
    expect(result).toMatchObject({ ok: true, findings: [], filesAnalyzed: 0, scanComplete: false, malformedFiles: [{ path, diagnostics: expect.any(Number) }] });
    if (result.ok) {
      const markup = renderToStaticMarkup(<SecurityFindings state={{ snapshotId: "test", status: "done", result }} selected={null} onSelect={() => {}} />);
      expect(markup).toContain("Malformed source excluded"); expect(markup).toContain("Partial supported-rule scan");
    }
  });
  it("keeps valid files and exposes excluded malformed files", async () => {
    const input = { "good.ts": 'const secret="synthetic-value-123";', "bad.ts": "const = ;" };
    const r = await detectSecurityFindings(securityFixture(input), new Map(Object.entries(input)), sha256Text);
    expect(r).toMatchObject({ ok: true, filesAnalyzed: 1, filesTotal: 2, scanComplete: false });
    if (r.ok) expect(r.findings.map(f => f.path)).toEqual(["good.ts"]);
  });
});

describe("P5-QA-05 exact location, context, multiple findings and accessible inspector", () => {
  it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])("preserves byte/UTF-16 coordinates across %j", async separator => {
    const source = `\ufeff// 😀 first${separator}const ordinary = 1;${separator}const apiKey = "synthetic-value-123";${separator}const secret = "synthetic-value-456";${separator}// after`;
    const f = await findings(source, "VF-SEC-001");
    expect(f).toHaveLength(2); expect(f[0].line).toBe(3); expect(f[1].line).toBe(4);
    for (const finding of f) {
      expect(source.slice(finding.charOffset, finding.endCharOffset)).toBe(finding.quote);
      expect(new TextEncoder().encode(source.slice(0, finding.charOffset)).length).toBe(finding.byteOffset);
      expect(new TextDecoder().decode(new TextEncoder().encode(source).slice(finding.byteOffset, finding.endByteOffset))).toBe(finding.quote);
      const target = finding.context.find(r => r.target)!;
      expect(target.line).toBe(finding.line); expect(sourceLines(source)[finding.line - 1].slice(finding.column - 1).startsWith(finding.quote)).toBe(true);
      expect(finding.excerpt).toContain("const ordinary = 1;");
    }
    expect(f[0].id).not.toBe(f[1].id);
    const markup = renderToStaticMarkup(<SecurityFindingInspector finding={f[1]} />);
    expect(markup).toContain(`src/test.ts:4:${f[1].column}`);
    expect(markup).toContain('tabindex="-1"'); expect(markup).toContain('id="security-finding-inspector"');
    expect(markup).toContain(f[1].fileSha256);
    // C003: no source excerpt is rendered; only the withheld notice + location/provenance.
    expect(markup).toContain(WITHHELD_NOTICE);
    expect(markup).toContain("Source excerpt withheld");
    expect(markup).not.toContain("synthetic-value-123");
    expect(markup).not.toContain("synthetic-value-456");
  });
  it("centers long-line context on the actual finding", async () => {
    const source = ' '.repeat(500) + 'const secret="synthetic-value-123";';
    const [f] = await findings(source, "VF-SEC-001");
    expect(f.column).toBe(507); expect(f.excerpt).toContain("secret");
    expect(f.context[0].startColumn).toBeGreaterThan(1); expect(f.context[0].text.length).toBeLessThanOrEqual(320);
  });
  it("numbers findings and binds each accessible action to the exact selection", async () => {
    const r = await run('const secret="synthetic-value-123"; const password="synthetic-value-456";');
    if (!r.ok) throw Error(r.message);
    const markup = renderToStaticMarkup(<SecurityFindings state={{ snapshotId: "test", status: "done", result: r }} selected={r.findings[1].id} onSelect={() => {}} />);
    expect(markup).toContain("2 potential finding(s) shown"); expect(markup).toContain("Inspect finding 2: src/test.ts:1:");
    expect(markup).toContain('aria-pressed="true"'); expect(markup).toContain('aria-controls="security-finding-inspector"');
    const wiring = readFileSync("components/AstGraph.tsx", "utf8");
    expect(wiring).toContain("setFindingId(f.id)"); expect(wiring).toContain("<SecurityFindingInspector finding={selectedFinding}");
    expect(wiring).toContain("security.snapshotId === live.snapshot.snapshotId");
  });
});

describe("P5-QA-06 bounded scanning and truthful cooperative cancellation", () => {
  it("caps findings, reports the count and never calls an early stop complete", async () => {
    const source = Array.from({ length: 205 }, (_, i) => `const secret_${i}="synthetic-value-123";`).join("\n");
    const r = await run(source);
    expect(r).toMatchObject({ ok: true, findingLimitReached: true, scanComplete: false });
    if (!r.ok) return;
    expect(r.findings).toHaveLength(DETECTION_LIMITS.maxFindings);
    const markup = renderToStaticMarkup(<SecurityFindings state={{ snapshotId: "x", status: "done", result: r }} selected={null} onSelect={() => {}} />);
    expect(markup).toContain("200 potential finding(s) shown"); expect(markup).toContain("scanning stopped early");
    expect(markup).toContain("cannot be interrupted mid-file");
  });
  it.each(["maxFiles", "maxSourceBytes", "maxFileBytes", "maxLineStarts", "maxAstNodes", "maxAstDepth", "deadlineMs"] as const)("enforces the %s bound", async key => {
    const input = { "a.ts": 'export function f() { const n = (1 + 2); return n; }\n\n', "b.ts": "const n = 1;" };
    const options: DetectionOptions = { limits: { [key]: 1 } };
    const r = await detectSecurityFindings(securityFixture(input), new Map(Object.entries(input)), key === "deadlineMs" ? async text => { await new Promise(r => setTimeout(r, 8)); return sha256Text(text); } : sha256Text, options);
    expect(r).toMatchObject({ ok: false, code: "DETECTION_LIMIT" }); expect(r).not.toHaveProperty("findings");
  });
  it("applies byte ceilings to actual multibyte text, not claimed sizes", async () => {
    const r = await run('// 😀😀😀', "src/test.ts", { limits: { maxSourceBytes: 12 } });
    expect(r).toMatchObject({ ok: false, code: "DETECTION_LIMIT" });
  });
  it("rejects invalid or enlarged limits", async () => {
    for (const maxFindings of [0, -1, 1.5, NaN, 201]) expect(await run("const n=1", "src/test.ts", { limits: { maxFindings } })).toMatchObject({ ok: false, code: "DETECTION_LIMIT" });
  });
  it("honors pre-abort and abort after an asynchronous hash boundary", async () => {
    const input = { "a.ts": "const n=1;" }, s = securityFixture(input), c = new AbortController(); c.abort();
    expect(await detectSecurityFindings(s, new Map(Object.entries(input)), sha256Text, { signal: c.signal })).toMatchObject({ ok: false, code: "CANCELLED" });
    const next = new AbortController();
    expect(await detectSecurityFindings(s, new Map(Object.entries(input)), async text => { next.abort(); return sha256Text(text); }, { signal: next.signal })).toMatchObject({ ok: false, code: "CANCELLED" });
  });
  it("yields between validation and parsing so queued cancellation is delivered", async () => {
    const c = new AbortController(); setTimeout(() => c.abort(), 0);
    expect(await run("const n=1;", "src/test.ts", { signal: c.signal })).toMatchObject({ ok: false, code: "CANCELLED" });
  });
});

describe("P5-QA-07 exact local evidence and explicit upstream schema trust", () => {
  it("creates a complete typed fixture that passes E1 identity/manifest validation", () => {
    const snapshot = securityFixture({ "a.ts": "const n=1;" });
    expect(SourceSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(readFileSync("security-test-fixture.ts", "utf8")).not.toContain("as unknown as");
  });
  it.each(["byte count", "interior line offset", "line count", "hash", "duplicate path", "unsafe path", "language"])("fails closed on forged %s", async kind => {
    const input = { "a.ts": '// 😀\r\nconst secret="synthetic-value-123";\n' }, s = securityFixture(input);
    const file = s.files[0];
    if (kind === "byte count") file.bytes++;
    if (kind === "interior line offset") file.lineStartOffsets[1]--;
    if (kind === "line count") file.lineCount++;
    if (kind === "hash") file.sha256 = "0".repeat(64);
    if (kind === "duplicate path") s.files.push({ ...file });
    if (kind === "unsafe path") file.path = "../a.ts";
    if (kind === "language") file.language = "tsx";
    const r = await detectSecurityFindings(s, new Map(Object.entries(input)), sha256Text);
    expect(r).toMatchObject({ ok: false, code: "EVIDENCE_INVALID" }); expect(r).not.toHaveProperty("findings");
  });
  it("rejects missing/extra inventory before any hash callback", async () => {
    const input = { "a.ts": "const n=1;" }, s = securityFixture(input), hash = vi.fn(sha256Text);
    for (const map of [new Map<string, string>(), new Map([...Object.entries(input), ["extra.ts", "const x=1;"]])]) expect(await detectSecurityFindings(s, map, hash)).toMatchObject({ ok: false, code: "EVIDENCE_INVALID" });
    expect(hash).not.toHaveBeenCalled();
  });
  it("validates all files before emitting any finding and fails closed if hashing throws", async () => {
    const input = { "a.ts": 'const secret="synthetic-value-123";', "b.ts": "const n=1;" }, s = securityFixture(input);
    const contents = new Map(Object.entries(input)); contents.set("b.ts", "const n=2;");
    expect(await detectSecurityFindings(s, contents, sha256Text)).toMatchObject({ ok: false, code: "EVIDENCE_INVALID" });
    expect(await detectSecurityFindings(s, new Map(Object.entries(input)), () => { throw Error("hash unavailable"); })).toMatchObject({ ok: false, code: "EVIDENCE_INVALID" });
  });
});
