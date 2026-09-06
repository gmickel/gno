---
satisfies: [R3]
---
# fn-136-pdf-viewing-over-a-remote-link.1 Server HTTP hygiene: ETag/304 on doc-asset, gzip + immutable SPA chunks

## Description
Implement R3. Add a strong ETag and conditional 304 handling to `/api/doc-asset`, replace its `no-store` policy, and serve hashed SPA chunks gzip-encoded with an immutable cache policy. Split as one task because both halves are server header work with adjacent tests and no client dependency.

**Size:** M
**Files:** `src/serve/routes/api.ts` (handleDocAsset), `src/serve/server.ts` (public SPA fetch fallback), `src/serve/spa-bundle-source.ts` (only if a per-file precomputed gzip cache is exposed from the source), `test/serve/api-doc-assets.test.ts`, `test/serve/fn112-doc-asset-bytes.test.ts`, `test/serve/spa-bundle-source.test.ts`, `test/serve/spa-first-chunk.test.ts`, `docs/API.md`
**Touches:** [src/serve/routes/api.ts, src/serve/server.ts, src/serve/spa-bundle-source.ts, test/serve/api-doc-assets.test.ts, test/serve/fn112-doc-asset-bytes.test.ts, test/serve/spa-bundle-source.test.ts, test/serve/spa-first-chunk.test.ts, docs/API.md]

### Approach
- In `handleDocAsset` (`src/serve/routes/api.ts:2191-2306`) build the header set once, then add `ETag` from `Bun.file(...).lastModified` plus `size` (strong, quoted). Check `If-None-Match` before the Range branch: on match return 304 with no body and the same `ETag`, `Cache-Control`, and `Accept-Ranges` headers; on mismatch fall through unchanged. Replace `Cache-Control: no-store` with `private, max-age=0, must-revalidate`. Keep every existing Range, HEAD, and 416 branch byte-identical; the fn-112 byte tests pin them.
- Encoding negotiation happens in the public fetch fallback in `src/serve/server.ts:1298-1315`, never inside the private source. `hostPrivateSource` (`src/serve/spa-bundle-source.ts:103-150`) re-issues the internal request with only its method, so `Accept-Encoding` never reaches `fetchAsset`. In the fallback, after `spaBundleSource.fetch(req)` returns, branch on the hashed-chunk path shape: read the original `req.headers.get("accept-encoding")`, and when it lists gzip replace the body with a gzip body computed once per pathname (`Bun.gzipSync`, Bun-first rule, cached in a `Map` keyed by pathname) and set `Content-Encoding: gzip`, `Vary: Accept-Encoding`, `Content-Length`, and the immutable cache-control string already exported at `src/serve/pdfjs-assets.ts:28`. Identity clients get the original body with the same cache headers. The entry HTML path (`spaInternalPath`) keeps its existing headers and ETag pass-through (`server.ts:329-373`).
- Tests go through the public production fallback (a real `Bun.serve` request with and without `Accept-Encoding: gzip`), not only through the source in isolation. The three `no-store` assertions in `test/serve/api-doc-assets.test.ts` (lines about 76, 174, 494) are rewritten deliberately.
- Update `docs/API.md` "Get Document Asset" headers table (line about 1421-1439; it claims `no-store` today) and add a short static-assets note next to the vendor asset section.

### Investigation targets
**Required** (read before coding):
- `src/serve/routes/api.ts:2191-2306` — handleDocAsset, Range/HEAD/416 branches to preserve
- `src/serve/server.ts:329-373` and `:1298-1315` — SPA HTML ETag cache and the public fetch fallback
- `src/serve/spa-bundle-source.ts:60-150` — in-memory chunk serving and the private-source request reconstruction that drops headers
- `test/serve/fn112-doc-asset-bytes.test.ts` — byte-exact Range pins that must keep passing

**Optional** (reference as needed):
- `src/serve/pdfjs-assets.ts:28` — immutable cache-control constant to reuse
- `test/serve/spa-first-chunk.test.ts` — first-chunk test shape

### Key context
- `Bun.serve` does not compress responses on its own; nothing in `src/serve` compresses today.
- The fn-112 spec chose `no-store` deliberately; this task overrides it with a validator, which is recorded in the spec's Decision context.
- Run `bun install --frozen-lockfile` first; node_modules is absent in a fresh checkout.
## Acceptance
- [ ] GET and HEAD on `/api/doc-asset` return `ETag`; a matching `If-None-Match` returns 304 with an empty body and no `Content-Length` mismatch; a mismatched validator on a Range request returns the normal 206
- [ ] `Cache-Control` on doc-asset is `private, max-age=0, must-revalidate`; Range, suffix-range, and multi-range behaviour unchanged (fn-112 byte tests pass); the three `no-store` assertions are rewritten deliberately
- [ ] Through the public production fallback, a hashed chunk request with `Accept-Encoding: gzip` returns a gzip body with `Content-Encoding: gzip`, `Vary: Accept-Encoding`, a matching `Content-Length`, and `public, max-age=31536000, immutable`; a request without gzip acceptance returns the identity body with the same cache headers; the entry HTML response headers are unchanged
- [ ] The gzip body for a pathname is computed once and reused across requests
- [ ] `docs/API.md` doc-asset section updated; `bun test` and `bun run lint:check` pass
## Done summary
Implemented R3 server HTTP hygiene. `/api/doc-asset` returns a strong ETag (size + mtime), answers a matching If-None-Match with an empty 304 before Range handling (HEAD included), and sends `private, max-age=0, must-revalidate` instead of `no-store`. The public listener's catch-all fetch is now `createPublicFetchFallback`: hashed `/chunk-*.js|css` responses gain the immutable one-year policy, `Vary: Accept-Encoding`, and a gzip body computed once per pathname when the client accepts gzip (wildcard `*` honoured); identity clients get the original bytes with the same cache headers; HEAD mirrors GET headers on both paths; entry HTML and dev mode untouched. docs/API.md documents the new headers, 304, and the static-assets policy. One edit outside the declared Touches (a fourth `no-store` pin in test/serve/fn112-production-routes.test.ts) was required to keep the suite green.

Review round 1 (NEEDS_WORK) found the identity HEAD Content-Length regression, the `*` Accept-Encoding gap, and four P3 notes; all fixed in the review-fix commit. Round 2: SHIP, with one non-blocking P3 (no in-flight dedupe of the gzip cache) left as a follow-up.

stage: wave-join - ran (cherry-pick of the worker commit onto the target; no collision)
stage: impl-review - ran [round 1 NEEDS_WORK -> fixes -> round 2 SHIP] (model: claude-opus-5 via harness subagent, host backend)
stage: plan-sync - skipped(config: planSync.enabled != true)

2026-09-06 reconciliation: restored completion state from this existing summary and merged PR #206. Gordon confirmed all remaining work was completed and requested spec closure. Earlier BLOCKED/UNMET observations above are historical and superseded by that confirmation.
## Evidence
- Commits: 104311362a53d057803e6805f805bf16d7c1e40c, c37bc1389d79b93f67b1a183ac504f765d356cc4, d17ac7d8577c87fbd14a072deef3f39db121edae
- Tests: bun test test/serve/api-doc-assets.test.ts test/serve/fn112-doc-asset-bytes.test.ts test/serve/spa-bundle-source.test.ts test/serve/spa-first-chunk.test.ts test/serve/fn112-production-routes.test.ts test/serve/security.test.ts -> 56 pass, 0 fail (integrated target), bun run lint:check -> clean, worker: bun test test/serve -> 832 pass, 0 fail (workspace)
- PRs: https://github.com/gmickel/gno/pull/206