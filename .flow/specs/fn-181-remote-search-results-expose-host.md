# Remote search results expose host absolute paths

## Goal & Context
<!-- scope: business; source: inferred -->

Remote callers of the REST search route receive `source.absPath`, the host's absolute file path, for every hit. That reveals the owner's home directory and archive or vault layout to any client that can call the API, which conflicts with the rule that remote clients cannot discover host directories. Decide which surfaces are "remote" for this purpose and stop exposing host paths there without breaking local owner workflows that open files.

## Architecture & Data Models
<!-- scope: technical; source: inferred -->

Inventory every remote-reachable output that carries a host absolute path (REST search/query/get/ask payloads, MCP HTTP results, share/export payloads). Local-owner surfaces (CLI, stdio MCP, loopback Web UI) may keep absolute paths where they are used to open files. Prefer the collection-relative path plus `gno://` URI already present in results; add a path only where a documented local action needs it.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [inferred] A documented inventory lists each result field that carries a host absolute path and which surfaces can reach it remotely.
- **R2:** [inferred] Remote-reachable surfaces return no host absolute path; results still identify documents by `gno://` URI and collection-relative path. Errors: omitting the field must not break existing clients' ability to fetch or open a result via its URI.
- **R3:** [inferred] Local owner flows that open files keep working; a contract test covers one remote and one local caller. Update affected schemas and API/MCP docs.

## Boundaries
<!-- scope: business -->

- [inferred] No new auth model; existing egress and loopback classification decide what is remote.
