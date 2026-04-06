# fn-66-collection-level-model-editor-in-web-ui.3 Document collection model editing and recovery flows

## Description

Finish docs/website coverage for the collection model editor and the operator flow around it.

Start here:

- `docs/WEB-UI.md`
- `docs/API.md`
- `docs/CONFIGURATION.md`
- `docs/TROUBLESHOOTING.md`
- `README.md`
- `website/features/hybrid-search.md`
- `website/_data/features.yml`

Cover:

- where the editor lives in the web UI
- what each role means
- how inheritance from the active preset works
- how to clear an override
- what to do after changing `embed` on an existing collection
- how this relates to code-specific benchmark recommendations

Also decide whether to add:

- one screenshot or callout in `docs/WEB-UI.md`
- one short website mention under retrieval/hybrid-search features

Important:

- do not imply that collection editing changes path/file-type behavior; that is a separate future epic
- document recovery if a user points a collection at an uncached/invalid model URI

Run:

- `bun run website:sync-docs`
- docs verification after copy changes

## Acceptance

- [ ] Web UI docs show where to edit collection model overrides.
- [ ] API docs cover the collection model override payloads.
- [ ] Configuration/troubleshooting docs explain inheritance and re-embed implications.
- [ ] Website copy is updated if the new editor is user-visible enough to merit surfacing.
- [ ] README only changes if the new UI meaningfully improves the getting-started story.

## Done summary

TBD

## Evidence

- Commits:
- Tests:
- PRs:
