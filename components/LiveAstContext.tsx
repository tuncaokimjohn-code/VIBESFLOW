"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { GitHubAstSuccess } from "@/lib/github-ast-contract";
import type { LiveAnalysisState } from "@/lib/live-ast-request";

/** Result of the server GitHub-to-AST path, shared header -> graph. */
export type LiveAstResult = GitHubAstSuccess;

const LiveAstContext = createContext<{
  live: LiveAstResult | null;
  setLive: (r: LiveAstResult | null) => void;
  realStatus: LiveAnalysisState["status"];
  setRealStatus: (status: LiveAnalysisState["status"]) => void;
  attempt?: LiveAnalysisState;
  setAttempt?: (attempt: LiveAnalysisState) => void;
}>({ live: null, setLive: () => undefined, realStatus: "idle", setRealStatus: () => undefined });

export function LiveAstProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<LiveAstResult | null>(null);
  const [realStatus, setRealStatus] = useState<LiveAnalysisState["status"]>("idle");
  const [attempt, setAttempt] = useState<LiveAnalysisState>({ status: "idle", message: null });
  return <LiveAstContext.Provider value={{ live, setLive, realStatus, setRealStatus, attempt, setAttempt }}>{children}</LiveAstContext.Provider>;
}

export function useLiveAst() {
  return useContext(LiveAstContext);
}
