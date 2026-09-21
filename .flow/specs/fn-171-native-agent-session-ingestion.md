# Native agent-session ingestion

## Goal & Context

<!-- scope: business; source: paraphrase -->

Make selected local agent conversations searchable with notes and documents, preserving who said what, when, and where. Users can recover decisions and explanations from previous sessions without manual conversion. Import is explicitly manual by default. Imported dialogue is source evidence, not an assertion that an assistant suggestion is true or that an option discussed became a decision.

Extend the shipped file/export adapter system from fn-110. Native session support initially covers Codex JSONL, Claude Code JSONL, OpenClaw session files and Hermes session storage, with dated format fixtures and honest supported-version notes. Consumer chat exports continue through existing generic adapters where supported; adding account connectors is outside this scope. `fn-172-opt-in-session-hooks-and-scheduled` owns optional hooks and scheduled runs.

The recommended destination is a dedicated session archive outside the curated vault, with an explicitly configurable destination for users who prefer an archive area inside their vault. Treat placement as a user-visible setting rather than a required vault layout. Separate collections by privacy/domain boundary and optionally project; retain harness and source-project identity as metadata so one project remains searchable across agents. Do not create a separate knowledge Space per harness by default or restructure an existing vault.

## Architecture & Data Models

<!-- scope: technical; source: inferred -->

Use one ingestion service with adapters for native session formats and the existing canonical record/index pipeline. Session identity combines harness, source namespace and the harness's actual conversation/thread identity. Forks and subagent threads remain distinct even when they share a root session. Preserve timestamps, role, project context and exact safe source locators; logical turn IDs stay stable across appends and re-imports. Version adapter fingerprints and redaction policy so a changed parser or sanitization policy forces the necessary reprocessing.

Read source files without modifying them. For live database-backed history, acquire a coherent read-only snapshot using supported backup/WAL-aware semantics; copying only the main database file while a writer runs is not sufficient. Keep any temporary raw snapshot private, outside repos and indexable roots, and clean it up after bounded processing. Archive canonical sanitized dialogue in a dedicated user-selected collection; raw runtime directories never become a broad ordinary collection by accident. Sanitized archive files are durable user data, separate from the disposable SQLite/vector index and temporary raw snapshots. Include explicit archive backup/export and reconstruction guidance; index cleanup, uninstall or source-log rotation must not silently erase the archive.

Structural parsing sketch, internal only:

```ts
type TurnClass = "human" | "assistant" | "skip";
function classifyTurn(
  eventKind: string,
  payloadKind: string,
  role: string | undefined
): TurnClass {
  if (eventKind === "event_msg" && payloadKind === "user_message")
    return "human";
  if (
    eventKind === "response_item" &&
    payloadKind === "message" &&
    role === "assistant"
  )
    return "assistant";
  return "skip";
}
```

Each adapter supplies its own verified mapping. Injected instruction/context records are never inferred to be human speech merely because a record says `role=user`. Unknown records produce bounded drift diagnostics; role forgery inside message text remains ordinary quoted content. Tool payloads and reasoning are excluded by default; do not silently reinterpret this omission as a complete execution audit.

## API Contracts

<!-- scope: technical; source: inferred -->

Session-archive collections are excluded from unscoped general search/query/ask/context and unsolicited graph/similarity expansion by default. Explicit collection selection or the dedicated session-search surface includes authorized archives through the ordinary retrieval pipeline. Direct get of a selected session reference remains explicit retrieval. Existing non-archive collections retain their default behavior. The owner can opt a session collection into broad search, but neither that preference nor a harness label grants access across privacy boundaries. Archive records do not enter managed-memory recall or become remembered facts without an explicit promotion workflow.

Introduce a coherent `gno sessions` command family for discovery/status and manual import. No arguments or a discovery action previews supported local sources without importing. Import requires selected paths or an explicitly selected source profile and destination collection; support dry-run, format override, bounded limits, incremental rerun and JSON receipts. Exact flags, error codes and schemas are specified in the interface contracts before implementation and remain shared across surfaces.

Import receipts distinguish imported, unchanged, updated, skipped-policy, unsupported, incomplete and failed work, plus lexical readiness and embedding backlog. Do not call a partial import complete or advance a source checkpoint beyond unread/failed data. Reruns heal interrupted writes without duplicating sessions or turns. Removing a source file alone does not authorize deleting the retained archive; explicit pruning previews its affected records.

| Surface    | Required scope                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI        | Discover, preview, import selected sources, inspect status and retry incomplete work; paths/profile/index/collection are explicit and JSON is machine-readable.                                                                                                                                                                 |
| MCP        | Bounded status and import tools reuse the core service; writes retain opt-in. Remote clients cannot discover host home directories or name arbitrary paths; import is limited to owner-registered sources and caller scope. Keep the core tool profile small.                                                                   |
| SDK / REST | Shared typed service/result contracts; reject malformed selections and unauthorized roots before reads or writes. REST uses configured source IDs rather than unchecked host paths.                                                                                                                                             |
| Web UI     | Select/configure permitted sources and an archive destination, preview redaction/collection policy, manually import, inspect partial outcomes, and use a dedicated session-search view with project/harness filters. Label human/assistant authorship and archive inclusion in general searches visibly.                        |
| Skills     | Teach discovery then explicit import, safe archive placement, opt-in session search, scope selection, incremental retries and session-source citation. Explain how to find a past decision even though broad search omits archives. Distinguish session evidence from remember/recall facts and avoid automatic fact promotion. |
| Git docs   | Add a session ingestion guide and support matrix; update CLI/MCP/API/SDK/configuration/Web UI, privacy, source adapters, memory distinctions, archive placement/search inclusion, backup/retention, README and changelog.                                                                                                       |
| gno.sh     | Add matching sessions docs and navigation, local-agent setup references, feature/FAQ explanations of manual defaults, archive versus curated vault, opt-in search inclusion, supported formats, exclusions, provenance, backup and retention.                                                                                   |

## Edge Cases & Constraints

<!-- scope: technical; source: inferred -->

Bound file/record/session sizes and processing memory; stream where possible. Handle truncated final lines, growing files, invalid JSON, duplicate events, missing timestamps, timestamp disorder, session forks, renamed roots, format drift and inaccessible sources explicitly. Source-root identity uses canonical paths with symlink containment; runtime state, credentials and generated archive paths are excluded to prevent recursive ingestion.

Sanitize secrets before persistent archive/index/cache/diagnostic writes, including titles, authors and metadata. Use bounded format-based and configurable exact-pattern detection with adversarial long-line tests. Report residual limitations; sanitization is not a promise to detect every secret or PII. Preserve the untouched original outside the archive. Scope/privacy policy applies to all search/get/answer/Capsule and remote access paths, including source-locator metadata. A mixed-domain session cannot be automatically assigned to a less restricted collection from its working directory alone; require the configured owner-approved mapping or quarantine the ambiguous import. Redaction/parser reprocessing reconciles superseded archive records, index chunks and retained derivatives so corrected content does not leave an older searchable copy.

## Acceptance Criteria

<!-- scope: both -->

- **R1:** [paraphrase] A fresh installation performs no session import, watching, hook registration or scheduling. Users can discover and manually import selected sources into an explicit collection. Errors: missing selection/destination, inaccessible roots and unsupported formats return actionable outcomes without broadening scope.
- **R2:** [inferred] All four native harness adapters preserve correct role, session/thread identity, time and source anchors on pinned fixtures. Errors: injected instructions, subagent forks, forged transcript delimiters and unknown record kinds cannot create false human statements or merge unrelated sessions.
- **R3:** [inferred] Sanitize dialogue and all derived metadata before persistence, with bounded memory/time and private snapshot handling. Errors: unsafe paths, unredactable malformed records, over-limit inputs and failed snapshot reads produce explicit skips/failures; no raw secrets appear in retained fixture receipts or diagnostics.
- **R4:** [paraphrase] Re-import unchanged sources is idempotent; appends, revisions and interrupted imports reconcile deterministically while retaining source provenance. Errors: partial reads never advance completion watermarks; concurrent runs serialize; deleted sources do not silently purge archives.
- **R5:** [paraphrase] Users can retrieve the right original conversation passage across supported search/get/ask/Capsule surfaces. Errors: assistant proposals cannot be displayed as user decisions, missing timestamps remain unknown, and clipped or excluded evidence cannot support a cited answer.
- **R6:** [inferred] Run a fixed cross-session retrieval/task eval with synthetic secrets, project collisions, contradictory suggestions and real decisions. Require exact provenance/role correctness and zero fixture secret leaks; every designated exact lookup succeeds and held-out multi-session evidence coverage does not regress versus the manually normalized gold archive at the same budget. Errors: report format-specific failures and abstentions, never average them away.
- **R7:** [paraphrase] CLI, MCP, SDK, REST and Web UI deliver the surface matrix with consistent receipts and permissions. Errors: remote discovery or arbitrary host-path access is denied, dry-run writes no archive/index state, and partial imports remain visible across surfaces.
- **R8:** [inferred] Provide a dedicated configurable archive with privacy/project separation and cross-harness metadata. Default broad retrieval and managed-memory recall exclude archive dialogue; explicit session search finds it without a separate ranking engine. Errors: graph expansion cannot bypass exclusion, mixed-domain sessions cannot be silently downgraded, and index cleanup/uninstall/source deletion cannot erase durable archive files; opting in never expands caller authority.

**Documentation and delivery obligations.** [paraphrase] Complete the topic-specific documentation work listed in the surface matrix as part of this feature, across the two canonical documentation surfaces: repository Markdown rendered by Git hosting, and `gno.sh`. Update affected README capability/setup examples, changelog, user guides, CLI/MCP/API/configuration reference, architecture explanation, interface specs and structured-output schemas. Keep examples executable and distinguish defaults, opt-ins, unsupported cases and recovery behavior. Update the shipped GNO skill and relevant reference files, connector/harness instructions, and installed-skill verification. Do not create a third documentation site or update the retired in-repository website pages.

For `gno.sh`, update the matching docs/reference pages, relevant product/feature and install pages, FAQs and any affected comparison claims. Register new docs in navigation and prerender/sitemap routes. Verify the HTML and its generated Markdown twin, `/llms.txt`, `/llms-full.txt`, and alternate-format links agree; do not maintain divergent copies. Preserve local-only privacy promises and accurately state any new writes or background behavior. Keep internal eval fixtures, raw diagnostics and design notes out of public user documentation; public docs explain supported behavior and reproducible limits.

**Verification and delivery gates.** [inferred] Run focused regression and schema tests, then `bun run lint:check`, `bun test`, `bun run docs:verify` and documentation/public-truth checks appropriate to the changed scope. Run the topic-specific evals specified in the acceptance criteria; freeze models, fixtures, settings and thresholds before comparing arms, retain negative results, and never lower a threshold to pass. Where CLI/MCP behavior or shipped skill instructions change, run the GNO skill autoresearch eval, reconcile the shipped skill/reference sources and verify installation. Exercise changed CLI/MCP/REST/SDK behavior through actual invocations; drive changed Web UI flows with screenshots/responses, including keyboard and mobile behavior. A build or source inspection is not live QA.

For the hosted site run `bun run check`, `bun run typecheck`, `bun run build` and affected tests, then drive the changed pages locally, including navigation, copy buttons, Markdown twins and narrow width. Keep the GNO and hosted-site changes linked for coordinated delivery. When deployment is authorized, deploy from the canonical site repository and verify production HTTP response, service health, deployed revision, and the changed live pages. Do not claim production verification before deployment. Product publication follows the separately authorized release workflow. Record applicable gates and evidence in the spec completion record, including any blocked external delivery.

## Boundaries

<!-- scope: business -->

- [paraphrase] No automatic fact extraction/promotion, silent session watching, account login/OAuth, cloud chat scraping, source-log edits, or ingestion of tool/reasoning payloads by default.
- [inferred] Hooks and schedules belong to the dependent automation spec; users can ship and use manual ingestion without it. Import does not grant publication or relax collection egress.

## Decision Context

<!-- scope: both -->

- [inferred] Harness-aware adapters add trustworthy semantics to the existing record pipeline; flattening every JSON field into text would import instructions and noise as conversation.
- [inferred] Four native harnesses cover existing agent integrations while keeping live account connectors and unrelated export formats out of scope.
- [inferred] Archived dialogue retains uncertainty and authorship. Promoting a supported fact remains the existing explicit memory workflow.
