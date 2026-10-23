---
satisfies: [R1, R2, R3, R4, R5]
---
# fn-228-profile-apply-keeps-collection-settings.1 Implement Profile apply keeps collection settings it does not own

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Profile apply now builds the collection entry from the existing entry and overlays only profile-owned fields (path, pattern, include, exclude; languageHint/models/recordAdapters when the profile sets them), so egressPolicy, egressPolicyRevision, sourceAvailability, workspaceRoot, memoryManaged, audit and updateCmd survive. A root move outside an explicit workspaceRoot fails with WORKSPACE_ROOT_CONFLICT (exit 1) before any config write. Docs: spec/cli.md, docs/guides/project-profiles.md, CHANGELOG.

Live QA (sealed sandbox, CLI): settings kept across re-apply (config sha unchanged) and across an exclude edit; remember accepted the collection (control without memoryManaged refused); root move refused with config unchanged and still loadable.

stage: impl-review - skipped(policy: repo CLAUDE.md skips review stages)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: cc949528a2b60256e97d2102e564c971aace1023
- Tests: bun test (6385 pass, 0 fail), bun run lint:check
- PRs: