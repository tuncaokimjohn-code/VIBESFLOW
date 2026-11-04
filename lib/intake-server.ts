/** Server-only synthetic route helpers; no remote provider or network. */
import { NextResponse } from "next/server";
import type { GitHubSourceProvider } from "@/lib/github-intake";
import type { FileMeta } from "@/lib/source-snapshot-contract";

const enc = new TextEncoder();

/** Deterministic synthetic fixture bytes keyed by requested repo. */
const SYNTHETIC_FIXTURES: Record<string, Array<{ path: string; text: string }>> = {
  "example/sample-api": [
    { path: "src/index.ts", text: 'export * from "./api";\nexport * from "./services";\n' },
    { path: "src/api/orders.ts", text: "export async function listOrders(): Promise<unknown[]> {\n  return [];\n}\n" },
  ],
};

function fixtureFor(owner: string, repo: string): Array<{ path: string; text: string }> {
  return (
    SYNTHETIC_FIXTURES[`${owner}/${repo}`] ?? [
      { path: "src/index.ts", text: "// synthetic intake receipt — not a real scan\n" },
    ]
  );
}

/** Synthetic provider: bounded async enumeration + chunked reads, no network. */
export function syntheticProvider(owner: string, repo: string): GitHubSourceProvider {
  const entries = fixtureFor(owner, repo).map((f) => ({ path: f.path, bytes: enc.encode(f.text) }));
  return {
    async resolveRef(requestOwner, requestRepo, ref, signal) {
      signal.throwIfAborted();
      if (requestOwner === "private" || requestRepo === "private") {
        throw Object.assign(new Error("forbidden"), { code: "PRIVATE_OR_FORBIDDEN" });
      }
      if (requestOwner === "missing") {
        throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
      }
      if (requestOwner === "limited") {
        throw Object.assign(new Error("rate limited"), { code: "RATE_LIMITED" });
      }
      if (requestOwner === "empty") {
        throw Object.assign(new Error("empty"), { code: "EMPTY" });
      }
      void ref;
      // Fixed synthetic SHA: proves the "pinned commit" shape without a
      // real resolution. Never presented as a retrieved GitHub commit.
      return { sha: "0123456789abcdef0123456789abcdef01234567" };
    },
    async *listEntries(requestOwner, requestRepo, _sha, signal): AsyncIterable<FileMeta> {
      signal.throwIfAborted();
      void _sha;
      for (const e of entries) {
        signal.throwIfAborted();
        void requestOwner;
        void requestRepo;
        yield { path: e.path, size: e.bytes.length, kind: "file" as const };
      }
    },
    async *openFile(requestOwner, requestRepo, _sha, path, signal): AsyncIterable<Uint8Array> {
      signal.throwIfAborted();
      void _sha;
      const found = entries.find((e) => e.path === path);
      if (!found) throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
      void requestOwner;
      void requestRepo;
      // Small chunks: demonstrates the streaming contract honestly.
      const CHUNK = 16;
      for (let i = 0; i < found.bytes.length; i += CHUNK) {
        signal.throwIfAborted();
        yield found.bytes.subarray(i, i + CHUNK);
      }
    },
  };
}

/**
 * Map a body-read failure to a typed response (Finding B). Exported so the
 * TIMEOUT→408 mapping is testable through an isolated short-deadline
 * fixture without waiting the production 30 s: the fixture produces the
 * same error shapes `readRequestBody` settles with.
 */
export function bodyErrorResponse(err: unknown): Response {
  if (err instanceof DOMException && err.name === "AbortError") {
    return NextResponse.json({ ok: false, code: "CANCELLED", message: "Intake request was cancelled." }, { status: 400 });
  }
  if ((err as { code?: string } | null)?.code === "TIMEOUT") {
    return NextResponse.json({ ok: false, code: "TIMEOUT", message: "Request body intake exceeded its deadline." }, { status: 408 });
  }
  return NextResponse.json({ ok: false, code: "MALFORMED", message: "Could not read request body." }, { status: 400 });
}

