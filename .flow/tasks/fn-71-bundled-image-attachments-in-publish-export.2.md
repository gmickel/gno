# fn-71-bundled-image-attachments-in-publish-export.2 Bundle image attachments into the v1 artifact + rewrite markdown references

## Description

With the resolver from task 1 in hand, extend the v1 publish artifact
schema with an `assets` field on each note, write the bundler that
populates it, and rewrite each resolved `![[filename.ext]]` embed in the
note's markdown to a stable sentinel the consumer can pick up.

Start here:

- `src/publish/artifact.ts` — `PublishArtifactNote` type + v1 envelope
  builder
- `src/publish/obsidian-sanitize.ts` — current point of embed detection;
  the bundler replaces the "drop + warn" branch for image embeds
- `src/publish/export-service.ts` — pipeline where sanitize runs today
- `src/cli/commands/publish.ts` — `--preview` surface; extend to report
  bundled / unresolved / oversize / rejected counts
- `src/publish/attachment-resolver.ts` (from task 1)

Requirements:

### Schema

Extend `PublishArtifactNote` with an optional `assets` array:

```ts
interface PublishArtifactAsset {
  key: string; // sentinel target, e.g. `3f4a9c22-cover.png`
  contentType: string; // one of the allowlisted MIMEs
  bytesBase64: string;
  originalPath: string; // relative to collection root
  size: number; // pre-encoding byte count
  sha256: string; // hex digest of pre-encoding bytes
}

interface PublishArtifactNote {
  // existing fields …
  assets?: PublishArtifactAsset[];
}
```

`key` format: `<sha256[0:8]>-<sanitized-basename>.<ext>`. Sanitize the
basename to `[a-z0-9._-]+`, lowercase. Collisions within a note (same
hash, same basename) dedupe to a single entry.

### MIME allowlist

- `image/png`
- `image/jpeg`
- `image/gif`
- `image/webp`
- `image/svg+xml`

Sniff the first bytes (magic numbers) and reject anything whose sniffed
type does not match both the allowlist and the file extension. Treat SVG
as a special case (text-based, sniffed by `<svg` prefix).

### Budgets

- Per-asset cap: 10 MB (raw bytes, pre-base64).
- Per-artifact cap: 90 MB (raw bytes, summed across all notes' assets).
- When the per-artifact cap would be exceeded, sort pending attachments
  largest-first and skip from the top until the remainder fits. Report
  every skip.

### Markdown rewriting

For every embed the resolver returns:

- `bundled`: replace `![[filename.ext]]` with `![<basename-no-ext>](gno-asset:<key>)`.
  Aliased form `![[filename.ext|Alt Text]]` becomes `![Alt Text](gno-asset:<key>)`.
  Obsidian resize pipes (`|200`, `|200x150`) are treated as alt text and
  ignored for sizing in v1 (document this).
- `unresolved` / `oversize-*` / `mime-rejected`: replace `![[…]]` with
  the alt text (basename without extension or the aliased text), so the
  sentence stays readable. Report outcome.

Preserve surrounding whitespace. Embeds inside blockquotes, lists, and
tables must round-trip correctly.

### Wiring

- Run the bundler as a new stage inside `exportDocumentArtifact` and
  `exportCollectionArtifact` in `export-service.ts`, after frontmatter
  parse, before sanitize.
- The sanitizer's current `image-embed-dropped` warning becomes a
  fallback for embeds the bundler does not handle (e.g. resolver
  returned `not-found`). Keep a single unified warnings channel by
  extending `SanitizeWarning` (or moving to a shared `ExportWarning`
  type).
- `--preview` output groups: bundled (count + total bytes), unresolved,
  oversize-per-asset, oversize-artifact-budget, mime-rejected.
- HTTP export route (`src/serve/routes/api.ts`) surfaces asset counts
  alongside existing warnings in the JSON response.

### Tests / smoke

- Unit tests for the bundler against a fixture vault:
  - bundles a PNG under the per-asset cap
  - rejects a 20 MB PNG (oversize-per-asset)
  - rejects a ZIP renamed to `.png` (mime-rejected)
  - drops to alt text when the resolver says `not-found`
  - deduplicates identical attachments referenced twice in one note
  - preserves aliased alt text (`![[cover.png|Hero]]` → `![Hero](gno-asset:…)`)
- Base64 inflation test: asserts `bytesBase64.length > size` and that
  decoding reproduces the original bytes (sha256 round-trip).
- Golden test for markdown rewriting: input with five embeds across
  blockquote / list / table / paragraph, compare output against a
  checked-in fixture.
- `--preview` integration test that exercises the full bundler path
  with warnings output.

### Hands-off guardrails

- No native binary deps. Use the Web Crypto `crypto.subtle.digest` for
  sha256 and `Buffer.from(bytes).toString("base64")` for encoding.
- Do not touch the v2 encrypted path in this task. Task 3 covers that.
- Keep `MAX_PUBLISH_SLUG_LENGTH` and other existing limits as-is.

## Acceptance

- [ ] `PublishArtifactNote.assets` is defined with the shape above and
      exported from `src/publish/artifact.ts`.
- [ ] Bundler runs in the v1 export path and produces assets for
      resolvable, in-budget, allowlisted image embeds.
- [ ] Resolved embeds in the note's `markdown` are rewritten to
      `gno-asset:<key>` references; unresolved / rejected embeds fall
      back to alt text.
- [ ] Budgets are enforced and skipped assets are reported.
- [ ] `gno publish export --preview` reports per-category counts and
      per-attachment detail.
- [ ] All new code is covered by unit tests + at least one golden
      rewrite test.
- [ ] No new runtime dependencies.

## Done summary

(to fill on completion)

## Evidence

- Commits:
- Tests: `bun test test/publish/asset-bundler.test.ts`,
  `bun test test/publish/export-service.test.ts`,
  `bun test test/cli/publish-export.test.ts`
- PRs:
