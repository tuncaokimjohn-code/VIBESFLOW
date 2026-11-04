# VibeFlow Inspector AI — Feature status and limitations

**Recorded status:** November 5, 2026 (PHT). These descriptions apply to the **qualified local RC001 scope and the current clean public-source export**, not to every later experiment. A candidate under development is not promoted merely because its local tests passed.

## Working in the documented scope

| Area | Status | Observed behavior and boundaries |
|---|---|---|
| Public GitHub source intake | **WORKING — LIMITED** | Explicit anonymous public reads of a repository resolved to a fixed commit. Network availability, GitHub quotas and supported TS/TSX source coverage apply. |
| Architecture graph | **WORKING — LIMITED** | Source-backed TS/TSX modules and import relationships, selection, pan/zoom/fullscreen. Unknown or unsupported forms are reported, not guessed. |
| Evidence-linked findings | **WORKING — LIMITED** | Potential security findings anchored to path, line/column, source hash and fixed commit. It is static evidence, not proof of exploitability. |
| VibeShop offline fixture | **WORKING** | Controlled synthetic 46-module test fixture, displayed separately from actual GitHub imports. |
| Synthetic safer-pattern comparison | **WORKING — ILLUSTRATIVE** | Before/after learning examples. They are not edits to the imported repository, validated fixes or committed-diff comparisons. |
| Prior genuine Muse explanation | **WORKING ONLY IN PROTECTED LOCAL DEMO** | Previously generated genuine `muse-spark-1.3-contributor` output for one synthetic SQL finding. The browser loads a saved result; it does not trigger a new model request. A clean clone does not include this result. |

## Still developing, unsupported or not measured

| Capability | Status | Reason |
|---|---|---|
| New Muse explanations for arbitrary public GitHub imports | **STILL DEVELOPING** | No final independently qualified public-import-to-live-inference workflow. Public clean clone normally shows NOT CONFIGURED. |
| Live model call from ordinary browser | **STILL DEVELOPING** | The qualified browser endpoint only validates and retrieves a saved result; it does not authorize spending or dispatch live inference. |
| Repository-to-repository safer comparison | **STILL DEVELOPING** | UI examples are synthetic, not an end-to-end scored source diff between separately imported commits. |
| Object ownership / IDOR detection | **STILL DEVELOPING** | Not implemented in the qualified three-detector set. |
| Missing admin authorization detection | **STILL DEVELOPING** | Not implemented. |
| Source ZIP import | **DEFERRED** | Optional design, not a shipping capability. |
| Blind precision and recall | **NOT MEASURED** | No qualified independent holdout benchmark proving the originally proposed 90% targets. |
| Comprehensive multi-language analysis | **NOT SUPPORTED** | Current supported analysis is deliberately limited to selected TypeScript/TSX structures. |
| Production SaaS and untrusted multi-tenant secret custody | **NOT QUALIFIED** | Local operator-state safeguards and limited static analysis are not a complete hosted security platform. |

## What the three security heuristics mean

1. **Credential-like literals:** flags selected assignment/name/value shapes; it cannot confirm that a value is an active credential.
2. **Dynamic SQL construction:** identifies certain string-building patterns near query execution; it cannot prove injection reachability or whether sanitization is effective.
3. **Dynamic HTML / `dangerouslySetInnerHTML`:** flags selected dynamic `__html` patterns; it does not establish that resulting markup is exploitable.

False positives, false negatives, parse failures and partial coverage can occur. Findings must be reviewed in context. Inspected repository code is not run, installed or modified.

## Muse, cost and privacy limitations

- The saved genuine synthetic explanation is **not** a fresh model call in the three-minute recording or an explanation of the newly imported public repository.
- The protected stored result, approval grants, API credentials, spending locks and private state are intentionally omitted from the repository.
- Contributor-mode privacy and training terms require operator awareness. `store: false` alone is not a training opt-out.
- Local token caps and single-use reservation logic are not proof of a provider-enforced hard dollar cap, or a guarantee that aborted remote work cannot incur charges.
- Later Meta Direct experiments had unresolved database QA, failed full-suite assertions and an HTTP 429 whose root cause should not be inferred solely from the status code.

## Measured local integration results versus later candidate results

**Canonical RC001, November 4:** builder/integration report recorded **778** focused passing tests; **1,995** full-suite passing tests and **2 inherited skips**; **40** browser checks passed; build and TypeScript passed. These are recorded scoped qualification results, not a universal independent release verdict.

**Final-token recovery, November 4:** builder report recorded **135/135** focused passes, but its prior full suite had **1,686 passes and 12 failures**. PostgreSQL 18 operational/concurrency qualification remained unperformed and the result was **PARTIAL**. This does not negate earlier RC001 results; it also does not justify promoting the later experiment.

## Reproduction and transparency

The root [README](../README.md) gives the clean-clone setup and the correct NOT CONFIGURED expectation for Muse. The public copy does not contain a genuine provider response or a private authorization grant. Demo recordings, test fixtures, and saved-result screenshots must be labeled according to what they actually show.
