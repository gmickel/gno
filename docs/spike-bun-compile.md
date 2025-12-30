# Spike: bun build --compile with Native Dependencies

**Date**: 2025-12-30
**Issue**: gno-quw.1
**Status**: Complete

## Summary

`bun build --compile` can produce a working 67MB standalone binary, but native dependencies have limitations.

## Findings by Dependency

### bun:sqlite (Built-in)
**Status**: BUNDLED

- FTS5 and JSON1 extensions work out of the box
- No special handling required
- Tested: `./gno-test doctor` confirms both available

### sqlite-vec
**Status**: SIDECAR REQUIRED

- Cannot bundle `.dylib/.so/.dll` into executable
- npm package uses `import.meta.url` for extension lookup
- Compiled binary's `import.meta.url` → bunfs virtual path
- Extension file not found even with node_modules present

**Path forward**:
1. Ship `vec0.{dylib|so|dll}` alongside binary (162KB per platform)
2. Modify loader to look in:
   - Same directory as binary
   - XDG data directory (`~/.local/share/gno/`)
   - System paths
3. Or: runtime download on first use

### node-llama-cpp
**Status**: UNSUPPORTED

- Has platform-specific dynamic imports at build time
- `@node-llama-cpp/darwin-arm64`, `@node-llama-cpp/linux-x64`, etc.
- Bundler tries to resolve ALL platforms, not just current
- Must use `--external node-llama-cpp` to build
- At runtime: "Cannot find package 'node-llama-cpp'"

**Path forward**:
1. Keep as optional dependency
2. Runtime installation: `bun add node-llama-cpp` when user enables local embeddings
3. Or: use API-based embeddings by default (OpenAI, Anthropic)

## Build Command

```bash
bun build --compile --minify src/index.ts --outfile gno \
  --external node-llama-cpp \
  --external youtube-transcript \
  --external unzipper
```

## Test Results

| Test | Result |
|------|--------|
| Binary builds | PASS (67MB arm64) |
| --version (cold) | PASS |
| doctor (cold) | PARTIAL - sqlite-vec and node-llama-cpp fail |
| FTS5/JSON1 | PASS |
| Vector search | FAIL - extension not found |
| Local embeddings | FAIL - package not found |

## Distribution Design Decision

### Tier A: npm-only (RECOMMENDED for now)
- `bunx gno` or `bun add -g gno`
- Requires Bun runtime installed
- All features work

### Tier B: Standalone + API embeddings
- Ship compiled binary
- sqlite-vec as sidecar (162KB per platform)
- Use API embeddings (no local model support)
- Good for users who don't want to install Bun

### Tier C: Full standalone (COMPLEX)
- Compiled binary + sqlite-vec sidecar
- Runtime node-llama-cpp installation when needed
- Most complex, most features

## Recommendation

Start with **Tier A (npm-only)** for initial release:
- Simplest distribution
- All features work
- Users install Bun once: `curl -fsSL https://bun.sh/install | bash`
- Then: `bun add -g gno`

Add Tier B later for users who want a single binary without Node/Bun runtime.

## Files Modified

None - this was a research spike.

## Next Steps

1. Close this spike
2. Proceed with npm publishing setup (gno-quw.4)
3. Gate Windows distribution on CI (gno-quw.11)
4. Consider Tier B later based on user demand
