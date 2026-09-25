/** Windows owner-only evidence storage. Paths are data, never interpolated script.
 * Fresh Windows objects may use the token default Owner instead of its User.
 * Only those exact owner SIDs are accepted; allowed DACL entries remain User-only. */
// bun:ffi — reading a security descriptor in-process needs advapi32; Bun has no ACL API
import { dlopen, FFIType } from "bun:ffi";

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

export async function windowsPrivatePath(
  path: string,
  create = false
): Promise<void> {
  if (process.platform !== "win32")
    throw new Error("Windows ACL operation requires Windows");
  const started = performance.now();
  const child = Bun.spawn(
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
    }
  );
  const reader = child.stderr.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536)
        throw new Error("Private path ACL stderr exceeded 64 KiB");
      chunks.push(value);
    }
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      const stderr = new TextDecoder().decode(Buffer.concat(chunks)).trim();
      throw new Error(
        `Private path ACL unavailable (exit=${String(exitCode)}, signal=${String(child.signalCode)}, elapsedMs=${Math.round(performance.now() - started)}): ${stderr || "no stderr"}`
      );
    }
  } finally {
    reader.releaseLock();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await child.exited;
  }
}

const OWNER_AND_DACL = 0x1 | 0x4; // OWNER_ | DACL_SECURITY_INFORMATION
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x4_00;
const INVALID_FILE_ATTRIBUTES = 0xff_ff_ff_ff;
const SECURITY_DESCRIPTOR_MAX_BYTES = 65_536;

interface Win32Security {
  getFileAttributes: (path: Uint8Array) => number;
  getFileSecurity: (
    path: Uint8Array,
    info: number,
    descriptor: Uint8Array,
    length: number,
    needed: Uint32Array
  ) => number;
}

let win32Security: Win32Security | null | undefined;

function loadWin32Security(): Win32Security | null {
  if (win32Security !== undefined) return win32Security;
  try {
    const kernel32 = dlopen("kernel32.dll", {
      GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
    });
    const advapi32 = dlopen("advapi32.dll", {
      GetFileSecurityW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    win32Security = {
      getFileAttributes: kernel32.symbols.GetFileAttributesW,
      getFileSecurity: advapi32.symbols.GetFileSecurityW,
    };
  } catch {
    win32Security = null;
  }
  return win32Security;
}

/**
 * Owner and DACL of a directory that is not a reparse point, read in-process
 * (no PowerShell). Null when unavailable: callers treat that as unverified.
 */
export function windowsDirectoryDescriptor(path: string): Uint8Array | null {
  if (process.platform !== "win32") return null;
  const win32 = loadWin32Security();
  if (!win32) return null;
  const widePath = Buffer.from(`${path}\0`, "utf16le");
  const attributes = win32.getFileAttributes(widePath);
  if (
    attributes === INVALID_FILE_ATTRIBUTES ||
    (attributes & FILE_ATTRIBUTE_DIRECTORY) === 0 ||
    (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0
  ) {
    return null;
  }
  const descriptor = new Uint8Array(SECURITY_DESCRIPTOR_MAX_BYTES);
  const needed = new Uint32Array(1);
  const ok = win32.getFileSecurity(
    widePath,
    OWNER_AND_DACL,
    descriptor,
    descriptor.length,
    needed
  );
  const length = needed[0] ?? 0;
  if (ok === 0 || length === 0 || length > descriptor.length) return null;
  return descriptor.slice(0, length);
}

const SE_DACL_PRESENT = 0x4;
const SE_SELF_RELATIVE = 0x80_00;
const ACCESS_ALLOWED_ACE_TYPE = 0;
const ACCESS_DENIED_ACE_TYPE = 1;
const FILE_ALL_ACCESS = 0x1f_01_ff;

function sidAt(view: DataView, offset: number): Uint8Array | null {
  if (offset === 0 || offset + 8 > view.byteLength) return null;
  const end = offset + 8 + 4 * view.getUint8(offset + 1);
  if (end > view.byteLength) return null;
  return new Uint8Array(view.buffer, view.byteOffset + offset, end - offset);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((b, i) => b === right[i]);
}

/**
 * Self-relative descriptor whose owner is the only principal any allow entry
 * names, with full control among them. Stricter than the PowerShell policy
 * (which also accepts a token default owner): a false here only means the
 * authoritative check runs.
 */
export function isOwnerOnlyDescriptor(descriptor: Uint8Array): boolean {
  const view = new DataView(
    descriptor.buffer,
    descriptor.byteOffset,
    descriptor.byteLength
  );
  if (view.byteLength < 20 || view.getUint8(0) !== 1) return false;
  const control = view.getUint16(2, true);
  if ((control & SE_SELF_RELATIVE) === 0 || (control & SE_DACL_PRESENT) === 0)
    return false;
  const owner = sidAt(view, view.getUint32(4, true));
  const dacl = view.getUint32(16, true);
  if (!owner || dacl === 0 || dacl + 8 > view.byteLength) return false;
  const aclEnd = dacl + view.getUint16(dacl + 2, true);
  if (aclEnd > view.byteLength) return false;
  let offset = dacl + 8;
  let fullControl = false;
  for (let ace = view.getUint16(dacl + 4, true); ace > 0; ace--) {
    if (offset + 8 > aclEnd) return false;
    const type = view.getUint8(offset);
    const size = view.getUint16(offset + 2, true);
    if (size < 8 || offset + size > aclEnd) return false;
    if (type === ACCESS_ALLOWED_ACE_TYPE) {
      const sid = sidAt(view, offset + 8);
      if (!sid || offset + 8 + sid.length > offset + size) return false;
      if (!sameBytes(sid, owner)) return false;
      const mask = view.getUint32(offset + 4, true);
      if ((mask & FILE_ALL_ACCESS) === FILE_ALL_ACCESS) fullControl = true;
    } else if (type !== ACCESS_DENIED_ACE_TYPE) {
      return false;
    }
    offset += size;
  }
  return fullControl;
}
