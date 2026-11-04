/** C024 safety tombstone. There is deliberately no executable CLI path.
 * Environment flags, caller consent and request headers cannot enable it.
 * Reintroduction needs a separately reviewed authorization, credential and
 * process-lifetime boundary; CLI isolation has not been verified offline.
 */
import type { MuseProvider } from "./muse-contract";

export const MUSE_CLI_CONFIG = Object.freeze({
  model: "muse-spark-1.3",
  reasoningEffort: "medium",
  enabled: false,
} as const);

export function createMuseCliAdapter(): MuseProvider {
  return {
    label: "Muse Spark 1.3 medium (disabled)",
    async explain() {
      throw new Error("Live Muse inference is disabled in C024.");
    },
  };
}
