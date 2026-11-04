"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { parseGitHubRepoInput } from "@/lib/github-url";
import { parseIntakeResponse, receiptMatchesRequest, type SourceSnapshot } from "@/lib/intake-client";
import { useLiveAst } from "@/components/LiveAstContext";
import { createLiveAnalysisController, type LiveAnalysisState } from "@/lib/live-ast-request";

type IntakeState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "loading"; owner: string; repo: string }
  | { status: "success"; snapshot: SourceSnapshot; owner: string; repo: string }
  | { status: "error"; message: string };

/**
 * Public GitHub repository intake control (P3 E2 intake UI).
 *
 * Same header slot and visual language as P2/P3. States: idle →
 * validating (client-side URL check) → loading (cancellable) → success
 * (synthetic intake receipt; no findings invented) or error/unsupported.
 *
 * The API payload is validated at runtime with Zod
 * (`parseIntakeResponse`) — never trusted via assertion. The control is
 * usable at narrow/mobile widths (compact wrapping layout), not hidden.
 * E2–E8 analysis is not part of this phase.
 */
export function RepoIntake() {
  const [value, setValue] = useState("github.com/example/sample-api");
  const [state, setState] = useState<IntakeState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const { setLive, setRealStatus } = useLiveAst();
  const [liveState, setLiveState] = useState<LiveAnalysisState>({ status: "idle", message: null });
  const liveController = useMemo(() => createLiveAnalysisController({
    setLive, onState: next => { setLiveState(next); setRealStatus(next.status); },
  }), [setLive, setRealStatus]);
  useEffect(() => {
    liveController.activate();
    return () => liveController.dispose();
  }, [liveController]);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (busy) return;
    liveController.clear();
    setState({ status: "validating" });
    const parsed = parseGitHubRepoInput(value);
    if (!parsed.ok) {
      setState({ status: "error", message: parsed.message });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "loading", owner: parsed.owner, repo: parsed.repo });
    try {
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: value }),
        signal: controller.signal,
      });
      const data = await parseIntakeResponse(await res.json());
      controller.signal.throwIfAborted();
      if (data.ok !== true) {
        setState({ status: "error", message: data.message });
        return;
      }
      // Receipt/locator binding (Finding D): never display a success whose
      // receipt names a different owner, repo, or ref than submitted — a
      // mismatched or forged receipt is an error, not a success.
      if (!receiptMatchesRequest(data.requested, parsed.owner, parsed.repo, parsed.ref)) {
        setState({ status: "error", message: "Intake receipt did not match the submitted repository." });
        return;
      }
      setState({
        status: "success",
        snapshot: data.snapshot,
        owner: data.requested.owner,
        repo: data.requested.repo,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setState({ status: "error", message: "Intake cancelled." });
      } else {
        setState({ status: "error", message: "Intake request failed." });
      }
    } finally {
      abortRef.current = null;
    }
  }

  function submitReal() { void liveController.submit(value); }

  const busy = state.status === "validating" || state.status === "loading";

  function cancel() {
    abortRef.current?.abort();
  }

  return (
    <div className="vf-intake min-w-0">
      <form onSubmit={submit} className="vf-intake-form flex min-w-0 flex-wrap items-center gap-2" aria-label="Public GitHub repository intake">
        <label htmlFor="repo-input" className="sr-only">Public GitHub repository URL</label>
        <input
          id="repo-input"
          value={value}
          onChange={(e) => { liveController.clear(); setValue(e.target.value); }}
          disabled={busy}
          placeholder="github.com/owner/repo"
          spellCheck={false}
          autoComplete="off"
          aria-describedby="repo-intake-status"
          className="w-[160px] min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-1.5 text-[13px] outline-none disabled:opacity-60 sm:w-[220px] sm:flex-none"
          style={{ borderColor: "var(--vf-border)", background: "var(--vf-panel-bg)", color: "var(--vf-text)" }}
        />
        {state.status === "loading" ? (
          <button
            type="button"
            onClick={cancel}
            className="rounded-lg px-3 py-1.5 text-[13px] font-medium"
            style={{ background: "var(--vf-panel-active)", color: "var(--vf-text)" }}
          >
            Cancel
          </button>
        ) : (
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-[#06222A] disabled:opacity-60"
            style={{ background: "var(--vf-primary-cyan)" }}
          >
            {state.status === "validating" ? "Checking…" : "Inspect"}
          </button>
        )}
        <button
          type="button"
          onClick={submitReal}
          disabled={busy}
          className="rounded-lg border px-3 py-1.5 text-[13px] font-medium"
          style={{ borderColor: "var(--vf-border)", color: "var(--vf-text)" }}
        >
          Analyze repository
        </button>
        {liveState.status === "loading" && (
          <button type="button" onClick={() => liveController.cancel()} className="text-[12px] underline">
            Cancel analysis
          </button>
        )}
      </form>
      <div id="repo-intake-status" role="status" aria-live="polite" className="vf-intake-status text-[11px]" style={{ color: "var(--vf-muted-text)" }}>
        {liveState.message !== null && <p>{liveState.message}</p>}
        {state.status === "idle" && "Synthetic E1 intake: validates any public github.com URL; builds a labeled synthetic receipt. Real fetching needs separate authorization."}
        {state.status === "validating" && "Validating repository URL…"}
        {state.status === "loading" && `Requesting intake for ${state.owner}/${state.repo}… (synthetic provider, cancellable)`}
        {state.status === "error" && <span role="alert">Intake unavailable: {state.message}</span>}
        {state.status === "success" && (
          <span>
            Synthetic receipt: {state.owner}/{state.repo} · {state.snapshot.coverage.collected} file(s), {state.snapshot.coverage.totalBytes} bytes,{" "}
            {state.snapshot.coverage.skippedCount} skipped · manifest {state.snapshot.manifestHash.slice(0, 12)}… · no findings produced (E2–E8 not authorized).
          </span>
        )}
      </div>
    </div>
  );
}
