/** Windows owner-only evidence storage. Paths are data, never interpolated script.
 * Fresh Windows objects may use the token default Owner instead of its User.
 * Only those exact owner SIDs are accepted; allowed DACL entries remain User-only. */
const ACL = `
$ErrorActionPreference='Stop'
$p=$env:GNO_PRIVATE_PATH
$item=Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse private path' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User
$defaultOwner=$identity.Owner
$owner=(Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $sid.Value -and $owner.Value -ne $defaultOwner.Value) { throw 'Foreign private owner' }
if ($env:GNO_PRIVATE_CREATE -eq '1') {
  if (-not $item.PSIsContainer) { throw 'Private directory required' }
  $acl=[Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true,$false)
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $p -AclObject $acl
  if (@(Get-ChildItem -LiteralPath $p -Force).Count -ne 0) { throw 'Private directory must be empty' }
}
$acl=Get-Acl -LiteralPath $p
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
      timeout: 10000,
      maxBuffer: 65536,
    }
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Private path ACL unavailable: ${result.stderr.toString().trim()}`
    );
}
