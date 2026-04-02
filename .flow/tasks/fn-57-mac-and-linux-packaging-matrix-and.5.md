# fn-57-mac-and-linux-packaging-matrix-and.5 Prove linux-x64 desktop runtime and artifact path

## Description
Prove or reject the first Linux desktop beta target after the macOS path is defined.

The goal is not broad Linux support. The goal is one explicit proof target:
- `linux-x64`
- Ubuntu `22.04+`

Scope:
- build the packaged desktop shell/runtime on the chosen Linux baseline
- verify packaged runtime behavior (`gno doctor --json`, core indexing/search path, extension loading)
- confirm whether the current shell/runtime can produce a supportable Linux desktop artifact
- choose the first Linux artifact shape (portable unpacked bundle vs AppImage-style path) based on what actually works
- document exactly what remains experimental or unsupported
## Acceptance
- [ ] Linux desktop validation is run on an explicit `linux-x64` baseline.
- [ ] Packaged runtime proof covers `gno doctor`, indexing, search, `sqlite-vec`, and vendored `fts5-snowball` load.
- [ ] The first Linux desktop artifact recommendation is explicit.
- [ ] Unsupported Linux arches/distros are explicitly called out.
- [ ] Docs are updated to reflect whether Linux desktop remains experimental or graduates to beta.
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
