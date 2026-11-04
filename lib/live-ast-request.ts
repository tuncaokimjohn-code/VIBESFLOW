import { parseGitHubRepoInput } from "@/lib/github-url";
import { parseGitHubAstResponse, readGitHubAstResponse } from "@/lib/github-ast-client";
import type { GitHubAstSuccess, RequestedRepo } from "@/lib/github-ast-contract";

export type LiveAnalysisState = { status: "idle" | "loading" | "success" | "error"; message: string | null; requested?: RequestedRepo | null; code?: string };

const failures: Record<string, string> = {
  RATE_LIMITED: "GitHub rate limit reached. Retry later; repeated retries may remain limited.",
  NOT_FOUND: "Repository or ref not found. Check the public repository URL and ref.",
  PRIVATE_OR_FORBIDDEN: "Repository is private or access is forbidden. Only public repositories are supported.",
  REF_UNRESOLVED: "The requested ref could not be resolved.",
  TIMEOUT: "The provider timed out. Retry later.",
  LIMIT_EXCEEDED: "Source exceeds intake limits. Choose a smaller repository.",
  ANALYSIS_LIMIT: "Source exceeds the analysis budget.",
  EVIDENCE_INVALID: "Response evidence failed validation. No new snapshot was accepted.",
  PROVIDER_UNAVAILABLE: "GitHub source is unavailable. Retry later.",
};

/** Request state machine used directly by the UI and deterministic async tests. */
export function createLiveAnalysisController(options: {
  setLive: (live: GitHubAstSuccess | null) => void;
  onState: (state: LiveAnalysisState) => void;
  fetchFn?: typeof fetch;
  /** Public workspace keeps its last validated result; legacy preview stays unchanged. */
  retainOnFailure?: boolean;
}) {
  let sequence = 0;
  let active: AbortController | null = null;
  let disposed = false;
  const invalidate = () => { sequence++; active?.abort(); active = null; };
  let requested: RequestedRepo | null = null;
  let latestStatus: LiveAnalysisState["status"] = "idle";
  const state = (status: LiveAnalysisState["status"], message: string | null, code?: string) => {
    latestStatus = status;
    if (!disposed) options.onState({ status, message, requested, ...(code ? { code } : {}) });
  };
  const clear = () => {
    invalidate();
    requested = null;
    if (!disposed) { options.setLive(null); state("idle", null); }
  };
  return {
    clear,
    edit() {
      if (!options.retainOnFailure) { clear(); return; }
      invalidate();
      if (latestStatus === "loading") state("error", "Analysis cancelled because the URL was edited.", "CANCELLED");
      else if (latestStatus !== "error") state("idle", "URL edited. Inspect explicitly to analyze this input.");
    },
    activate() { disposed = false; },
    cancel() {
      invalidate();
      if (!disposed) { if (!options.retainOnFailure) options.setLive(null); state("error", "Real analysis cancelled.", "CANCELLED"); }
    },
    dispose() { disposed = true; invalidate(); },
    async submit(raw: string) {
      if (disposed) return;
      if (options.retainOnFailure) invalidate();
      else clear();
      const parsed = parseGitHubRepoInput(raw);
      requested = parsed.ok ? { owner: parsed.owner, repo: parsed.repo, ref: parsed.ref } : null;
      if (!parsed.ok) { state("error", "Invalid public GitHub URL. Use github.com/owner/repo with optional /tree/ref.", "MALFORMED"); return; }
      const controller = new AbortController(); active = controller;
      const token = sequence;
      const current = () => !disposed && token === sequence && !controller.signal.aborted;
      state("loading", `Analyzing ${parsed.owner}/${parsed.repo} from real GitHub source…`);
      try {
        const response = await (options.fetchFn ?? fetch)("/api/github-ast", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: raw }), signal: controller.signal,
        });
        if (!current()) return;
        if (response.status === 429) {
          void response.body?.cancel().catch(() => undefined);
          state("error", failures.RATE_LIMITED, "RATE_LIMITED");
          return;
        }
        const payload = await readGitHubAstResponse(response, controller.signal);
        if (!current()) return;
        const data = await parseGitHubAstResponse(payload, parsed);
        if (!current()) return;
        if (!response.ok || !data.ok) {
          const code = response.status === 429 ? "RATE_LIMITED" : !data.ok && Object.hasOwn(failures, data.code) ? data.code : "EVIDENCE_INVALID";
          state("error", failures[code], code);
          return;
        }
        options.setLive(data);
        state("success", `Real AST ${data.analysisStatus === "partial" ? "partial" : "ready"}: ${data.requested.owner}/${data.requested.repo} @ ${data.snapshot.resolvedCommitIfGitHub} · ${data.snapshot.coverage.collected} file(s), ${data.snapshot.coverage.skippedCount} skipped.`);
      } catch (error) {
        if (current()) state("error", error instanceof DOMException && error.name === "AbortError" ? "Real analysis cancelled." : "Real analysis request failed.");
      } finally {
        if (token === sequence) active = null;
      }
    },
  };
}
