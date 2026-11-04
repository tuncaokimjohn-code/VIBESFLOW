/** UNIT: E1 GitHub URL parser/validator v2 (Finding E). No network access. */
import { describe, expect, it } from "vitest";
import { GitHubRepoRefSchema, isCanonicalRef, parseGitHubRepoInput } from "@/lib/github-url";

describe("parseGitHubRepoInput — valid inputs", () => {
  it("accepts bare owner/repo", () => {
    expect(parseGitHubRepoInput("github.com/acme/api")).toEqual({ ok: true, owner: "acme", repo: "api", ref: null });
  });
  it("accepts https scheme and trailing slash", () => {
    expect(parseGitHubRepoInput("https://github.com/acme/api/")).toEqual({ ok: true, owner: "acme", repo: "api", ref: null });
  });
  it("accepts /tree/<ref> suffix", () => {
    expect(parseGitHubRepoInput("https://github.com/acme/api/tree/v1.2.3")).toEqual({ ok: true, owner: "acme", repo: "api", ref: "v1.2.3" });
  });
  it("accepts refs containing slashes (feature branches)", () => {
    expect(parseGitHubRepoInput("github.com/acme/api/tree/feature/login-flow")).toEqual({
      ok: true, owner: "acme", repo: "api", ref: "feature/login-flow",
    });
  });
  it("accepts uppercase host by canonicalizing", () => {
    expect(parseGitHubRepoInput("https://GitHub.COM/acme/api")).toEqual({ ok: true, owner: "acme", repo: "api", ref: null });
  });
  it("strips a .git suffix", () => {
    expect(parseGitHubRepoInput("github.com/acme/api.git")).toEqual({ ok: true, owner: "acme", repo: "api", ref: null });
  });
  it("trims surrounding whitespace", () => {
    expect(parseGitHubRepoInput("  github.com/acme/api  ").ok).toBe(true);
  });
  it("output passes the runtime output schema", () => {
    const r = parseGitHubRepoInput("github.com/acme/api/tree/main");
    expect(r.ok).toBe(true);
    if (r.ok) expect(GitHubRepoRefSchema.safeParse({ owner: r.owner, repo: r.repo, ref: r.ref }).success).toBe(true);
  });
});

describe("parseGitHubRepoInput — rejections", () => {
  it("rejects empty input", () => {
    expect(parseGitHubRepoInput("   ")).toMatchObject({ ok: false, code: "EMPTY" });
  });
  it("rejects non-GitHub hosts", () => {
    expect(parseGitHubRepoInput("https://gitlab.com/acme/api")).toMatchObject({ ok: false, code: "UNSUPPORTED_HOST" });
  });
  it("rejects deceptive suffix hostnames", () => {
    expect(parseGitHubRepoInput("https://github.com.evil.example/acme/api")).toMatchObject({ ok: false, code: "UNSUPPORTED_HOST" });
  });
  it("rejects lookalike hostnames", () => {
    expect(parseGitHubRepoInput("https://evilgithub.com/acme/api")).toMatchObject({ ok: false, code: "UNSUPPORTED_HOST" });
  });
  it("rejects ALL explicit ports including :443 (Finding E)", () => {
    // The contract prohibits every explicit port; raw-stage rejection is the
    // only layer that catches :443 because URL parsing normalizes it away.
    expect(parseGitHubRepoInput("https://github.com:8443/acme/api")).toMatchObject({ ok: false, code: "UNSUPPORTED_HOST" });
    expect(parseGitHubRepoInput("https://github.com:443/acme/api")).toMatchObject({ ok: false, code: "UNSUPPORTED_HOST" });
    expect(parseGitHubRepoInput("github.com:443/acme/api").ok).toBe(false);
  });
  it("rejects percent-encoded ref aliases instead of canonicalizing (Finding E)", () => {
    // %61 = 'a', %20 = space: accepting and decoding these could resolve
    // differently downstream, so the canonical form is literal-only.
    expect(parseGitHubRepoInput("github.com/acme/api/tree/fe%61ture").ok).toBe(false);
    expect(parseGitHubRepoInput("github.com/acme/api/tree/my%20branch").ok).toBe(false);
    expect(parseGitHubRepoInput("github.com/acme/api/tree/v1%2E0").ok).toBe(false);
    // Literal equivalents are accepted: the canonical representation.
    expect(parseGitHubRepoInput("github.com/acme/api/tree/feature")).toMatchObject({ ok: true, ref: "feature" });
    expect(parseGitHubRepoInput("github.com/acme/api/tree/feature/login")).toMatchObject({ ok: true, ref: "feature/login" });
  });
  it("rejects encoded controls and double encodings (Finding E)", () => {
    expect(parseGitHubRepoInput("github.com/acme/api%0Aevil").ok).toBe(false);
    expect(parseGitHubRepoInput("github.com/ac%2500me/api").ok).toBe(false);
    expect(parseGitHubRepoInput("github.com/acme/a%252Fpi").ok).toBe(false);
    expect(parseGitHubRepoInput("github.com/acme/api/tree/a%252Fb").ok).toBe(false);
    expect(parseGitHubRepoInput("github.com/acme/api/tree/%2e%2e/x").ok).toBe(false);
  });
  it("rejects embedded credentials", () => {
    expect(parseGitHubRepoInput("https://user:pass@github.com/acme/api")).toMatchObject({ ok: false, code: "CREDENTIALS" });
  });
  it("rejects user@host without scheme", () => {
    expect(parseGitHubRepoInput("user@github.com/acme/api")).toMatchObject({ ok: false, code: "CREDENTIALS" });
  });
  it("rejects non-https schemes", () => {
    expect(parseGitHubRepoInput("http://github.com/acme/api")).toMatchObject({ ok: false, code: "UNSUPPORTED_HOST" });
  });
  it("rejects query strings and fragments", () => {
    expect(parseGitHubRepoInput("github.com/acme/api?x=1")).toMatchObject({ ok: false, code: "QUERY_OR_FRAGMENT" });
    expect(parseGitHubRepoInput("github.com/acme/api#readme")).toMatchObject({ ok: false, code: "QUERY_OR_FRAGMENT" });
  });
  it("rejects explicit EMPTY trailing delimiters (Finding A, 009)", () => {
    // WHATWG serialization normalizes a trailing `?`/`#` to an empty
    // search/hash, so post-normalization checks go blind: the raw input
    // must reject them. All four must fail with the same code as
    // nonempty query/fragment values.
    for (const u of [
      "github.com/acme/api?",
      "github.com/acme/api#",
      "github.com/acme/api/tree/main?",
      "github.com/acme/api/tree/main#",
    ]) {
      expect(parseGitHubRepoInput(u)).toMatchObject({ ok: false, code: "QUERY_OR_FRAGMENT" });
    }
    // Delimiter-free forms still pass, refs intact.
    expect(parseGitHubRepoInput("github.com/acme/api")).toMatchObject({ ok: true, ref: null });
    expect(parseGitHubRepoInput("github.com/acme/api/tree/main")).toMatchObject({ ok: true, ref: "main" });
    expect(parseGitHubRepoInput("https://github.com/acme/api/tree/feature/x")).toMatchObject({ ok: true, ref: "feature/x" });
  });
  it("rejects non-tree deep paths (issues, blob, pulls)", () => {
    expect(parseGitHubRepoInput("github.com/acme/api/issues/1")).toMatchObject({ ok: false, code: "UNSUPPORTED_PATH" });
    expect(parseGitHubRepoInput("github.com/acme/api/blob/main/a.ts")).toMatchObject({ ok: false, code: "UNSUPPORTED_PATH" });
  });
  it("rejects duplicate separators", () => {
    expect(parseGitHubRepoInput("github.com//acme/api").ok).toBe(false);
    expect(parseGitHubRepoInput("github.com/acme//api").ok).toBe(false);
  });
  it("rejects dot segments", () => {
    expect(parseGitHubRepoInput("github.com/acme/./api").ok).toBe(false);
    expect(parseGitHubRepoInput("github.com/acme/../api").ok).toBe(false);
  });
  it("rejects encoded separators in owner/repo", () => {
    expect(parseGitHubRepoInput("github.com/ac%2Fme/api").ok).toBe(false);
    expect(parseGitHubRepoInput("github.com/acme/a%2epi").ok).toBe(false);
  });
  it("rejects encoded separators and NUL in refs", () => {
    expect(parseGitHubRepoInput("github.com/acme/api/tree/a%2Fb").ok).toBe(false);
    expect(parseGitHubRepoInput("github.com/acme/api/tree/a%00b").ok).toBe(false);
  });
  it("rejects owner-only input and bare /tree/", () => {
    expect(parseGitHubRepoInput("github.com/acme")).toMatchObject({ ok: false, code: "UNSUPPORTED_PATH" });
    expect(parseGitHubRepoInput("github.com/acme/api/tree").ok).toBe(false);
  });
  it("rejects invalid owner/repo characters", () => {
    expect(parseGitHubRepoInput("github.com/ac!me/api")).toMatchObject({ ok: false, code: "INVALID_OWNER" });
    expect(parseGitHubRepoInput("github.com/acme/a*pi")).toMatchObject({ ok: false, code: "INVALID_REPO" });
  });
  it("rejects interior whitespace at the raw-input layer", () => {
    expect(parseGitHubRepoInput("github.com/ac me/api")).toMatchObject({ ok: false, code: "UNSAFE_INPUT" });
  });
  it("rejects traversal refs", () => {
    expect(parseGitHubRepoInput("github.com/acme/api/tree/../main").ok).toBe(false);
    expect(parseGitHubRepoInput("github.com/acme/api/tree/a//b").ok).toBe(false);
  });
  it("rejects interior whitespace/control characters", () => {
    expect(parseGitHubRepoInput("github.com/acme/a\tpi").ok).toBe(false);
  });
});

describe("isCanonicalRef — same predicate as the parser (Finding D)", () => {
  // Parser-accept implies predicate-accept and vice versa, sampled across
  // literal, hierarchical, dot-segment, encoded, overlong, and control refs.
  const cases: Array<[string, boolean]> = [
    ["main", true],
    ["v1.2.3", true],
    ["feature/login-flow", true],
    ["a/b/c", true],
    ["UPPER/lower_1-2.3", true],
    ["../main", false],
    ["a/../c", false],
    [".", false],
    ["..", false],
    ["a//b", false],
    ["/main", false],
    ["main/", false],
    ["fe%61ture", false],
    ["x%2Fb", false],
    ["x%0Ay", false],
    ["a?b", false],
    ["a#b", false],
    ["?", false],
    ["#", false],
    ["\u00e9", false],
    ["\u65e5\u672c\u8a9e", false],
    ["emoji-\u{1F600}", false],
    ["a<b", false],
    ["a>b", false],
    ['a"b', false],
    ["a{b", false],
    ["a}b", false],
    ["a^b", false],
    ["a`b", false],
    ["a|b", true],
    ["a[b", true],
    ["a]b", true],
    ["a~b", true],
    ["a'b", true],
    ["a:b", true],
    ["a@b", true],
    ["a+b", true],
    ["a=b", true],
    ["a,b", true],
    ["a;b", true],
    ["Main", true],
    ["FEATURE/X", true],
    ["has space", false], // spaces survive neither layer
    [`${"r".repeat(128)}`, true],
    [`${"r".repeat(129)}`, false], // parser caps segments at 128
    [`${"r".repeat(256)}`, false],
    [`${"r".repeat(257)}`, false],
    [`a/${"s".repeat(129)}`, false],
    ["back\\slash", false],
  ];
  it("agrees with the parser on every sampled ref", () => {
    for (const [ref, expected] of cases) {
      expect(isCanonicalRef(ref)).toBe(expected);
      const parsed = parseGitHubRepoInput(`github.com/acme/api/tree/${ref}`);
      // Documented divergences only: the raw-input scan rejects spaces
      // outright, and the parser normalizes ONE trailing slash away
      // (canonical ref form never carries it). Anything else must agree.
      if (ref.includes(" ")) {
        expect(parsed.ok).toBe(false);
        continue;
      }
      if (ref === "main/") {
        expect(parsed).toMatchObject({ ok: true, ref: "main" });
        continue;
      }
      // `?`/`#` can never survive URL parsing as ref content: the parser
      // either rejects or truncates at the delimiter — it never PRODUCES
      // these characters inside a ref, so the predicate rejects them.
      if (ref.includes("?") || ref.includes("#")) {
        expect(parsed.ok).toBe(false);
        continue;
      }
      expect(parsed.ok).toBe(expected);
      if (expected) expect(parsed).toMatchObject({ ok: true, ref });
    }
  });
  it("accepts null (default-resolution intent)", () => {
    expect(isCanonicalRef(null)).toBe(true);
  });
  it("round-trips accepted refs verbatim (normalization correctness, not just booleans)", () => {
    // Every accepted canonical ref must parse back to ITSELF — proving the
    // parser produces exactly what the predicate accepts, with case and
    // hierarchy preserved and nothing silently rewritten.
    const accepted = [
      "main",
      "v1.2.3",
      "feature/login-flow",
      "a/b/c",
      "UPPER/lower_1-2.3",
      "Main",
      "FEATURE/X",
      "a|b",
      "a[b",
      "a]b",
      "a~b",
      "a'b",
      "a:b",
      "a@b",
      "a+b",
      "a=b",
      "a,b",
      "a;b",
      "r".repeat(128),
    ];
    for (const ref of accepted) {
      expect(isCanonicalRef(ref)).toBe(true);
      expect(parseGitHubRepoInput(`github.com/acme/api/tree/${ref}`)).toEqual({
        ok: true,
        owner: "acme",
        repo: "api",
        ref,
      });
    }
  });
  it("enforces the 256-char total ref bound with individually valid segments (009)", () => {
    // Three 85-char segments: every segment legal, separators legal,
    // total 85*3+2 = 257 -> invalid ONLY on total length.
    const seg85 = "s".repeat(85);
    const over = `${seg85}/${seg85}/${seg85}`;
    expect(over.length).toBe(257);
    expect(isCanonicalRef(over)).toBe(false);
    expect(parseGitHubRepoInput(`github.com/acme/api/tree/${over}`).ok).toBe(false);
    // Exactly 256 across hierarchy: 84+1+84+1+86 = 256 -> valid, verbatim.
    const under = `${"a".repeat(84)}/${"b".repeat(84)}/${"c".repeat(86)}`;
    expect(under.length).toBe(256);
    expect(isCanonicalRef(under)).toBe(true);
    expect(parseGitHubRepoInput(`github.com/acme/api/tree/${under}`)).toEqual({
      ok: true,
      owner: "acme",
      repo: "api",
      ref: under,
    });
    // Single-segment extremes agree on both layers.
    expect(isCanonicalRef("r".repeat(128))).toBe(true);
    expect(parseGitHubRepoInput(`github.com/acme/api/tree/${"r".repeat(128)}`)).toMatchObject({ ok: true });
    expect(isCanonicalRef("r".repeat(129))).toBe(false);
    expect(parseGitHubRepoInput(`github.com/acme/api/tree/${"r".repeat(129)}`).ok).toBe(false);
    // Empty total is invalid everywhere.
    expect(isCanonicalRef("")).toBe(false);
  });
  it("documents the parser's own normalizations (trailing slash, case of host)", () => {
    // One trailing slash is trimmed by the parser; the canonical form
    // never carries it.
    expect(parseGitHubRepoInput("github.com/acme/api/tree/main/")).toMatchObject({ ok: true, ref: "main" });
    expect(isCanonicalRef("main/")).toBe(false);
    // Query/fragment inputs are rejected outright, never truncated to a ref.
    expect(parseGitHubRepoInput("github.com/acme/api/tree/a?b")).toMatchObject({ ok: false, code: "QUERY_OR_FRAGMENT" });
    expect(parseGitHubRepoInput("github.com/acme/api/tree/a#b")).toMatchObject({ ok: false, code: "QUERY_OR_FRAGMENT" });
  });
});
