# Request-local hydration fixture

`fixture.ts` generates 1,000 complete chunks, including UTF-8 and CRLF text.
`manifest.json` pins the SHA-256 of `JSON.stringify(hydrationLongDocument())`;
this is a separate fixture identity and does not refresh fn-143's frozen pins.

Run `bun test ./test/pipeline/hydration.test.ts` for paired uncached/cached
search results and actual deterministic reranker-port arguments using fn-143's
exact comparator. The stale-input control must fail that comparator. The test
counts store calls, hydrated rows and UTF-8 text bytes across stages. These are
unit-level allocation/read observations, not native-model or live QA evidence.

The helper caches raw snapshots only. Integrating callers create one owner per
request, pass it across stages and call `release()` in `finally`. An optional
abort signal releases ownership too. Release rejects new loads but permits
pending reads and existing snapshots to finish. Returned maps and document
result arrays belong to callers; cached rows/chunk arrays are frozen, so a
consumer that mutates them must copy first. No transaction or model context is
retained. No model-specific prepared input is cached.
