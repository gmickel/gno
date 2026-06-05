---
satisfies: [R1, R2, R4, R5]
---

## Description

Create the Rust binary crate (standalone directory or `examples/rust-hello-cli/` if user chose in-tree) and prove the default program runs.

**Size:** S  
**Files:** `Cargo.toml`, `src/main.rs`, `.gitignore` (from cargo)

## Approach

- Run `cargo new <crate_name> --bin` (use snake_case crate name, e.g. `hello_rust_cli`).
- Keep `Cargo.toml` minimal: package metadata + edition only; empty `[dependencies]`.
- Implement `fn main()` with `println!("Hello, world!");` (stdlib only).
- Confirm `cargo run` and `cargo test` succeed locally.
- If in-tree under gno: place under `examples/rust-hello-cli/`; do not touch `package.json` or `src/cli/`.

## Investigation targets

**Required:**

- `package.json` L25-27 — confirm `gno` bin stays Bun-only (do not add Rust bin)
- `src/index.ts` L1-10 — contrast: thin entry pattern only

**Optional:**

- `src/cli/errors.ts` L2-4 — exit code conventions for future CLI hardening

## Acceptance

- [ ] `cargo new ... --bin` layout present with `src/main.rs`
- [ ] `cargo run` exits 0; stdout contains `Hello, world!`
- [ ] `cargo test` passes
- [ ] No edits to GNO `package.json` `bin`, `src/cli/`, or npm publish paths

## Done summary

_(pending)_

## Evidence

_(pending)_
