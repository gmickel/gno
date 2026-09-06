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
artifact. File selection creates a draft; review access and choose Publish to
activate it. To replace an existing publication, explicitly choose its target
and Update publication. Matching filenames or slugs do not authorize overwrite.
Publish a copy creates an independent item with a distinct route.

Local Markdown images and Obsidian image embeds are bundled when they resolve
inside the exported collection and are PNG, JPEG, GIF, WebP, or AVIF. GNO
content-addresses and deduplicates their bytes, preserves external public
HTTPS images, and reports unresolved, ambiguous, unsupported, or unsafe local
references in the export summary. The exact final serialized artifact —
including base64 or encryption overhead — must remain within 100 MiB.

Public readers receive generation-bound image routes that check current
publication access. Secret-link readers receive capability-authorized routes.
Both disable caching so a withdrawn publication cannot keep serving images. Encrypted exports keep
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
Unpublish or delete the hosted item separately in Studio, including public
publications. Unpublish retains source and history; deletion denies access
before background cleanup. Never assume republishing, deleting a local
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
  gno.sh delivers public images via generation-bound routes that check current
  access, and secret images via capability-authorized routes, both no-store. Invite-only
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
- `secret-link`: anyone with the secret link can read it, including someone
  it was forwarded to;
- `invite-only`: signed-in readers must pass the displayed access checks.
  Personal shares allow their owner by default; organization shares use
  membership and access settings;
- `encrypted`: GNO encrypts locally before upload and gno.sh stores the
  encrypted artifact.

The local Web UI starts with no visibility selected and requires an explicit
choice for both note and collection exports. Cancelling or omitting a required
encryption passphrase produces no artifact. CLI and REST API exports retain
their `public` default for compatibility; pass `--visibility` or `visibility`
explicitly when another mode is intended. The export result reports its mode.
Local help describes hosted plan availability but cannot inspect your account;
private publishing is paid and encrypted publishing has its own entitlement.
Check [pricing](https://gno.sh/pricing) for your hosted account.

Studio preserves uploaded artifact access. For new Markdown or source content,
it starts with secret-link when your plan allows private publishing, and public
otherwise. Review declared/effective access and the intended audience before
Publish. Unsupported choices require explicit correction or upgrade; Studio
never silently makes a restricted artifact public. Unsupported multi-space
imports or updates are rejected before activation; export one space separately.

Public, secret-link, and invite-only access can convert after review. A
content-only update preserves the active route, mode, and token. An access
change invalidates the old route/token before activating the new mode; a
withdrawn public URL is not reused by a later conversion back to public.
A stale edit requires refresh and review. Conversion into or out of encrypted
mode requires a new local export in that mode; hosted controls cannot decrypt
or re-encrypt an existing payload.

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

## Reader tools and note identities

The gno.sh reader shows an estimated reading time for notes with visible prose.
**Copy Markdown** or **Shift+Y** copies the current note with its title and
structure; protected images become descriptive placeholders. Encrypted notes
are processed in the browser after unlock.

Views count approximate page opens. Refreshing or returning counts again;
blocked signals and outages can lose increments. The first total appears about
five seconds after opening a note. Counting uses aggregate note counters without
visitor identifiers or analytics cookies; private access still uses normal
authentication. New counters start at zero with the September 6, 2026 rollout.

New exports include random stable note IDs for reader view totals. GNO keeps the
private `publish-identities.json` registry beside the loaded config file; custom
`--config` paths and `GNO_CONFIG_DIR` are respected. Back up this file with your
config. The collection root must be accessible when exporting so GNO can
resolve its canonical path. Content/title edits, published URL changes, and index rebuilds retain
IDs while the source-relative path and collection root stay the same. Moving a
source file or root, or losing the registry, starts a new identity and view total.
GNO never adds identity fields to your Markdown. A damaged or unwritable registry
stops export instead of silently resetting identities.

Plain artifacts carry each note's `id`. Encrypted artifacts expose only an
opaque UUID roster (`noteIds`) and its count; matching IDs remain inside the
encrypted note cards. Paths, titles, and note content stay encrypted. Legacy
plain artifacts remain supported; encrypted artifacts without the roster need
a fresh export before note view totals are available.

## Unpublish and delete permanently

Studio keeps retained sources distinct from their publications. The library
shows item titles, note/collection type, counts, access, and states such as
Draft, Published, Unpublished, Expired, Deleting, and Cleanup failed. Item
details contain publication history and advanced operations.

**Unpublish** stops hosted access for every mode, including public, while
retaining the source and history. A retained source can be explicitly published
again. Reader pages, historical routes, assets, search, and public Markdown,
manifest, and llms projections stop serving the withdrawn publication.

**Delete permanently** names the selected item and affected publication,
snapshot, and asset counts before confirmation. It denies access first, then
cleans the selected hosted source, its associated history, and unreferenced
payloads through durable background cleanup. Deleting means cleanup is still
pending. Cleanup failed keeps access denied and offers retry; refresh or
restart does not lose the job. Completed cleanup retains only a minimal
content-free operation receipt.

Deletion does not touch local vault files, independently published notes or
copies, or objects still referenced by another item. Downloads and third-party
caches cannot be recalled. Live cleanup does not promise immediate backup
erasure; see [Privacy](https://gno.sh/privacy) and [Terms](https://gno.sh/terms)
for retention boundaries. Deleting local files or tightening local egress
policy does not perform hosted deletion.

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
