/** Server-only public GitHub authentication. Never import into client modules.
 * node:process deliberately makes this module unusable in browser bundles.
 * Credentials are read lazily during a request; authenticated reads require
 * an anonymous visibility check. No credential files, CLI integration, persistence or logging.
 */
import { env } from "node:process";
import {
  assertAllowlistedApiUrl, buildRepoUrl, GitHubRestProvider,
  type GitHubRestProviderOptions,
} from "@/lib/github-provider";

export interface PublicGitHubOptions extends GitHubRestProviderOptions {
  /** Test seam; production uses only the optional runtime environment variable. */
  readPublicToken?: () => string | undefined;
}

const runtimePublicToken = (): string | undefined => env.VIBEFLOW_GITHUB_PUBLIC_TOKEN;
const safeCodes = new Set([
  "MALFORMED", "NOT_FOUND", "PRIVATE_OR_FORBIDDEN", "RATE_LIMITED",
  "REF_UNRESOLVED", "TIMEOUT", "LIMIT_EXCEEDED", "PROVIDER_UNAVAILABLE",
]);
function failure(code: string): Error & { code: string } {
  return Object.assign(new Error("Public GitHub request could not be completed."), { code });
}

export class PublicGitHubRestProvider extends GitHubRestProvider {
  // Store only a reader, never a token. No cross-request visibility cache.
  #readPublicToken: () => string | undefined;
  constructor(options: PublicGitHubOptions = {}) {
    super(options);
    this.#readPublicToken = options.readPublicToken ?? runtimePublicToken;
  }

  protected override async getJson(url: string, caller: AbortSignal, context: string): Promise<unknown> {
    try {
      assertAllowlistedApiUrl(url);
      const parsed = new URL(url);
      // Restrict auth to the exact existing REST endpoint shapes, in addition
      // to the immutable host/scheme/port/credential checks in the base class.
      const endpoint = /^\/repos\/([^/]+)\/([^/]+)(\/(?:commits\/[^/]+|git\/trees\/[0-9a-f]{40}|contents\/.+|git\/blobs\/[0-9a-f]{40}))?$/.exec(parsed.pathname);
      if (!endpoint) throw failure("MALFORMED");
      const repoUrl = buildRepoUrl(decodeURIComponent(endpoint[1]), decodeURIComponent(endpoint[2]));
      const verifyPublic = async (): Promise<Record<string, unknown>> => {
        // Always anonymous: even a token with private access cannot make a
        // private repository eligible. Recheck before EVERY authenticated read.
        const info = await super.getJson(repoUrl, caller, "Repository visibility");
        if (!info || typeof info !== "object" || Array.isArray(info)
          || (info as Record<string, unknown>).private !== false
          || (info as Record<string, unknown>).visibility !== "public") {
          throw failure("PRIVATE_OR_FORBIDDEN");
        }
        return info as Record<string, unknown>;
      };
      if (!endpoint[3]) return await verifyPublic(); // metadata always anonymous
      caller.throwIfAborted();
      let token: string | undefined;
      try { token = this.#readPublicToken(); } catch { /* Optional config unavailable: anonymous. */ }
      // Invalid/missing configuration preserves the anonymous path. Strict
      // ASCII token syntax prevents header injection; no normalization/logging.
      if (typeof token !== "string" || !/^[A-Za-z0-9_\-.]{1,255}$/.test(token)) token = undefined;
      // Anonymous REST cannot access private source. Avoid spending anonymous
      // quota on a redundant visibility probe when no valid token is available.
      if (!token) return await super.getJson(url, caller, context);
      await verifyPublic();
      caller.throwIfAborted();
      try {
        return await super.getJson(url, caller, "Public repository source", `Bearer ${token}`);
      } catch (error) {
        // A rejected optional credential gets one anonymous retry only, after
        // a fresh public check. No fallback for rate limits, redirects or 403.
        if ((error as { code?: unknown } | null)?.code !== "AUTH_REJECTED") throw error;
        await verifyPublic();
        return await super.getJson(url, caller, "Public repository source");
      }
    } catch (error) {
      // Never propagate provider messages, body, URLs, causes or abort reasons.
      if (caller.aborted) throw new DOMException("Public GitHub request cancelled.", "AbortError");
      const code = (error as { code?: unknown } | null)?.code;
      throw failure(typeof code === "string" && safeCodes.has(code) ? code : "PROVIDER_UNAVAILABLE");
    }
  }
}
