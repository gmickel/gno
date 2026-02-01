# Plan: Cross-Platform sqlite-vec Support

## Overview

Extend the macOS-only workaround in `src/store/sqlite/setup.ts` to enable sqlite-vec on all platforms with minimal user friction.

**Key insight from research:**

- **Linux/Windows**: `Database.setCustomSQLite()` is a no-op - Bun's bundled SQLite supports extensions natively
- **macOS**: Apple's SQLite disables extension loading - requires custom SQLite

**Current state**: macOS works with Homebrew SQLite; Linux/Windows untested but should work.

## Scope

- Verify Linux/Windows work out of the box
- Keep macOS Homebrew approach (already works)
- Add bundled SQLite option for macOS (zero-friction fallback)
- Improve diagnostics in `gno doctor` with runtime probes
- Fix `hasExtensionSupport()` to correctly report Linux/Windows capability

## Approach

### Phase 1: Fix Extension Support Detection API

**Problem**: Current `hasExtensionSupport()` returns `false` on Linux/Windows even when extensions work natively.

**File**: `src/store/sqlite/setup.ts`

Replace `hasExtensionSupport(): boolean` with:

```typescript
export type ExtensionLoadingMode = "native" | "custom" | "unavailable";

export function getExtensionLoadingMode(): ExtensionLoadingMode {
  if (platform() !== "darwin") {
    return "native"; // Linux/Windows: bundled SQLite supports extensions
  }
  return customSqlitePath ? "custom" : "unavailable";
}

export function getCustomSqlitePath(): string | null {
  return customSqlitePath;
}
```

**Rationale**: Truthful API prevents downstream diagnostics from lying.

### Phase 2: Verify Platform Behavior

1. **Test Linux** - Verify `sqliteVec.load(db)` works without any setup
2. **Test Windows** - Same verification
3. **Add integration test** `sqlite-vec-works.test.ts` that actually asserts vector search works:
   - Create in-memory DB
   - Load sqlite-vec
   - Create vec table, insert vector, run `searchNearest`
   - Assert result returned

   **Deterministic skip/fail rules**:
   - If `platform() !== 'darwin'` (Linux/Windows): test **MUST fail** if sqlite-vec load fails (regression gate)
   - If `platform() === 'darwin'` and `getExtensionLoadingMode() !== 'unavailable'`: test **MUST fail** if load fails
   - If `platform() === 'darwin'` and `getExtensionLoadingMode() === 'unavailable'`: test **may skip** with explicit reason logged
   - In CI (detect via `process.env.CI`): test **MUST pass** on all platforms (CI has Homebrew or bundled)

### Phase 3: Bundle SQLite for macOS (Zero-Friction Option)

**Goal**: Ship `libsqlite3.dylib` (arm64 + x64) with the package so macOS users don't need Homebrew.

**Required SQLite compile options** (must validate):

- `SQLITE_ENABLE_LOAD_EXTENSION` - for sqlite-vec
- `SQLITE_ENABLE_FTS5` - required by migrations/FTS queries
- `SQLITE_ENABLE_JSON1` - commonly used

**Bundled artifact requirements**:

1. Pin exact SQLite version (e.g., 3.45.0)
2. Add `vendor/sqlite/README.md` with:
   - Provenance (download URL or build script)
   - SHA256 checksums for each dylib
   - Compile options used
3. Add `vendor/sqlite/darwin-arm64/libsqlite3.dylib` (~2MB)
4. Add `vendor/sqlite/darwin-x64/libsqlite3.dylib` (~2MB)

**Path resolution** (ESM-safe):

```typescript
import { fileURLToPath } from "node:url";
import { arch } from "node:process";

function getBundledSqlitePath(): string | null {
  const archDir = arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  const url = new URL(
    `../../vendor/sqlite/${archDir}/libsqlite3.dylib`,
    import.meta.url
  );
  const path = fileURLToPath(url);
  return existsSync(path) ? path : null;
}
```

**Resolution order** (macOS) with fallback on failure:

1. Try bundled `vendor/sqlite/darwin-{arch}/libsqlite3.dylib`
   - If `setCustomSQLite()` throws, log error and continue to next
2. Try Homebrew ARM: `/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib`
   - If throws, continue to next
3. Try Homebrew Intel: `/usr/local/opt/sqlite3/lib/libsqlite3.dylib`
   - If throws, continue to next
4. If all fail, `getExtensionLoadingMode()` returns `'unavailable'`

**Failure chain tracking** for diagnostics (full chain, not just last error):

```typescript
type LoadAttempt = { path: string; error: string };
const attempts: LoadAttempt[] = [];

for (const path of sqlitePaths) {
  try {
    Database.setCustomSQLite(path);
    customSqlitePath = path;
    return; // Success
  } catch (e) {
    attempts.push({ path, error: e.message });
  }
}
// All failed - export attempts array for doctor to report full chain
export function getLoadAttempts(): LoadAttempt[] {
  return attempts;
}
```

Doctor prints full chain:

```
SQLite loading attempts:
  1. vendor/sqlite/darwin-arm64/libsqlite3.dylib → dlopen failed: code signature invalid
  2. /opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib → file not found
  3. /usr/local/opt/sqlite3/lib/libsqlite3.dylib → file not found
```

**Code signing stance**:

- Bundled dylib is best-effort for zero-friction
- Homebrew remains recommended path for production
- Doctor detects and reports dlopen failures distinctly

### Phase 4: Improve Diagnostics (Runtime Probes)

**File**: `src/cli/commands/doctor.ts`

Add SQLite extension diagnostics using **capability probes** (not compile-option string matching).

**Critical constraint**: Doctor must import `src/store/sqlite/setup` **before** creating any `Database` instance. `Database.setCustomSQLite()` must be called before any DB handle exists.

```typescript
async function checkSqliteExtensions(): Promise<DiagnosticResult> {
  // CRITICAL: Must import setup.ts before creating any Database
  await import("../../store/sqlite/setup");

  const db = new Database(":memory:");
  const version = db.query("SELECT sqlite_version() as v").get().v;

  // 1. Probe FTS5 capability (not compile_options - strings vary across builds)
  try {
    db.exec("CREATE VIRTUAL TABLE _fts5_probe USING fts5(x)");
    db.exec("DROP TABLE _fts5_probe");
  } catch {
    return { status: "error", message: "SQLite missing FTS5 support" };
  }

  // 2. Probe JSON capability
  try {
    db.query("SELECT json_valid('{}')").get();
  } catch {
    return { status: "error", message: "SQLite missing JSON support" };
  }

  // 3. Try loading sqlite-vec (probes extension loading capability)
  try {
    const sqliteVec = await import("sqlite-vec");
    sqliteVec.load(db);
    return { status: "ok", message: `sqlite-vec loaded (SQLite ${version})` };
  } catch (e) {
    return { status: "warn", message: `sqlite-vec unavailable: ${e.message}` };
  }
}
```

**Example output**:

```
SQLite Extension Support:
  Platform: darwin-arm64
  Mode: custom (/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib)
  SQLite version: 3.45.0
  FTS5: ✓ enabled
  sqlite-vec: ✓ loaded (v0.1.7)
  Vector search: ✓ available
```

**Important**: No logging at module load time in setup.ts. All diagnostics via `gno doctor` or `--verbose`.

### Phase 5: Cleanup

Specific items to address once cross-platform works:

1. **Update setup.ts header comment** - Remove claim "Bun's bundled SQLite doesn't support extensions" (only true for macOS)
2. **Preserve failure reasons** - Modify `createVectorIndexPort()` catch blocks to store error for doctor to report
3. **Update README** - Simpler instructions now that bundled SQLite exists

## Files to Modify

| File                                         | Changes                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `src/store/sqlite/setup.ts`                  | New `getExtensionLoadingMode()` API, bundled path resolution, fix comments |
| `src/store/vector/sqlite-vec.ts:77-85`       | Preserve load failure reason for diagnostics                               |
| `src/cli/commands/doctor.ts`                 | Add runtime probe for sqlite-vec, validate FTS5                            |
| `vendor/sqlite/README.md`                    | New - provenance, checksums, compile options                               |
| `vendor/sqlite/darwin-*/libsqlite3.dylib`    | New - bundled SQLite dylibs                                                |
| `test/store/vector/sqlite-vec-works.test.ts` | New - test that actually asserts vec search works                          |

**NOT modifying**: `package.json` optional deps - let sqlite-vec handle its own packaging.

## Risks & Mitigations

| Risk                                   | Likelihood | Mitigation                                           |
| -------------------------------------- | ---------- | ---------------------------------------------------- |
| Bundled dylib missing FTS5             | Medium     | Validate compile_options at runtime, fail fast       |
| Path resolution fails in npm install   | Medium     | Use import.meta.url, test in CI                      |
| Package size increase (~4MB)           | Certain    | Acceptable for zero-friction UX                      |
| macOS Gatekeeper blocks unsigned dylib | Medium     | Homebrew is recommended path; bundled is best-effort |
| SQLite version incompatibility         | Low        | Pin version, validate at runtime                     |

## Acceptance Criteria

- [ ] `gno embed` + `gno vsearch` work on macOS without Homebrew (bundled SQLite)
- [ ] `gno embed` + `gno vsearch` work on Linux without extra packages
- [ ] `gno embed` + `gno vsearch` work on Windows without extra setup
- [ ] `gno doctor` shows runtime-verified extension status
- [ ] `gno doctor` validates FTS5 is available
- [ ] Integration test asserts vector search actually works
- [ ] All existing tests pass
- [ ] No user-facing installation steps beyond `bun install`

## Open Questions

1. **Bundle size**: Is ~4MB for macOS SQLite dylibs acceptable? → Yes, acceptable for UX
2. **Code signing**: Need to sign bundled dylib? → No, Homebrew is recommended; bundled is fallback
3. **CI testing**: Do we have Linux/Windows CI runners? → Need to verify/add
4. **SQLite version**: Which version to bundle? → Latest stable with required features

## Test Plan

1. **Unit tests**:
   - `getExtensionLoadingMode()` returns correct value per platform
   - Bundled path resolution works
   - Fallback chain preserves errors

2. **Integration tests**:
   - **New**: `sqlite-vec-works.test.ts` - actually exercises vector search
   - Test graceful degradation when extension unavailable
   - Test doctor output accuracy

3. **CI enforcement story**:

| Platform          | Expected Result               | CI Setup Required                                                     |
| ----------------- | ----------------------------- | --------------------------------------------------------------------- |
| Linux x64         | sqlite-vec MUST work (native) | None - extensions work OOTB                                           |
| Windows x64       | sqlite-vec MUST work (native) | None - extensions work OOTB                                           |
| macOS (CI)        | sqlite-vec MUST work          | Either: install Homebrew sqlite3 OR ensure bundled dylibs in test env |
| macOS (no sqlite) | Graceful degradation          | Test that doctor reports unavailable correctly                        |

**Test expectations**:

- `sqlite-vec-works.test.ts` MUST pass on Linux/Windows (regression gate)
- `sqlite-vec-works.test.ts` MUST pass on macOS CI (with Homebrew or bundled)
- `sqlite-vec.test.ts` (existing) tests graceful degradation

**CI workflow changes** (`.github/workflows/ci.yml`):

```yaml
# Linux/Windows: no changes needed
# macOS: either install Homebrew sqlite3 or include bundled dylibs
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      # macOS: install sqlite3 with extension support
      - if: matrix.os == 'macos-latest'
        run: brew install sqlite3
      - run: bun install
      - run: bun test
```

## References

- Current workaround: `src/store/sqlite/setup.ts:30-55`
- sqlite-vec loader: `src/store/vector/sqlite-vec.ts:77-85`
- Doctor command: `src/cli/commands/doctor.ts`
- sqlite-vec npm package: `node_modules/sqlite-vec/index.mjs`
- Platform extension: `node_modules/sqlite-vec-darwin-arm64/vec0.dylib`
- [Bun SQLite docs](https://bun.com/docs/runtime/sqlite)
- [sqlite-vec JS docs](https://alexgarcia.xyz/sqlite-vec/js.html)
- [SQLite macOS extensions](https://til.simonwillison.net/sqlite/trying-macos-extensions)
