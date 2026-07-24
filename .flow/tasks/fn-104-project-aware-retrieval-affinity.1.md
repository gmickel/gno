---
satisfies: [R1, R3, R5]
---
# fn-104-project-aware-retrieval-affinity.1 Build trusted project-root resolution and affinity metadata

## Description
Deliver build trusted project-root resolution and affinity metadata as one implementation-sized increment.

**Size:** M
**Files:** `src/core/project-affinity.ts`, `src/config/types.ts`, `src/core/validation.ts`, `test/core/project-affinity.test.ts`

### Approach
- Normalize CLI cwd/repository roots and explicit workspace roots using realpath/segment containment against configured collection roots.
- Define trusted CLI-local roots versus opaque remote caller hints; remote surfaces cannot probe arbitrary server paths or learn existence.
- Return redaction-safe matched collection/root identity plus zero-affinity reasons for deleted, unknown, overlapping, nested, symlink, and worktree cases.

### Investigation targets
**Required** (read before coding):
- `src/core/validation.ts`
- `src/config/types.ts:71-114`
- `src/config/paths.ts`
- `src/store/types.ts:67-130`

**Optional** (reference as needed):
- `src/core/user-dirs.ts`
- `test/core/validation.test.ts`

## Acceptance
- [ ] Symlink/worktree/nested/overlap/case/deleted-root fixtures resolve deterministically with segment-safe containment.
- [ ] Unknown/untrusted remote roots return zero affinity without filesystem existence disclosure.
- [ ] Public/remote metadata exposes stable collection/root aliases, never unrelated absolute paths.


## Done summary
Implemented trusted project-root resolution and redaction-safe affinity metadata.

- Added separate local and remote project-affinity schemas plus a required out-of-band resolver channel.
- Canonicalized trusted local roots and configured collection roots through injectable boundaries.
- Added segment-safe containment, nearest repository/worktree discovery, stable redacted aliases, deterministic overlap ordering, and explicit zero reasons.
- Remote resolution short-circuits before filesystem or collection probing, including forged local-source payloads.
- Added temporary-tree coverage for nested/prefix collisions, symlinks, worktrees, overlaps, case behavior, deleted roots, opaque hints, and forged remote trust escalation.
- Ranking behavior remains unchanged.
## Evidence
- Commits: f961917
- Tests: bun test test/core/project-affinity.test.ts (8 pass, 0 fail), bun run lint:check (clean), bun run typecheck (clean), git diff --check (clean), bun test (2868 pass, 1 Windows-only skip, 0 fail)
- PRs: