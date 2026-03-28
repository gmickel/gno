# Windows Support

Windows support in GNO currently targets `windows-x64`.

## Current Recommendation

### CLI

Supported path today:

```bash
bun install -g @gmickel/gno
gno doctor
```

That is the recommended Windows path for normal use right now.

### Desktop Beta

The desktop shell/runtime story is now validated around a packaged Electrobun
artifact that stages the real GNO runtime inside the app bundle.

Current recommendation:

- `windows-x64` only
- portable packaged artifact first
- treat MSI/installer polish as follow-up work, not the first supported shape

## What Is Explicitly Validated

Windows packaging validation now checks packaged runtime behavior, not just
source checkout behavior:

- bundled Bun runtime exists inside the packaged app
- staged GNO runtime exists inside the app resources
- packaged `gno doctor --json` works
- packaged runtime loads:
  - FTS5
  - vendored `fts5-snowball.dll`
  - `sqlite-vec`
- packaged runtime can:
  - `init`
  - `update`
  - `search`
- packaged desktop shell can boot in self-test mode

## Unsupported / Not Yet Claimed

- `windows-arm64`
- MSI installer as the primary supported delivery path
- auto-update story for Windows desktop artifacts

## Manual Validation On A Real Windows Machine

If you want to smoke the desktop beta manually:

1. build the shell artifact
2. run the packaged-runtime verifier
3. launch the packaged app
4. verify:
   - onboarding
   - add-folder paste/input
   - preset switching
   - `gno://` deep links
   - singleton handoff
   - indexing/search on a real folder

## Why `windows-arm64` Is Not Supported Yet

Current vendored/runtime proof covers `windows-x64` only:

- vendored `fts5-snowball.dll` is present for `windows-x64`
- packaged runtime validation is scoped to `windows-x64`
- native dependency/runtime proof for `windows-arm64` is still missing
