# Security policy and review boundaries

## System and scope

VibeFlow Inspector AI performs read-only public GitHub TS/TSX inspection and presents source-bound architecture and potential findings. This release is qualified for local, loopback-only use. It does not establish a hardened internet-facing service or multi-user authorization model.

The public application contains a read-only Muse saved-result retrieval route. It does not expose a billable inference endpoint. The genuine authorized local result and its operator environment are outside this repository. Retained server-only provider source does not authorize its execution from a clone.

## Trust boundaries

- Repository URLs, imported source, source paths, archives, model responses and browser request bodies are untrusted.
- Imported source is data for bounded parsing. It must never be executed, imported as application code, evaluated or used to invoke a shell or dependency lifecycle.
- Public GitHub provenance requires an immutable commit and matching source bytes, location geometry, quote and hashes. Intake/AST coverage and potential findings must retain their limitations.
- The controlled offline fixture has synthetic provenance. It must never be presented as a fresh GitHub inspection.
- Local operator publication trusts the protected OS account and private external files. A local publication signature is not a Meta-signed attestation or a billing receipt.

## Security invariants

1. Browser requests cannot choose a live provider, supply a usable API key, create a grant, reset a consumed lock or authorize spending.
2. `/api/explain` remains retrieval-only. Its import graph must contain no native provider transport or key reader. Missing configuration, invalid evidence or missing publication authority fails closed without a mock fallback.
3. Saved-result retrieval must match the server-owned synthetic snapshot, selected finding, evidence ID, path, line, column, quote, source hash and exact request. Signed publication, completed outcome, receipt and consumed attempt must agree.
4. Only validated final claims and exact citations may be published. Preserve model/token/usage limits, rejection of tool calls and incomplete/commentary output, and safe discard of permitted private reasoning. Never persist, display or replay raw reasoning, summaries or encrypted payloads.
5. Genuine provider output and offline mocks must remain explicitly distinct. Test envelopes and invented receipts are never submission evidence.
6. Preserve HTTPS certificate/hostname verification, fixed provider endpoints, no redirects/retries/fallback calls, bounded bodies, cancellation, deadlines and sanitized failures in any future separately qualified operator workflow.
7. Secrets and private state stay outside source, Git history, browser bundles and public responses. Never commit `.env` files, API keys, real grants, locks, signed result bundles, private captures or publication approvals. `.gitignore` is only a second line of defense; inspect the proposed Git index before publication.

## Review and severity context

Report reachable violations of these invariants, including imported-source execution, credential/approval disclosure, unauthorized provider invocation, forged source provenance, acceptance of inconsistent publication state, cross-finding result substitution, or mock output labeled genuine. Assess severity from demonstrated reachability and impact; these examples do not suppress other valid findings.

Known limitations include conservative heuristic detection, partial AST coverage, three supported finding classes, unmeasured blind-test accuracy, and illustrative synthetic comparisons. They are not claims that arbitrary findings outside those areas are safe. No hard dollar spending cap or provider-side cancellation/billing guarantee is established for a future live call.

## Reporting

Contact the repository owner privately using an established private channel. If GitHub's private vulnerability-reporting control is available for this repository, use it. Do not post API keys, private grants, publication approvals, raw provider responses or sensitive source excerpts in public issues. Provide the affected revision/path, a sanitized reproduction and the observed impact. No response-time or remediation SLA is promised by this document.
