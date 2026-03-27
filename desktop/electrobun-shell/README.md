# GNO Desktop Beta Shell

Repo-owned Electrobun shell scaffold for the mac-first desktop beta.

Purpose:

- keep the desktop shell thin around the existing GNO workspace
- launch and supervise the real `gno serve` process
- own app-level singleton handoff while Electrobun lacks a first-class API
- keep `gno://` deep links routed into the same web workspace routes
- record the interim `open-file` / file-association strategy without leaking shell details into core app code

## Current boundary

GNO owns:

- child-process startup/shutdown for `gno serve`
- localhost control-port singleton handoff
- route normalization from shell events into existing workspace URLs
- packaging metadata fragments for URL/file associations

Electrobun / upstream owns:

- native shell runtime
- window primitives
- app lifecycle events
- eventual first-class `open-file` support if upstream lands it

## Open-file strategy

Current interim plan:

1. package markdown/plaintext associations via plist metadata
2. when shell `open-file` support exists upstream, translate incoming file paths into existing GNO workspace routes
3. until then, keep the packaging fragment and boundary documented here instead of inventing fake runtime glue in core app code

## Distribution placeholders

Distribution scaffolding now lives in:

- `desktop/electrobun-shell/distribution/`
- `docs/DESKTOP-BETA-ROLLOUT.md`

These are placeholders for the eventual signed/notarized beta path, not proof that credentials or hosting already exist.

Fallback trigger:

- only revisit another shell if Electrobun still fails a must-have capability:
  - no acceptable `open-file` / file-association path
  - no acceptable signing/distribution path
  - unacceptable shell glue or maintenance cost

## Tabs

Tabs stay app-level GNO workspace state.

Do not build around native BrowserView tabs.

## Run

```bash
cd desktop/electrobun-shell
bun install
bun run start
```

Optional env:

```bash
GNO_ELECTROBUN_PORT=3927 bun run start
GNO_ELECTROBUN_SELFTEST=1 bun run start
```
