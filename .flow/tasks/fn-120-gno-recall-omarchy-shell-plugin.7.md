---
satisfies: [R8]
---
# fn-120-gno-recall-omarchy-shell-plugin.7 Gate marketplace publish on released gno and the 14-state matrix

## Description
Manual publish gate (R8). Do not start until a released gno that contains fn-119 is the floor recorded in README/manifest, and the full 14-state evidence matrix has been driven on a live Omarchy session. This task is last, never CI-automated, and blocked by unresolved P0/P1 findings unless the user waives a named finding.

**Size:** M
**Files:** README.md; manifest.json (version + documented gno floor); marketplace submission artifacts (issue body / evidence index)
**Touches:** README.md; manifest.json

### Approach
- Record the released gno version (the one that shipped fn-119.1 peek + fn-119.2 deep-link/source.absPath) as the plugin floor in README and manifest/settings copy. Re-run discovery/version-skew against that released binary, not a local gno checkout.
- Drive the named R8 matrix on the live session, one evidence artifact per state: healthy glyph; backlog badge; stale cache; gno-missing; uninitialized; empty-but-initialized; serve-down open-in-UI; search empty; search timeout; open-file failure; keybind conflict; theme switch; shell restart; keyboard-only flow. Screenshots / real JSON / observed IPC — no source reading as verdict.
- Unresolved P0/P1 ⇒ stop. A waiver is an explicit user decision naming the finding.
- Marketplace is https://omarchyplugins.com/publish.html: public GitHub repo, root manifest.json that still passes omarchy plugin validate, README + license, then the site's issue form (automated validation of the current commit, maintainer approval). Do not add a CI publish workflow. Confirm parked display name with the user one last time before submit.
- After listing, verify a clean machine-style install: omarchy plugin add <public-url> --enable against released gno.

### Investigation targets
**Required**: /home/gordon/work/gno/.flow/specs/fn-120-gno-recall-omarchy-shell-plugin.md; /home/gordon/work/gno/.flow/specs/fn-119-gno-peek-command-desktop-integration.md; /usr/share/omarchy/bin/omarchy-plugin-validate; /usr/share/omarchy/shell/README.md
**Optional**: https://omarchyplugins.com/publish.html; /home/gordon/.config/omarchy/plugins/robzolkos.github/README.md

### Key context
Publishing against an unreleased local gno is out of spec even if the plugin looks done. The installer clones; the git URL must be the public repo, not $PWD.

## Acceptance
- [ ] README/manifest record a released gno version that includes fn-119 contracts as the floor; live plugin QA in this task used that released binary, not a local build.
- [ ] Full R8 14-state matrix driven on a live Omarchy session with captured evidence per state (healthy glyph, backlog badge, stale cache, gno-missing, uninitialized, empty-but-initialized, serve-down open-in-UI, search empty, search timeout, open-file failure, keybind conflict, theme switch, shell restart, keyboard-only flow).
- [ ] No unresolved P0/P1, or the user recorded an explicit waiver naming each waived finding.
- [ ] Marketplace submission completed manually via omarchyplugins.com (public repo + validate-clean manifest + README/license); no CI publish job.
- [ ] Post-submit check: omarchy plugin add <public-url> installs and the widget/overlay still load against released gno.

## Done summary
Marketplace publish completed: GNO Recall listed on omacom/omarchy-plugin-marketplace (issue #3590, closed 2026-09-15, labels listed + approved-and-verified). Plugin repo commit 4b261f7 links the listing.

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits:
- Tests:
- PRs: