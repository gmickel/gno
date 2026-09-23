/** Windows owner-only evidence storage. Paths are data, never interpolated script.
 * Fresh Windows objects may use the token default Owner instead of its User.
 * Only those exact owner SIDs are accepted; allowed DACL entries remain User-only. */
// Use framework APIs directly: module auto-discovery depends on profile paths
// deliberately absent from isolated native workers.
const ACL = `
$ErrorActionPreference='Stop'
$p=$env:GNO_PRIVATE_PATH
$attributes=[IO.File]::GetAttributes($p)
$isDirectory=($attributes -band [IO.FileAttributes]::Directory) -ne 0
if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse private path' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User
$defaultOwner=$identity.Owner
$acl=if ($isDirectory) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }
$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $sid.Value -and $owner.Value -ne $defaultOwner.Value) { throw 'Foreign private owner' }
if ($env:GNO_PRIVATE_CREATE -eq '1') {
  if (-not $isDirectory) { throw 'Private directory required' }
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true,$false)
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
  [IO.Directory]::SetAccessControl($p,$acl)
  if ([IO.Directory]::GetFileSystemEntries($p).Length -ne 0) { throw 'Private directory must be empty' }
}
$acl=if ($isDirectory) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }
$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $sid.Value -and $owner.Value -ne $defaultOwner.Value) { throw 'Foreign private owner' }
$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
$allowed=$false
foreach ($rule in $rules) {
  if ($rule.AccessControlType -eq 'Allow') {
    if ($rule.IdentityReference.Value -ne $sid.Value) { throw 'Private ACL permits another principal' }
    if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $allowed=$true }
  }
}
if (-not $allowed) { throw 'Private owner access unavailable' }
`;

export function windowsPrivatePath(path: string, create = false): void {
  if (process.platform !== "win32")
    throw new Error("Windows ACL operation requires Windows");
  const started = performance.now();
  const result = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(ACL, "utf16le").toString("base64"),
    ],
    {
      env: {
        ...process.env,
        GNO_PRIVATE_PATH: path,
        GNO_PRIVATE_CREATE: create ? "1" : "0",
      },
      stdin: "ignore",
      // ACL checks return no data; do not allocate an unused stdout pipe.
      stdout: "ignore",
      stderr: "pipe",
      timeout: 10000,
      maxBuffer: 65536,
    }
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Private path ACL unavailable (exit=${String(result.exitCode)}, signal=${String(result.signalCode)}, success=${String(result.success)}, elapsedMs=${Math.round(performance.now() - started)}): ${result.stderr.toString().trim() || "no stderr"}`
    );
}
