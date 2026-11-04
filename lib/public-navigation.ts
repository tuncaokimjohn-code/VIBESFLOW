import { applyInspectorHash } from "@/lib/inspector-hash";

export const PUBLIC_VIEWS = ["overview", "architecture", "findings", "compare", "evaluation"] as const;
export type PublicView = typeof PUBLIC_VIEWS[number];
export function publicViewForHash(hash: string): PublicView {
  const views: Record<string, PublicView> = { "#public-architecture": "architecture", "#public-findings": "findings", "#public-readiness": "compare", "#public-evaluation": "evaluation" };
  return Object.hasOwn(views, hash) ? views[hash] : "overview";
}
export function publicHref(view: PublicView): string {
  return ({ overview: "/", architecture: "/#public-architecture", findings: "/#public-findings", compare: "/#public-readiness", evaluation: "/#public-evaluation" })[view];
}
/** Native link activation and explicit commits share committed hash state. */
export function commitPublicNavigation(view: PublicView, win: Pick<Window, "history" | "location">): void {
  const hash = publicHref(view).slice(1);
  if (win.location.hash !== hash) win.history.pushState(null, "", `${win.location.pathname}${win.location.search}${hash}`);
  applyInspectorHash(win.location.hash);
}
export function publicNavigationKey(index: number, key: string): number | null {
  if (key === "ArrowDown" || key === "ArrowRight") return (index + 1) % PUBLIC_VIEWS.length;
  if (key === "ArrowUp" || key === "ArrowLeft") return (index + PUBLIC_VIEWS.length - 1) % PUBLIC_VIEWS.length;
  if (key === "Home") return 0;
  if (key === "End") return PUBLIC_VIEWS.length - 1;
  return null;
}
