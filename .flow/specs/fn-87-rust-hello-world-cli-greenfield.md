# fn-87 Rust hello-world CLI (greenfield)

## Goal & Context

Learn or scaffold a minimal **Rust binary CLI** that prints a greeting to stdout. This is intentionally **outside** the GNO product surface: GNO remains a Bun/TypeScript CLI (`package.json` → `src/index.ts`). No replacement of `gno`, no MCP, no ingestion changes.

**Default placement:** standalone directory/repo (e.g. `~/projects/hello-rust-cli`). **Optional in-tree spike:** `examples/rust-hello-cli/` with local README only (tier A — no `docs/` sweep).

## Architecture & Data Models

Single **binary crate** layout from `cargo new <name> --bin`:

```
<crate>/
├── Cargo.toml    # package name, version, edition
├── src/main.rs   # fn main() → stdout
└── README.md     # rustup + cargo commands
```

No `lib.rs`, workspace, or CLI parser crate on v1. Optional future: `clap` when flags/subcommands are needed.

**Conceptual mirror from GNO (optional):** thin entry → runner with explicit exit codes (`src/index.ts` → `src/cli/run.ts`, `src/cli/errors.ts`) — not required for hello-world.

## API Contracts

**CLI interface (v1):**

| Invocation               | Behavior                           | Exit |
| ------------------------ | ---------------------------------- | ---- |
| `cargo run`              | Prints `Hello, world!\n` to stdout | 0    |
| `cargo run --release`    | Same, optimized binary             | 0    |
| `<binary>` (after build) | Same as `cargo run` default output | 0    |

No flags, env vars, or stdin contract in v1.

## Edge Cases & Constraints

- Use **`--bin`** (not `--lib`) so `src/main.rs` is the entry point.
- **Edition:** default `2024` from current `cargo new`; use `2021` only if `rustc` is older than 1.85.
- Do **not** add `clap`, `anyhow`, workspaces, or `[[bin]]` extras for v1.
- **gno repo:** do not register a Rust binary in root `package.json` `bin` map.
- **CI (gno in-tree only):** new optional job; must not block existing `bun test` unless explicitly promoted.
- Commit **`target/`** only by mistake — rely on Cargo `.gitignore`.

## Overview

Greenfield Rust hello-world binary: `cargo new --bin`, `println!` in `main`, README with toolchain steps, smoke-verify with `cargo run`. Standalone by default to avoid Bun/Rust CI coupling in `@gmickel/gno`.

## Quick commands

```bash
# Prerequisites (once)
rustup --version && cargo --version

# Scaffold (standalone example)
cargo new hello_rust_cli --bin
cd hello_rust_cli

# Smoke test
cargo run
# Expected stdout: Hello, world!

cargo build
cargo test   # default empty test passes
```

## Boundaries / non-goals

- Not shipping on npm or replacing `gno` CLI
- No `clap` / argument parsing / subcommands
- No integration with GNO index, MCP, or `spec/cli.md`
- No crates.io publish
- No changes to GNO `docs/`, root `README.md`, or CI (unless user explicitly chooses in-tree + CI task)
- No FFI, native embedding, or `node-llama-cpp` bridge

## Decision context

**Standalone (default) over in-tree:** GNO has zero `Cargo.toml`, Bun-only CI (`.github/workflows/publish.yml`), and agent docs are Bun-first (`CLAUDE.md`). A toy Rust binary adds toolchain and maintainer cost without advancing product epics (fn-76 Rust is ingestion-only).

**Stdlib-only over `clap`:** Hello-world has no args; `clap` adds compile time and API surface prematurely (rust-cli book defers parsers until needed).

**`println!` over `print!`:** Newline-terminated greeting matches conventional hello-world and test expectations.

## Acceptance Criteria

- **R1:** From a clean tree, `cargo run` exits 0 and stdout is exactly `Hello, world!\n` (or project-chosen greeting documented in README).
- **R2:** Crate is a binary package: `src/main.rs` exists; `cargo new` used `--bin` (or equivalent `[[bin]]` not required).
- **R3:** `README.md` documents rustup install (or link), `cargo build`, and `cargo run`.
- **R4:** Project does not modify GNO `package.json` `bin`, `src/cli/`, or publish artifacts.
- **R5:** `cargo test` passes (default empty test suite is fine).

## Early proof point

Task **fn-87-rust-hello-world-cli-greenfield.1** validates `cargo run` prints the greeting. If toolchain/edition fails, fix rustup/edition before README/CI work in task 2.

## Requirement coverage

| Req | Description             | Task(s)                                     | Gap justification |
| --- | ----------------------- | ------------------------------------------- | ----------------- |
| R1  | `cargo run` greeting    | fn-87-rust-hello-world-cli-greenfield.1     | —                 |
| R2  | Binary crate layout     | fn-87-rust-hello-world-cli-greenfield.1     | —                 |
| R3  | README toolchain docs   | fn-87-rust-hello-world-cli-greenfield.2     | —                 |
| R4  | No GNO product coupling | fn-87-rust-hello-world-cli-greenfield.1, .2 | —                 |
| R5  | `cargo test` passes     | fn-87-rust-hello-world-cli-greenfield.1     | —                 |

## References

- Rust install: https://www.rust-lang.org/tools/install
- TRPL Hello Cargo: https://doc.rust-lang.org/book/ch01-03-hello-cargo.html
- `cargo new`: https://doc.rust-lang.org/cargo/commands/cargo-new.html
- GNO CLI entry (contrast only): `src/index.ts`, `src/cli/run.ts`
- GNO CLI conventions: `src/cli/CLAUDE.md`, `spec/cli.md` (exit codes — not applicable to v1 Rust spike)
