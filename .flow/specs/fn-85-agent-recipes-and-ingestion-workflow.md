# Agent recipes and ingestion workflow playbooks

## Overview

Ship GNO's second-brain value as reusable agent recipes: concise workflow files that teach Claude Code, Codex, OpenCode, OpenClaw, and similar agents how to search local context first, capture durable facts with provenance, and cite evidence without inventing integrations.

This plan builds on shipped capture/provenance, page-type presets, and typed graph diagnostics. It is not a native connector or autonomous background-agent project. The first implementation risk is packaging: `assets/skill/recipes/*.md` will not be useful unless `gno skill install` and `gno skill show` can copy/list/display nested recipe files safely.

Stakeholders:

- End users: clearer second-brain workflows from installed GNO skills and hosted docs.
- Developers: small CLI skill-management behavior change for nested skill assets, with specs/tests and path-safety checks.
- Operations/release: npm package/tarball proof, autoresearch skill eval, stale-surface audit, and hosted `gno.sh` docs/build.

## Quick commands

```bash
gno skill show --all
gno skill show --file recipes/brain-first-lookup.md
gno skill install --target codex --scope user --force
bun test test/cli/skill.test.ts
npm pack --dry-run
bun run docs:verify
bun run lint:check
bun test
cd ~/repos/autoresearch-gno-skill && uv run eval.py > run.log 2>&1
cd ~/work/gno.sh && bun run build
```

## Boundaries / non-goals

- No native Gmail, Calendar, Slack, webhook, or SaaS connector integration.
- No autonomous meeting/email/source fetcher, cron detector, minion runtime, or background propagation loop.
- No `gno recipes` runtime command unless a later spec explicitly chooses that surface.
- No MCP prompt/resource API for recipes in this spec; recipes are agent-side skill guidance.
- No copying gbrain text or code verbatim; use it only as workflow inspiration.

## Approach

1. Make skill recipe files shippable and discoverable.
   - Extend the existing skill install/show surface so nested recipe markdown can be copied, listed, and previewed by path.
   - Task 1 may create the `recipes/` directory and minimal placeholder recipe files only as packaging fixtures; task 2 owns final recipe content.
   - Use an allowlist of relative POSIX markdown paths under `assets/skill`; reject absolute paths, `..`, and unsafe symlink/path traversal behavior.
   - Update CLI spec/docs only for the skill-management behavior that actually ships.
   - Prove nested files survive install and early npm packaging, then repeat final package proof after recipe content lands.

2. Keep `assets/skill/SKILL.md` as a router.
   - Add a compact recipe resolver/routing table, not a full cookbook.
   - Route intent to recipe files with triggers, inputs, exact GNO commands, what to cite, what not to do, and final verification.
   - Keep detailed workflows in `assets/skill/recipes/*.md` for progressive disclosure.

3. Write seven task-shaped recipes.
   - `brain-first-lookup.md`
   - `capture-and-file.md`
   - `meeting-ingestion.md`
   - `email-context.md`
   - `source-summary.md`
   - `idea-capture.md`
   - `citation-and-provenance.md`

4. Publish docs parity in two phases.
   - Repo docs and legacy checked-in website surfaces explain recipes and second-brain workflows.
   - Hosted `~/work/gno.sh` gets the same user-facing workflow story in a separate task so source/build evidence is clear.

5. Verify agent behavior and stale/false surface safety.
   - Autoresearch GNO skill eval must run.
   - Before autoresearch iteration, seed the experiment skill from current `assets/skill/SKILL.md` so copying back cannot clobber the new router.
   - If score or behavior regresses, update the experiment skill, copy the winning skill back to `assets/skill/SKILL.md`, verify the router/recipe links remain, reinstall, and retest.
   - Audit recipes/docs for nonexistent commands, unsupported flags/targets, MCP tools/prompts, native connector claims, cron/background-agent claims, and stale runtime surfaces.

## Decision context

The current spec originally treated recipe files as mostly docs. Repo research found that `src/cli/commands/skill/install.ts:93-115` copies only top-level source files, and `src/cli/commands/skill/show.ts:39-73` lists only top-level markdown. Therefore the first task must harden skill asset packaging/discovery before final recipe content can be considered shippable.

The recipe content should reuse shipped GNO surfaces: capture source kinds from `src/core/capture.ts:27-35`, structured source frontmatter from `src/core/capture.ts:499-516`, capture planning/default paths from `src/core/capture.ts:627-646`, and page presets from `src/core/note-presets.ts:11-21` plus `src/core/note-presets.ts:132-155`. Existing skill guidance at `assets/skill/SKILL.md:207-261` already explains embedding-after-changes and capture receipt semantics; recipes should link to or reuse that behavior, not fork it.

The docs surface is broad but bounded: `docs/USE-CASES.md:66-96` and `docs/USE-CASES.md:181-207` already explain typed second-brain pages and meeting capture, while `docs/integrations/skills.md:36-57` explains skill usage. Hosted docs already have `skills` and `how-to` pages in `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx:1849-1955` and `/Users/gordon/work/gno.sh/src/lib/gno-docs.tsx:1958-2062`.

## Dependencies / related specs

- `fn-82-second-brain-capture-and-provenance`: hard prerequisite for `gno capture`, provenance receipts, MCP capture, and docs/skill parity.
- `fn-83-second-brain-page-types-and-synthesis`: hard prerequisite for preset/page-type recipe accuracy. Its tasks are done but the spec is still open; fn-85 may reference shipped behavior, but completion should not hide that fn-83 closure may still be pending.
- `fn-84-typed-graph-traversal-and-retrieval`: hard prerequisite for any graph query, relation lookup, backlinks, or query-diagnose recipe language.
- `fn-86-deferred-second-brain-maintenance-and`: likely downstream of fn-85; when fn-86 is planned, add fn-85 as a dependency before task breakdown.
- `fn-88-fix-evalite-eval-runner-ergonomics`: separate eval system; fn-85 must not depend on local Evalite release gates, only on the GNO skill autoresearch eval.

## Acceptance Criteria

- **R1:** Skill recipe files are packaged for all supported skill targets and included in the npm package/tarball surface.
- **R2:** `gno skill show` can list and preview recipe files, including nested `recipes/<name>.md` paths or an explicitly chosen equivalent file layout, while rejecting absolute paths, `..`, and unsafe symlink/path traversal cases.
- **R3:** `assets/skill/SKILL.md` stays concise and acts as a recipe router with clear triggers, inputs, command ladders, citation expectations, and exit conditions.
- **R4:** Recipes cover brain-first lookup, capture/file, meeting ingestion, email-context workflow, source summary, idea capture, and citation/provenance practice.
- **R5:** Recipes use only actual shipped GNO commands and clearly mark external email/calendar/chat/web sources as user-supplied, exported, optional, or out of scope.
- **R6:** Every write-flavored recipe includes provenance, prompt-injection handling, privacy boundaries, and post-write sync/index/embed/search verification.
- **R7:** Repo docs, skill docs, legacy checked-in website surfaces, and hosted `~/work/gno.sh` docs explain second-brain recipes without advertising nonexistent runtime commands or connectors.
- **R8:** Autoresearch GNO skill eval is rerun from a current-router seed; if score or behavior regresses, the winning skill text is copied back to `assets/skill/SKILL.md`, router links are verified, and the skill is reinstalled.
- **R9:** A stale/false surface audit finds no unqualified native Gmail/Calendar/Slack/webhook/cron/API/background-agent claims and no nonexistent GNO commands, flags, targets, MCP tools/prompts, or runtime surfaces in recipes or updated docs.
- **R10:** Plan/task evidence records the relationship to fn-83's shipped page-type behavior and does not imply fn-83 spec closure if it remains open.

## Early proof point

Task `fn-85-agent-recipes-and-ingestion-workflow.1` proves the core approach by making recipe files installable, previewable, package-visible, and path-safe. If nested recipe assets cannot be made reliable across supported skill targets, reconsider the file layout before writing the full recipe set.

## Requirement coverage

| Req | Description                                                                     | Task(s)                                                                                                                                  | Gap justification |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| R1  | Recipe files package/install for supported skill targets and npm tarball        | fn-85-agent-recipes-and-ingestion-workflow.1, fn-85-agent-recipes-and-ingestion-workflow.4                                               | —                 |
| R2  | Skill preview/listing can display recipes with path safety                      | fn-85-agent-recipes-and-ingestion-workflow.1                                                                                             | —                 |
| R3  | Concise `SKILL.md` recipe router                                                | fn-85-agent-recipes-and-ingestion-workflow.2                                                                                             | —                 |
| R4  | Seven recipe files cover required workflows                                     | fn-85-agent-recipes-and-ingestion-workflow.2                                                                                             | —                 |
| R5  | Recipes use shipped GNO commands and mark external sources correctly            | fn-85-agent-recipes-and-ingestion-workflow.2, fn-85-agent-recipes-and-ingestion-workflow.4                                               | —                 |
| R6  | Provenance, prompt-injection, privacy, and post-write verification guardrails   | fn-85-agent-recipes-and-ingestion-workflow.2, fn-85-agent-recipes-and-ingestion-workflow.4                                               | —                 |
| R7  | Repo docs, bundled skill docs, legacy website, and hosted `gno.sh` docs aligned | fn-85-agent-recipes-and-ingestion-workflow.2, fn-85-agent-recipes-and-ingestion-workflow.3, fn-85-agent-recipes-and-ingestion-workflow.5 | —                 |
| R8  | Autoresearch eval rerun from current-router seed and skill updated if needed    | fn-85-agent-recipes-and-ingestion-workflow.4                                                                                             | —                 |
| R9  | Stale/false surface audit passes                                                | fn-85-agent-recipes-and-ingestion-workflow.4                                                                                             | —                 |
| R10 | fn-83 relationship recorded without implying closure                            | fn-85-agent-recipes-and-ingestion-workflow.2, fn-85-agent-recipes-and-ingestion-workflow.3, fn-85-agent-recipes-and-ingestion-workflow.5 | —                 |
