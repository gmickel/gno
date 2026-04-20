# fn-71-bundled-image-attachments-in-publish-export.3 Carry bundled assets through the v2 encrypted envelope

## Description

Task 2 lands bundled assets on the v1 (plaintext) artifact. The v2
(encrypted) envelope has its own pipeline in `src/publish/encrypted-export.ts`
that serializes a `ReaderSpaceData` payload, encrypts it with
AES-GCM + PBKDF2, and emits a ciphertext-only `encryptedPayload`. This task
threads bundled assets through that pipeline so encrypted shares can carry
images too, without leaking any asset bytes outside the ciphertext.

Start here:

- `src/publish/encrypted-export.ts` (`deriveReaderPayload`,
  `buildEncryptedArtifactPayload`, `parseMarkdownBlocks`, and the
  `ReaderNoteCard` / `ReaderSpaceData` types)
- `src/publish/artifact.ts` (`PublishArtifactNote.assets` from task 2)
- `src/publish/export-service.ts` (both the v1 and v2 branches now receive
  sanitized + bundled notes from the bundler)

Requirements:

- Extend the in-memory `ReaderNoteCard` type in `encrypted-export.ts` with
  an `assets?: PublishArtifactAsset[]` field that mirrors the v1 shape.
- `deriveReaderPayload` copies the bundled assets from the incoming
  `PublishArtifactNote.assets` onto the `ReaderNoteCard` in the
  pre-encryption payload.
- The ciphertext therefore contains the `bytesBase64` strings. Nothing
  changes in the envelope structure (`version: 2` stays a single
  `encryptedPayload` + `secretToken` per space).
- The gno.sh consumer, after in-browser decrypt, receives the
  `ReaderSpaceData` with `currentNote.assets` populated and is responsible
  for rendering images client-side from those assets (task 4 will adapt
  the consumer).
- Per-artifact + per-asset budgets remain the same as v1 (applied before
  encryption to keep browser decrypt cost bounded).
- Assert via test that encrypting a payload with a known asset yields a
  ciphertext whose Base64 JSON body does not contain the asset's original
  filename or the first N bytes of the asset in plain form.

Tests / smoke:

- Round-trip test using the existing `encryptJson`/`decryptJson` pair
  (test utility; can reuse `src/lib/server/crypto.ts` analog from gno.sh
  or expose a local decrypt in test). Given an input note with one PNG
  asset, the decrypted payload's `currentNote.assets[0].bytesBase64`
  equals the input Base64 exactly and the sha256 round-trips.
- Negative test: a grep of the stringified `encryptedPayload` for the
  original asset `originalPath`, for a 16-byte prefix of the PNG magic
  bytes, and for `bytesBase64` must all miss.
- Size test: a v2 artifact bundling a ~5 MB PNG still encrypts and
  decrypts within a soft budget (e.g. < 1 s on the test machine);
  record the time and fail only if it exceeds a generous threshold.

Docs:

- Note in the spec (or in `docs/SYNTAX.md`) that encrypted shares may
  want a tighter per-artifact budget than public/secret-link shares due
  to in-browser decrypt cost. Concrete guidance like "prefer < 25 MB
  total bundled assets for encrypted shares; the reader has to decrypt
  it all before rendering."

## Acceptance

- [ ] `ReaderNoteCard` carries `assets` and the v2 pipeline forwards
      them from `PublishArtifactNote` through `deriveReaderPayload`.
- [ ] Encrypted v2 artifacts contain no plaintext asset bytes, filenames,
      or base64 strings — verified by explicit negative grep tests.
- [ ] Decryption round-trip preserves every asset byte (sha256 match).
- [ ] Budgets enforced pre-encryption match the v1 task 2 behavior.
- [ ] Docs mention the encrypted-share budget guidance.

## Done summary

(to fill on completion)

## Evidence

- Commits:
- Tests: `bun test test/publish/encrypted-export.test.ts`
- PRs:
