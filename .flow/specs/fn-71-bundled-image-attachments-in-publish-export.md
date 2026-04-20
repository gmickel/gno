# fn-71-bundled-image-attachments-in-publish-export Bundled image attachments in publish export

## Overview

Today `gno publish export` cannot carry image attachments across the gno.sh
hand-off. Obsidian-style embeds (`![[cover.png]]`) are stripped by the 1.0.2
sanitizer because the artifact schema has no place to put the bytes and the
consumer has no way to resolve the filename. Authors are forced to migrate
every image to `![alt](public-url)` before publish or accept silently missing
figures in the rendered snapshot.

This epic closes that gap. It adds a bundled-asset channel to the publish
artifact so `![[image.ext]]` references travel with the note, arrive on
gno.sh intact, and render as `<img>` in the reader.

The epic is narrow on purpose:

- images only (PNG, JPEG, GIF, WebP, SVG)
- local vault files only (no remote URL mirroring)
- no image optimization / resizing in v1
- extends the existing v1 plaintext and v2 encrypted artifact envelopes
  rather than introducing a new format version

## Scope

Included:

- a resolver that maps `![[filename.ext]]` inside a note's markdown to a
  concrete file on disk, using the note's collection root and Obsidian's
  attachment-folder search behavior
- an asset bundler that reads matched files, validates MIME + size, adds
  entries to a new `assets` field on the publish artifact, and rewrites each
  `![[…]]` reference in the note's markdown to a stable sentinel the consumer
  can resolve
- parity for the encrypted (v2) artifact path: assets travel inside the
  encrypted payload, never as plaintext siblings
- a per-artifact size budget (enforced against the existing
  `MAX_UPLOAD_BYTES = 100 MB` cap on the gno.sh side) plus a per-asset size cap
- transparent handling for unresolved / oversized / disallowed attachments
  (report + skip, never silently drop)
- `gno publish export --preview` surface: bundled vs skipped vs rejected
  counts, per-attachment detail
- gno.sh ingest: accept the bundled-asset schema, persist bytes to Hetzner
  Object Storage, rewrite sentinel references in the stored markdown to the
  served URL, render as `<img>` in the reader
- end-to-end smoke via `scripts/smoke-publish-from-gno.ts` (or equivalent) on
  a fixture note with at least one PNG embed
- updates to `docs/handoffs/gno-publish-artifact-contract.md` (owned by the
  gno.sh repo, cross-referenced here) and to the gno CLI docs

Excluded:

- image optimization (resize, recompress, format conversion). Native image
  libraries (`sharp`, `oxipng`, `pngquant`) materially complicate the gno
  Windows + macOS + Linux npm publish matrix. Authors pre-optimize in
  Obsidian.
- non-image attachments (PDFs, office docs, audio, video)
- remote-URL mirroring (`![](https://…)` staying verbatim is fine; we do not
  fetch and re-host)
- rewriting the artifact schema beyond `version: 1` / `version: 2`. We add
  fields in a way that older consumers tolerate; a new `version: 3` is
  explicitly out of scope.
- retroactive attachment bundling for snapshots already hosted on gno.sh.
  Authors re-export to get attachments.
- Obsidian-specific block references, pinned asset galleries, excalidraw
  embeds, dataview — plain file embeds only.

## Approach

### Prior context

Just landed in gno 1.0.2 / 1.0.3:

- `src/publish/obsidian-sanitize.ts` — sanitizer with an `image-embed-dropped`
  warning for every `![[…]]` it currently strips. This is the hook point for
  the bundler: same regex, now followed by resolution + bundling before the
  markdown is rewritten.
- `src/publish/export-service.ts` — wiring of the sanitizer into the export
  pipeline; `loadDocumentMarkdown` gives us the note's raw text.
- `src/publish/artifact.ts` — `PublishArtifactNote` shape (`markdown`,
  `metadata`, `slug`, `summary`, `title`) and the v1 envelope builder.
- `src/publish/encrypted-export.ts` — the v2 encrypted envelope and the
  in-browser `ReaderSpaceData` shape used for the encrypted payload.
- `src/cli/commands/publish.ts` + `src/cli/program.ts` — `--preview` surface,
  warnings formatting.
- `src/config/types.ts` — `Collection.path` is the absolute vault root.
- `src/store/types.ts` — `DocumentRow.collection` + `DocumentRow.relPath` give
  us the note's home folder when resolving embeds.

gno.sh side (consumer, separate repo):

- `src/lib/publish-artifact.ts` — `buildStateFromArtifact` is where bundled
  assets have to be extracted; must run before `parseMarkdownBlocks` sees the
  sentinel references so the sentinels can be rewritten to URLs.
- `src/lib/publish-artifact-client.ts` / `publish-import.server.ts` — upload
  path; asset bytes must travel through without corruption and be validated
  at boundary.
- Hetzner Object Storage client (`src/lib/server/storage.ts`) — target for
  bundled asset bytes.
- Reader rendering: `ReactMarkdown` already renders `<img src="…">`; once
  sentinels are rewritten to Object Storage URLs nothing extra is needed.

### Product stance

- Honest by default. If an attachment cannot be resolved or exceeds the size
  cap, report it on `--preview` and in the export output. Never silently
  drop. Never falsify.
- Authors should not have to change their source note to publish it. An
  Obsidian note with `![[cover.png]]` should render with the cover on
  gno.sh after a single `gno publish export`.
- Strict allowlist at the boundary. Only bundle files whose extension AND
  sniffed content match one of the supported MIME types. Refuse to bundle a
  `cover.png` whose bytes are actually a ZIP.
- Cross-platform npm publish stays boring. No native binaries, no optional
  deps, no postinstall scripts. Pure TypeScript, Bun-native reads.
- Encrypted artifacts stay encrypted end-to-end. Bundled assets must live
  inside the `encryptedPayload`, never next to it.

### Supported MIME types (v1)

- `image/png` (`.png`)
- `image/jpeg` (`.jpg`, `.jpeg`)
- `image/gif` (`.gif`)
- `image/webp` (`.webp`)
- `image/svg+xml` (`.svg`) — text, but treat as asset; strip scripts on the
  gno.sh reader side (SVG is a known XSS vector and must not be rendered
  inline without sanitation)

### Resolution strategy

- For each `![[filename.ext]]` embed in the note body:
  1. Look in the same folder as the note first (`dirname(note.relPath)`)
  2. Then a sibling `attachments/` folder under the note's folder
  3. Then a vault-wide recursive search for a file matching the exact
     basename under the collection root
  4. If multiple matches are found in step 3, pick the one closest to the
     note by path distance; warn about the ambiguity
- Only files under the note's collection root are eligible. An embed that
  would resolve outside `Collection.path` is treated as unresolved (path
  traversal guard).
- Resolution is case-sensitive on Linux, case-insensitive on macOS/Windows —
  let the OS filesystem decide, don't normalize ourselves.

### Artifact schema extension

Add to `PublishArtifactNote` (v1):

```ts
interface PublishArtifactNote {
  markdown: string;
  metadata?: Record<string, string | string[]>;
  slug: string;
  summary: string;
  title: string;
  assets?: PublishArtifactAsset[]; // new, optional
}

interface PublishArtifactAsset {
  key: string; // stable sentinel referenced from markdown
  contentType: string; // one of the allowlisted MIME types
  bytesBase64: string; // base64-encoded payload
  originalPath: string; // relative-to-collection path for audit
  size: number; // uncompressed byte length
  sha256: string; // integrity hash
}
```

`key` is what the bundler puts into the rewritten markdown reference, e.g.
`![](gno-asset:<key>)`. `key` must be opaque, stable, collision-free within
the note (e.g. `<sha256[0:12]>-<sanitized-basename>.ext`).

Keep `assets` scoped to the note, not the artifact, to keep the
asset-to-note relationship trivial on the consumer side and to keep the v2
encrypted envelope single-note-friendly.

For the v2 encrypted path: the reader payload that gets encrypted already
mirrors `PublishArtifactNote` into `ReaderNoteCard.blocks`. Extend the
in-memory shape to carry a parallel `assets` field; the encryption step
continues to serialize-then-encrypt, so the assets end up encrypted alongside
the markdown. No envelope change.

### Markdown rewriting

Replace each resolved `![[filename.ext]]` occurrence with
`![alt](gno-asset:<key>)` where `alt` is the basename without extension
(matches Obsidian's behavior). Aliased variants (`![[cover.png|Cover]]`) keep
their alias text.

gno.sh resolves the `gno-asset:` URL scheme at ingest time: look up the key
in the note's assets, store bytes in Object Storage, mint a public URL, then
overwrite the markdown reference with that URL before it lands in the stored
snapshot. The sentinel never leaks to the browser.

### Size budgets

- Per-asset cap: 10 MB. Oversized assets are reported + skipped, not bundled.
- Per-artifact cap: 90 MB of bundled-asset bytes (leaves headroom under the
  existing 100 MB `MAX_UPLOAD_BYTES` for markdown + metadata + base64
  overhead). Budget-exceeded attachments are reported + skipped in a stable
  order (largest first) so the author sees which ones to trim.

### Failure modes

For each `![[…]]` embed the bundler emits exactly one outcome:

- `bundled` — resolved, bundled, reference rewritten
- `unresolved` — no match in vault, reference replaced with alt text only
- `oversize-per-asset` — reference replaced with alt text
- `oversize-artifact-budget` — reference replaced with alt text
- `mime-rejected` — extension and/or content type outside allowlist,
  reference replaced with alt text

All outcomes surface in the preprocessor warnings channel added in 1.0.2 and
in the `--preview` report. Nothing blocks the export.

### Testing posture

- unit tests for the resolver against a fixture vault that exercises: same
  folder, sibling `attachments/`, recursive search, ambiguity, path
  traversal attempt, missing file
- unit tests for MIME sniff + allowlist rejection
- unit tests for size-cap enforcement (per-asset and artifact-budget)
- unit tests for markdown rewriting: bare embed, aliased embed
  (`![[file.png|Alias]]`), multiple embeds on one line, embed inside a
  blockquote
- end-to-end bun test that round-trips a fixture note through
  `exportPublishArtifact` and asserts the `assets` array contents + the
  rewritten markdown
- regression test that confirms the 1.0.2 sanitizer behavior is unchanged
  for non-image embeds and for unresolved image embeds
- smoke via `scripts/smoke-publish-from-gno.ts` against a fixture collection
  with one bundled PNG, ending with an asserted `<img>` in the rendered
  reader page

### Risks / traps

- Two notes in the same collection embed `assets/logo.png`. Same bytes, same
  `sha256`. Ensure `key` is deterministic per-note so we do not accidentally
  dedupe in a way that breaks the note → asset back-reference.
- SVG files that contain `<script>` or `javascript:` URLs. gno.sh reader
  must sanitize SVG on render; the gno bundler is not the right place to
  strip, but it must be documented so the gno.sh side enforces it.
- Base64 inflation is ~33%. A 10 MB PNG lands as ~13.3 MB of JSON. The
  90 MB artifact budget already accounts for this; regression tests must
  assert the boundary in base64-encoded bytes, not raw bytes.
- Encrypted payload size explosion: PBKDF2 iteration count multiplied by
  bigger ciphertext chunks. Browser decrypt has to stay under a sane budget
  (say < 3 s on an M1). If we see regressions, document a recommended
  per-artifact attachment budget for encrypted shares specifically.
- Collision-by-filename across folders: Obsidian warns about this. We log
  and pick by distance, matching Obsidian's "closest" heuristic.
- `![[cover.png|200]]` is Obsidian image-resize syntax. v1 ignores the
  pipe-argument for images (treats it as alias). Document that resize
  hints do not survive.

### Task breakdown

#### Task 1

`fn-71-bundled-image-attachments-in-publish-export.1`

Implement the attachment resolver: vault-aware filename lookup under a
collection root, honoring Obsidian attachment-folder search order and
rejecting anything that would escape the collection path.

#### Task 2

`fn-71-bundled-image-attachments-in-publish-export.2`

Extend the artifact schema and write the bundler: MIME sniff, size caps,
base64 encode, asset keying, markdown rewriting. Wire into
`export-service.ts` alongside the existing sanitizer; surface warnings
through the existing channel. Update `--preview` output.

#### Task 3

`fn-71-bundled-image-attachments-in-publish-export.3`

Carry bundled assets through the v2 encrypted envelope so attachments are
encrypted alongside the note content. Assert no plaintext asset bytes leak
into the v2 artifact JSON.

#### Task 4

`fn-71-bundled-image-attachments-in-publish-export.4`

**Cross-repo task (gno.sh).** Extract bundled assets at ingest, push bytes
to Hetzner Object Storage, rewrite `gno-asset:` sentinels in the stored
markdown to the served URL, and sanitize SVG on render. Update the
artifact-contract handoff doc. This task lives in the gno.sh repo's flow
but is tracked here for visibility.

#### Task 5

`fn-71-bundled-image-attachments-in-publish-export.5`

Smoke + documentation: fixture vault with a bundled PNG, end-to-end smoke
script, docs updates (`docs/SYNTAX.md`, `docs/handoffs/gno-publish-artifact-contract.md`
on the gno.sh side, `README.md` publish section, CHANGELOG entry).

## Quick commands

- `bun run lint:check`
- `bun test test/publish`
- `bun run typecheck`
- `bun src/index.ts publish export "gno://<collection>/<note>.md" --preview`
- `bun scripts/smoke-publish-from-gno.ts` (gno.sh side, after task 4)

## Acceptance

- [ ] `gno publish export` on a note that contains `![[cover.png]]` produces
      an artifact whose JSON includes the PNG bytes under
      `spaces[].notes[].assets`, and whose `markdown` field references the
      asset via a `gno-asset:<key>` sentinel rather than `![[cover.png]]`.
- [ ] Uploading that artifact to gno.sh results in a rendered reader page
      that displays the PNG via an `<img>` pointing at a gno.sh-served URL,
      not at a `gno-asset:` sentinel or a raw base64 data URL.
- [ ] Encrypted (v2) artifacts carry bundled assets inside the encrypted
      payload; a `grep` of the raw v2 JSON for any bundled filename returns
      nothing, and the ciphertext decrypts in-browser to a structure that
      surfaces the image on the reader.
- [ ] Unresolved, oversize, and MIME-rejected embeds are reported on
      `--preview` and in the warnings channel on both CLI and serve API,
      with per-attachment detail. None of them block the export.
- [ ] Total artifact size stays under the gno.sh 100 MB upload cap, enforced
      by a per-artifact asset budget that leaves headroom for markdown +
      base64 overhead.
- [ ] gno + gno.sh combined have a smoke test that starts from a fixture
      note and ends with an asserted `<img>` in the rendered reader DOM.
- [ ] Docs explain: what filename resolution does, what MIME types are
      accepted, what the size caps are, what `--preview` reports, and that
      authors who want image optimization must pre-optimize in Obsidian.
- [ ] No new native binary dependencies are added to the gno npm package.

## References

- gno 1.0.2 sanitizer + export service:
  - `src/publish/obsidian-sanitize.ts`
  - `src/publish/export-service.ts`
  - `src/publish/artifact.ts`
  - `src/publish/encrypted-export.ts`
  - `src/cli/commands/publish.ts`
  - `src/cli/program.ts`
- gno collection + document model:
  - `src/config/types.ts` (`Collection.path`)
  - `src/store/types.ts` (`DocumentRow.collection`, `DocumentRow.relPath`)
- gno.sh consumer side:
  - `src/lib/publish-artifact.ts`
  - `src/lib/publish-artifact-client.ts`
  - `src/lib/publish-import.server.ts`
  - `src/lib/server/storage.ts`
  - `src/components/reader/note-blocks.tsx`
- Cross-repo contract:
  - gno.sh repo: `docs/handoffs/gno-publish-artifact-contract.md`
