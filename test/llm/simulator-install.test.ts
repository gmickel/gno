import { expect, test } from "bun:test";
// Bun has no directory creation/copy/link API; all copies are test-owned.
import { cp, mkdir, mkdtemp, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Bun has no file URL conversion API for package-relative filesystem operations.
import { fileURLToPath, pathToFileURL } from "node:url";

import type { SimulatorBackend } from "../../src/llm/nodeLlamaCpp/simulator-types";

import {
  installSimulatorLifetimeGuard,
  verifySimulatorPackage,
} from "../../src/llm/nodeLlamaCpp/simulator-install";
import { GuardedSimulatorSession } from "../../src/llm/nodeLlamaCpp/simulator-session";

test("factory installation is shared and creates the guarded session before native work", async () => {
  await Promise.all([
    installSimulatorLifetimeGuard(),
    installSimulatorLifetimeGuard(),
  ]);
  const module = await import("node-llama-cpp");
  const prototype = module.GgufInsights.prototype as unknown as {
    _createSimulatorSession: (
      this: { _llama: SimulatorBackend },
      size?: number
    ) => GuardedSimulatorSession;
  };
  const factory = prototype._createSimulatorSession;
  await installSimulatorLifetimeGuard();
  expect(prototype._createSimulatorSession).toBe(factory);
  const session = factory.call({ _llama: {} as SimulatorBackend });
  expect(session).toBeInstanceOf(GuardedSimulatorSession);
  await session.dispose();
});

test("dependency source and version drift fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "gno-simulator-drift-"));
  await mkdir(join(root, "dist/gguf/insights"), { recursive: true });
  const entry = pathToFileURL(join(root, "dist/index.js")).href;
  for (const version of ["3.20.0", "3.19.1"]) {
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ name: "node-llama-cpp", version })
    );
    await Bun.write(
      join(root, "dist/gguf/insights/GgufInsights.js"),
      "unexpected source"
    );
    const failure = await verifySimulatorPackage(entry).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "Unsupported node-llama-cpp simulator source"
    );
  }
});

test("factory installs from an extracted GNO location with a nested dependency copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "gno-simulator-package-"));
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const modules = join(root, "node_modules");
  const gno = join(modules, "@gmickel/gno");
  const nested = join(gno, "node_modules/node-llama-cpp");
  await mkdir(join(gno, "src/llm/nodeLlamaCpp"), { recursive: true });
  await mkdir(nested, { recursive: true });
  const installed = fileURLToPath(
    new URL("../", import.meta.resolve("node-llama-cpp"))
  );
  await cp(join(installed, "dist"), join(nested, "dist"), { recursive: true });
  await cp(join(installed, "llama"), join(nested, "llama"), {
    recursive: true,
  });
  await cp(join(installed, "package.json"), join(nested, "package.json"));
  for (const name of await readdir(join(repository, "node_modules"))) {
    if (name === "@gmickel" || name.startsWith(".")) continue;
    await symlink(
      join(repository, "node_modules", name),
      join(modules, name),
      process.platform === "win32" ? "junction" : "dir"
    );
  }
  for (const name of [
    "simulator-install.ts",
    "simulator-session.ts",
    "simulator-handle.ts",
    "simulator-types.ts",
  ]) {
    await cp(
      join(repository, "src/llm/nodeLlamaCpp", name),
      join(gno, "src/llm/nodeLlamaCpp", name)
    );
  }
  const script = join(gno, "probe.ts");
  await Bun.write(
    script,
    `
import {installSimulatorLifetimeGuard,verifySimulatorPackage} from './src/llm/nodeLlamaCpp/simulator-install';
await installSimulatorLifetimeGuard();
const {GgufInsights}=await import('node-llama-cpp');
console.log(JSON.stringify({entry:await verifySimulatorPackage(),guarded:GgufInsights.prototype[Symbol.for('gno.node-llama-cpp.simulator-lifetime.v1')]===GgufInsights.prototype._createSimulatorSession}));
`
  );
  const child = Bun.spawn([process.execPath, "--no-env-file", script], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const result = JSON.parse(stdout) as { entry: string; guarded: boolean };
  expect(result.guarded).toBe(true);
  expect(result.entry).toBe(pathToFileURL(join(nested, "dist/index.js")).href);
}, 15000);
