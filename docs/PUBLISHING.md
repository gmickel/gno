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

GNO omits notes marked `publish: false`. It also strips local source paths,
source URIs, credential-bearing URLs, and unsafe metadata from reader
artifacts. Review the preview and the exported file before upload. Publication
is a disclosure decision, not a backup.

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
snapshot.

Secret-link, invite-only, and encrypted spaces do not expose an agent
projection. gno.sh does not currently provide token-authenticated private agent
access. Do not treat a secret link as an agent API credential.

## Encrypted export

```bash
gno publish export work-docs \
  --visibility encrypted \
  --passphrase "use-a-long-unique-passphrase"
```

GNO encrypts the payload locally. The exported wrapper contains ciphertext
metadata and an opaque share token, not plaintext notes or evidence. Losing the
passphrase means losing access; gno.sh cannot recover it.

Avoid passing a real passphrase directly in shared shell history. Use a private
interactive environment and follow your organization’s secret-handling rules.

## Privacy boundary

Local indexing, retrieval, and local models remain on the machine. Configured
HTTP model endpoints are a separate explicit boundary. gno.sh receives the
exported artifact only when you upload it.

The design-partner validation pilot is separately opt-in and concierge-run. Its
closed receipts contain only a cohort identifier, pseudonymous participant key,
consent receipt identifier, milestone event name, and calendar date. They never
contain document content, queries, raw URLs, evidence spans, or free-form
notes. Participation can be withdrawn at any time.

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
