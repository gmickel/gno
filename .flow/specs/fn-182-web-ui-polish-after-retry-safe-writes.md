# Web UI polish after retry-safe writes

## Goal & Context
<!-- scope: business; source: inferred -->

Live QA of retry-safe writes found three small Web UI problems that predate that change and lose no data, but confuse users: the document view keeps showing old tags after a successful tag save until reload; while a save's response is lost, the "changed on disk" banner attributes the user's own committed save to an outside change; and the home dashboard content is wider than a 390px phone screen.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [inferred] After a tag save commits, the document view's tag list shows the saved tags without a reload. Errors: a failed or conflicting tag save keeps the previous tags and shows the error.
- **R2:** [inferred] While a save outcome is unknown (lost response), the editor says the save may have completed and offers retry, rather than claiming an outside change; a genuine outside change still shows the reload banner.
- **R4:** [inferred] Search result snippets on the main Search page render highlights as elements and strip Markdown escapes (for example `\#`, `\_`), reusing the session-search snippet renderer rather than a second implementation. Errors: untrusted snippet text is never injected as HTML.
- **R3:** [inferred] The home dashboard has no content wider than the viewport at 390px; verify with a screenshot at 390x844 and 1440x900.

## Boundaries
<!-- scope: business -->

- [inferred] No redesign; smallest layout and state fixes with focused DOM tests.
