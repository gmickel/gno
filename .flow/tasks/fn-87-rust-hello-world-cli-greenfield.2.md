---
satisfies: [R3, R4]
---

## Description

Document how to install Rust, build, and run the hello CLI. Optional: note in-tree vs standalone placement decided in task 1.

**Size:** S  
**Files:** `README.md` (crate root); optional `.github/workflows/rust.yml` only if user explicitly requested CI (out of default scope)

## Approach

- README sections: Prerequisites (rustup link), Quick start (`cargo run`), Build (`cargo build`), Test (`cargo test`).
- If standalone repo: include MIT license file matching intent.
- If in-tree `examples/rust-hello-cli/`: README is self-contained; no root `README.md` change unless user asks.
- Do not update GNO `docs/CLI.md` or `CHANGELOG.md`.

## Investigation targets

**Required:**

- `CONTRIBUTING.md` L1-5 — gno contribution entry points (contrast: this crate is separate)

**Optional:**

- `.github/workflows/publish.yml` L27-61 — Bun CI pattern (only if adding optional Rust CI job)

## Acceptance

- [ ] `README.md` exists at crate root with rustup + `cargo run` instructions
- [ ] README states project is non-shipping / not part of `gno` npm package
- [ ] No mandatory changes to GNO `docs/` or root `README.md`

## Done summary

_(pending)_

## Evidence

_(pending)_
