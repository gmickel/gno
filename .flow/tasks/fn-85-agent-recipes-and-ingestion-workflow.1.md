---
satisfies: [R1, R2]
---

## Description

Make GNO skill recipe files shippable, discoverable, and path-safe before final recipe content lands. Decide and implement the stable file layout for recipe markdown, with a strong preference for nested `assets/skill/recipes/*.md` because that matches progressive-disclosure skill guidance. This task may create the `recipes/` directory and minimal placeholder recipe files only as packaging fixtures; task 2 owns final recipe content.

**Size:** M
**Files:** `src/cli/commands/skill/install.ts`, `src/cli/commands/skill/show.ts`, `src/cli/commands/skill/paths.ts` if target paths need verification, `test/cli/skill.test.ts`, `spec/cli.md`, `docs/CLI.md`, `assets/skill/README.md`, `assets/skill/recipes/*.md` placeholders only, `package.json` only if package/files behavior needs explicit adjustment.

## Approach

- Extend the existing skill asset copy/list/show behavior so recipe files are installed and previewable without changing the primary `gno --skill` behavior.
- Keep the command surface small: no `gno recipes` command in this task.
- Preserve atomic install semantics and existing safety checks.
- Build an allowlist of relative POSIX markdown paths under `assets/skill` for preview/discovery; reject absolute paths, `..`, and unsafe traversal.
- Copy skill directories without following unsafe symlinks or escaping the skill source tree.
- Treat Codex target path drift as an explicit verification point; confirm current desired install path before changing docs or path resolution.

## Investigation targets

**Required**

- `src/cli/commands/skill/install.ts:93-115` — current top-level source file copy behavior.
- `src/cli/commands/skill/show.ts:39-73` — current top-level markdown listing and `--file` validation.
- `test/cli/skill.test.ts:203-230` — install tests that should prove recipe files copy to targets.
- `test/cli/skill.test.ts:327-349` — `showSkill` tests that should prove `--all` and selected recipe preview.
- `spec/cli.md:1682-1714` — CLI contract for `gno skill show`.
- `package.json` — package `files` includes `assets`; verify nested recipe assets ship in tarballs.

**Optional**

- `docs/integrations/skills.md:19-28` — target path docs if install path behavior changes.
- `assets/skill/README.md:32-56` — skill install/show documentation.

## Key context

Repo research found nested recipes will not install or preview today. `install.ts` currently reads `readdir(sourceDir)` and writes each entry as a file, while `show.ts` filters top-level `.md` files only. If recipes remain nested, this task must make nested paths first-class for install/show and tests. The first plan review also flagged path traversal/symlink risk; path allowlisting and safe recursive copy are part of this task, not follow-up polish.

## Acceptance

- [ ] Minimal recipe placeholder files exist only as needed to prove packaging/discovery; final recipe content remains task 2.
- [ ] `gno skill install --target claude --scope project --force` and `--target codex --scope project --force` install recipe markdown files in the chosen layout.
- [ ] `gno skill show --all` includes recipe files in its output or file list.
- [ ] `gno skill show --file recipes/brain-first-lookup.md` works, or the task documents and tests the chosen equivalent layout.
- [ ] Unknown nested recipe paths fail with a validation error that lists available files.
- [ ] Absolute paths, `..`, and path traversal attempts are rejected for previewed files.
- [ ] Recursive copy/preview behavior does not follow unsafe symlinks or escape `assets/skill`.
- [ ] `bun test test/cli/skill.test.ts` covers install/show recipe behavior and path-safety cases.
- [ ] `npm pack --dry-run` or equivalent package evidence proves placeholder/early recipe files are included in the npm package surface; task 4 repeats final tarball proof after content lands.
- [ ] `spec/cli.md` and `docs/CLI.md` are updated only for actual skill show/install behavior changes.

## Done summary

Implemented recursive GNO skill asset packaging and preview support. `gno skill install` now copies nested recipe files with symlink refusal, and `gno skill show` recursively lists markdown files, previews `recipes/<name>.md`, and rejects unsafe file paths. Added initial recipe assets as package-visible fixtures and regression coverage.

## Evidence

- Commits:
- Tests: bun test test/cli/skill.test.ts, npm pack --dry-run
- PRs:
