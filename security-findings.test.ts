/** P5 offline security-detection tests: synthetic fixtures only. */
import { describe, expect, it } from "vitest";
import { detectSecurityFindings, type SecurityFinding } from "@/lib/security-findings";
import { sha256Text } from "@/lib/source-snapshot";
import { securityFixture as snap } from "@/security-test-fixture";

const contents = (files: Record<string, string>) => new Map(Object.entries(files));
const run = (files: Record<string, string>) => detectSecurityFindings(snap(files), contents(files), sha256Text);

describe("VF-SEC-001 hardcoded credential", () => {
  it("flags a credential literal with exact evidence", async () => {
    const src = "const apiKey = \"sk-live-123456\";\nexport const x = 1;\n";
    const r = await run({ "src/config.ts": src });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f.ruleId).toBe("VF-SEC-001");
    expect(f.line).toBe(1);
    expect(f.excerpt).toContain("apiKey");
    expect(f.commit).toBe("a".repeat(40));
    expect(f.fileSha256).toBe(sha256Text(src));
    expect(f.recommendation).toContain("environment variable");
  });
  it("does not flag environment-based secrets or short placeholders", async () => {
    const r = await run({ "src/config.ts": "const apiKey = process.env.API_KEY;\nconst password = \"\";\n" });
    expect(r.ok && r.findings).toEqual([]);
  });
});

describe("VF-SEC-002 SQL injection (potential)", () => {
  it("flags interpolated SQL reaching a query call", async () => {
    const r = await run({ "src/db.ts": "export const f = (id: string) => db.query(`SELECT * FROM t WHERE id = ${id}`);\n" });
    expect(r.ok && r.findings.map((x: SecurityFinding) => x.ruleId)).toEqual(["VF-SEC-002"]);
  });
  it("does not flag parameterized queries or static SQL", async () => {
    const r = await run({ "src/db.ts": "export const f = (id: string) => db.query(\"SELECT * FROM t WHERE id = $1\", [id]);\nexport const g = () => db.query(\"SELECT 1\");\n" });
    expect(r.ok && r.findings).toEqual([]);
  });
});

describe("VF-SEC-003 XSS (potential)", () => {
  it("flags dynamic dangerouslySetInnerHTML in TSX", async () => {
    const r = await run({ "src/View.tsx": "export const V = (html: string) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n" });
    expect(r.ok && r.findings.map((x: SecurityFinding) => x.ruleId)).toEqual(["VF-SEC-003"]);
  });
  it("does not flag escaped children", async () => {
    const r = await run({ "src/View.tsx": "export const V = (text: string) => <div>{text}</div>;\n" });
    expect(r.ok && r.findings).toEqual([]);
  });
});

describe("evidence integrity and geometry", () => {
  it("fails closed on tampered contents (no findings emitted)", async () => {
    const files = { "src/config.ts": "const apiKey = \"sk-live-123456\";\n" };
    const tampered = new Map([["src/config.ts", "const apiKey = \"sk-live-999999\";\n"]]);
    const r = await detectSecurityFindings(snap(files), tampered, sha256Text);
    expect(r).toEqual({ ok: false, code: "EVIDENCE_INVALID", message: expect.stringContaining("hash mismatch") });
  });
  it("reports accurate lines under CRLF geometry", async () => {
    const src = "export const a = 1;\r\nconst dbPassword = \"hunter2-secret\";\r\n";
    const r = await run({ "src/c.ts": src });
    expect(r.ok && r.findings[0]?.line).toBe(2);
  });
  it("keeps repositories isolated (no cross-snapshot findings)", async () => {
    const clean = await run({ "src/a.ts": "export const a = 1;\n" });
    const dirty = await run({ "src/a.ts": "const secret = \"abcd1234\";\n" });
    expect(clean.ok && clean.findings).toEqual([]);
    expect(dirty.ok && dirty.findings).toHaveLength(1);
  });
});
