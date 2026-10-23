## Problem

`gno profile apply` builds the target collection's config entry from the profile, plus a fixed list of settings it carries over: `updateCmd`, `updateCmdTimeoutMs`, `languageHint`, `models`, `recordAdapters` and `audit`. Apply drops every other existing setting:

- `egressPolicy`: the collection falls back to `local_only`. That is stricter, but it undoes a choice the user made, without saying so.
- `egressPolicyRevision`: resets to 0, which breaks the monotonic revision token that the egress service and store sync rely on.
- `workspaceRoot`: link resolution changes without notice; an explicit root, or `false`, reverts to auto-detect.
- `sourceAvailability`: `local` reverts to `any`, so cloud placeholders may be materialized again.
- `memoryManaged`: `gno remember` starts refusing the collection.

Nothing records this as intended. The profile owns the name, root, include and exclude rules, languageHint, model preset and record adapters, and is documented as create/update-only. The carry-over list just never grew when new collection fields were added; fn-225 had to add `audit` by hand.

## Approach

Start the applied entry from the existing entry, then overlay only the fields the profile owns. Settings the profile does not own then survive by default, including fields added later. Profile-owned fields keep their current precedence: the profile's value wins, and `languageHint`, `models` and `recordAdapters` fall back to the existing value when the profile leaves them out.

Root repair edge case: when apply moves the collection root, an explicit `workspaceRoot` path can stop containing the new root. The config loader would then reject the saved config on its next load. Apply refuses before saving, with a message that names the collection and the setting. It neither writes a config that cannot load nor silently drops the setting.

## Requirements

- R1: Applying a profile to an existing collection keeps every collection setting the profile does not own. At minimum that is `egressPolicy`, `egressPolicyRevision`, `workspaceRoot` (including `false`), `sourceAvailability` and `memoryManaged`, plus the already-kept `updateCmd`, `updateCmdTimeoutMs` and `audit`.
- R2: Profile-owned fields behave as before. `path`, `pattern`, `include` and `exclude` come from the profile. `languageHint`, `models` and `recordAdapters` use the profile's value when it sets one, otherwise the existing value.
- R3: Re-applying an unchanged profile to a collection that carries these settings reports the collection as `reused` and does not rewrite the config.
- R4: When the applied root falls outside an explicit `workspaceRoot`, apply fails before writing any config, with an error naming the collection and `workspaceRoot`. The config file is unchanged.
- R5: Creating a new collection from a profile is unchanged.

## Boundaries

- No new profile schema fields. Profiles still cannot set egress, source availability, memory or workspace settings.
- No change to diff or plan output.

## Acceptance

- Unit tests for R1, R2 and R5 in `test/core/project-profile-apply-state.test.ts`. R3 and R4 are tested through `applyProjectProfile` in `test/core/project-profile-apply.test.ts`.
- Live check in an isolated config: give a collection all five settings, run `gno profile apply` through the CLI, and compare the config file before and after. The root-move case must be refused with the config unchanged.
- A CHANGELOG entry under Fixed.
