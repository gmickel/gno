# Brain-First Lookup

Use this recipe when local context may already answer the request.

## Inputs

- User question or task.
- Likely collection, tags, project, person, or document names.
- Freshness risk: decide whether local context needs `gno status` first.

## Workflow

1. Check index health when stale results would matter.

```bash
gno status --json
```

2. Search locally before web/API calls.

```bash
gno query "<question>" --json
gno search "<exact phrase or name>" --json
```

3. Retrieve the strongest evidence.

```bash
gno get <uri> --from <line> -l <count>
gno multi-get <uri-1> <uri-2>
```

4. Expand only when relationships matter.

```bash
gno backlinks <uri>
gno links <uri>
gno graph query <uri> --edge-type <type> --max-depth 2
```

5. Answer from cited evidence. If local evidence is missing, say that before using external sources.

## Guardrails

- Do not claim freshness unless `gno status` or a recent index run supports it.
- Use `--intent` for ambiguous terms instead of padding the query.
- Preserve `?index=<name>` in `gno://` URIs when present.
- Cite exact files, URIs, and line ranges when the user needs traceability.

## Done

- Local evidence checked first.
- Answer names evidence and uncertainty.
- External lookup only used after the local gap is explicit.
