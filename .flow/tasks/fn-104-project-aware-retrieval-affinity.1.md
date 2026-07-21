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
TBD

## Evidence
- Commits:
- Tests:
- PRs:
