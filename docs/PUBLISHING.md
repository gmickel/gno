# Publishing to gno.sh

GNO is local, free, open source, and MIT-licensed. Publishing is optional:
GNO compiles an explicit reader-safe snapshot, and gno.sh hosts only the
artifact you choose to upload. It never mounts or synchronizes the source
folder.

## Export and upload

Export one collection or document:

```bash
gno publish export work-docs --out ~/Downloads/work-docs.json
gno publish export "gno://work-docs/runbooks/deploy.md"
```

Inspect the preview without writing a file:

```bash
gno publish export work-docs --preview
```

Then open [gno.sh Studio](https://gno.sh/studio), sign in, and upload the JSON
artifact. Republishing is another explicit export and upload; it creates a new
snapshot for the same route.

Local Markdown images and Obsidian image embeds are bundled when they resolve
inside the exported collection and are PNG, JPEG, GIF, WebP, or AVIF. GNO
content-addresses and deduplicates their bytes, preserves external public
HTTPS images, and reports unresolved, ambiguous, unsupported, or unsafe local
references in the export summary. The exact final serialized artifact —
including base64 or encryption overhead — must remain within 100 MiB.

Public readers receive immutable generation-bound image URLs. Secret-link
readers receive capability-authorized, no-store URLs. Encrypted exports keep
the asset descriptors and bytes inside ciphertext; the browser creates scoped
Blob URLs after decryption and revokes them on replacement or unmount. Hosted
invite-only bundled-image delivery is not available yet: image-bearing
invite-only shares fail closed rather than exposing storage identifiers. Use
an asset-free invite artifact, secret link, or encrypted share for now.

GNO omits notes marked `publish: false`. It also strips local source paths,
source URIs, credential-bearing URLs, and unsafe metadata from reader
artifacts. Review the preview and the exported file before upload. Publication
is a disclosure decision, not a backup.

## Collection policy and migration

Every exported snapshot records its exact collection membership and the most
restrictive effective `local_only`, `lan`, or `remote` policy. Building and
previewing the JSON file is a local-process operation; it never uploads by
itself. The current Studio upload is a second, explicit user action. Future
integrated upload or private agent access remains disabled until both its own
authentication gate and a current `publish` policy decision pass.

Collections created before egress policies are migrated to an effective
`local_only` boundary without deleting or rebuilding local documents. That
default blocks future GNO-controlled network transfer while local indexing,
search, retrieval, trace inspection, and local-file export remain usable.
Choose a less restrictive policy only after reviewing the destination and the
exact current revision:

```bash
gno collection policy get work-docs
gno collection policy set work-docs remote --confirm-relaxation <revision>
```

Tightening policy does not retract an artifact already uploaded or copied.
Revoke or expire supported private links in Studio; public-space deletion is
not yet self-service, so request remote takedown before regenerating and
reviewing any replacement artifact. Never assume republishing, deleting a local
export, or changing local policy removed independently retained remote copies.

## Bundled local images

Publish export discovers local raster images referenced from Markdown
(`![alt](path)`) and Obsidian embeds (`![[image.png]]`), confines them to the
collection root, validates real PNG/JPEG/GIF/WebP/AVIF bytes (AVIF requires
AV1-decodable media at producer/file-ingress, not merely a structural BMFF
container), deduplicates by SHA-256, and rewrites successful references to
deterministic `gno-asset:<sha256>` sentinels. External `https://` image URLs
stay as-is. Unsupported formats (SVG, PDF, HTML, data URLs), missing files, and
MIME spoofs are omitted with diagnostics — they never become raw sentinels in
the artifact. A traversal attempt outside the collection root fails the export.
Image examples inside CommonMark backtick or tilde fenced code are not
discovered or rewritten.

Exact final serialized upload bytes (JSON including base64/encryption overhead)
are enforced against the **100 MiB** ceiling (authoritative gate for both
plaintext and encrypted envelopes; ciphertext field bounds align to that
budget and never replace final-envelope measurement). Successful exports report an
`assetSummary` (CLI `--json` and `POST /api/publish/export`) with asset/ref
counts, raw/encoded/final bytes, dedup savings, external image count, and
diagnostics. Asset-free notes omit `assets` / `requiredCapabilities`.

Visibility delivery:

- **public** / **secret-link** / **invite-only**: assets travel in the V1
  plaintext envelope with `requiredCapabilities: ["bundled-raster-assets@1"]`.
  gno.sh currently delivers public images via immutable generation-bound URLs
  and secret images via capability-authorized no-store routes. Invite-only
  note text still publishes, but invite-only **bundled-image delivery is not
  supported** on gno.sh yet (fail-closed; images will not render for invite
  readers until that consumer path ships).
- **encrypted**: asset bytes exist only inside ciphertext. The outer envelope
  never carries plaintext assets, note bodies, or `gno-asset:` tokens.
  Readers decrypt in-browser to scoped Blob URLs that are revoked on replace
  or unmount.

## Visibility and agent access

Human-reader access modes:

- `public`: anyone with the route can read it;
- `secret`: anyone with the secret link can read it;
- `invite`: authenticated invited readers can read it;
- `encrypted`: GNO encrypts locally before upload and gno.sh stores the
  encrypted artifact.

Public artifacts also carry the shipped read-only agent projection: a closed
manifest, deterministic Markdown, `llms.txt`, content hashes, and exact line
locators. The projection contains only the explicitly exported public
snapshot. Every current artifact records deterministic `egressLineage`: sorted
source-collection membership plus the most restrictive effective policy.
Public manifests repeat that lineage, and `projectionRevision` binds it so a
policy change cannot reuse an older revision.

Secret-link, invite-only, and encrypted spaces do not expose an agent
projection. Their wrappers retain the same redacted egress lineage for local
verification without exposing an agent manifest or decrypting content. gno.sh
does not currently provide token-authenticated private agent access. Do not
treat a secret link as an agent API credential.

## Encrypted export

```bash
gno publish export work-docs \
  --visibility encrypted \
  --passphrase "use-a-long-unique-passphrase"
```

GNO encrypts the payload locally. The exported wrapper contains ciphertext
metadata and an opaque share token, not plaintext notes or evidence. Losing the
passphrase means losing access; gno.sh cannot recover it.

The passphrase and plaintext never become server inputs. Readers decrypt in
their browser; gno.sh stores and serves ciphertext only. No plan, support path,
agent route, or administrator action enables server-side recovery.

Avoid passing a real passphrase directly in shared shell history. Use a private
interactive environment and follow your organization’s secret-handling rules.

## Privacy boundary

Local indexing, retrieval, and local models remain on the machine. Configured
HTTP model endpoints are a separate explicit boundary. gno.sh receives the
exported artifact only when you upload it.

Building a publish artifact is a policy-checked local-process export. The local
REST response does not upload it and is classified as loopback serving, not
remote publication. Remote upload, private/invite agent access, and
server-side decryption are not implemented; an upload or future agent route
must add its own authentication gate and a separate `publish` policy decision.

The design-partner validation pilot is separately opt-in and concierge-run. Its
closed receipts contain only a generated high-entropy cohort key, pseudonymous
participant key, consent receipt identifier, milestone event name, monotonic
sequence, exact UTC timestamp, and an aggregate cutoff/fingerprint for
publication approval. Cohort keys never contain client names, project names,
semantic slugs, or another free-form identity. Public reports omit the internal
cohort key and expose only a one-way opaque report identifier bound to the
approved aggregate. Receipts never contain document content, queries, raw URLs,
evidence spans, or free-form notes. Approval seals the exact current aggregate;
a later outcome invalidates it until every participant approves the new seal.
Participation can be withdrawn at any time.

## Verification

For a public agent-ready space, verify all three surfaces against the same
snapshot:

```bash
base=https://gno.sh/share/<owner>/<space>
curl -fsS "$base/llms.txt"
curl -fsS "$base/manifest.json"
curl -fsS "$base/<document>.md"
```

Confirm the Markdown hash and exact line locator match the manifest. Public
resources use strong ETags and revalidation. Missing, guessed, source-map, and
restricted agent-shaped routes return a private `404` with no-store/noindex
headers.

## Current commercial boundary

The local GNO product remains free. gno.sh plans apply to implemented hosted
human-reader publishing quotas and access modes. Public agent-readable
projection is shipped. Authenticated private agent access is deferred and is
not an entitlement in a current plan.

The five-partner knowledge-room pilot is a concierge product-validation
exercise, not a generally available managed service, support SLA, or proof of
product-market fit. Any published outcome is cohort-level, consented, and
privacy-suppressed.
