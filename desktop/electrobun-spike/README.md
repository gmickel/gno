# GNO Electrobun Spike

Thin Electrobun wrapper around the existing GNO Bun/web app.

Goal:

- start the existing `gno serve` flow as a child process
- wait for `/api/health`
- open the real GNO workspace in a native window
- prove a few native shell primitives without changing the main app first
- prove a manual singleton handoff for forced second launch

Current native actions:

- `Spike > Choose Folder...`
- `Spike > Reveal Repo Root`
- `Spike > Trash Probe File`
- `Spike > Open Sample Deep Link`

## Run

```bash
cd desktop/electrobun-spike
bun install
bun run start
```

Optional env:

```bash
GNO_ELECTROBUN_PORT=3927 bun run start
GNO_ELECTROBUN_SELFTEST=1 bun run start
GNO_ELECTROBUN_SELFTEST=1 GNO_ELECTROBUN_SELFTEST_DIALOG=1 bun run start
```

Notes:

- Uses the developer's real GNO config/index for now.
- Meant for fit-testing only, not production packaging.
- `GNO_ELECTROBUN_SELFTEST=1` automatically runs a tiny smoke path after boot:
  - move a probe file to Trash
  - navigate the live window through a sample `gno://` deep link
- `GNO_ELECTROBUN_SELFTEST_DIALOG=1` also opens the native folder picker during self-test.
- Includes a localhost control-port handoff:
  - first instance owns `3928`
  - later instances hand off `focus` to the first instance and exit
  - this neutralizes the `open -n` duplicate-process problem for the spike
