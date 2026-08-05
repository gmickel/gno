# macOS test/cli suite fails as a directory run: SQLite custom-lib race

## Overview

On macOS, `bun test test/cli` reports **189 failures**, while every one of those
files passes when run individually. The suite is green on a per-file basis and red
as a directory. Discovered while establishing a clean baseline for
`fn-114-reliable-watcher-reconciliation-for`; it is unrelated to that work and
reproduces on an untouched `origin/main` tree.

## Evidence

Measured at `35b7b3cf` (origin/main content) on darwin 25.5.0, Bun 1.3.11,
after a clean `bun install --frozen-lockfile`:

```
bun test              -> 3534 pass, 2 skip, 0 fail   <-- the canonical gate is GREEN
bun test test/spec    ->  275 pass,   0 fail
bun test test/serve   ->  471 pass,   0 fail
bun test test/cli     ->  521 pass, 189 fail          <-- only this narrower scope
```

**Scope matters and was initially mis-stated.** Running the whole suite is green: the
`test/cli` files execute inside it and pass. The failure appears only when `test/cli` is
given its own directory scope, which is exactly what an ordering race predicts — a
different set of files, in a different order, in that process. Severity is therefore
"a supported command is broken", not "the repo is red".

Isolation check — the same files, alone:

```
bun test test/cli/trace.test.ts                     -> 3 pass, 0 fail
bun test test/cli/setup-activation-lifecycle.test.ts -> 3 pass, 0 fail
```

Dominant error in the directory run:

```
CliError: Failed to load fts5-snowball: This build of sqlite3 does not support
dynamic extension loading
```

## Root cause (diagnosed, not assumed)

`bun:sqlite` binds Apple's system SQLite by default, which is built **without**
dynamic extension loading, so `db.loadExtension()` on `vendor/fts5-snowball/
darwin-arm64/fts5stemmer.dylib` cannot work. The repo already handles this:
`src/store/sqlite/setup.ts:45-79` detects `/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib`
and calls `Database.setCustomSQLite(path)`.

Confirmed working in isolation:

```bash
bun -e 'import{Database}from"bun:sqlite";
  Database.setCustomSQLite("/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib");
  new Database(":memory:").loadExtension(".../fts5stemmer.dylib")'
# -> EXTENSION LOADED OK
```

`Database.setCustomSQLite()` is process-global and must run **before the first
`Database` is constructed in that process**. Bun executes a directory's test files
in one process, so whichever file first constructs a `Database` without going
through `setupSqlite` pins the system library for the whole run, and every later
file's extension load fails. Per-file runs each get a fresh process, so they pass.

This is an ordering/isolation defect in the test setup, not a product defect —
the shipped CLI calls `setupSqlite` before opening a store.

## Boundaries / non-goals

- Not a change to `src/store/sqlite/setup.ts`'s detection list or load order in production
- Not a fix for `fn-114`'s watcher work (that spec's suites — `test/ingestion`,
  `test/store`, `test/serve` — are green)
- Not vendoring a different SQLite build

## Acceptance Criteria

- **R1:** `bun test test/cli` passes on macOS as a single directory run, with no
  reduction in the number of tests executed, and full `bun test` stays green.
- **R2:** The fix makes the custom-SQLite selection order-independent rather than
  relying on file execution order — a newly added test file that constructs a
  `Database` cannot silently re-break the suite.
- **R3:** A regression guard fails loudly if the process ends up on a SQLite build
  without extension loading when the platform requires the Homebrew library, rather
  than surfacing as 189 unrelated assertion failures.
- **R4:** Behavior on Linux and Windows is unchanged, and CI timing does not regress
  meaningfully.

## Open questions

- Is macOS CI (`.github/workflows/ci.yml:40` runs `brew install sqlite3`) currently
  green because it shards `test/cli` differently, or is it red/flaky in the same way?
  Check before assuming this is local-only.
- Preferred fix shape: a preload module (`bunfig.toml` `[test] preload`) that calls
  `setupSqlite` once per process, versus making every store-constructing test route
  through a shared helper. The preload is likely smaller and order-proof.

## References

- `src/store/sqlite/setup.ts:45-79` — detection list + `Database.setCustomSQLite`
- `src/store/sqlite/fts5-snowball.ts:108-140` — loader and the raised error
- `vendor/fts5-snowball/darwin-arm64/fts5stemmer.dylib`
- `.github/workflows/ci.yml:40` — `brew install sqlite3`
- Discovered during `fn-114-reliable-watcher-reconciliation-for` baseline verification
