# Glossary

## Collection

A named set of source files rooted at one directory and governed by its own matching, context, model, and egress configuration. A collection is GNO's primary source boundary, not a folder copied into GNO.

_Relates to_: [Source](#source), [Egress Policy](#egress-policy)

## Source

The original caller-owned file on disk. GNO indexes and derives data from a source but does not treat its canonical mirror, chunks, embeddings, or published projections as the source itself.

_Relates to_: [Mirror](#mirror), [Document](#document)

## Mirror

GNO's canonical Markdown representation of a source, identified by a content hash and used for indexing and deduplication. Multiple sources may resolve to the same mirror without losing their distinct provenance.

_Relates to_: [Source](#source), [Document](#document)

## Document

The indexed logical record for one source, addressed by a stable GNO URI or document ID and carrying provenance back to that source. Document-level metadata and lexical retrieval remain distinct from the chunks derived for semantic retrieval.

_Relates to_: [Chunk](#chunk), [Virtual URI](#virtual-uri)

## Chunk

A bounded segment derived from a document for embedding, semantic retrieval, citation, and evidence assembly. Chunks are retrieval units with source lineage; they are not independently owned notes.

_Relates to_: [Document](#document), [Context Capsule](#context-capsule)

## Virtual URI

GNO's stable `gno://collection/path` identifier for an indexed document. It is the canonical reference used across retrieval and read surfaces even when the underlying source lives at a filesystem path.

_Avoid_: URI

## Context

A human-authored semantic hint attached globally, to a collection, or to a path prefix to improve retrieval interpretation. Context guides ranking; it is not retrieved evidence and must not be presented as source support.

_Relates to_: [Collection](#collection), [Context Capsule](#context-capsule)

## Context Capsule

A deterministic, bounded evidence bundle compiled for one goal, containing exact source spans, hashes, a shared token budget, deduplication decisions, and declared retrieval gaps. A Capsule is the reusable handoff between retrieval and an agent, not a generated answer.

_Avoid_: context bundle, evidence pack

## Verified Answer

An answer generated against one closed Context Capsule whose substantive claims are classified and linked to supporting spans. If complete support cannot be established, verification withholds the draft and reports the failing claim instead of silently weakening the standard.

_Relates to_: [Context Capsule](#context-capsule), [Retrieval Diagnosis](#retrieval-diagnosis)

## Retrieval Proof

A real corpus-derived lexical hit used to prove that a configured folder is searchable. It is stricter than process liveness, successful indexing, model readiness, or a green health indicator.

_Avoid_: health check, readiness check

## Retrieval Diagnosis

The stage-by-stage explanation of whether and why a target document appeared in lexical retrieval, vector retrieval, fusion, graph expansion, and reranking. It distinguishes a candidate-generation miss from a ranking miss.

_Avoid_: retrieval explain

## Content Type

An optional schema-lite document classification declared in collection configuration. A matching frontmatter `type` becomes canonical `contentType`; unmatched values remain ordinary categories rather than silently becoming schemas.

_Relates to_: [Note Preset](#note-preset), [Document](#document)

## Note Preset

A built-in capture scaffold that emits flat frontmatter and useful section headings for recurring note shapes such as people, companies or projects, meetings, and original ideas. A preset shapes a new source note; it does not impose a database schema.

_Relates to_: [Content Type](#content-type), [Source](#source)

## Positional Link

A Markdown or wiki link whose relationship comes from where it appears in source text. Positional links support navigation and backlinks but remain distinct from explicitly typed semantic relationships.

_Avoid_: untyped edge

## Typed Edge

A semantic relationship in GNO's derived graph layer with an explicit relation label such as `mentions`, `works_at`, or `decided`. Typed edges are rebuilt from source declarations and graph hints; GNO does not mutate source files to store them.

_Avoid_: link

## Knowledge Delta

GNO's bounded, metadata-first history of source and structural changes, exposed through change, diff, and impact surfaces. It explains what changed and what may be affected without becoming a second source-control system.

_Avoid_: audit log, version control

## Project Affinity

A bounded, explainable soft ranking signal derived from a trusted local project root. It may reorder otherwise eligible results but never overrides hard filters, probes untrusted paths, or changes stored document identity.

_Avoid_: project filter

## Egress Policy

A per-collection fail-closed boundary describing where derived material may go: local-only, LAN, or remote. The policy is inherited by Capsules, traces, and exports so later workflows cannot silently loosen the source boundary.

_Distinct from_: [Source Availability](#source-availability)

_Avoid_: privacy mode

## Source Availability

A per-collection indexing policy (`any` | `local`) that controls whether source **content may be materialized** during walk, sniff, hash, conversion, targeted sync, and watch-triggered ingestion. Default `any` preserves legacy reads. Opt-in `local` refuses cloud-placeholder materialization on the macOS File Provider layouts covered by physical evidence (Google Drive, iCloud Drive, and OneDrive only for the tested OS/provider configuration and both validated immediate SharePoint library roots). Local mode uses process-scoped no-materialization I/O policy, hierarchical per-directory availability classification, and a guarded content recheck; it does not pin, evict, or download as product behavior. Unsupported platforms/filesystems and policy setup failures fail closed. Metadata or provider bookkeeping may still occur; source availability is not a promise of zero provider-process network activity. Source availability is not egress policy: availability gates source materialization; egress gates where derived data may travel.

_Relates to_: [Collection](#collection), [Source](#source), [Egress Policy](#egress-policy)

_Avoid_: cloud sync policy, offline mode, egress policy

## Resident Gateway

The long-lived runtime shared by `gno serve` and `gno daemon`, hosting indexing jobs, watchers, stores, models, and Streamable HTTP MCP over one index. It is a lifecycle boundary, not an additional copy of the knowledge base.

_Avoid_: MCP daemon

## Publish Artifact

A caller-created, portable projection of one note or collection for deliberate publishing. It contains only the selected material and provenance allowed by policy; it is not a live mount or automatic synchronization of the source collection.

_Avoid_: hosted collection, sync

## GNO Recall

Working name for the GNO Omarchy shell plugin: a quiet bar widget plus a summonable, keyboard-first overlay for recall and quick browse of the local GNO index.
