---
title: Typed metadata filters
description: Filter local retrieval with explicit custom strings, numbers, booleans, and arrays.
---

# Typed metadata filters

Custom metadata is opt-in. Put fields in a nested YAML `gno.metadata` mapping;
a literal `gno.metadata:` key is not the namespace. Existing tags, dates, authors,
categories, and collection/path filters keep their existing behavior.

```markdown
---
title: Atlas rollout decision
tags: [decision]
gno:
  metadata:
    project: atlas
    status: approved
    confidence: 0.9
    archived: false
    reviewers: [ana, sam]
---

The Atlas rollout is approved.
```

After saving the note in an indexed collection, run `gno update`. Then:

```bash
gno search "rollout" --filter '{"op":"eq","key":"status","value":"approved"}'
gno query "rollout decisions" --filter '{"op":"and","predicates":[{"op":"eq","key":"project","value":"atlas"},{"op":"gte","key":"confidence","value":0.8}]}'
gno context build "Atlas rollout" --filter '{"op":"all","key":"reviewers","values":["ana","sam"]}'
```

`--filter` accepts JSON on search, vector search, hybrid/structured query,
query diagnosis, ask, and Context Capsule building. SDK, MCP, and REST inputs
accept the same object in `filter`. It intersects collection/path, exclusions,
authority, egress, and memory visibility before candidate limits. It cannot
expand access. No model or background service is needed to extract metadata.

## Types and operators

Strings match exactly, including case. `0.9` is a number; `"0.9"` is a string.
`false`, `0`, `""`, and an empty array are present values. Values may be strings,
finite numbers, booleans, or flat arrays containing one scalar type. Null,
nested objects, mixed arrays, and non-finite numbers are invalid. Quote dates
when they are intended as strings. YAML aliases must resolve to the same bounded, flat value types; nested or cyclic values are invalid.

| Predicate                | Input                                | Meaning                                                            |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------ |
| `eq`, `ne`               | `key`, scalar `value`                | Scalar field has the same type and equals/does not equal the value |
| `gt`, `gte`, `lt`, `lte` | `key`, numeric `value`               | Numeric ordering; no string coercion                               |
| `in`, `nin`              | `key`, nonempty homogeneous `values` | Present scalar/array has any/no matching member                    |
| `all`                    | `key`, nonempty homogeneous `values` | Array contains every requested member                              |
| `exists`                 | `key`, boolean `value`               | Field is present/absent                                            |
| `and`, `or`              | nonempty `predicates`                | Every/any child matches                                            |
| `not`                    | one `predicate`                      | Negates the complete child result                                  |

Array equality is unsupported. `ne` does not match a different scalar type;
`nin` tests the absence of exact typed members in a present scalar or array.

## Missing fields and invalid documents

For a valid document and a string comparison against `"approved"`:

| Stored `status` | `eq`  | `ne`  | `not(eq)` | `exists: false` |
| --------------- | ----- | ----- | --------- | --------------- |
| `"approved"`    | true  | false | false     | false           |
| `"draft"`       | false | true  | true      | false           |
| missing         | false | false | true      | true            |
| `false`         | false | false | true      | false           |

`nin` also requires presence; `not(in)` can match a missing key. Documents with
invalid metadata or pending extraction are excluded from **every** typed filter,
including `not` and `exists: false`. A document without the namespace has a valid
empty map. Unfiltered search remains available for invalid documents.

## Repair and coverage

Upgraded indexes use the normal `gno update` repair path (ingest version 7).
Progress is tracked per document, so interrupted sync can resume. Re-extracting
unchanged text does not require new embeddings; actual content changes retain
normal embedding rules. GNO never rewrites source notes during this repair.

Filtered responses warn when relevant documents still need re-ingestion or
contain invalid metadata. An empty result with a coverage warning is not proof
that no matching document exists. Correct the source YAML and sync again.
Filtered Capsules may still use eligible evidence: version 1.2 records
`metadata_coverage_incomplete` and `coverage.complete: false` while metadata
coverage is incomplete. Conversion failures without searchable content are
reported as ingestion errors, not a permanent typed-metadata backfill backlog.
Use `gno query diagnose "rollout" --target <uri-or-path> --filter '<JSON>'`
before relaxing a predicate: metadata backfill, invalid metadata, and predicate
mismatch are distinct eligibility reasons. Diagnostics do not echo excluded
field values.

## Limits and persisted context

At most 64 keys per document, 128 characters per key, 4,096 characters per
string, and 128 members per array. Serialized metadata and filters each have a
64 KiB limit; frontmatter parsing is also bounded. Predicates allow at most
128 nodes and depth 8. Empty logical groups/membership operands and keys
`__proto__`, `prototype`, and `constructor` are rejected. Invalid request
predicates fail validation; they are never silently discarded.

Filtered Context Capsules use contract version 1.2 and retain the normalized
predicate in scope. Existing filter-free 1.0/1.1 Capsules remain valid. Private
retrieval traces retain filters for identity, verification, and replay. These
records may contain user-supplied filter values: handle them with the same
privacy care as queries. Filters do not change source egress policy.
