---
title: Config hand-editor can't read config after a write — saved as single-line flow Y
date: "2026-10-23"
track: bug
category: ui
module: src/config/saver.ts
tags: [qa, fn-228-profile-apply-keeps-collection-settings, config]
problem_type: ui
symptoms: config index.yml rewritten as one-line flow-style YAML after gno profile apply
root_cause: (observed via live QA — unconfirmed)
resolution_type: fix
related_to: [bug/ui/phone-width-user-sees-the-dashboard-2026-10-07, bug/ui/publisher-cannot-finish-encrypted-2026-09-06]
---

## Problem
A user who edits their GNO config by hand ran `gno profile apply`. Afterwards the config file was saved as compact single-line flow-style YAML, which is hard to read or edit by hand.

## Steps to reproduce (cold)
1. Use an isolated GNO config (`GNO_CONFIG_DIR`) that has a block-style `index.yml` with one collection.
2. Run `gno profile apply <project>` in a project whose `.gno/index.yml` changes that collection (for example, a new `exclude` entry).
3. Read `<GNO_CONFIG_DIR>/index.yml`.

## Expected
The config stays readable YAML that a person can edit. The spec doesn't require this.

## Actual
The whole config is written on one line, `{version: "1.0",ftsTokenizer: ...,collections: [{name: notes,...}]}`. The values are correct, and the file still loads.

## Evidence
- console: .flow/tmp/qa-fn-228-profile-apply-keeps-collection-settings/s1-apply-scenarios.log (step 4)
- cause seen in source after capture: src/config/saver.ts:65 calls `Bun.YAML.stringify(config)` with no indent argument. This file is unchanged on this branch, so the problem predates it.

## Traceability
- R-IDs: none (pre-existing)   scenario: S1   driver_rung: CLI   viewport: n/a
