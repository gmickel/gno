# fn-71-bundled-image-attachments-in-publish-export.4 Consume bundled assets on gno.sh: Object Storage + URL rewriting + SVG sanitize

## Description

**Cross-repo task (lives in `~/work/gno.sh`).** Tracked in gno's flow for
visibility because it is the consumer half of the bundled-attachment
contract. Without this task landing in gno.sh, the artifact produced by
tasks 2 + 3 cannot render images; with it, the loop closes.

Start here (in the `~/work/gno.sh` repo):

- `src/lib/publish-artifact.ts` — `buildStateFromArtifact` is where bundled
  assets need to be extracted; run this before the markdown parser in the
  same file so the `gno-asset:` sentinels get rewritten to served URLs
  before `ReactMarkdown` ever sees them.
- `src/lib/publish-import.server.ts` — upload / ingest entrypoint for v1
  artifacts. Asset bytes must travel through intact.
- `src/lib/publish-artifact-client.ts` — client-side validation. Extend the
  version-1 branch validation to optionally check `spaces[].notes[].assets`
  shape when present.
- `src/lib/server/storage.ts` — Hetzner Object Storage client; add a
  `putAsset(key, bytes, contentType)` helper if one does not exist.
- `src/components/reader/note-blocks.tsx` — ReactMarkdown config. May need
  an SVG sanitizer wrapper on the `img` renderer or the served URL.
- `docs/handoffs/gno-publish-artifact-contract.md` — update the contract
  so the schema extension is documented in one place.

Requirements:

### Ingest (v1 plaintext artifacts)

- In `buildStateFromArtifact`, before calling `parseMarkdownBlocks` on each
  note's markdown, if `note.assets` is present:
  1. For each asset, decode `bytesBase64` → bytes.
  2. Verify `sha256` matches; reject the whole artifact if any hash fails.
  3. Verify `contentType` is in the allowlist (same list as gno-side
     task 2). Reject on mismatch.
  4. Push bytes to Object Storage under a per-snapshot prefix, e.g.
     `publish-assets/<snapshotId>/<asset.key>`.
  5. Build a map `key → servedUrl`.
- Rewrite the note's markdown: replace each `gno-asset:<key>` occurrence
  with the served URL. Use a single pass over the markdown string.
- Drop the `assets` field from the note before persisting; the stored
  markdown now references the public URL directly and assets live only in
  Object Storage.

### Ingest (v2 encrypted artifacts)

- Encrypted artifacts decrypt entirely client-side, so the server never
  sees plaintext assets. No Object Storage pushes happen for v2.
- Reader JS (the encrypted-reader component) decodes the bundled assets
  from the decrypted `ReaderSpaceData`, materializes `blob:` or data URLs
  in the browser, and rewrites `gno-asset:<key>` occurrences to those
  in-memory URLs before rendering.
- Revoke blob URLs on unmount to avoid leaks.

### SVG sanitization

- For any SVG bundled via the v1 path, sanitize before upload to Object
  Storage: strip `<script>` elements, `on*` event attributes, and any
  `href`/`xlink:href` whose value is `javascript:`. Use a small, audited
  sanitizer (e.g. a handwritten DOM-parser-based pass or an existing
  vetted library — no new heavy dep).
- For the v2 path, sanitize at render time before creating the blob URL.
- Regression test: a crafted SVG with `<script>alert(1)</script>` +
  `onload="…"` must sanitize cleanly and render without executing.

### Contract doc

Update `docs/handoffs/gno-publish-artifact-contract.md`:

- Add `PublishArtifactAsset` shape with field descriptions.
- Document the `gno-asset:<key>` sentinel convention.
- Document the MIME allowlist, size caps, resolution failure fallback
  (alt-text), and SVG sanitation requirement.
- Note that v2 artifacts carry assets inside `encryptedPayload` and that
  the reader does the Object-Storage equivalent in the browser.

### Budget + storage concerns

- `MAX_UPLOAD_BYTES` stays at 100 MB. Gno-side task 2 enforces the 90 MB
  artifact cap; gno.sh only needs to accept ≤ 100 MB uploads.
- Object Storage writes are best-effort per-asset. A single failed write
  rolls back the snapshot: delete already-uploaded assets and refuse the
  import with a clear error. No half-imported snapshots.

Tests / smoke:

- Unit test in gno.sh for the markdown rewriter (sentinel → URL).
- Integration test: mock Object Storage, feed a v1 artifact with one PNG
  bundled, assert the stored snapshot has the served URL and the PNG was
  put to the mock store.
- SVG sanitization regression test (crafted malicious SVG).
- Run `scripts/smoke-publish-from-gno.ts` end-to-end using a fresh
  `gno publish export` from a fixture vault that embeds one PNG, and
  assert the final reader page DOM contains an `<img>` whose `src` is a
  served URL (not `gno-asset:`, not `data:`).

## Acceptance

- [ ] gno.sh accepts v1 artifacts with bundled assets, pushes bytes to
      Object Storage, rewrites markdown sentinels to served URLs, and
      persists snapshots without the `assets` array.
- [ ] gno.sh rejects artifacts whose asset sha256 or MIME fails the
      allowlist.
- [ ] v2 artifacts render bundled images via in-browser blob URLs
      without ever sending decrypted bytes to the server.
- [ ] SVG assets are sanitized on both v1 (server) and v2 (client) paths;
      the crafted malicious-SVG regression test passes.
- [ ] `docs/handoffs/gno-publish-artifact-contract.md` documents the
      schema extension, MIME allowlist, size caps, and sanitation rules.
- [ ] End-to-end smoke asserts an `<img>` with a served URL for a
      bundled PNG.

## Done summary

(to fill on completion)

## Evidence

- Commits:
- Tests: (in gno.sh) `bun run test` + smoke script above
- PRs:
