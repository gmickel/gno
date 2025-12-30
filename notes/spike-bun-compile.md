# Spike: bun build --compile with Native Dependencies

**Date**: 2025-12-30
**Issue**: gno-quw.1
**Status**: Complete

## Environment

- **OS**: macOS 15.1 (Darwin 25.1.0) arm64
- **Bun**: 1.1.38
- **Test layout**: `./gno-test` binary in project root, `./node_modules/` present

## Summary

`bun build --compile` produces a 67MB executable. However, `--external` flags mean it's **not fully standalone**—externalized packages require runtime resolution (node_modules or global install).

## Findings by Dependency

### bun:sqlite (Built-in)
**Status**: AVAILABLE (extension loading is platform-dependent)

- SQLite available via `bun:sqlite` on all platforms
- FTS5 and JSON1 extensions work out of the box
- **Extension loading behavior**:
  - Linux/Windows: Bun's bundled SQLite supports extensions natively
  - macOS: Apple's system SQLite disables extension loading; gno calls `Database.setCustomSQLite()` to use Homebrew SQLite (see `src/store/sqlite/setup.ts`)
- Tested: `./gno-test doctor` confirms FTS5/JSON1 available

### sqlite-vec
**Status**: SIDECAR REQUIRED

- Cannot bundle `.dylib/.so/.dll` into executable
- npm package uses `import.meta.url` for extension lookup
- Compiled binary's `import.meta.url` → bunfs virtual path (`/$bunfs/root/gno-test`)
- Extension file not found even with `./node_modules/sqlite-vec-darwin-arm64/vec0.dylib` present adjacent to binary

**Error** (verbatim): `Loadble extension for sqlite-vec not found. Was the sqlite-vec-darwin-arm64 package installed?`

**macOS caveat**: Even with sidecar `vec0.dylib`, extension loading requires either:
- Homebrew SQLite installed (`brew install sqlite`), or
- Ship custom SQLite dylib + call `Database.setCustomSQLite()`, or
- Accept storage-only mode (no KNN search)

**Path forward** (choose one):
1. **Bypass sqlite-vec loader**: Call `db.loadExtension(path)` directly with explicit path (avoids `import.meta.url` issue) — *not validated in this spike*
2. **Fork/patch sqlite-vec**: Accept configurable extension path
3. **Runtime download**: Download `vec0.*` on first use to known location

Current code (`src/store/vector/sqlite-vec.ts`) delegates to sqlite-vec's loader:
```ts
const sqliteVec = await import('sqlite-vec');
sqliteVec.load(db);
```
Remediation requires either bypassing this or patching sqlite-vec.

### node-llama-cpp
**Status**: UNSUPPORTED (requires runtime installation)

- Has platform-specific dynamic imports at build time
- `@node-llama-cpp/darwin-arm64`, `@node-llama-cpp/linux-x64`, etc.
- Bundler tries to resolve ALL platforms, not just current
- Must use `--external node-llama-cpp` to build
- At runtime: `Cannot find package 'node-llama-cpp' from '/$bunfs/root/gno-test'`

**Path forward**:
1. Keep as optional—runtime install when user enables local embeddings
2. API-based embeddings (OpenAI, Anthropic) as default—**not yet implemented, requires new work**

### Other Externals

These packages were externalized to allow compilation:
- **youtube-transcript**: Used by markitdown-ts for YouTube processing
- **unzipper**: Used by markitdown-ts for archive handling

Both are optional features in markitdown-ts. Externalized because bundler couldn't resolve their dynamic imports.

## Build Command

```bash
bun build --compile --minify src/index.ts --outfile gno-test \
  --external node-llama-cpp \
  --external youtube-transcript \
  --external unzipper
```

**Note**: `--external` means these packages must be resolvable at runtime. The binary is not fully standalone.

## Test Results

| Test | Result | Notes |
|------|--------|-------|
| Binary builds | PASS | 67MB arm64 Mach-O |
| --version (cold) | PASS | No node_modules needed |
| doctor (cold) | PARTIAL | sqlite-vec, node-llama-cpp fail |
| FTS5/JSON1 | PASS | Built into bun:sqlite |
| Vector search | FAIL | `Loadble extension...not found` |
| Local embeddings | FAIL | `Cannot find package 'node-llama-cpp'` |

"Cold" = node_modules moved away during test.

## Distribution Design Decision

### Tier A: npm-only (RECOMMENDED for now)
- `bunx gno` or `bun add -g gno`
- Requires Bun runtime installed
- All features work including local embeddings and vector search

### Tier B: Compiled + API embeddings (FUTURE)
- Ship compiled binary + sqlite-vec sidecar (162KB per platform)
- On macOS: also need Homebrew SQLite or bundled dylib
- Use API embeddings instead of local models
- **Note**: API provider integration not yet implemented—requires new code for OpenAI/Anthropic clients, auth, caching

### Tier C: Full standalone (COMPLEX, FUTURE)
- Compiled binary + sqlite-vec sidecar + SQLite sidecar (macOS)
- Runtime node-llama-cpp installation when user enables local embeddings
- Most complex, most features

## Recommendation

Start with **Tier A (npm-only)** for initial release:
- Simplest distribution, all features work
- Users install Bun once: `curl -fsSL https://bun.sh/install | bash`
- Then: `bun add -g gno`

Tier B/C are aspirational—require additional implementation work beyond this spike.

## Files Modified

None - this was a research spike.

## Next Steps

1. ~~Close this spike~~ Done
2. Proceed with npm publishing setup (gno-quw.4)
3. Gate Windows distribution on CI (gno-quw.11)
4. Consider Tier B later based on user demand (requires API provider implementation)
