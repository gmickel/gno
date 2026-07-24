---
title: Project-Local Retrieval Profiles
description: Reproduce a GNO collection from a safe, source-controlled .gno/index.yml without committing runtime state.
keywords: gno project profile, local rag config, reproducible retrieval, .gno index
---

# Project-Local Retrieval Profiles

A project profile declares portable retrieval intent in `.gno/index.yml`.
Commit the profile; keep the user config, database, model cache, locks, receipts,
and indexed content outside the repository.

## Inspect Before Applying

From anywhere inside the repository or worktree:

```bash
gno profile check
gno profile show
gno profile diff
```

`check`, `show`, and `diff` are read-only. Discovery walks upward to the first
Git boundary and chooses the nearest profile. A nested monorepo profile shadows
an ancestor; profiles are never merged. A worktree `.git` file is a repository
boundary. Use an exact directory or `.gno/index.yml` path to disable upward
fallback:

```bash
gno profile check /path/to/repository
```

Remote SDK, REST, MCP, and Web inputs cannot trigger profile discovery.

## Example

```yaml
schemaVersion: "1.0"
collection:
  name: project-docs
  root: docs
  include:
    - "**/*.md"
    - "**/*.pdf"
  exclude:
    - generated
  languageHint: en
  modelPreset: slim-tuned
contexts:
  - file: AGENTS.md
  - text: Prefer primary project decisions.
contentTypes:
  people:
    prefixes: [people]
    preset: person
    graphHints: [works_at, mentions]
affinityDefaults:
  enabled: true
  contribution: 0.02
recommendedCapabilities:
  - workspace.read
```

All paths are repository-relative and portable across POSIX and Windows.
Absolute paths, traversal, environment expansion, runtime database/model/lock
paths, secret fields, arbitrary hooks, and symlink escapes fail validation.
Windows-reserved names, trailing dots/spaces, unbalanced or negated globs, and
likely secret context paths such as `.env`, private keys, and credentials also
fail validation, including when a safe-looking context symlink resolves to a
secret filename inside the repository. Context files must be regular UTF-8
files no larger than 64 KiB; `.gno/index.yml` is bounded at 1 MiB. `.gno` is
always excluded from the declared collection.

`contentTypes` is keyed by content type ID. Map keys make IDs structurally
unique in both the YAML contract and runtime validation.

Profile excludes are real Bun globs when they contain glob metacharacters;
plain components retain directory-component matching. Multiple include globs,
including brace alternatives and literal commas, are combined without changing
their meaning.

## Apply and Prove Retrieval

Apply without indexing:

```bash
gno profile apply
```

Apply and then run verified lexical setup in one explicit operation:

```bash
gno setup . --apply-profile
```

Plain `gno setup` detects a nearby profile before changing local state and
prints preview/apply guidance. It does not apply the profile implicitly.
`--apply-profile` uses the same cross-process lock-safe, create/update-only
apply path as `gno profile apply`, then indexes the profile-declared collection
root and name. This remains true when setup starts in a nested subdirectory.
It cannot be combined with explicit `--name` or `--exclude` overrides; remove
those options or run setup without `--apply-profile`.

Invalid or absent profiles never make profiles mandatory: ordinary folder setup
continues. With `--apply-profile --json`, `status: completed_with_actions`,
`profile.check`, and `profile.apply: null` report that the requested optional
action did not run.

Apply additively projects its declared collection and contexts into the store.
It never deletes unrelated DB-only collections, documents, contexts, omitted
content types, or index state. Multiple context entries for one collection are
preserved. Changed collections appear in `pendingIndexing`; repeat apply
converges to `unchanged`.

## Affinity Precedence

Local retrieval uses one deterministic order:

1. Repeatable explicit `--project-root` values.
2. The nearest valid compiled project profile.
3. The user config `projectAffinity` default with trusted cwd discovery.

`--no-project-affinity` disables all three. A profile's `affinityDefaults` are
request-local and do not overwrite the user default, so project A cannot change
ranking behavior for project B or for a directory with no profile. Explain and
diagnose identify profile-derived affinity as `project_profile`.

Remote `projectHints` remain opaque and zero-effect. Source metadata, contexts,
content types, and indexed document fields never become project identity; only
explicit trusted roots or the canonical locally discovered profile root can do
so.

## Runtime-State Boundary

The repository contains only declarative inputs such as:

```text
.gno/index.yml
AGENTS.md
docs/
```

Machine-local state stays under the configured user directories:

```text
<configDir>/index.yml
<dataDir>/indexes/
<dataDir>/project-profiles/apply-receipt.json
<cacheDir>/models/
```

Profile apply fails before mutation if config, database, data, cache, receipt,
lock, or file-backed selected model paths overlap the project root. GNO user
config writers share one canonical target-derived lock, including existing and
dangling symlink aliases, so CLI setup/init/collection/context/model changes,
profile apply, MCP, and resident Web mutations cannot overwrite each other.
Host application config files edited by MCP install/uninstall are separate
targets. Read-only profile commands never repair or mutate model-cache metadata.
Never commit generated databases, models, cache files, locks, receipts, or
credentials.
