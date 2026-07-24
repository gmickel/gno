/**
 * Locate the configured Bun runtime without executing an untrusted
 * node_modules/.bin/bun peer shim. Node is intentional here: this bootstrap
 * exists specifically because Bun is not yet safely resolved.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, delimiter, join, sep } from "node:path";

const isBunName = (path) => /^bun(?:\.exe)?$/iu.test(basename(path));
const isLocalBin = (path) =>
  path.includes(`${sep}node_modules${sep}.bin${sep}`);
const isUsable = (path) => {
  try {
    return (
      isBunName(path) &&
      !isLocalBin(path) &&
      existsSync(path) &&
      statSync(path).size > 0
    );
  } catch {
    return false;
  }
};

const candidates = [];
if (process.env.npm_execpath) {
  candidates.push(process.env.npm_execpath);
}
const executableNames =
  process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"];
for (const directory of (process.env.PATH ?? "").split(delimiter)) {
  if (!directory) continue;
  for (const name of executableNames) {
    candidates.push(join(directory, name));
  }
}

const bun = candidates.find(isUsable);
if (!bun) {
  console.error(
    "Unable to locate a non-empty Bun runtime outside node_modules/.bin"
  );
  process.exit(1);
}
const result = spawnSync(bun, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
