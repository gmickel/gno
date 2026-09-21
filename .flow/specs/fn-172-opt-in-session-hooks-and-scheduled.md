# Opt-in session hooks and scheduled ingestion

## Goal & Context

<!-- scope: business; source: paraphrase -->

Let users explicitly enable automatic processing of their selected agent sessions after manual ingestion works. Offer independently configurable hooks and schedules while keeping the installed default entirely manual. A user must be able to see what runs, for which sources and archive destination, when it last worked, and how to pause or remove it. Automation preserves the manual importer's dedicated archive and default exclusion from broad search; enabling a trigger cannot opt archived dialogue into general retrieval or managed-memory recall.

Depends on `fn-171-native-agent-session-ingestion` for native session ingestion. Automatic processing means incremental sanitization, archival and indexing through that importer. It does not authorize autonomous fact extraction, synthesis, account access or external model calls.

## Architecture & Data Models

<!-- scope: technical; source: inferred -->

Persist an owner-controlled automation profile with source IDs, destination archive root/index/collection and privacy mapping, enabled triggers, schedule/timezone, bounded work budget, retry policy and last-run state. Reuse the resident lifecycle, shared write lease and importer checkpoints. Hook events and scheduled ticks enqueue the same deduplicated job; do not implement separate parsers or an independent memory database.

Hooks finish within a documented short deadline. If work cannot complete safely, acknowledge only durable admission or report a skipped/failed trigger. Heavy import/embedding happens outside the foreground agent turn. A pre-compaction trigger may capture the available source position durably when supported; it cannot claim the unseen tail is archived. Verify actual hook capabilities per harness and ship only supported registrations. Unsupported hosts retain manual and scheduled operation with explicit status.

Coalescing sketch, internal only:

```ts
type Work = { running: boolean; rerun: boolean };
function onTrigger(work: Work): "start" | "coalesced" {
  if (work.running) {
    work.rerun = true;
    return "coalesced";
  }
  work.running = true;
  return "start";
}
function onSettled(work: Work): "start" | "idle" {
  if (work.rerun) {
    work.rerun = false;
    return "start";
  }
  work.running = false;
  return "idle";
}
```

This illustrates duplicate-trigger behavior only. Durable job identity, restart recovery, cancellation and checkpoints use the resident/importer contracts; the in-memory sketch is not durable admission.

## API Contracts

<!-- scope: technical; source: inferred -->

Extend the sessions command family with automation configuration, preview, enable/disable, run-now and status operations. Enabling hooks or scheduling requires an explicit local action for the selected profile. A stored disabled profile, upgrade, setup repair or restart cannot enable itself. Installation edits only owned configuration entries and preserves existing user hooks/services. Use absolute launchers bound to the selected index; ambient project configuration must not redirect work.

Scheduled processing uses explicit timezone semantics, reports next due time, and coalesces missed runs after sleep/restart rather than creating unbounded catch-up work. Enabling a schedule must identify whether it requires a resident process or installs an owned platform service; no hidden promise to run while nothing is alive. Plan and status show this prerequisite before activation. Do not create Todoist tasks or reminders for machine maintenance jobs.

| Surface    | Required scope                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI        | Preview and explicitly manage profile triggers/schedule, run now, inspect last success/partial/failure and next due, pause and remove owned integration.                        |
| MCP        | Read bounded automation status and request an allowed run for registered sources; installing host hooks/services or widening source access stays local-owner-only.              |
| SDK / REST | Reuse automation admission/status services. Authenticated local management follows existing write protections; remote requests cannot enable machine integrations.              |
| Web UI     | Show manual/off by default, separate hook/schedule switches, source/destination preview, schedule timezone, pending/running/partial/failure, last success, pause and uninstall. |
| Skills     | Explain manual versus enabled operation, host capability limits, safe repair, status checks and retries; never install automation merely because a skill is installed.          |
| Git docs   | Extend sessions/configuration/resident/troubleshooting and harness setup docs with ownership, schedule lifetime, opt-in, retry/backoff, disable/remove and recovery recipes.    |
| gno.sh     | Mirror automation guide, support matrix, install/feature/FAQ defaults and privacy language; describe actual supported platforms and generated agent-readable references.        |

## Edge Cases & Constraints

<!-- scope: technical; source: inferred -->

Handle concurrent hooks/ticks, scheduler restart, DST/timezone changes, computer sleep, source absence, destination removal, source permission revocation, disk-full admission, stale process IDs and shutdown. Bound backlog and retries; use backoff for contention and transient failures. Invalid formats or revoked access require correction rather than infinite retries. Recheck current profile authority immediately before work; a queued job cannot resurrect disabled access.

Disable stops future admission and prevents queued jobs starting; show any in-flight work and its bounded cancellation/drain result. Removal touches only entries this integration owns, never foreign hooks or jobs. Changes to roots/destination/schedule are validated and previewable; privacy-domain mappings and broad-search inclusion remain explicit owner settings, never inferred from a hook payload; source expansion requires explicit reconfiguration. No transcript content or credentials in job names, environment dumps, notifications or status metadata.

## Acceptance Criteria

<!-- scope: both -->

- **R1:** [paraphrase] Manual ingestion remains the default across install, upgrade, repair and restart; hooks and schedules require separate explicit activation on a selected profile. Errors: malformed profiles and unsupported integrations fail without creating services or widening selected sources.
- **R2:** [inferred] Verify each shipped hook against a supported harness version and bound foreground latency; unsupported triggers are named as unsupported. Errors: unavailable importer/resident, admission failure and deadline expiry cannot report successful archival.
- **R3:** [paraphrase] Enabled schedules run incremental imports with explicit timezone, runtime prerequisites and visible next-run state. Errors: DST, sleep and missed ticks produce bounded catch-up, not duplicate archives or unbounded queues.
- **R4:** [inferred] All triggers share deduplicated, bounded, restart-safe admission and importer checkpoints. Errors: duplicate events, concurrent schedules, cancellation and process death preserve pending work or report an explicit nonaccepted outcome; no accepted job silently disappears.
- **R5:** [paraphrase] Pause/disable/remove behave predictably and preserve user-owned integrations and archived conversations. Errors: revoked scopes block queued execution; running work is shown until drained/cancelled; foreign configuration cannot be deleted.
- **R6:** [inferred] Run deterministic fake-clock and crash/restart scenarios plus a bounded real supported-hook and scheduler smoke. Feed manual, hook and scheduled imports the same fixtures and require identical sanitized archive identities, content and retrieval outcomes. Errors: timeouts or absent live harnesses remain unverified; replay never duplicates turns or changes provenance.
- **R7:** [paraphrase] All relevant surfaces show enabled state, selected sources, ownership, pending/running/partial/failure, last successful completion and recovery action. Errors: zero imported records, stale heartbeats and failed runs cannot appear as healthy completion; logs remain content-free.

**Documentation and delivery obligations.** [paraphrase] Complete the topic-specific documentation work listed in the surface matrix as part of this feature, across the two canonical documentation surfaces: repository Markdown rendered by Git hosting, and `gno.sh`. Update affected README capability/setup examples, changelog, user guides, CLI/MCP/API/configuration reference, architecture explanation, interface specs and structured-output schemas. Keep examples executable and distinguish defaults, opt-ins, unsupported cases and recovery behavior. Update the shipped GNO skill and relevant reference files, connector/harness instructions, and installed-skill verification. Do not create a third documentation site or update the retired in-repository website pages.

For `gno.sh`, update the matching docs/reference pages, relevant product/feature and install pages, FAQs and any affected comparison claims. Register new docs in navigation and prerender/sitemap routes. Verify the HTML and its generated Markdown twin, `/llms.txt`, `/llms-full.txt`, and alternate-format links agree; do not maintain divergent copies. Preserve local-only privacy promises and accurately state any new writes or background behavior. Keep internal eval fixtures, raw diagnostics and design notes out of public user documentation; public docs explain supported behavior and reproducible limits.

**Verification and delivery gates.** [inferred] Run focused regression and schema tests, then `bun run lint:check`, `bun test`, `bun run docs:verify` and documentation/public-truth checks appropriate to the changed scope. Run the topic-specific evals specified in the acceptance criteria; freeze models, fixtures, settings and thresholds before comparing arms, retain negative results, and never lower a threshold to pass. Where CLI/MCP behavior or shipped skill instructions change, run the GNO skill autoresearch eval, reconcile the shipped skill/reference sources and verify installation. Exercise changed CLI/MCP/REST/SDK behavior through actual invocations; drive changed Web UI flows with screenshots/responses, including keyboard and mobile behavior. A build or source inspection is not live QA.

For the hosted site run `bun run check`, `bun run typecheck`, `bun run build` and affected tests, then drive the changed pages locally, including navigation, copy buttons, Markdown twins and narrow width. Keep the GNO and hosted-site changes linked for coordinated delivery. When deployment is authorized, deploy from the canonical site repository and verify production HTTP response, service health, deployed revision, and the changed live pages. Do not claim production verification before deployment. Product publication follows the separately authorized release workflow. Record applicable gates and evidence in the spec completion record, including any blocked external delivery.

## Boundaries

<!-- scope: business -->

- [paraphrase] No enabled-by-default automation, automatic memory-fact promotion, task/reminder creation, account sync or autonomous synthesis.
- [inferred] No new general-purpose workflow engine, remote service installer, daemon replacement or automatic instruction-file rewriting.

## Decision Context

<!-- scope: both -->

- [inferred] Automation depends on the manual importer so parsing, privacy and retry semantics have one implementation. It can ship later without delaying useful manual imports.
- [inferred] Hooks provide prompt session-boundary triggers and schedules provide catch-up; both are optional and share the same profile and durable job semantics.
- [inferred] A format/hook change requires re-verification of the affected harness, not a blanket claim of support across every agent.
