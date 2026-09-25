---
title: Blanket /api JSON redaction rewrote original-file downloads
date: "2026-09-25"
track: bug
category: integration
module: src/serve/host-path-redaction.ts
tags: [fn-181, host-paths, doc-asset, redaction]
problem_type: integration
symptoms: JSON source served by /api/doc-asset lost keys; Range slices threw
root_cause: content-type gate treated original JSON files as API envelopes
resolution_type: fix
---

## Problem
A route-table wrapper that deep-stripped `absPath` from every `/api/*` JSON response for remote callers also rewrote `/api/doc-asset`, which streams the owner's original file bytes with the file's own MIME type. A JSON source file lost its own `absPath` keys, and a Range (206) slice containing `"absPath"` threw in `JSON.parse`.

## What Didn't Work
Gating on `content-type: application/json` alone: original-file routes carry the source file's MIME type, so a JSON document looks like an API envelope.

## Solution
`src/serve/host-path-redaction.ts` exempts source-byte routes (`SOURCE_BYTE_ROUTES = {"/api/doc-asset"}`); a regression test in `test/spec/schemas/host-paths.test.ts` pins byte-for-byte passthrough.

## Prevention
Any response-body transform applied across `/api/*` must enumerate routes that serve owner bytes (doc-asset, future downloads) and test them with a JSON source and a Range request.
