/** Fixed Windows-native primitives for private QA evidence and owned processes. */
// Bun has no filesystem ACL API. Paths travel as environment data, never script text.
import { lstatSync } from "node:fs";

import { windowsPrivatePath } from "../../src/core/windows-private-path";

function command(script: string): string[] {
  return [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

export function privateCapturePath(path: string, create = false): void {
  if (process.platform !== "win32") {
    if ((lstatSync(path).mode & 0o077) !== 0)
      throw new Error("Capture path must be private");
    return;
  }
  windowsPrivatePath(path, create);
}

const PROCESSES = `
$ErrorActionPreference='Stop'
$idText=[string]$env:GNO_QA_PROCESS_IDS
$ids=@($idText.Split(',',[StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { [int]$_ })
$rows=@(Get-CimInstance Win32_Process | Where-Object { $ids.Count -eq 0 -or $ids -contains [int]$_.ProcessId })
foreach ($p in $rows) {
  switch ($env:GNO_QA_PROCESS_FIELDS) {
    'rss' { '{0} {1}' -f $p.ProcessId,([double]$p.WorkingSetSize / 1024).ToString([Globalization.CultureInfo]::InvariantCulture) }
    'parent' { '{0} {1}' -f $p.ProcessId,$p.ParentProcessId }
    'identity' { if ($null -eq $p.CreationDate) { throw 'Process creation identity unavailable' }; '{0} {1}' -f $p.ParentProcessId,([DateTime]$p.CreationDate).ToUniversalTime().Ticks }
    default { throw 'Unknown process observation' }
  }
}
if ($rows.Count -eq 0) { exit 1 }
`;

export function windowsProcessCommand(args: string[]): {
  cmd: string[];
  env: Record<string, string | undefined>;
} {
  const fields = args.includes("pid=,rss=")
    ? "rss"
    : args.includes("ppid=,lstart=")
      ? "identity"
      : "parent";
  const index = args.indexOf("-p");
  const ids = index < 0 ? "" : args[index + 1]!;
  if (ids && !/^\d+(,\d+)*$/.test(ids))
    throw new Error("Invalid observed PIDs");
  return {
    cmd: command(PROCESSES),
    env: {
      ...process.env,
      GNO_QA_PROCESS_FIELDS: fields,
      GNO_QA_PROCESS_IDS: ids,
    },
  };
}
