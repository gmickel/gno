# GNO Browser Clipper privacy

The GNO Browser Clipper captures content only after you click the extension and
choose Selection or Reader capture. It sends that explicit payload to the GNO
gateway on `http://127.0.0.1`; it does not contact GNO cloud services.

## What can be captured

- Selection mode captures the exact rendered text you selected in the active,
  top-level tab.
- Reader mode captures a constrained visible-content structure: headings,
  paragraphs, lists, quotes, code, rules, and safe links.
- Source URL, canonical URL, title, author/site metadata, visible-page dates,
  capture time, browser metadata, destination, tags, note, and edits accompany
  the capture.
- If a signed-in page visibly shows content to you, that visible content can be
  captured. The preview warns when you identify a capture as authenticated.

The clipper excludes hidden, inert, or `aria-hidden` content; scripts, styles,
forms, navigation, sidebars, embeds, iframes, images and media, canvas, SVG,
MathML, raw HTML, and dangerous links. Large or dynamic Reader captures can be
partial and are disclosed in the preview.

## Local state and retention

`chrome.storage.local`, restricted to trusted extension contexts, stores the
loopback gateway origin and the usable grant ID, plaintext grant token, and
expiry. While a confirmed write awaits recovery it also stores exactly one
payload, preview digest, and idempotency key. That payload can contain the
selected text or Reader content until the write succeeds or you choose **Stop
recovery**.

`chrome.storage.session` temporarily stores the pairing ID, eight-digit code,
gateway and extension origins, approval path, and expiry. It is cleared after
approval or terminal failure and does not survive a browser restart.

The resident gateway stores only a hash of the grant token plus bounded grant
metadata, revocation/expiry state, and bounded idempotency receipts. Pairing
requests are memory-only and die when the gateway restarts. Created notes and
their provenance remain in the destination you chose until you delete them.

Use **Revoke browser access** to revoke the resident grant and remove the local
grant and pending write. Browser extension removal clears extension-managed
state, but does not delete notes already created in GNO.

## What the clipper does not access or send

The clipper does not request browsing-history or cookie permissions. It does
not export cookies, sessions, passwords, browser history, background tabs, or
raw page HTML. It does not bypass paywalls, fetch source pages or linked
resources remotely, watch browsing in the background, clip autonomously, use
OAuth, sync extension state, or collect telemetry.

The manifest permissions are limited to `activeTab`, `scripting`, `storage`,
and exact loopback host access at `http://127.0.0.1/*`.
