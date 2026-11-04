/**
 * POST /api/intake — E1 intake endpoint v3 (P3 Candidate 003).
 *
 * SYNTHETIC provider only: no external network. The request body is read
 * INCREMENTALLY with a hard cap (never fully buffered when oversized;
 * Content-Length never trusted), validated with `IntakeRequestSchema`, and
 * the emitted receipt is validated by the strict `SourceSnapshotSchema`
 * before responding. Real public-GitHub retrieval stays unauthorized.
 */
import { NextResponse } from "next/server";
import { syntheticProvider, bodyErrorResponse } from "@/lib/intake-server";
import { parseGitHubRepoInput } from "@/lib/github-url";
import {
  buildSyntheticSnapshot,
  rejectUnsafePath,
} from "@/lib/github-intake";
import { IntakeRequestSchema, MAX_REQUEST_BODY_BYTES, readRequestBody } from "@/lib/intake-api";
import {
  E1_LIMITS,
  languageForPath,
  sha256Hex,
  splitSourceLines,
  type FileMeta,
  type SkippedFile,
  type SnapshotFile,
} from "@/lib/source-snapshot";

/**
 * Overall intake deadline for request-body consumption (Finding B).
 * Independent of provider behavior: a never-ending body stream settles
 * here instead of leaving POST pending indefinitely. This bounds
 * application waiting — it does not forcibly terminate transport activity.
 */
const BODY_DEADLINE_MS = 30_000;

export async function POST(req: Request): Promise<Response> {
  // req.signal flows through body consumption AND the deadline boundary:
  // client abort settles promptly; the deadline settles hanging streams.
  // Rejection handlers attach inside settleIndependently before any
  // already-aborted exit, so late outcomes stay observed, never unhandled.
  let bounded: { ok: true; text: string } | { ok: false; code: "LIMIT_EXCEEDED" | "MALFORMED" | "CANCELLED" };
  try {
    bounded = await readRequestBody(req, MAX_REQUEST_BODY_BYTES, BODY_DEADLINE_MS);
  } catch (err) {
    return bodyErrorResponse(err);
  }
  if (!bounded.ok) {
    const status = bounded.code === "LIMIT_EXCEEDED" ? 413 : 400;
    const message =
      bounded.code === "LIMIT_EXCEEDED"
        ? "Request body exceeds the intake limit."
        : bounded.code === "CANCELLED"
          ? "Intake request was cancelled."
          : "Could not read request body.";
    return NextResponse.json({ ok: false, code: bounded.code, message }, { status });
  }
  let body: unknown;
  try {
    body = JSON.parse(bounded.text);
  } catch {
    return NextResponse.json({ ok: false, code: "MALFORMED", message: "Request body must be JSON." }, { status: 400 });
  }
  const checked = IntakeRequestSchema.safeParse(body);
  if (!checked.success) {
    return NextResponse.json({ ok: false, code: "VALIDATION", message: "Missing or invalid repository URL." }, { status: 400 });
  }
  const parsed = parseGitHubRepoInput(checked.data.url);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, code: "VALIDATION", message: parsed.message }, { status: 422 });
  }

  // Synthetic-only intake through the v3 pipeline, labeled synthetic.
  const provider = syntheticProvider(parsed.owner, parsed.repo);
  const signal = req.signal;
  let sha: string;
  try {
    ({ sha } = await provider.resolveRef(parsed.owner, parsed.repo, parsed.ref, signal));
  } catch (err) {
    return NextResponse.json(
      { ok: false, code: (err as { code?: string })?.code ?? "PROVIDER_UNAVAILABLE", message: "Synthetic provider could not resolve the reference." },
      { status: 502 }
    );
  }
  const metas: FileMeta[] = [];
  try {
    for await (const meta of provider.listEntries(parsed.owner, parsed.repo, sha, signal)) {
      if (metas.length >= E1_LIMITS.maxMetadataEntries) {
        return NextResponse.json({ ok: false, code: "LIMIT_EXCEEDED", message: "Metadata cap exceeded." }, { status: 502 });
      }
      if (typeof meta?.path !== "string" || typeof meta?.size !== "number") {
        return NextResponse.json({ ok: false, code: "MALFORMED", message: "Synthetic provider listing was malformed." }, { status: 502 });
      }
      metas.push(meta);
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, code: (err as { code?: string })?.code ?? "PROVIDER_UNAVAILABLE", message: "Synthetic provider listing failed." },
      { status: 502 }
    );
  }
  const files: SnapshotFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const meta of [...metas].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const unsafe = rejectUnsafePath(meta.path, E1_LIMITS.maxPathDepth);
    const language = languageForPath(meta.path);
    if (unsafe !== null) {
      if (unsafe === "max-depth") {
        skipped.push({ path: meta.path.slice(0, 512), reason: "depth-limit" });
        continue;
      }
      // Syntax-unsafe paths are never itemized (Finding C); fixtures are
      // safe so this only defends against future provider changes.
      continue;
    }
    if (language === null) {
      skipped.push({ path: meta.path.slice(0, 512), reason: "unsupported-language" });
      continue;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let over = false;
    try {
      for await (const chunk of provider.openFile(parsed.owner, parsed.repo, sha, meta.path, signal)) {
        if (total + chunk.length > E1_LIMITS.maxFileBytes) {
          over = true;
          break;
        }
        chunks.push(chunk);
        total += chunk.length;
      }
    } catch {
      skipped.push({ path: meta.path.slice(0, 512), reason: "not-found" });
      continue;
    }
    if (over) {
      skipped.push({ path: meta.path.slice(0, 512), reason: "oversized" });
      continue;
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.length;
    }
    const geom = splitSourceLines(bytes);
    files.push({
      path: meta.path,
      language,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      lineCount: geom.lineCount,
      lineStartOffsets: geom.lineStartOffsets,
    });
  }
  const snapshot = buildSyntheticSnapshot(parsed.owner, parsed.repo, parsed.ref, files, skipped);
  return NextResponse.json({
    ok: true,
    snapshot,
    requested: { owner: parsed.owner, repo: parsed.repo, ref: parsed.ref },
    synthetic: true,
    note: "Synthetic intake receipt only. Real GitHub retrieval is not authorized in this candidate; no repository was fetched and no findings were produced.",
  });
}
