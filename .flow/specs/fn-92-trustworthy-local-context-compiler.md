# fn-92 Trustworthy Local Context Compiler Program

## Goal & Context
<!-- scope: business -->

Establish the exclusive next-work lane for GNO: evolve the product into a trustworthy local context compiler for agents. This master spec is an ordering authority only. It preserves the exact sequence agreed after the competitive/product audit and makes clear that unrelated open specs are paused unless Gordon explicitly reprioritizes them.

## Architecture & Data Models
<!-- scope: technical -->

No product architecture is defined here. Detailed architecture belongs to the child specs. Execute the first incomplete item in this list; each detailed spec depends on its predecessor so Flow exposes the same sequence mechanically.

1. `fn-93` Retrieval Context Propagation Correctness
2. `fn-94` Retrieval-Proven Setup and Connector Activation
3. `fn-95` Public Documentation and Multilingual Claim Truth
4. `fn-96` CJK Lexical Degradation Benchmark
5. `fn-97` Agentic Retrieval Outcome Benchmark
6. `fn-98` Context Capsule MVP
7. `fn-99` Resident Local Context Gateway
8. `fn-100` Private Retrieval Learning Loop
9. `fn-101` Trustworthy Synthesis and Claim Verification
10. `fn-102` Knowledge Delta and Capsule Reverification
11. `fn-103` Capsule Distribution and Commercial Proof
12. `fn-104` Project-Aware Retrieval Affinity
13. `fn-105` Verified Folder Setup
14. `fn-106` Browser Clipper with Provenance
15. `fn-107` Project-Local Retrieval Profiles
16. `fn-108` Explainable Content-Type Search Boosts
17. `fn-109` CJK Lexical Normalization
18. `fn-110` File and Export-First Source Adapters
19. `fn-111` Collection Egress Policies

## API Contracts
<!-- scope: technical -->

No runtime API. Flow contract: the ordered IDs above are canonical; detailed specs own requirements, contracts, tasks, readiness, and evidence. Reordering requires an explicit user decision and an update to this master plus affected spec dependencies.

## Edge Cases & Constraints
<!-- scope: technical -->

- Existing open specs are neither deleted nor implicitly completed; they are outside this priority lane.
- A completed, invalidated, or deliberately skipped item must be recorded before advancing.
- Detailed specs remain unready until their normal human readiness gate; this master does not authorize implementation by itself.
- Dependencies express sequencing, not a requirement to combine releases.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** The master lists all 19 agreed detailed specs once, in the agreed order.
- **R2:** Every listed ID resolves to a full seven-section Flow spec with testable R-IDs.
- **R3:** `fn-94` through `fn-111` each depend on the immediately preceding program spec; `fn-93` is the first executable item.
- **R4:** No unrelated existing spec is closed, rewritten, or placed ahead of this lane.
- **R5:** This master contains no implementation tasks or product requirements beyond sequencing governance.

## Boundaries
<!-- scope: business -->

No implementation, task breakdown, release promise, date commitment, legacy-backlog cleanup, or automatic readiness changes. The master does not supersede detailed acceptance criteria.

## Decision Context
<!-- scope: both — conditionally substructured -->

### Motivation
<!-- scope: business -->

GNO already has broad local retrieval, workspace, graph, capture, SDK, Web, and desktop capabilities. The next constraint is trustworthy agent handoff, measurable outcomes, and operational simplicity—not more disconnected features.

### Implementation Tradeoffs
<!-- scope: technical -->

A thin ordering spec avoids duplicating child requirements. A linear dependency chain trades some theoretical parallelism for a clear execution queue and prevents unrelated open backlog items from becoming the accidental next task.

## Program Planning State

The detailed program is implementation-planned as 82 bounded tasks. The master remains intentionally taskless: it is the ordering and governance surface, while each child owns its implementation plan and evidence.

| Order | Spec | Planned tasks | Program role |
| ---: | --- | ---: | --- |
| 1 | `fn-93` | 3 | Repair retrieval context propagation |
| 2 | `fn-94` | 4 | Prove setup and connector activation with retrieval |
| 3 | `fn-95` | 3 | Restore public documentation and claim truth |
| 4 | `fn-96` | 3 | Establish the CJK lexical degradation evidence |
| 5 | `fn-97` | 4 | Establish agent-outcome benchmark infrastructure |
| 6 | `fn-98` | 6 | Ship the Context Capsule evidence primitive |
| 7 | `fn-99` | 5 | Share one resident warm runtime across clients |
| 8 | `fn-100` | 5 | Capture private outcome receipts and replay them |
| 9 | `fn-101` | 4 | Verify answer claims against exact evidence |
| 10 | `fn-102` | 5 | Journal knowledge changes and reverify capsules |
| 11 | `fn-103` | 4 | Distribute public capsules and prove the wedge |
| 12 | `fn-104` | 4 | Add transparent project-aware affinity |
| 13 | `fn-105` | 4 | Make folder setup end in successful retrieval |
| 14 | `fn-106` | 4 | Capture browser evidence with provenance |
| 15 | `fn-107` | 4 | Add source-controlled project retrieval profiles |
| 16 | `fn-108` | 4 | Activate bounded explainable content-type boosts |
| 17 | `fn-109` | 4 | Ship CJK normalization only if evidence supports it |
| 18 | `fn-110` | 6 | Add deterministic file/export source adapters |
| 19 | `fn-111` | 6 | Enforce collection egress policy at network boundaries |
|  | **Total** | **82** |  |

### Quick commands

```bash
.flow/bin/flowctl show fn-92
.flow/bin/flowctl ready --spec fn-93
.flow/bin/flowctl tasks --spec fn-98
.flow/bin/flowctl deps fn-111
.flow/bin/flowctl validate --all --json
```

### References

- Detailed contracts and implementation plans: `.flow/specs/fn-93-*.md` through `.flow/specs/fn-111-*.md`
- Program research basis: competitive audit of GNO, qmd, and gbrain; agentic-retrieval evaluation literature; official MCP Streamable HTTP and Bun server guidance
- Existing product contracts: `spec/cli.md`, `spec/mcp.md`, `spec/output-schemas/`, and `spec/db/schema.sql`

### Early proof point

The first proof is `fn-93.1`: a failing cross-mode regression fixture that demonstrates persisted configured context is absent from an otherwise valid retrieval result. The program does not advance past any child whose acceptance evidence is missing, invalidated, or below its explicit gate.

## Requirement coverage

| Requirement | Coverage | Gap or deferred work |
| --- | --- | --- |
| R1 | Ordered table above contains each of `fn-93` through `fn-111` exactly once. | None. |
| R2 | Each child has a seven-section contract, bounded task plan, investigation targets, acceptance tests, and R-ID mapping. | Human readiness remains a separate gate. |
| R3 | Flow dependency metadata forms the exact predecessor chain from `fn-94` back to `fn-93`. | None. |
| R4 | Planning changed only this program lane; unrelated specs retain their state and content. | Future reprioritization requires Gordon's explicit direction. |
| R5 | No tasks are attached to `fn-92`; all 82 implementation tasks belong to child specs. | Governance is intentionally taskless. |
