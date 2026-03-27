/**
 * Shared file operations.
 *
 * @module src/core/file-ops
 */

// node:fs/promises for rename/unlink (no Bun equivalent for structure ops)
import { mkdir, rename, unlink } from "node:fs/promises";
// node:os platform/homedir/tmpdir: no Bun equivalent
import { homedir, platform as getPlatform, tmpdir } from "node:os";
// node:path dirname/join/parse: no Bun equivalent
import { dirname, join, parse } from "node:path";

export async function atomicWrite(
  path: string,
  content: string
): Promise<void> {
  const tempPath = `${path}.tmp.${crypto.randomUUID()}`;
  await Bun.write(tempPath, content);
  try {
    await rename(tempPath, path);
  } catch (e) {
    await unlink(tempPath).catch(() => {
      /* ignore cleanup errors */
    });
    throw e;
  }
}

async function runCommand(cmd: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return;
  }
  const stderr = await new Response(proc.stderr).text();
  throw new Error(stderr.trim() || `Command failed: ${cmd.join(" ")}`);
}

export async function renameFilePath(
  currentPath: string,
  nextPath: string
): Promise<void> {
  await rename(currentPath, nextPath);
}

type TrashFileDeps = {
  homeDir?: string;
  platform?: ReturnType<typeof getPlatform>;
  runCommand?: typeof runCommand;
  tempDir?: string;
};

function isCrossDeviceRenameError(
  error: unknown
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "EXDEV"
  );
}

async function nextAvailableTrashPath(
  trashDir: string,
  sourcePath: string
): Promise<string> {
  const { ext, name, base } = parse(sourcePath);
  let candidate = join(trashDir, base);
  let suffix = 2;
  while (await Bun.file(candidate).exists()) {
    candidate = join(trashDir, `${name} ${suffix}${ext}`);
    suffix += 1;
  }
  return candidate;
}

async function moveFilePath(
  sourcePath: string,
  targetPath: string
): Promise<void> {
  try {
    await rename(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!isCrossDeviceRenameError(error)) {
      throw error;
    }
  }

  await Bun.write(targetPath, Bun.file(sourcePath));
  await unlink(sourcePath);
}

async function trashFilePathOnDarwin(
  path: string,
  homeDir: string
): Promise<void> {
  const trashDir = join(homeDir, ".Trash");
  await mkdir(trashDir, { recursive: true });
  const targetPath = await nextAvailableTrashPath(trashDir, path);
  await moveFilePath(path, targetPath);
}

function encodeTrashInfoPath(path: string): string {
  return path
    .split("/")
    .map((segment, index) =>
      index === 0 && segment.length === 0 ? "" : encodeURIComponent(segment)
    )
    .join("/");
}

async function trashFilePathOnLinux(
  path: string,
  homeDir: string
): Promise<void> {
  const trashRoot = join(homeDir, ".local", "share", "Trash");
  const filesDir = join(trashRoot, "files");
  const infoDir = join(trashRoot, "info");
  await mkdir(filesDir, { recursive: true });
  await mkdir(infoDir, { recursive: true });

  const targetPath = await nextAvailableTrashPath(filesDir, path);
  const infoPath = join(infoDir, `${parse(targetPath).base}.trashinfo`);
  const infoContent = [
    "[Trash Info]",
    `Path=${encodeTrashInfoPath(path)}`,
    `DeletionDate=${new Date().toISOString().slice(0, 19)}`,
    "",
  ].join("\n");

  await moveFilePath(path, targetPath);
  try {
    await Bun.write(infoPath, infoContent);
  } catch (error) {
    await moveFilePath(targetPath, path).catch(() => {
      /* ignore rollback errors */
    });
    throw error;
  }
}

async function trashFilePathOnWindows(
  path: string,
  deps: Required<Pick<TrashFileDeps, "runCommand" | "tempDir">>
): Promise<void> {
  const scriptPath = join(deps.tempDir, `gno-trash-${crypto.randomUUID()}.ps1`);
  const script = `param([string]$LiteralPath)
Add-Type -AssemblyName Microsoft.VisualBasic
if (Test-Path -LiteralPath $LiteralPath -PathType Container) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
    $LiteralPath,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
  )
} else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
    $LiteralPath,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
  )
}
`;

  await Bun.write(scriptPath, script);
  try {
    await deps.runCommand([
      "powershell",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      path,
    ]);
  } finally {
    await unlink(scriptPath).catch(() => {
      /* ignore cleanup errors */
    });
  }
}

export async function trashFilePath(
  path: string,
  deps: TrashFileDeps = {}
): Promise<void> {
  const platform = deps.platform ?? getPlatform();
  const homeDir = deps.homeDir ?? homedir();
  const runner = deps.runCommand ?? runCommand;
  const tempDir = deps.tempDir ?? tmpdir();

  if (platform === "darwin") {
    await trashFilePathOnDarwin(path, homeDir);
    return;
  }

  if (platform === "linux") {
    await trashFilePathOnLinux(path, homeDir);
    return;
  }

  if (platform === "win32") {
    await trashFilePathOnWindows(path, {
      runCommand: runner,
      tempDir,
    });
    return;
  }

  throw new Error(`Trash is not supported on platform: ${platform}`);
}

export async function revealFilePath(path: string): Promise<void> {
  if (getPlatform() === "darwin") {
    await runCommand(["open", "-R", path]);
    return;
  }

  await runCommand(["xdg-open", dirname(path)]);
}
