# VibeFlow Inspector AI

Read-only TypeScript/TSX source inspection with an evidence-linked architecture graph, conservative security findings, and clearly labeled synthetic safer-pattern examples.

This source export comes from Chief-approved Canonical RC001. Application code, fixture bytes, dependency pins and security boundaries are unchanged. Workspace-only operator launchers, private runtime state, historical QA evidence and local publication approvals are excluded.

## 🎥 Hackathon demo

[![Watch the VibeFlow Inspector AI Demo](https://img.shields.io/badge/YouTube-Watch%20Demo-red?logo=youtube)](https://youtu.be/Npr_WJGDkcY)

**[▶ Watch the VibeFlow Inspector AI demo on YouTube](https://youtu.be/Npr_WJGDkcY)**

**[🌐 Visit the official VibeFlow Inspector AI website](https://vibeflowinspectorai.vercel.app/)**

The hackathon video demonstrates read-only repository inspection, the architecture graph, evidence-linked potential findings, and live Meta Muse explanations for selected findings. The recorded demo is a prototype, not a comprehensive vulnerability scanner; not every finding or workflow is supported end to end.

## Run without Muse credentials

Use Node.js **24.18.0** and npm **11.16.0**, the versions used for local qualification. Registry access is needed to install the locked dependencies. The GitHub repository is currently private, so cloning requires repository access; this is separate from Muse access.

```bash
git clone https://github.com/tuncaokimjohn-code/VIBESFLOW.git
cd VIBESFLOW
npm ci
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open <http://127.0.0.1:3000> for public GitHub intake, or <http://127.0.0.1:3000/demo/vibeshop> for the bundled offline fixture.

**No `.env` file, Muse API key, authorization grant or publication approval is needed.** The public explanation endpoint only retrieves existing, validated results. It cannot initiate inference. In a clean clone, Muse remains **NOT CONFIGURED**, and loading an unavailable explanation is expected to fail closed.

For the qualified webpack production path, use:

```bash
npm run build -- --webpack
npm run typecheck -- --incremental false
npm start -- --hostname 127.0.0.1 --port 3000
```

See [SETUP.md](SETUP.md) for prerequisites, tests, generated files and troubleshooting.

## What the clone provides

| Workflow | Capability and limits |
|---|---|
| Public GitHub intake | Explicit, anonymous reads pinned to an immutable commit; TS/TSX only; subject to network availability and GitHub quota. Source is parsed, never executed. |
| Architecture | Source-backed modules/import relationships with partial or unsupported coverage reported. |
| Potential findings | Three conservative classes: credential-like literals, dynamic SQL construction, and dynamic HTML. These are not confirmed vulnerabilities. Ownership/IDOR and admin authorization are not supported. |
| Public evidence | Validated source location/hash/commit and narrowly allowlisted anchor tokens; surrounding excerpts and literals are withheld. |
| Offline VibeShop | A controlled synthetic fixture with 46 modules and three potential findings. It is explicitly labeled as not fetched from GitHub. |
| Safer comparison | Illustrative synthetic before/after patterns. These are not repository diffs or validated fixes. |
| Muse | Saved-result retrieval code is present; a clean clone contains no genuine result and cannot generate one through the browser. |
| Evaluation | Blind-test precision and recall are not measured. |

## The authorized local Muse demonstration

The approved local demonstration retrieved an existing genuine **Muse Spark 1.3 Contributor** SQL explanation, bound to one exact synthetic finding and source snapshot. The UI labeled it **REAL MUSE — AUTHORIZED LOCAL RESULT**, showed its saved generation time and requested medium reasoning, and stated that retrieval made no new provider call.

That genuine result stays in its protected external environment. It is **not distributed with this repository**, and it is not an explanation of an arbitrary GitHub import. API keys, grants, consumed locks, signed result bundles, private captures and publication approvals are not included. Do not copy them into a clone to imitate the demonstration. No automatic mock result is served as genuine Muse output.

The retained server-only provider modules are reviewed source, not a live execution interface for this export. Workspace operator tooling and its authorization procedure are not part of the clone. Future live execution requires separate owner authorization and qualification; no verified hard dollar spending ceiling is claimed.

## Verification and security

```bash
npm exec -- vitest run
sha256sum --check SOURCE_MANIFEST.sha256
```

The packaged tests use synthetic fixtures and mocked transports. Their invented receipts and reasoning strings are not provider evidence. The original full RC001 qualification also used workspace-specific baseline and launcher tests; those are not claimed as runnable from this filtered export. See [RELEASE_PROVENANCE.json](RELEASE_PROVENANCE.json) for the approved input pins and copied-file hashes, and [SECURITY.md](SECURITY.md) for the threat boundaries and reporting guidance.
