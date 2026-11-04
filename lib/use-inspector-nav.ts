"use client";
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import {
  applyInspectorHash,
  getInspectorHashServerSnapshot,
  getInspectorHashSnapshot,
  refreshInspectorHashFromUrl,
  subscribeInspectorHashStore,
  subscribeInspectorSync,
} from "@/lib/inspector-hash";

/**
 * Shared committed-navigation observation for the analysis inspector.
 *
 * Returns the canonical hash from the shared navigation-state store.
 * The store converges from (a) an authoritative re-read of the committed
 * URL on mount and whenever Next.js commits a navigation that re-renders
 * us (query changes via `useSearchParams`), and (b) the shared DOM
 * subscription (click intent + `hashchange`/`popstate`). The store starts
 * at the SSR value (""), so direct `#findings` loads stay
 * hydration-safe and converge on mount.
 *
 * Only mounted on analysis routes (dynamic, never statically prerendered),
 * so `useSearchParams` needs no Suspense boundary here. The Shell consumes
 * the same store without `useSearchParams` (static-safe) and converges via
 * the subscription plus store refreshes published from this hook.
 */
export function useInspectorHash(): string {
  const search = useSearchParams().toString();
  const hash = useSyncExternalStore(
    subscribeInspectorHashStore,
    getInspectorHashSnapshot,
    getInspectorHashServerSnapshot
  );
  useEffect(() => {
    refreshInspectorHashFromUrl(() => window.location.hash || "");
    return subscribeInspectorSync(window, document, (h) => {
      applyInspectorHash(h);
    });
  }, [search]);
  return hash;
}
