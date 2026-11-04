# Muse contributions, integration and verification record

**Cutoff:** 5 November 2026 (PHT)

## Three roles that should not be conflated

- **Muse Code (development tooling):** Used during early VibeFlow implementation, with standardized run artifacts under `docs/muse-runs/` in the protected engineering workspace. Some later isolated repairs were performed by Codex, and their attribution belongs to Codex. No blanket claim that Muse created every file is supported.
- **Muse Spark 1.3 Contributor (runtime inference):** The intended model for potential-finding explanations, requested at medium reasoning effort.
- **Codex/Astra review:** Separate independent QA or builder tasks as authorized. A builder self-test or handoff checklist is not itself an independent verification verdict.

## Early model-work documentation coverage

At the November 3 review, the protected workspace held **56 Muse-run folders** across P01–P08, with **15** standardized `PROMPT.md` records and **15** standardized `SESSION_LOG.md` records. Later work may also appear in distinct builder/implementation reports rather than those exact filenames. These counts are not a claim to have exported or verified every full conversation transcript.

| Phase | Muse-run folders | Standard prompt files | Standard session logs |
|---|---:|---:|---:|
| P01 | 2 | 2 | 2 |
| P02 | 7 | 4 | 4 |
| P03 | 24 | 9 | 9 |
| P04 | 14 | 0 | 0 |
| P05 | 1 | 0 | 0 |
| P06 | 3 | 0 | 0 |
| P07 | 3 | 0 | 0 |
| P08 | 2 | 0 | 0 |

Incomplete standardized coverage must not be used to invent missing prompts or to reassign Codex changes to Muse.

## Runtime explanation sequence

1. **October 31, P6:** Redaction, source citation, bounded explanation requests, consent, cancellation and NOT CONFIGURED behavior were developed using offline injected transports. C009 preserved an unresolved historical evidence-integrity issue and did not qualify production inference.
2. **November 3, C033:** A finding inspector was connected to an offline explanation path. Mock responses were visibly labeled `OFFLINE MOCK — NO MUSE CALL`. Production remained null-provider.
3. **November 3, C034:** An operator-only model request design and a browser **saved-result retrieval** path were recorded. This implementation performed no genuine model call during its offline qualification.
4. **November 3–4, C035–C038:** Follow-on isolated candidates addressed publication, reasoning compatibility, retained response binding and final message handling.
5. **Genuine result documented in canonical RC001:** A `muse-spark-1.3-contributor` response was generated **2026-11-03T20:06:40.686Z** for one controlled synthetic SQL finding, `VF-SEC-002`. It was saved under protected external operator state. The qualified local browser could retrieve this verified result and display **REAL MUSE — AUTHORIZED LOCAL RESULT**. The result was not generated when the user clicked to load it.
6. **November 4 public-model experiments:** Separate Gateway and Meta Direct variants attempted future public-source inference and billing/reservation controls. They are not equivalent to a completed, independently qualified general solution. A public `meta-direct` HTTP 429 needs diagnostic evidence; possible database state or quota conditions must not be silently classified as provider rate limiting.

## Why the GitHub clone does not perform genuine inference

The release deliberately omits API keys, sensitive grants, consumed locks, signed publication bundles, direct operator runners and private raw captures. A clone can inspect public supported TypeScript/TSX source and demonstrate the offline fixture, but it cannot reproduce the local saved genuine result. The browser explanation endpoint is a **reader**, not an unrestricted provider request dispatcher.

## Engineering evidence and qualifications

| Record | Scope | Reported outcome |
|---|---|---|
| P6 C009 | P6 final candidate follow-up | 769 full-suite passes; qualification blocked by historical C007 log/manifest mismatch |
| P8 C033 | Offline explanation integration | 1,272 passes / 2 skips; live API and browser visual not verified at that point |
| P8 C034 | Operator-only saved-result architecture | 1,384 passes / 2 skips; live request not run during implementation |
| Canonical RC001 | Integrated local public import and saved-result browser | 778 focused passes; 1,995 full-suite passes / 2 skips; 40 browser checks |
| Final-token recovery | Later isolated Meta Direct repair | 135 focused passes; previously 1,686 full-suite passes / 12 failures; PostgreSQL 18 QA blocked |

All these figures are claims recorded in the named candidate reports. They are not re-executed by the documentation publication.

## Public documentation evidence standard

For any claim about actual Muse inference, include the model identifier, source finding binding, generation time, whether the response is saved or newly generated, and whether there is separate trustworthy provider evidence. Never present test-shaped receipts or copied mock response objects as billable provider receipts.

The Meta hackathon organizer's Discord guidance asked teams to demonstrate Meta models doing real work in the three-minute video and describe model use in the repository README. The preserved genuine saved synthetic explanation supports a narrower claim than a live on-screen request. The accompanying recording did not independently establish a fresh model call.
