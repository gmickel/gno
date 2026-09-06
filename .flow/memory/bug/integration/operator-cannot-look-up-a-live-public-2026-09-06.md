---
title: Operator cannot look up a live public publication by URL
date: "2026-09-06"
track: bug
category: integration
module: moderation
tags: [qa, fn-155, moderation, resolved-fixture]
problem_type: integration
symptoms: Live public reader URL returns publication not found in operator lookup
root_cause: (observed via live QA - unconfirmed)
resolution_type: fix
last_updated: "2026-09-06"
related_to: [bug/integration/reader-opens-a-relative-markdown-note-2026-09-05]
---

## Problem
The synthetic operator cannot find a live public publication by its supported public URL. Reproduced twice.

## Steps to reproduce (cold)
1. Sign in to http://localhost:3345 as synthetic operator@fn155.test.
2. Open /moderation.
3. Enter https://gno.sh/share/fn155-owner/db-agent-space and click Look up publication.
4. After loading finishes, observe the not-found message. Repeat lookup; same result.
5. The corresponding local reader /share/fn155-owner/db-agent-space serves DB Agent Atlas.

## Expected
"Operator lookup accepts a validated public-route identity or exact target ID and returns only the metadata needed for review."

## Actual
Public publication not found. Use the exact target ID for deleted content.

## Evidence
- screenshot: .flow/tmp/qa-fn-155-public-share-abuse-reporting-and/operator-public-url-not-found.png
- console: .flow/tmp/qa-fn-155-public-share-abuse-reporting-and/operator-console.log
- text: .flow/tmp/qa-fn-155-public-share-abuse-reporting-and/operator-public-url-not-found.txt
- url: http://localhost:3345/moderation

## Traceability
- R2, R8; scenario S3; agent-browser; desktop viewport.
- Initial severity P1: public URL lookup is broken; exact target ID is the alternative input under investigation.

## Update 2026-09-06

## Problem
The synthetic operator cannot find a live public publication by its supported public URL. Reproduced twice.

## Steps to reproduce (cold)
1. Sign in to http://localhost:3345 as synthetic operator@fn155.test.
2. Open /moderation.
3. Enter https://gno.sh/share/fn155-owner/db-agent-space and click Look up publication.
4. After loading finishes, observe the not-found message. Repeat lookup; same result.
5. The corresponding local reader /share/fn155-owner/db-agent-space serves DB Agent Atlas.

## Expected
"Operator lookup accepts a validated public-route identity or exact target ID and returns only the metadata needed for review."

## Actual
Public publication not found. Use the exact target ID for deleted content.

## Evidence
- screenshot: .flow/tmp/qa-fn-155-public-share-abuse-reporting-and/operator-public-url-not-found.png
- console: .flow/tmp/qa-fn-155-public-share-abuse-reporting-and/operator-console.log
- text: .flow/tmp/qa-fn-155-public-share-abuse-reporting-and/operator-public-url-not-found.txt
- url: http://localhost:3345/moderation

## Traceability
- R2, R8; scenario S3; agent-browser; desktop viewport.
- Initial severity P1: public URL lookup is broken; exact target ID is the alternative input under investigation.

## Resolution
This was a synthetic fixture handoff issue, not a product lookup failure. Existing account bootstrap canonicalized owner_slug from fn155-owner to owner. A fresh old-route request returns 404; /share/owner/db-agent-space returns 200 and lookup of https://gno.sh/share/owner/db-agent-space returns Not restricted. Exact target ID lookup also succeeds. The earlier browser was displaying pre-bootstrap content. No product-code fix required. Fixture URLs must be captured after account/bootstrap initialization. Product finding closed after the canonical route was verified.
