# Windows request-ID writes start PowerShell on every CLI call

## Goal & Context
<!-- scope: business; source: inferred -->

On Windows, every CLI invocation that uses a request ID (`gno capture --request-id`, `gno remember --request-id`) checks the private write-receipts ledger directory's owner-only permissions by starting PowerShell. The "already checked" result is cached only for the current process, so each CLI call pays about 0.3-0.4 s warm and several seconds on a cold machine. Agents that retry-safe every write feel this on every call.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** [inferred] A second and later CLI call with a request ID on Windows does not start PowerShell when the ledger directory's owner-only permissions were already verified and have not changed, without weakening the fail-closed check (a directory another principal can access is still refused before any write). Measure warm and cold per-call cost before and after on a Windows runner.
- **R2:** [inferred] Tests cover: first call verifies and records, a later call skips the process spawn, and a permissions change (or a replaced directory) is detected and refused.

## Boundaries
<!-- scope: business -->

- [inferred] No change to which permissions the ledger requires; no new configuration knob.

## Completion record
<!-- scope: technical; source: fn-191-windows-request-id-writes-start.1 -->

**Design chosen: in-process descriptor read plus a verification marker.**
After the PowerShell check passes, `securePrivateLedgerDir`
(`src/core/request-receipts.ts`) writes `write-receipts/.owner-only-verified`
holding `dev:ino:sha256(owner+DACL bytes)`. A later process reads the
directory's owner and DACL in-process through `bun:ffi`
(`GetFileAttributesW` + `GetFileSecurityW`, `windowsDirectoryDescriptor`) and
skips the spawn only when all of these hold:

1. the directory is a real directory, not a reparse point (attributes);
2. its identity (`lstat` bigint `dev`/`ino`) matches the marker;
3. its owner and DACL are byte-identical to the recorded digest;
4. the descriptor independently parses as owner-only
   (`isOwnerOnlyDescriptor`): every allow entry names the owner SID, at least
   one grants full control, and any other entry type is rejected;
5. the marker was readable, which the owner-only DACL grants only to its
   owner.

Anything else runs the authoritative PowerShell check again, which refuses a
directory another principal can access before any write. An FFI failure
returns null and falls back to the check, so a defect in the fast path costs
time, never safety.

**Options rejected.**
- Directory `ctime`/`mtime` as the change signal: NTFS updates the directory's
  ChangeTime on every entry add or remove, and each ledger open creates and
  deletes the SQLite WAL/SHM files, so the marker would never match. The time
  fields also cannot separate a DACL edit from ordinary churn.
- Marker plus identity without the descriptor: the check would miss a
  permissions change on the same directory.
- Descriptor digest without the owner-only parse: an attacker able to
  pre-create the directory (shared data dir) could plant a marker for a
  permissive descriptor. The parse makes a planted marker useless: a directory
  owned by another account and allowing only that owner is unreadable to us,
  and a normal account cannot set someone else as owner.
- Long-lived helper process: larger surface (IPC trust, lifecycle) with no
  safety gain over an in-process read.

**Residual risk.**
- Path-based TOCTOU between the check and SQLite's open, as before: swapping
  the directory needs delete rights on it or on the data directory.
- An administrator, or the owner acting deliberately (for example restoring a
  byte-identical descriptor over a changed one), is trusted, as before.
- Elevated sessions whose directory owner is the token default owner
  (Administrators) fail the stricter parse and keep paying the spawn. GNO
  creates the directory with the user as owner, so this affects only
  directories made outside GNO.

**Timing.** Windows cannot be measured locally. The warm (~0.3-0.4 s) and cold
(2.5-5+ s) per-call PowerShell cost comes from CI history (memory entry
`windows-ci-first-powershell-acl-start`); the after number is the Windows CI
job's `ledger directory verification` test, which proves the second open
makes no spawn.
