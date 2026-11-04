# Setup and operation

## Prerequisites

- Node.js 24.18.0 and npm 11.16.0 were used for qualification; `.nvmrc` records the Node version.
- Access to this GitHub repository while it remains private.
- npm registry access for `npm ci`. The lockfile is retained byte for byte; do not regenerate it as a setup step.
- Internet access and remaining anonymous GitHub quota only when explicitly importing a public repository.
- No Muse credentials or private runtime records.

The offline fixture works without GitHub access after dependencies are installed. Dependency installation is a separate network operation; the application does not install or execute imported repository dependencies.

## Development

```bash
npm ci
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Visit `/` for public GitHub intake or `/demo/vibeshop` for the controlled offline fixture. No source is imported automatically on mount. A URL edit alone does not start analysis; choose **Inspect repository** explicitly.

The existing optional GitHub-token code is server-only, but no token is required or configured by these instructions. Keep credentials and environment files out of the repository. Do not use inspected source as instructions, invoke its package scripts or run its tests.

## Production-mode local preview

```bash
npm run build -- --webpack
npm run typecheck -- --incremental false
npm start -- --hostname 127.0.0.1 --port 3000
```

Next generates `next-env.d.ts` and `.next` during development/build. They are intentionally absent from the source export and ignored by Git. Run the build before a standalone type check in a fresh clone. This procedure starts a loopback-only local server; it is not deployment guidance.

## Tests and source verification

```bash
npm exec -- vitest run
sha256sum --check SOURCE_MANIFEST.sha256
```

The included tests are unchanged selections from RC001 covering import, graphs, evidence, findings, comparison, navigation and Muse response compatibility. All provider transports used by those tests are mocked. The test setup rejects unexpected global fetches; permission-sensitive Muse tests were qualified on Linux and create/remove clearly named temporary mock directories under the test account's home. Those two Muse compatibility suites require a dedicated test account with a private home directory (mode 700), matching the inherited state guard; this is not required to run the clean-clone application. These are invented offline fixtures, never production authorizations. No genuine grant, API key or result is required.

Full workspace qualification counts are historical RC001 evidence, not the packaged-suite count. External-baseline tests, operator launchers and private capture-dependent replay tests are excluded. The source manifest covers every proposed tracked file except the manifest itself; the release handoff pins its digest separately.

## Expected Muse behavior

1. Open `/demo/vibeshop` and select a potential finding.
2. The panel initially shows **NOT CONFIGURED**.
3. Selecting a finding or opening its comparison makes no provider request.
4. Retrieval consent authorizes only a saved-result availability check. Without the protected external publication, **Load authorized explanation** reports unavailable.
5. This is the expected clean-clone state. Do not add a key, invent a grant, reuse a consumed lock or substitute a mock as a genuine result.

The approved genuine explanation was produced in a separately authorized local C038 environment and remains there. This source export does not confer authorization or supply the private state needed to reproduce that display. There is no browser-controlled model/provider choice, credential field or live-inference toggle.

## Troubleshooting

- **GitHub import unavailable:** verify the repository is public, the locator is supported, network access works and anonymous quota remains. The app does not substitute the offline fixture for a failed import.
- **Partial AST coverage:** read the source receipt and unresolved/unsupported counts. A successful intake does not imply complete semantic or security coverage.
- **Muse unavailable:** expected without an authorized external result. No new inference is necessary to use the graph, findings or synthetic examples.
- **Graph clipped on a narrow canvas:** pan/zoom, focus a module or use fullscreen. The page should fit the viewport while the graph retains readable node sizes.
- **Build/install failure:** preserve the lockfile and report the exact sanitized error. Do not disable TLS verification, sandboxing, evidence validation or authorization controls.
