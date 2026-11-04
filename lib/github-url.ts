/**
 * E1 GitHub repository input parsing and validation v2 (P3 Candidate 002).
 *
 * Layered defense: raw-input checks run BEFORE URL normalization (so
 * normalization can never launder an unsafe form), then strict structural
 * checks run on the parsed URL. No network access happens here.
 *
 * Accepted canonical forms (scheme optional):
 *   github.com/owner/repo
 *   https://github.com/owner/repo
 *   github.com/owner/repo/tree/<ref>        (ref may contain slashes)
 *   (same with trailing slash)
 *
 * Rejected: non-https schemes, ANY explicit port (including :443),
 * credentials/userinfo, non-GitHub hosts (including deceptive suffixes
 * like github.com.evil), control characters/whitespace, backslashes,
 * duplicate separators, dot segments, percent-encoded controls, double
 * encodings, residual encodings, query strings, fragments, deeper
 * non-tree paths, and malformed owner/repo/ref names.
 *
 * Supported ref syntax (after /tree/): one or more '/'-separated segments
 * (slashed branch names like feature/login are branches, NOT paths — the
 * intake records the ref string verbatim and resolution is the provider's
 * job; GitHub-side branch-vs-path ambiguity is never guessed here).
 * Each segment: 1-128 chars, no empty/dot/dotdot segments, no encoded
 * separators or NUL. Total ref length <= 256.
 */
import { z } from "zod";

export type GitHubUrlErrorCode =
  | "EMPTY"
  | "UNSAFE_INPUT"
  | "UNSUPPORTED_HOST"
  | "CREDENTIALS"
  | "INVALID_OWNER"
  | "INVALID_REPO"
  | "UNSUPPORTED_PATH"
  | "QUERY_OR_FRAGMENT";

export type GitHubRepoRef =
  | { ok: true; owner: string; repo: string; ref: string | null }
  | { ok: false; code: GitHubUrlErrorCode; message: string };

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const MAX_NAME_LEN = 100;

/** Zod schema for the validated output (runtime-checked, not just typed). */
export const GitHubRepoRefSchema = z.object({
  owner: z.string().min(1).max(MAX_NAME_LEN).regex(NAME_RE),
  repo: z.string().min(1).max(MAX_NAME_LEN).regex(NAME_RE),
  ref: z.string().min(1).max(256).nullable(),
});

/**
 * Raw pre-normalization scan. Runs on the trimmed input BEFORE `new URL`,
 * so encoding tricks, separators, and dot games are rejected in the form
 * the user actually typed.
 */
function rejectRawInput(input: string): string | null {
  // Control characters, whitespace (incl. unicode spaces), backslashes.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f\\]/.test(input)) return "control characters, whitespace, or backslashes";
  // Duplicate separators and dot segments in the raw path.
  const pathStart = input.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").indexOf("/");
  const rawPath = pathStart >= 0 ? input.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").slice(pathStart) : "";
  if (rawPath.includes("//")) return "duplicate path separators";
  for (const seg of rawPath.split("/")) {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return "malformed percent-encoding";
    }
    if (decoded === "." || decoded === "..") return "dot segments";
  }
  return null;
}

export function parseGitHubRepoInput(raw: string): GitHubRepoRef {
  const input = raw.trim();
  if (input.length === 0) {
    return { ok: false, code: "EMPTY", message: "Enter a public github.com/owner/repo URL." };
  }
  if (input.length > 512) {
    return { ok: false, code: "UNSUPPORTED_PATH", message: "Input is too long to be a repository locator." };
  }
  const rawProblem = rejectRawInput(input);
  if (rawProblem !== null) {
    return { ok: false, code: "UNSAFE_INPUT", message: `Unsafe repository locator (${rawProblem}).` };
  }
  // Embedded credentials and explicit ports before URL parsing normalizes
  // anything away (URL drops the default :443 port, so raw-stage rejection
  // is the only layer that catches it — the accepted contract prohibits ALL
  // explicit ports).
  const withoutScheme = input.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const authority = withoutScheme.split(/[/?#]/, 1)[0];
  if (authority.includes("@")) {
    return { ok: false, code: "CREDENTIALS", message: "Credentials in the URL are not accepted." };
  }
  if (authority.includes(":")) {
    return { ok: false, code: "UNSUPPORTED_HOST", message: "Explicit ports are not accepted." };
  }
  // Percent-encoded C0 controls/DEL and any double encoding (%25...) are
  // rejected in the raw form, before normalization can launder them.
  if (/%(00|01|02|03|04|05|06|07|08|09|0a|0b|0c|0d|0e|0f|10|11|12|13|14|15|16|17|18|19|1a|1b|1c|1d|1e|1f|7f|25)/i.test(input)) {
    return { ok: false, code: "UNSAFE_INPUT", message: "Unsafe repository locator (encoded controls or double encoding)." };
  }
  // Explicit query/fragment delimiters — including EMPTY trailing `?`/`#`.
  // WHATWG serialization normalizes a trailing delimiter to an empty
  // search/hash, so post-normalization checks cannot see it; detect from
  // the raw input before `new URL` launders it away. Any literal `?`/`#`
  // is a delimiter attempt (encoded forms are separate inputs governed by
  // the percent rules above). This is raw URL validation, distinct from
  // the canonical-ref predicate (which never sees delimiters at all).
  if (input.includes("?") || input.includes("#")) {
    return { ok: false, code: "QUERY_OR_FRAGMENT", message: "Query strings and fragments are not part of a repository locator." };
  }

  let url: URL;
  try {
    url = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) ? input : `https://${input}`);
  } catch {
    return { ok: false, code: "UNSUPPORTED_HOST", message: "Only canonical public github.com URLs are accepted." };
  }

  if (url.protocol !== "https:") {
    return { ok: false, code: "UNSUPPORTED_HOST", message: "Only https github.com URLs are accepted." };
  }
  // Exact hostname match + no explicit port: `github.com.evil.example`,
  // `evilgithub.com`, and `github.com:443` all fail here. URL lowercases
  // the host, so mixed-case input canonicalizes safely.
  if (url.hostname.toLowerCase() !== "github.com" || url.port !== "") {
    return { ok: false, code: "UNSUPPORTED_HOST", message: "Only github.com repositories are accepted." };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, code: "CREDENTIALS", message: "Credentials in the URL are not accepted." };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, code: "QUERY_OR_FRAGMENT", message: "Query strings and fragments are not part of a repository locator." };
  }

  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    return { ok: false, code: "UNSUPPORTED_PATH", message: "Expected github.com/owner/repo." };
  }
  const [ownerRaw, repoRaw, ...rest] = segments;
  let ref: string | null = null;
  if (rest.length > 0) {
    // Only /tree/<ref...> is a supported ref-bearing path. Anything else
    // (issues, pulls, blob, actions) addresses a different resource.
    if (rest[0] !== "tree" || rest.length < 2) {
      return { ok: false, code: "UNSUPPORTED_PATH", message: "Only /owner/repo or /owner/repo/tree/<ref> paths are accepted." };
    }
    ref = rest.slice(1).join("/");
  }

  // Owner/repo need no percent-encoding (charset is encoding-free); any
  // residual % is therefore noncanonical and rejected.
  if (ownerRaw.includes("%") || repoRaw.includes("%")) {
    return { ok: false, code: "UNSAFE_INPUT", message: "Unsafe repository locator (encoded owner/repo names)." };
  }
  if (!isValidName(ownerRaw)) {
    return { ok: false, code: "INVALID_OWNER", message: `Invalid repository owner: ${JSON.stringify(ownerRaw)}.` };
  }
  const repoName = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw;
  if (!isValidName(repoName)) {
    return { ok: false, code: "INVALID_REPO", message: `Invalid repository name: ${JSON.stringify(repoRaw)}.` };
  }
  if (ref !== null) {
    // Single shared rule (Finding A, 008): the parser enforces EXACTLY
    // isCanonicalRef — identical by construction, never a parallel copy.
    // The accepted ref string IS canonical: literal characters only, case
    // preserved (Git refs are case-sensitive), slashes denote branch
    // hierarchy (recorded verbatim; branch-vs-path ambiguity is never
    // guessed here). ANY percent-encoding is rejected: %61-style aliases,
    // encoded spaces, and %2F/%252F forms could resolve differently
    // downstream, so encoded input is never canonicalized — it is refused
    // and the caller must supply the literal ref.
    if (!isCanonicalRef(ref)) {
      return { ok: false, code: "UNSUPPORTED_PATH", message: "Invalid branch/tag reference." };
    }
  }
  const checked = GitHubRepoRefSchema.safeParse({ owner: ownerRaw, repo: repoName, ref });
  if (!checked.success) {
    return { ok: false, code: "UNSAFE_INPUT", message: "Repository locator failed output validation." };
  }
  return { ok: true, owner: ownerRaw, repo: repoName, ref };
}

export function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LEN && NAME_RE.test(name);
}

/**
 * Canonical ref predicate (Findings D/007, A/008): accepts EXACTLY the
 * strings the URL parser can produce. Parser output refs come from
 * `new URL(...).pathname`, so every character must survive WHATWG URL
 * path serialization literally: alphanumerics plus `-._~!$&'()*+,;=:@|[]`
 * (empirically verified). Anything the serializer percent-encodes —
 * non-ASCII/Unicode, angle brackets, quotes, braces, caret, backtick, controls, `%` itself — can never
 * appear in parser output and is rejected here. `?`/`#` start the
 * query/fragment (the parser rejects them outright with
 * QUERY_OR_FRAGMENT), so they are rejected too. Case is preserved (Git
 * refs are case-sensitive); `/` separates hierarchy; segments are
 * 1-128 chars, never empty/`.`/`..`; total length 1..256. The API
 * receipt validator uses this same predicate so parser, builder, API,
 * and client agree. Intentional differences from raw-input parsing:
 * the raw scan additionally rejects whitespace/backslash/dot-games and
 * the parser trims one trailing slash — outputs of THOSE stages always
 * satisfy this predicate.
 */
const REF_SEGMENT_RE = /^[A-Za-z0-9\-._~!$&'()*+,;=:@|[\]]+$/;
export function isCanonicalRef(ref: string | null): boolean {
  if (ref === null) return true;
  if (ref.length === 0 || ref.length > 256) return false;
  for (const seg of ref.split("/")) {
    if (seg.length === 0 || seg.length > 128) return false;
    if (seg === "." || seg === "..") return false;
    if (!REF_SEGMENT_RE.test(seg)) return false;
  }
  return true;
}
