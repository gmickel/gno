// node:os homedir: no Bun equivalent.
import { homedir } from "node:os";
// node:path join/normalize: no Bun path utilities.
import { join, normalize } from "node:path";

interface ResolveDownloadsDirDeps {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  platform?: NodeJS.Platform;
  readTextFile?: (path: string) => Promise<string | null>;
}

const XDG_DOWNLOAD_DIR_REGEX = /^XDG_DOWNLOAD_DIR=(?:"([^"]+)"|([^\r\n#]+))$/mu;

function expandEnvPath(
  value: string,
  env: Record<string, string | undefined>,
  homeDir: string
): string {
  return normalize(
    value
      .trim()
      .replaceAll(/\$HOME|\$\{HOME\}/gu, homeDir)
      .replace(/^~(?=$|[\\/])/u, homeDir)
      .replaceAll(
        /%([^%]+)%/gu,
        (_match, key: string) => env[key] ?? env[key.toUpperCase()] ?? ""
      )
  );
}

function parseXdgDownloadsDir(
  fileContents: string,
  env: Record<string, string | undefined>,
  homeDir: string
): string | null {
  const match = fileContents.match(XDG_DOWNLOAD_DIR_REGEX);
  const rawValue = match?.[1] ?? match?.[2];
  if (!rawValue) {
    return null;
  }
  return expandEnvPath(rawValue, env, homeDir);
}

async function defaultReadTextFile(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }
  return file.text();
}

export async function resolveDownloadsDir(
  deps: ResolveDownloadsDirDeps = {}
): Promise<string> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const homeDir = deps.homeDir ?? homedir();
  const readTextFile = deps.readTextFile ?? defaultReadTextFile;

  if (platform === "linux") {
    const explicit = env.XDG_DOWNLOAD_DIR?.trim();
    if (explicit) {
      return expandEnvPath(explicit, env, homeDir);
    }

    const xdgConfigHome =
      env.XDG_CONFIG_HOME?.trim() || join(homeDir, ".config");
    const userDirs = await readTextFile(join(xdgConfigHome, "user-dirs.dirs"));
    if (userDirs) {
      const parsed = parseXdgDownloadsDir(userDirs, env, homeDir);
      if (parsed) {
        return parsed;
      }
    }
  }

  if (platform === "win32") {
    const userProfile = env.USERPROFILE?.trim();
    if (userProfile) {
      return join(userProfile, "Downloads");
    }
  }

  return join(homeDir, "Downloads");
}
