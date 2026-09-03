# Memory: Supersede A Stale Fact

Use this recipe when a recalled fact is no longer true and a newer statement
replaces it. Facts are replaced, never edited in place and never deleted by
the memory contract.

## Inputs

- The stale fact's `uri` and `contentHash`, taken from a recall.
- The replacement text.
- The same scopes the stale fact is visible in.
- Source evidence for the change when known.

## Workflow

1. Recall the current fact and keep the JSON; it carries the predecessor's
   `uri`, `contentHash`, and the receipt.

```bash
gno recall "<the topic>" --scope <scope> --json > /tmp/recall.json
```

2. Confirm the match is the same fact with stale content, not a different
   fact. Two facts that both hold get an add, not a supersede.

3. Supersede, naming the predecessor and its hash.

```bash
gno remember "<replacement text>" --scope <scope> \
  --supersede <uri> --predecessor-hash <contentHash> \
  --source "<what changed and where that is recorded>" \
  --receipt /tmp/recall.json --json
```

The scriptable spelling `--decision supersede --predecessor <uri>` means
the same thing.

4. Read the result. `outcome: "superseded"` returns the successor record with
   `supersedes: [<uri>]`.
   - `MEMORY_PREDECESSOR_HASH_MISMATCH`: the fact changed since the recall.
     Recall again and decide against the current text.
   - `MEMORY_SUPERSEDE_CONFLICT` (exit 4): another writer superseded it
     first. Recall again; the successor may already say what you meant.

5. Verify: recall returns the successor and not the predecessor.

```bash
gno recall "<distinctive phrase>" --scope <scope>
```

## Guardrails

- Never supersede without the `contentHash` from a recall; the hash is what
  proves the replacement targets the fact the agent actually read.
- The replacement must be a new statement. Re-storing the recalled text is
  fenced (`MEMORY_FENCED_REPLAY`) when the receipt is presented; a
  paraphrase without lineage is not, so do not rephrase the old fact as a
  "new" one.
- Superseded facts stay on disk and in ordinary `gno search`; only `recall`
  excludes them. To remove a file, the user deletes it and runs
  `gno update`; the contract has no delete.
- Do not chain supersedes speculatively; one recalled fact, one decision.

## Done

- `outcome: "superseded"` with a successor URI carrying `supersedes`.
- Recall in scope returns the successor only.
- A conflict or hash mismatch ended in a fresh recall, not a retry loop.
