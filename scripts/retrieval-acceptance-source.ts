// Bun has no realpath filesystem identity API.
import { realpath } from "node:fs/promises";

export interface AcceptanceSource {
  sourceRoot: string;
  sourceArchive?: { path: string; sha256: string };
}

// Bun.Archive.files() exposes File values, not tar entry/link metadata. Python's
// stdlib verifies links and bytes without extracting or depending on GNU tar.
const VERIFY_ARCHIVE = String.raw`
import hashlib, os, pathlib, stat, sys, tarfile
archive_path, source_root, expected_hash, expected_commit = sys.argv[1:]
root = pathlib.Path(source_root).resolve(strict=True)
def digest(stream):
    value = hashlib.sha256()
    while block := stream.read(1024 * 1024): value.update(block)
    return value.hexdigest()
with open(archive_path, 'rb') as source:
    if digest(source) != expected_hash: raise ValueError('Source archive hash mismatch')
    source.seek(0)
    with tarfile.open(fileobj=source, mode='r:') as archive:
        if archive.pax_headers.get('comment') != expected_commit:
            raise ValueError('Source archive commit mismatch')
        seen = set()
        for member in archive:
            name = pathlib.PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts:
                raise ValueError('Unsafe archive path: ' + member.name)
            if member.name in seen: raise ValueError('Duplicate archive path: ' + member.name)
            seen.add(member.name)
            if any(name == pathlib.PurePosixPath(p) or pathlib.PurePosixPath(p) in name.parents
                   for p in ('evals/acceptance', 'test/eval/acceptance')): continue
            target = root.joinpath(*name.parts)
            # Never follow a substituted parent directory outside the snapshot.
            target.parent.resolve(strict=True).relative_to(root)
            info = target.lstat()
            if member.isdir():
                valid = stat.S_ISDIR(info.st_mode)
            elif member.issym():
                valid = stat.S_ISLNK(info.st_mode) and os.readlink(target) == member.linkname
            elif member.isfile():
                valid = stat.S_ISREG(info.st_mode) and info.st_size == member.size
                if valid:
                    with target.open('rb') as actual, archive.extractfile(member) as expected:
                        valid = digest(actual) == digest(expected)
            else:
                raise ValueError('Unsupported archive entry: ' + member.name)
            if not valid: raise ValueError('Source tree differs from archive: ' + member.name)
`;

const ALLOWED_DEVELOPMENT = [
  ".flow/",
  "evals/acceptance/",
  "test/eval/acceptance/",
  "scripts/retrieval-acceptance.ts",
  "scripts/retrieval-acceptance-source.ts",
];
function allowed(path: string): boolean {
  return ALLOWED_DEVELOPMENT.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry
  );
}

export async function verifyAcceptanceSource(
  settings: AcceptanceSource,
  commit: string
) {
  const sourceRoot = await realpath(settings.sourceRoot);
  if (settings.sourceArchive) {
    const child = Bun.spawn(
      [
        "python3",
        "-c",
        VERIFY_ARCHIVE,
        settings.sourceArchive.path,
        sourceRoot,
        settings.sourceArchive.sha256,
        commit,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(
        `Source archive verification failed: ${stderr || stdout}`
      );
    return {
      sourceRoot,
      dirtyStatus: "archive verified; development acceptance harness excluded",
    };
  }
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: sourceRoot });
    if (result.exitCode !== 0)
      throw new Error(
        `Source Git inspection failed: ${result.stderr.toString()}`
      );
    return result.stdout.toString();
  };
  if (
    (await realpath(git(["rev-parse", "--show-toplevel"]).trim())) !==
    sourceRoot
  )
    throw new Error(
      "Source root must be the actual Git root or supply sourceArchive"
    );
  if (git(["rev-parse", "HEAD"]).trim() !== commit)
    throw new Error("Source commit mismatch");
  const changed = git([
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    "HEAD",
    "--",
  ])
    .split("\0")
    .filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  const unexpected = [...changed, ...untracked].filter(
    (path) => !allowed(path)
  );
  if (unexpected.length)
    throw new Error(
      `Source differs from pinned Git commit: ${unexpected.join(", ")}`
    );
  return { sourceRoot, dirtyStatus: git(["status", "--porcelain"]) };
}
