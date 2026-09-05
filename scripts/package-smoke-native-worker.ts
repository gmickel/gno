/** Exercise the real installed client/entry without downloading native models. */
// node:path: Bun has no portable path joining API.
import { join } from "node:path";

export async function verifyPackedNativeWorker(input: {
  packageRoot: string;
  cwd: string;
  env?: Record<string, string>;
}): Promise<void> {
  for (const file of [
    "client.ts",
    "entry.ts",
    "dispatcher.ts",
    "protocol.ts",
    "ports.ts",
  ]) {
    if (
      !(await Bun.file(
        join(input.packageRoot, "src/llm/native-worker", file)
      ).exists())
    ) {
      throw new Error(`Packed native runtime missing ${file}`);
    }
  }
  const runner = new URL(
    "../evals/fixtures/acceptance/native-lifecycle/runner.ts",
    import.meta.url
  ).pathname;
  const fixtureHash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(runner).bytes())
    .digest("hex");
  const manifest = await Bun.file(
    new URL(
      "../evals/fixtures/acceptance/native-lifecycle/manifest.json",
      import.meta.url
    )
  ).json();
  if (manifest.runnerSha256 !== fixtureHash)
    throw new Error("Native lifecycle fixture identity mismatch");
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", runner, input.packageRoot, input.cwd],
    {
      cwd: input.cwd,
      env: input.env,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 25_000);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  try {
    const code = await child.exited;
    const output = await stdout;
    if (code !== 0)
      throw new Error(
        `Native package contract failed (${code}): ${await stderr}\n${output}`
      );
    const receipt = JSON.parse(output);
    if (receipt.contract !== "native-lifecycle-v1" || receipt.passed !== true) {
      throw new Error(
        "Native package contract did not emit a complete JSON receipt"
      );
    }
    await Bun.write(
      join(input.cwd, "native-lifecycle-receipt.json"),
      JSON.stringify({ ...receipt, fixtureHash }, null, 2)
    );
    console.log(
      "Packed native client/entry fault contracts passed (no native weights)"
    );
  } finally {
    clearTimeout(watchdog);
    child.kill("SIGKILL");
    await child.exited;
  }
}
