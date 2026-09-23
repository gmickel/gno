# Preserve retrieval coverage warnings for MCP agents

## Goal & Context

MCP text responses must not present incomplete filtered retrieval as authoritative absence. Coverage warnings already exist in structured results; text-only clients need the same information.

## Acceptance Criteria

- **R1:** Search, vector search and hybrid query expose every existing retrieval warning in MCP text for empty and nonempty results. Keep structured warnings and warning-free response text unchanged. Verified Ask text exposes the Capsule metadata coverage warning.
- **R2:** All MCP inputs accepting typed metadata predicates explain that incomplete coverage does not establish absence, requested filters must be preserved, and diagnosis with the same filter applies when an expected target is known. Reuse concise guidance without expanding the agent protocol block.
- **R3:** Regression tests exercise actual MCP responses and advertised schemas, including incomplete, unknown and complete coverage. Real stdio MCP QA uses an isolated config/index and synthetic source documents.
- **R4:** Update affected repository MCP contracts/docs and changelog. Existing hosted metadata guidance already documents incomplete-coverage semantics; no site behavior or claims change. No version bump, tag, deployment or publication; deliver with the next product release alongside fn-169.

## Boundaries

No changes to predicate semantics, ranking, the retrieval ladder, the v3 agent block, canonical personal instructions or vault conventions. No fn-169 implementation in this fix.
