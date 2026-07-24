---
title: Chromium Browser Clipper
description: Install and pair GNO's local unpacked Chromium clipper for previewed visible-page capture with exact provenance.
keywords: gno browser clipper, chromium extension, local web capture, provenance
---

# Chromium Browser Clipper

The GNO browser clipper saves an exact visible selection or a constrained
Reader-style extraction into a local editable collection. Every write has a
server-owned preview, explicit confirmation, and closed provenance. It is an
unpacked Chromium Manifest V3 extension distributed inside the GNO npm
package—not a Chrome Web Store or Firefox release.

## Install

Install or update GNO first:

```bash
bun install -g @gmickel/gno
gno --version
```

The default Bun-global unpacked extension is:

```text
~/.bun/install/global/node_modules/@gmickel/gno/browser-extension/dist
```

If you installed with npm instead, use
`$(npm root -g)/@gmickel/gno/browser-extension/dist`.

In Chromium:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the package's `browser-extension/dist` directory.
5. Pin **GNO Browser Clipper**.

The packaged archive and checksum sit beside the unpacked build:

```text
browser-extension/artifacts/gno-browser-clipper-v<VERSION>.zip
browser-extension/artifacts/gno-browser-clipper-v<VERSION>.zip.sha256
```

The extension manifest, archive filename, and npm package use the same
`package.json` version. Contributors can reproduce and compare two clean
packages:

```bash
bun run package:clipper
bun run verify:clipper-package
```

To update an unpacked install, update GNO, return to `chrome://extensions`, and
reload the same directory. If the unpacked path changes, Chromium can assign a
new extension ID; remove/reload it and pair again because grants bind to the
exact extension origin.

## Pair with local GNO

Start the local workspace:

```bash
gno serve
```

Then:

1. Open the clipper and keep the gateway at
   `http://127.0.0.1:3000` unless `gno serve` uses another loopback port.
2. Choose **Start pairing**. The extension creates a five-minute request and
   opens `/clipper/pair#pairId=<64-hex-id>`.
3. Compare the eight-digit code shown in the extension, type it into the GNO
   approval page, and approve.
4. Return to the popup and poll once for the approved grant.

The Web page obtains an in-memory same-origin CSRF token and sends
`X-GNO-CSRF` to `/api/clipper/pair/approve`. It validates and scrubs the pair-ID
fragment before normal workspace state starts. The approval code never enters
the URL. The page never receives the bearer grant; only the exact
`chrome-extension://<id>` origin can poll it once.

Pairing codes expire after five minutes, stop after five wrong guesses, and
die on `gno serve` restart. Approved grants have a bounded expiry and can be
revoked from the popup.

## Capture

Use one of two explicit modes:

- **Selection**: select rendered text in the active top frame, then open the
  popup. Exact selection text stays in provenance even if you edit the final
  Markdown.
- **Reader**: open the popup without a usable selection and extract a
  constrained visible-page structure: paragraphs, headings, lists, quotes,
  code, horizontal rules, text, and validated HTTP(S) links.

Review the source metadata, optional authenticated-visible disclosure,
destination, tags, collision policy, normalized Markdown, provenance, warnings,
and digest. Any edit to content, metadata, destination, tags, mode, extraction,
or authenticated-visible state invalidates the preview. Preview again, then
confirm the write.

The gateway does not accept arbitrary HTML. Scripts, styles, forms,
navigation/aside content, hidden/inert/`aria-hidden` nodes, tracking content,
images, media, canvas, SVG, MathML, iframes, embeds, objects, dangerous links,
and background-tab content are excluded. Cross-frame selection is unsupported.
The gateway never fetches the source/canonical URL or any referenced resource.

The closed warning vocabulary is:

- `authenticated_visible_content`
- `canonical_url_differs`
- `edited_content`
- `line_endings_normalized`
- `reader_partial`
- `selection_truncated`
- `spa_snapshot`
- `unicode_normalized`

## Preview, provenance, and collision results

Preview is non-mutating and server-owned. A write must send the unchanged
payload, matching `previewDigest`, and one visible-ASCII idempotency key. The
server reparses and replans before committing through the normal atomic capture
path.

Browser-clip provenance contains exactly:

- `extractionHash`: selected text or constrained Reader extraction
- `finalBodyHash`: final normalized Markdown
- `clipIdentity`: source plus extraction/final identity
- `previewDigest`: exact preview and destination plan

Browser clips do not use `sourceHash`.

The wire result is closed and status-bound:

| HTTP  | Result                                                                    |
| :---- | :------------------------------------------------------------------------ |
| `200` | valid receipt with `opened_existing`                                      |
| `202` | valid receipt with `created`, `created_with_suffix`, or `overwritten`     |
| `409` | valid provenance `conflict` receipt, or its matching closed clipper error |

`open_existing` opens only when stored `clipIdentity` matches. Missing or
different browser provenance, or the same extraction with a changed final
body, returns `conflict` without writing. `create_with_suffix` creates a
separate note and reports `created_with_suffix`.

Unknown versions, fields, codes, non-JSON bodies, and impossible status/body
combinations fail closed. `CLIPPER_OFFLINE`, `CLIPPER_INVALID_RESPONSE`, and
`CLIPPER_CLIENT` are client-only classifications, not server
`clipper-error@1.0` codes.

## Recovery

The service worker allows one logical write at a time. Before the request, it
saves exactly `{payload, previewDigest, idempotencyKey}`. Reopening the popup
shows the pending destination and source:

- **Retry saved write** reuses the same payload, digest, and key.
- If the server lost only the preview ticket, the worker refreshes the preview
  for the same payload and resumes.
- A completed receipt is replayed for the same key.
- A different capture is refused while recovery is pending.
- **Stop recovery** explicitly discards the local pending write.

Plan, file, key, or provenance drift fails closed. Recovery never chooses a new
path or silently creates a suffix.

## Privacy and security

All clipper traffic stays on literal loopback `127.0.0.1`. The manifest grants
only:

- `activeTab`
- `scripting`
- `storage`
- `http://127.0.0.1/*`

`chrome.storage.session` holds the unfinished pairing request. Protected
`chrome.storage.local` holds the loopback origin, plaintext grant ID/token and
expiry, and at most one pending payload/digest/key. The extension does not use
sync storage. SQLite stores only the grant-token hash, exact extension origin,
fixed capture scope, expiry/revocation metadata, and bounded idempotency
receipts.

The clipper never reads or exports browsing history, cookies, sessions,
passwords, other tabs, iframe documents, or raw HTML. It does not bypass
paywalls. If a page contains authenticated content, only content already
visible to the user can be captured, and the user must mark that disclosure in
the preview.

Every request requires the actual TCP peer to be loopback, the exact listener
Host, and the exact approved Origin. Approval is same-origin plus CSRF;
extension CORS/PNA responses allow only the validated extension origin, never
wildcards or credentials. Clipper grants authorize capture only. MCP/API bearer
tokens and `gateway.enableWrite` do not authorize clipping, and clipper routes
are structurally absent from non-loopback listeners.

See [REST API](../API.md#browser-clipper-boundary) for the exact route and
response contracts and [Troubleshooting](../TROUBLESHOOTING.md#browser-clipper-issues)
for recovery help.
