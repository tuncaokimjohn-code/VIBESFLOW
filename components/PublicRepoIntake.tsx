"use client";
import { useEffect, useMemo, useState } from "react";
import { useLiveAst } from "@/components/LiveAstContext";
import { createLiveAnalysisController, type LiveAnalysisState } from "@/lib/live-ast-request";

/** Real intake is explicit user action only; never runs on mount or URL edits. */
export function PublicRepoIntake() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<LiveAnalysisState>({ status: "idle", message: null });
  const { live, setLive, setRealStatus, setAttempt } = useLiveAst();
  const controller = useMemo(() => createLiveAnalysisController({ setLive, retainOnFailure: true,
    onState: next => { setState(next); setRealStatus(next.status); setAttempt?.(next); },
  }), [setLive, setRealStatus, setAttempt]);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  return <div className="vf-intake min-w-0">
    <form aria-label="Inspect public GitHub repository" className="vf-intake-form flex min-w-0 flex-wrap items-center gap-2"
      onSubmit={event => { event.preventDefault(); void controller.submit(url); }}>
      <label htmlFor="public-repo-url" className="sr-only">Public GitHub repository URL</label>
      <input id="public-repo-url" value={url} autoComplete="off" spellCheck={false}
        placeholder="https://github.com/owner/repo" aria-describedby="public-intake-status"
        className="w-[220px] min-w-0 flex-1 rounded-lg border bg-transparent px-3 py-2 text-[13px]"
        style={{ borderColor: "var(--vf-border)" }}
        onChange={event => { controller.edit(); setUrl(event.target.value); }} />
      <button type="submit" disabled={state.status === "loading" || !url.trim()}
        className="rounded-lg bg-[#24BCD7] px-3 py-2 text-[13px] font-medium text-[#06222A] disabled:opacity-50">Inspect repository</button>
      {state.status === "loading" && <button type="button" className="text-[13px] underline" onClick={() => controller.cancel()}>Cancel analysis</button>}
      {(live || state.status !== "idle") && <button type="button" className="text-[13px] underline" onClick={() => { controller.clear(); setUrl(""); }}>Clear / new analysis</button>}
    </form>
    <p id="public-intake-status" role={state.status === "error" ? "alert" : "status"} aria-live="polite" className="vf-intake-status text-[11px]">
      {state.status === "idle" && "Public GitHub · read-only TS/TSX · sends a request only when you inspect."}
      {state.status === "loading" && "Resolving immutable commit, collecting source, and validating AST evidence…"}
      {state.status === "success" && "Source snapshot and AST evidence validated. Review coverage below."}
      {state.status === "error" && `${state.code ?? "REQUEST_FAILED"}: ${state.message} No new analysis succeeded. Retry with Inspect repository or edit the URL.`}
    </p>
  </div>;
}
