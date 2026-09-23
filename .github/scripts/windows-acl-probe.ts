// Temporary native diagnostic; removed once the ACL stall is understood.
// Bun has no directory creation/removal API.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os"; // Bun has no temporary-directory helper.
import { join } from "node:path"; // Bun has no path helpers.

import { nativeWorkerEnvironment } from "../../src/llm/native-worker/runtime-config";

if (process.platform !== "win32") throw new Error("Windows probe required");
const source = await Bun.file(
  new URL("../../src/core/windows-private-path.ts", import.meta.url)
).text();
const original = source.match(/const ACL = `([\s\S]*?)`;/)?.[1];
if (!original) throw new Error("ACL script not found");
const stamp = (phase: string) =>
  `[IO.File]::AppendAllText($env:GNO_ACL_PHASE_FILE, [DateTime]::UtcNow.ToString('O') + ' ${phase}' + [Environment]::NewLine)`;
let script = original.replace(
  "$ErrorActionPreference='Stop'",
  `$ErrorActionPreference='Stop'\n${stamp("entry")}`
);
script = script.replace("$attributes=", `${stamp("attributes")}\n$attributes=`);
script = script.replace("$identity=", `${stamp("identity")}\n$identity=`);
script = script.replaceAll("$acl=if", `${stamp("acl-read")}\n$acl=if`);
script = script.replace(
  "  [IO.Directory]::SetAccessControl($p,$acl)",
  `${stamp("acl-set")}\n  [IO.Directory]::SetAccessControl($p,$acl)\n${stamp("acl-set-done")}`
);
script = script.replace("$rules=", `${stamp("acl-verify")}\n$rules=`);
script += `\n${stamp("done")}\n`;
const root = await mkdtemp(join(tmpdir(), "gno-acl-probe-"));
const variants = [
  ["full", "encoded"],
  ["filtered", "plain"],
  ["full", "plain"],
  ["filtered", "encoded"],
] as const;
const samples: unknown[] = [];
try {
  for (let repetition = 0; repetition < 3; repetition++) {
    for (let index = 0; index < variants.length; index++) {
      const [environment, argument] =
        variants[(index + repetition) % variants.length]!;
      const label = `${repetition}-${environment}-${argument}`;
      const directory = join(root, label);
      const phases = join(root, `${label}.log`);
      await mkdir(directory);
      const started = performance.now();
      const result = Bun.spawnSync(
        [
          "powershell.exe",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          argument === "encoded" ? "-EncodedCommand" : "-Command",
          argument === "encoded"
            ? Buffer.from(script, "utf16le").toString("base64")
            : script,
        ],
        {
          env: {
            ...(environment === "full"
              ? process.env
              : nativeWorkerEnvironment()),
            GNO_PRIVATE_PATH: directory,
            GNO_PRIVATE_CREATE: "1",
            GNO_ACL_PHASE_FILE: phases,
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          timeout: 10000,
          maxBuffer: 65536,
        }
      );
      const sample = {
        label,
        elapsedMs: Math.round(performance.now() - started),
        exitCode: result.exitCode,
        signal: result.signalCode,
        success: result.success,
        stderr: result.stderr.toString(),
        phases: (await Bun.file(phases).exists())
          ? await Bun.file(phases).text()
          : "not-entered",
      };
      samples.push(sample);
      console.log(JSON.stringify(sample));
    }
  }
  const report = join(
    process.env.RUNNER_TEMP ?? tmpdir(),
    "windows-acl-probe.json"
  );
  await Bun.write(
    report,
    JSON.stringify(
      { bun: Bun.version, executable: Bun.which("powershell.exe"), samples },
      null,
      2
    )
  );
  if (process.env.GITHUB_OUTPUT)
    await Bun.write(process.env.GITHUB_OUTPUT, `report=${report}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
