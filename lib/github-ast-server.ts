/**
 * Server-only GitHub-to-AST integration (Integration Candidate 002).
 *
 * Data path: GitHubRestProvider (P3 C006 protections, injected transport)
 * -> runGitHubIntake (bounded collection, validated SourceSnapshot)
 * -> content capture (bytes actually read, capped per file)
 * -> buildAstGraph + validateGraphShape over the validated snapshot.
 *
 * Repository source is never executed. This module must never be
 * imported by client components: it pulls in the server provider.
 */
import { NextResponse } from "next/server";
import { runGitHubIntake, type GitHubSourceProvider } from "@/lib/github-intake";
import { parseGitHubRepoInput } from "@/lib/github-url";
import { buildAstGraph, type AstGraph } from "@/lib/ast-graph";
import { validateEvidence } from "@/lib/evidence";
import { IntakeRequestSchema, MAX_REQUEST_BODY_BYTES, readRequestBody } from "@/lib/intake-api";
import { bodyErrorResponse } from "@/lib/intake-server";
import { E1_LIMITS, SourceSnapshotSchema, sha256Text, type SourceSnapshot } from "@/lib/source-snapshot";
import { AstGraphSchema, analysisStatus, assertAnalysisBudget, createGitHubAstResponseSchema } from "@/lib/github-ast-contract";
import { serializeAstResponse, withAnalysisDeadline } from "@/lib/analysis-budget-server";

const BODY_DEADLINE_MS = 30_000;

/** Tee provider reads into a bounded capture map (per-file cap enforced). */
export function createContentCapturingProvider(
  base: GitHubSourceProvider,
  capture: Map<string, Uint8Array>,
  overflow: Set<string>
): GitHubSourceProvider {
  return {
    resolveRef: (owner, repo, ref, signal) => base.resolveRef(owner, repo, ref, signal),
    listEntries: (owner, repo, sha, signal) => base.listEntries(owner, repo, sha, signal),
    async *openFile(owner, repo, sha, path, signal): AsyncIterable<Uint8Array> {
      const chunks: Uint8Array[] = [];
      let total = 0;
      let over = false;
      for await (const chunk of base.openFile(owner, repo, sha, path, signal)) {
        if (!over) {
          if (total + chunk.length > E1_LIMITS.maxFileBytes) {
            over = true;
            overflow.add(path);
          } else {
            chunks.push(chunk);
            total += chunk.length;
          }
        }
        yield chunk;
      }
      if (!over) {
        const bytes = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { bytes.set(c, off); off += c.length; }
        capture.set(path, bytes);
      }
    },
  };
}

export type GitHubToAstResult =
  | { ok: true; snapshot: SourceSnapshot; contents: Map<string, string>; graph: AstGraph; shapeOk: true; shapeIssues: []; undecoded: []; evidenceVerified: true }
  | { ok: false; code: string; message: string; partial?: SourceSnapshot };

/** Run intake, then AST over the actual captured source bytes. */
export async function runGitHubToAst(args: {
  owner: string; repo: string; ref: string | null;
  provider: GitHubSourceProvider; signal?: AbortSignal; collectedAt?: string;
}): Promise<GitHubToAstResult> {
  const capture = new Map<string, Uint8Array>();
  const overflow = new Set<string>();
  const provider = createContentCapturingProvider(args.provider, capture, overflow);
  const intake = await runGitHubIntake(args.owner, args.repo, args.ref, provider, {
    signal: args.signal, collectedAt: args.collectedAt,
  });
  if (!intake.ok) return intake;
  try {
    args.signal?.throwIfAborted();
    const result = withAnalysisDeadline((): GitHubToAstResult => {
      const snapshot = SourceSnapshotSchema.parse(intake.snapshot);
      assertAnalysisBudget(snapshot);
      const contents = new Map<string, string>();
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      for (const file of snapshot.files) {
        const bytes = capture.get(file.path);
        if (bytes === undefined || overflow.has(file.path)) throw Object.assign(new Error("Missing captured source"), { code: "EVIDENCE_INVALID" });
        contents.set(file.path, decoder.decode(bytes));
      }
      const graph = buildAstGraph(snapshot, contents);
      if (!AstGraphSchema.safeParse(graph).success) throw Object.assign(new Error("Graph budget or shape exceeded"), { code: "ANALYSIS_LIMIT" });
      const evidence = validateEvidence(graph, snapshot, contents, sha256Text, {
        canonicalProvenance: `https://github.com/${args.owner}/${args.repo}`,
        resolvedCommitIfGitHub: snapshot.resolvedCommitIfGitHub,
      });
      if (!evidence.ok) throw Object.assign(new Error("Evidence check failed"), { code: "EVIDENCE_INVALID" });
      return { ok: true, snapshot, contents, graph, shapeOk: true, shapeIssues: [], undecoded: [], evidenceVerified: true };
    });
    args.signal?.throwIfAborted();
    return result;
  } catch (error) {
    return analysisFailure(error, args.signal);
  }
}

function analysisFailure(error: unknown, signal?: AbortSignal): Extract<GitHubToAstResult, { ok: false }> {
  if (signal?.aborted) return { ok: false, code: "CANCELLED", message: "Real analysis was cancelled." };
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return { ok: false, code: "ANALYSIS_TIMEOUT", message: "AST analysis exceeded its enforced processing deadline." };
  if (code === "ANALYSIS_LIMIT" || code === "RESPONSE_LIMIT") return { ok: false, code, message: "Real analysis exceeded its analysis or response resource budget." };
  return { ok: false, code: "EVIDENCE_INVALID", message: "Real analysis failed source evidence validation." };
}

const responseSchema = createGitHubAstResponseSchema(SourceSnapshotSchema);
function statusFor(code: string): number {
  if (code === "CANCELLED") return 499;
  if (code === "TIMEOUT" || code === "ANALYSIS_TIMEOUT") return 504;
  if (code === "ANALYSIS_LIMIT" || code === "RESPONSE_LIMIT" || code === "LIMIT_EXCEEDED") return 413;
  return code === "VALIDATION" || code === "EVIDENCE_INVALID" ? 422 : 502;
}

function failureResponse(failure: Extract<GitHubToAstResult, { ok: false }>): Response {
  // Failure geometry may itself be large: retain only a bounded, validated body.
  try {
    const body = withAnalysisDeadline(() => serializeAstResponse(responseSchema.parse(failure)));
    return new Response(body, { status: statusFor(failure.code), headers: { "content-type": "application/json" } });
  } catch {
    return NextResponse.json({ ok: false, code: failure.code, message: failure.message.slice(0, 512) }, { status: statusFor(failure.code) });
  }
}

/**
 * POST handler factory for /api/github-ast. The provider factory is
 * injected so tests can supply a GitHubRestProvider over a mocked
 * transport; production wiring passes the real REST provider.
 */
export function createGitHubAstPost(providerFactory: () => GitHubSourceProvider) {
  return async function POST(req: Request): Promise<Response> {
    let bounded: { ok: true; text: string } | { ok: false; code: "LIMIT_EXCEEDED" | "MALFORMED" | "CANCELLED" };
    try {
      bounded = await readRequestBody(req, MAX_REQUEST_BODY_BYTES, BODY_DEADLINE_MS);
    } catch (err) {
      return bodyErrorResponse(err);
    }
    if (!bounded.ok) {
      const status = bounded.code === "LIMIT_EXCEEDED" ? 413 : 400;
      return NextResponse.json({ ok: false, code: bounded.code, message: "Could not read request body." }, { status });
    }
    let body: unknown;
    try { body = JSON.parse(bounded.text); } catch {
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
    try {
      const result = await runGitHubToAst({
        owner: parsed.owner, repo: parsed.repo, ref: parsed.ref,
        provider: providerFactory(), signal: req.signal,
      });
      if (!result.ok) return failureResponse(result);
      req.signal.throwIfAborted();
      const body = withAnalysisDeadline(() => {
        const checked = responseSchema.parse({
        ok: true, synthetic: false,
        requested: { owner: parsed.owner, repo: parsed.repo, ref: parsed.ref },
        snapshot: result.snapshot, contents: Object.fromEntries(result.contents), graph: result.graph,
        shapeOk: true, evidenceVerified: true, undecoded: [],
        analysisStatus: analysisStatus(result.snapshot, result.graph),
        note: "Source evidence validated at the pinned commit. Unsupported and skipped source remains outside analysis; no security findings or live-network qualification are claimed.",
        });
        // Validate the schema's actual output too, so no parser transformation
        // can detach the graph that will be serialized from its source bytes.
        if (!checked.ok || !validateEvidence(checked.graph, checked.snapshot,
          new Map(Object.entries(checked.contents)), sha256Text,
          { canonicalProvenance: `https://github.com/${parsed.owner}/${parsed.repo}` }).ok) {
          throw Object.assign(new Error("Wire evidence mismatch"), { code: "EVIDENCE_INVALID" });
        }
        return serializeAstResponse(checked);
      });
      req.signal.throwIfAborted();
      return new Response(body, { headers: { "content-type": "application/json" } });
    } catch (error) {
      return failureResponse(analysisFailure(error, req.signal));
    }
  };
}
