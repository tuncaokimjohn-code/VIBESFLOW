/**
 * P7 C004 safer-code comparison (SAFER_COMPARISON_004; parent C003).
 *
 * Bounded, deterministic BEFORE/AFTER demonstration for the three
 * P5 supported rules (VF-SEC-001/002/003) only. This is NOT a generalized
 * rewrite engine and does NOT fix vulnerabilities.
 *
 * Provenance correction (C002, Codex blocker B1; hardened C003, Codex C002
 * QA MEDIUM): the BEFORE/AFTER pair is a FIXED synthetic sample with its
 * OWN independent sample identity (sampleId + sampleSha256). It is NEVER
 * derived from, and never inherits, the selected finding's source
 * path/line/hash. An associated finding is cited ONLY when its provenance
 * is verified against caller-provided trusted snapshot evidence (exact
 * snapshot membership: snapshotId, immutable commit, path, line/column
 * within content geometry, file SHA-256, and an ALWAYS-computed content
 * SHA-256 over the actual source bytes (bundled browser-safe sync helper,
 * compared against the snapshot file digest every time). Anything
 * unverified yields the example-only comparison with NO finding citation
 * attached (fail-closed, never a fabricated or misleading citation).
 * Unsupported rules fail closed (no comparison fabricated). C004 (Codex
 * C003 QA MEDIUM) additionally required an independently verified snapshot
 * (verified === true) and anchor binding (quote equals source bytes at
 * char/byte offsets mapping to the claimed line/column). C005 (Codex C004
 * QA MEDIUM) removes ALL trust in the caller-supplied
 * `contentHashVerified` boolean and in any caller-supplied hasher: the
 * membership check computes the actual SHA-256 itself, so changed
 * same-geometry bytes can never pass. Fabricated in-range anchors fail
 * closed with no citation; no automatic code fixes are produced.
 *
 * Display safety (C003, Codex C002 QA HIGH; extended C004, Codex C003 QA HIGH): the C002 line-oriented
 * `redactFindingText` could not establish confidence across multiline
 * lexical spans (template continuations, comment/regex secret
 * continuations), so it is retired to fail-closed: it now withholds ALL
 * untrusted excerpt/quote input and returns only a fixed notice. The
 * findings list and inspector render NO original excerpt/quote/anchor
 * content at all — only location and provenance metadata
 * (path/line/column, offsets, snapshot, commit, file SHA-256). The ONLY
 * code text rendered in the P7 panel is the fixed synthetic BEFORE/AFTER
 * pair, which is curated non-secret fixture content (no secrets inside;
 * BEFORE display additionally passes `redactLiteralsForDisplay`, which
 * MUST be applied only to those fixed fixtures, never to untrusted
 * source). No universal redaction is claimed. Inspected source is never
 * executed; this module performs no network or provider calls
 * (provider stays null) and imports no Node builtins.
 */
import type { SecurityFinding } from "@/lib/security-findings";
import { sourceLines } from "@/lib/source-lines";
import { sha256SyncHex } from "@/lib/sha256-sync";

export const SUPPORTED_COMPARISON_RULES = ["VF-SEC-001", "VF-SEC-002", "VF-SEC-003"] as const;
export type SupportedComparisonRule = (typeof SUPPORTED_COMPARISON_RULES)[number];

export function isSupportedComparisonRule(ruleId: string): ruleId is SupportedComparisonRule {
  return (SUPPORTED_COMPARISON_RULES as readonly string[]).includes(ruleId);
}

/** Independent identity of the FIXED synthetic sample. NOT repo provenance. */
export interface SampleProvenance {
  sampleId: string;
  sampleSha256: string;
  note: string;
}

/**
 * Distinctly-labeled reference to the associated selected finding.
 * This is the finding's OWN evidence identity — it is NOT the source of
 * the synthetic sample and must never be rendered as sample provenance.
 */
export interface AssociatedFindingRef {
  path: string;
  line: number;
  column: number;
  fileSha256: string;
  snapshotId: string;
  commit: string | null;
}

export interface SaferComparison {
  ruleId: SupportedComparisonRule;
  /** Exact vulnerable synthetic sample bytes (fixture bytes). Never rendered directly. */
  beforeExact: string;
  /** Redacted display text for BEFORE (safe for UI; no secret contents). */
  beforeDisplay: string;
  /** Curated illustrative safer pattern. NOT a validated fix. */
  after: string;
  beforeLabel: string;
  afterLabel: string;
  limitations: string;
  /** Independent synthetic sample identity — the ONLY provenance of the example. */
  sample: SampleProvenance;
  /** The associated selected finding's own evidence identity, or null (example-only). */
  associatedFinding: AssociatedFindingRef | null;
}

/**
 * Fixed notice rendered INSTEAD of any untrusted excerpt/quote/anchor.
 * Carries no source content; safe to render as text anywhere.
 */
export const WITHHELD_NOTICE =
  "[WITHHELD — source excerpt not shown; see location and provenance metadata]";

/**
 * Redact single/double-quoted literal contents.
 * Deterministic, offline. SCOPE: fixed synthetic P7 fixtures ONLY
 * (`beforeDisplay` derivation). MUST NOT be applied to untrusted finding
 * excerpts/quotes: indistinct lexical spans (multiline templates,
 * comment/regex continuations) make per-line redaction untrustworthy, so
 * untrusted text is withheld entirely (see `redactFindingText`). Template
 * literals are left intact: the P7 fixtures carry no secrets inside them
 * (the only synthetic secret is the VF-SEC-001 double-quoted literal),
 * and their static SQL text is the evidence shape the BEFORE panel shows.
 */
export function redactLiteralsForDisplay(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === "\\") j++;
        j++;
      }
      out += ch + "[REDACTED]" + (j < line.length ? ch : "");
      i = j < line.length ? j + 1 : j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * Fail-closed withholding for ANY untrusted finding excerpt/quote/anchor.
 *
 * C003 (Codex C002 QA HIGH): the C002 line-oriented redaction could not
 * establish confidence across multiline lexical spans — a secret opened
 * on one line (multiline template literal, block-comment continuation,
 * regex continuation, or an encoded/split token reassembled across
 * lines) can leak through per-line redaction of the continuation lines.
 * No per-line heuristic can enumerate every span shape, so this function
 * no longer inspects its input: every call returns the fixed
 * `WITHHELD_NOTICE`, and the list/inspector do not render untrusted
 * excerpt content at all. The input is accepted (and ignored) only to
 * preserve the call signature; callers MUST NOT render the input under
 * any condition. No universal redaction is claimed — withholding is the
 * absence of a redaction claim, not a stronger one.
 */
export function redactFindingText(_text: string): string {
  return WITHHELD_NOTICE;
}

interface RuleComparison {
  beforeExact: string;
  after: string;
  limitations: string;
}

const COMPARISONS: Record<SupportedComparisonRule, RuleComparison> = {
  "VF-SEC-001": {
    beforeExact: 'const apiKey = "AKIA-EXAMPLE-SYNTHETIC-12345";\nexport const x = 1;\n',
    after:
      "const apiKey = process.env.API_KEY;\n" +
      'if (!apiKey) throw new Error("Missing API_KEY");\n' +
      "export const x = 1;\n",
    limitations:
      "Illustrative safer pattern only: reads the secret from the environment instead of a source literal. " +
      "Not a validated fix — if a real credential was exposed, rotate it and remove it from source history.",
  },
  "VF-SEC-002": {
    beforeExact: "export const f = (id: string) => db.query(`SELECT * FROM t WHERE id = ${id}`);\n",
    after: 'export const f = (id: string) => db.query("SELECT * FROM t WHERE id = $1", [id]);\n',
    limitations:
      "Illustrative safer pattern only: parameterized query with a bound parameter instead of string interpolation. " +
      "Not a validated fix — verify the driver placeholder syntax and that no other dynamic SQL remains.",
  },
  "VF-SEC-003": {
    beforeExact:
      "export const V = (html: string) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n",
    after: "export const V = (text: string) => <div>{text}</div>;\n",
    limitations:
      "Illustrative safer pattern only: renders escaped React children instead of raw HTML. " +
      "Not a validated fix — if raw HTML is required, sanitize with a vetted sanitizer first.",
  },
};

/**
 * Independent sample hashes: SHA-256 of each rule's fixed `beforeExact`
 * bytes, computed offline and hardcoded so this client-reachable module
 * needs no Node builtin. `safer-comparison.test.ts` recomputes them from
 * `beforeExact` and fails if they ever drift.
 */
const SAMPLE_SHA256: Record<SupportedComparisonRule, string> = {
  "VF-SEC-001": "0c2ea865943aaf2246122e8e5918652cbac17ce265d965f96b8dd1cb9b303c6b",
  "VF-SEC-002": "150711cbc0f02cc6bbbb01e44f6dc69ed0e62b7474f6faaddbab933752eb12fd",
  "VF-SEC-003": "9849ad981433dc3301810b8f399234f261492eea50286e480d8273d649fff01d",
};

function sampleFor(ruleId: SupportedComparisonRule): SampleProvenance {
  return {
    sampleId: `SYNTH-SAMPLE-${ruleId}`,
    sampleSha256: SAMPLE_SHA256[ruleId],
    note: "Fixed illustrative synthetic sample. NOT from the selected repository.",
  };
}

function buildComparison(ruleId: SupportedComparisonRule, associatedFinding: AssociatedFindingRef | null): SaferComparison {
  const c = COMPARISONS[ruleId];
  return {
    ruleId,
    beforeExact: c.beforeExact,
    beforeDisplay: redactLiteralsForDisplay(c.beforeExact),
    after: c.after,
    beforeLabel: "BEFORE — vulnerable synthetic sample (fixed example bytes; display redacted)",
    afterLabel: "AFTER — illustrative safer pattern (developer-reviewed example, NOT a validated fix)",
    limitations: c.limitations,
    sample: sampleFor(ruleId),
    associatedFinding,
  };
}

export type ComparisonResult =
  | { ok: true; comparison: SaferComparison }
  | { ok: false; code: "UNSUPPORTED_RULE"; message: string };

/** Deterministic mapping for a rule id. Unsupported rules fail closed (withheld). */
export function comparisonForRule(ruleId: string): ComparisonResult {
  if (!isSupportedComparisonRule(ruleId)) {
    return { ok: false, code: "UNSUPPORTED_RULE", message: `No safer comparison available for rule ${ruleId}; supported: VF-SEC-001, VF-SEC-002, VF-SEC-003.` };
  }
  return { ok: true, comparison: buildComparison(ruleId, null) };
}

/**
 * Minimal shape validation for an associated finding reference.
 * Only validated references are cited; anything else yields example-only
 * output with NO finding citation attached (fail-closed, no fabrication).
 */
export function isValidFindingRef(finding: unknown): finding is SecurityFinding {
  if (typeof finding !== "object" || finding === null) return false;
  const f = finding as Record<string, unknown>;
  return (
    typeof f["ruleId"] === "string" &&
    isSupportedComparisonRule(f["ruleId"]) &&
    typeof f["path"] === "string" &&
    (f["path"] as string).length > 0 &&
    Number.isInteger(f["line"]) &&
    (f["line"] as number) >= 1 &&
    Number.isInteger(f["column"]) &&
    (f["column"] as number) >= 1 &&
    typeof f["fileSha256"] === "string" &&
    /^[0-9a-f]{64}$/.test(f["fileSha256"] as string) &&
    typeof f["snapshotId"] === "string" &&
    (f["snapshotId"] as string).length > 0
  );
}

/**
 * Caller-provided trusted source evidence against which a finding's
 * claimed provenance MUST be verified before it may be cited. The snapshot
 * file entries and contents are the upstream-validated records (hash and
 * geometry checked at intake/detection time); this module re-checks exact
 * membership here so a merely valid-shaped fabricated finding cannot buy
 * itself a citation. No network, no fetching — only the records handed in.
 */
export interface TrustedSourceEvidence {
  snapshotId: string;
  /** Immutable resolved commit; null only for synthetic snapshots. Must match exactly. */
  commit: string | null;
  files: ReadonlyArray<{ path: string; sha256: string; lineCount: number }>;
  contents: ReadonlyMap<string, string> | Record<string, string>;
  /**
   * C004 (Codex C003 QA MEDIUM): the caller asserts this snapshot was
   * independently verified (detection-time SHA-256, byte/line geometry and
   * graph checks over these exact records). Membership is cited ONLY when
   * `verified === true`; anything else fails closed with
   * NO_TRUSTED_EVIDENCE / UNVERIFIED_SNAPSHOT and no citation.
   */
  verified: boolean;
  /**
   * C005 (Codex C004 QA MEDIUM): NO caller-supplied hash input is trusted.
   * The removed `contentHashVerified` boolean let changed same-geometry
   * bytes pass without hashing, so it no longer exists — any such record
   * field is ignored. A caller-supplied hasher is not trusted either: the
   * membership check ALWAYS computes the SHA-256 of the actual `contents`
   * bytes with the bundled browser-safe sync helper
   * (`lib/sha256-sync.ts`: pure TypeScript, no Node builtins, runs in the
   * browser bundle and in tests) and requires equality with the snapshot
   * file digest on EVERY call. The optional legacy `sha256Text` callback,
   * when present, is accepted but IGNORED for the decision and exists only
   * so older evidence records still type-check.
   */
  sha256Text?: (text: string) => string;
}

export type MembershipVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Exact snapshot-membership verification for a finding's claimed
 * provenance. Every check must pass; the first failure names its reason.
 * Fabricated but valid-shaped provenance fails here (it is not a member
 * of the trusted snapshot) and the caller must then omit the finding
 * entirely and label the output a synthetic example only.
 */
/**
 * Map a 0-based UTF-16 char offset to 1-based (line, column) using the same
 * ECMAScript line terminators the detector enforces (LF, CRLF, CR, U+2028/29).
 */
function lineColumnForOffset(text: string, offset: number): { line: number; column: number } | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return null;
  const re = /\r\n|[\n\r\u2028\u2029]/g;
  let line = 1;
  let lineStart = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    if (offset < end) break;
    line += 1;
    lineStart = end;
  }
  return { line, column: offset - lineStart + 1 };
}

export function verifyFindingMembership(finding: unknown, trusted: unknown): MembershipVerdict {
  if (typeof trusted !== "object" || trusted === null) return { ok: false, reason: "NO_TRUSTED_EVIDENCE" };
  const t = trusted as Record<string, unknown>;
  if (typeof t["snapshotId"] !== "string" || (t["snapshotId"] as string).length === 0) return { ok: false, reason: "NO_TRUSTED_EVIDENCE" };
  if (!Array.isArray(t["files"])) return { ok: false, reason: "NO_TRUSTED_EVIDENCE" };
  if (typeof t["contents"] !== "object" || t["contents"] === null) return { ok: false, reason: "NO_TRUSTED_EVIDENCE" };
  // C004: independently verified snapshot required. A merely well-shaped
  // hand-built record (verified missing/false) never buys a citation.
  if (t["verified"] !== true) {
    const shapeOk =
      typeof t["snapshotId"] === "string" && (t["snapshotId"] as string).length > 0 &&
      Array.isArray(t["files"]) && typeof t["contents"] === "object" && t["contents"] !== null;
    return { ok: false, reason: shapeOk ? "UNVERIFIED_SNAPSHOT" : "NO_TRUSTED_EVIDENCE" };
  }
  if (!isValidFindingRef(finding)) return { ok: false, reason: "INVALID_FINDING_SHAPE" };
  const f = finding as SecurityFinding;
  if (f.snapshotId !== t["snapshotId"]) return { ok: false, reason: "SNAPSHOT_MISMATCH" };
  if (f.commit !== (t["commit"] as string | null)) return { ok: false, reason: "COMMIT_MISMATCH" };
  const files = t["files"] as Array<{ path: unknown; sha256: unknown; lineCount: unknown }>;
  const entry = files.find((e) => e.path === f.path);
  if (!entry) return { ok: false, reason: "PATH_NOT_IN_SNAPSHOT" };
  if (entry.sha256 !== f.fileSha256) return { ok: false, reason: "HASH_MISMATCH" };
  if (!Number.isInteger(entry.lineCount) || (entry.lineCount as number) < 1) return { ok: false, reason: "NO_TRUSTED_EVIDENCE" };
  const contents = t["contents"] as ReadonlyMap<string, string> | Record<string, string>;
  const text = typeof (contents as ReadonlyMap<string, string>).get === "function"
    ? (contents as ReadonlyMap<string, string>).get(f.path)
    : (contents as Record<string, string>)[f.path];
  if (typeof text !== "string") return { ok: false, reason: "CONTENTS_MISSING" };
  // Same line geometry the detector enforces (LF, CRLF, CR, U+2028/29).
  const lines = sourceLines(text);
  if (lines.length !== (entry.lineCount as number)) return { ok: false, reason: "LINECOUNT_MISMATCH" };
  if (f.line < 1 || f.line > (entry.lineCount as number)) return { ok: false, reason: "LOCATION_OUT_OF_RANGE" };
  const lineText = lines[f.line - 1] ?? "";
  if (!Number.isInteger(f.column) || f.column < 1 || f.column > lineText.length + 1) return { ok: false, reason: "LOCATION_OUT_OF_RANGE" };
  // C005 (Codex C004 QA MEDIUM): the actual source content SHA-256 is
  // ALWAYS computed here from the handed-in `contents` bytes with the
  // bundled browser-safe sync helper and MUST equal the snapshot file
  // digest (which in turn must equal the finding's claimed digest — see
  // HASH_MISMATCH above). No caller boolean (`contentHashVerified`) and
  // no caller-supplied hasher is consulted: changed same-geometry bytes
  // fail closed here with CONTENT_HASH_MISMATCH and never reach the
  // anchor checks below. Where this helper is unavailable the correct
  // outcome is fail-closed example-only (no citation).
  const actual = sha256SyncHex(text);
  if (actual !== entry.sha256) return { ok: false, reason: "CONTENT_HASH_MISMATCH" };
  if (actual !== f.fileSha256) return { ok: false, reason: "CONTENT_HASH_MISMATCH" };
  // C004: the selected finding's anchor/quote must equal the actual source
  // bytes at the claimed offsets, and the offsets must map to the claimed
  // line/column. A fabricated in-range anchor (valid shape, valid geometry,
  // but invented quote/offsets) fails here with no citation.
  if (!Number.isInteger(f.charOffset) || !Number.isInteger(f.endCharOffset)) return { ok: false, reason: "ANCHOR_MISMATCH" };
  if (f.charOffset < 0 || f.endCharOffset <= f.charOffset || f.endCharOffset > text.length) return { ok: false, reason: "ANCHOR_MISMATCH" };
  if (typeof f.quote !== "string" || text.slice(f.charOffset, f.endCharOffset) !== f.quote) return { ok: false, reason: "ANCHOR_MISMATCH" };
  const enc = new TextEncoder();
  if (enc.encode(text.slice(0, f.charOffset)).length !== f.byteOffset) return { ok: false, reason: "ANCHOR_MISMATCH" };
  if (enc.encode(text.slice(0, f.endCharOffset)).length !== f.endByteOffset) return { ok: false, reason: "ANCHOR_MISMATCH" };
  const mapped = lineColumnForOffset(text, f.charOffset);
  if (mapped === null || mapped.line !== f.line || mapped.column !== f.column) return { ok: false, reason: "ANCHOR_MISMATCH" };
  return { ok: true };
}

/**
 * Example-only comparison, optionally associated with a finding whose
 * provenance verifies against trusted snapshot evidence.
 * The synthetic sample NEVER inherits the finding's path/line/hash as its
 * provenance: the sample carries only its independent sampleId/sampleSha256,
 * and the finding (when membership-verified) is cited separately as
 * `associatedFinding`. Unsupported rule ids fail closed (withheld).
 * Unverified findings — no evidence supplied, or ANY membership check
 * fails — yield the example with NO finding citation (never a misleading
 * citation, never secretly attached real finding data, never an invented
 * citation). Callers MUST label that output a synthetic example only.
 */
export function comparisonForFinding(finding: SecurityFinding, trusted?: TrustedSourceEvidence): ComparisonResult {
  const ruleId: string | undefined = (finding as { ruleId?: unknown } | null)?.ruleId as string | undefined;
  if (typeof ruleId !== "string" || !isSupportedComparisonRule(ruleId)) {
    return { ok: false, code: "UNSUPPORTED_RULE", message: `No safer comparison available for rule ${String(ruleId)}; supported: VF-SEC-001, VF-SEC-002, VF-SEC-003.` };
  }
  if (verifyFindingMembership(finding, trusted).ok) {
    return {
      ok: true,
      comparison: buildComparison(ruleId, {
        path: finding.path,
        line: finding.line,
        column: finding.column,
        fileSha256: finding.fileSha256,
        snapshotId: finding.snapshotId,
        commit: finding.commit,
      }),
    };
  }
  return { ok: true, comparison: buildComparison(ruleId, null) };
}
