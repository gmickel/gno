import { expect, test } from "bun:test";
// Bun has no directory copy/creation/removal or symlink APIs.
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
// Bun has no OS/path utility equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionDriverOptions } from "../../../evals/acceptance/session-driver";

import { ACCEPTANCE_SCHEMA_VERSION } from "../../../evals/acceptance/manifest";
import { OwnedResources } from "../../../evals/acceptance/resources";
import { createSessionDriverFactory } from "../../../evals/acceptance/session-driver";
import { createDefaultConfig } from "../../../src/config";

async function fixture(): Promise<{
  options: SessionDriverOptions;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "gno-session-driver-"));
  const config = createDefaultConfig();
  config.collections = [];
  config.retrievalTraces = {
    enabled: true,
    redactionMode: "metadata",
    retention: {
      maxAgeDays: 1,
      maxTraces: 10,
      maxRecordsPerTrace: 1000,
      maxBytes: 1048576,
    },
  };
  const hash = "a".repeat(64);
  const manifest: SessionDriverOptions["manifest"] = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    role: "baseline" as const,
    identity: {
      commit: "a".repeat(40),
      indexId: "session-test",
      indexSha256: hash,
      bunVersion: Bun.version,
      nativeDependencies: {},
      platform: process.platform,
      architecture: process.arch,
    },
    fixtureVersion: "session-test",
    fixtures: [{ path: "empty", sha256: hash }],
    models: [],
    cases: [
      {
        caseId: "test",
        fixtureSha256: hash,
        surface: "sdk" as const,
        preset: "test",
        configuration: {},
      },
    ],
    intendedDeltas: [],
  };
  await mkdir(join(root, "protocol"));
  return {
    root,
    options: {
      sourceRoot: process.cwd(),
      isolatedRoot: root,
      protocolRoot: join(root, "protocol"),
      manifest,
      init: { config, dbPath: join(root, "index.sqlite") },
      requests: [
        {
          manifest,
          caseId: "test",
          query: "no native models",
          operation: "hybrid",
          options: { noExpand: true },
          expectedBackend: "cuda",
        },
      ],
      timeoutMs: 10000,
    },
  };
}

test("retained actual child has truthful cold state, lossless replies, and explicit close", async () => {
  const { root, options } = await fixture();
  const scope = new OwnedResources();
  try {
    const session = await createSessionDriverFactory(options).open(scope);
    expect(session.processId).not.toBe(process.pid);
    expect(scope.owns(session.processId)).toBe(true);
    expect(await session.modelState()).toBe(false);
    const result = await session.run("test");
    expect(result.coverage).toBe("incomplete");
    expect(result.record.caseId).toBe("test");
    await session.idle(1);
    expect(await session.modelState()).toBe(false);
    const file = join(session.processIdentity.directory, "2.reply.json.gz");
    const captured = JSON.parse(
      new TextDecoder().decode(
        Bun.gunzipSync(await Bun.file(file).arrayBuffer())
      )
    );
    expect(captured.pid).toBe(session.processId);
    expect(captured.response.result.record).toEqual(result.record);
    await session.close();
    expect(scope.owns(session.processId)).toBe(false);
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh opens use different OS processes and invalid request stops its child", async () => {
  const { root, options } = await fixture();
  const scope = new OwnedResources();
  try {
    const factory = createSessionDriverFactory(options);
    const first = await factory.open(scope);
    const firstPid = first.processId;
    await first.close();
    const second = await factory.open(scope);
    expect(second.processId).not.toBe(firstPid);
    await expect(second.run("unknown")).rejects.toThrow("Unknown session case");
    expect(scope.owns(second.processId)).toBe(false);
    await second.close();
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup timeout and closed resource scope cannot leave owned children running", async () => {
  const { root, options } = await fixture();
  const scope = new OwnedResources();
  try {
    await expect(
      createSessionDriverFactory({ ...options, timeoutMs: 1 }).open(scope)
    ).rejects.toThrow("timed out");
    await scope.close();
    await expect(
      createSessionDriverFactory(options).open(scope)
    ).rejects.toThrow("already closed");
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("driver rejects external DB before spawning a process", async () => {
  const { root, options } = await fixture();
  const scope = new OwnedResources();
  try {
    await expect(
      createSessionDriverFactory({
        ...options,
        init: {
          ...options.init,
          dbPath: join(tmpdir(), "outside-index.sqlite"),
        },
      }).open(scope)
    ).rejects.toThrow("outside acceptance DB");
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cached hash preflight revalidates a changed physical GGUF file", async () => {
  const { root } = await fixture();
  const { ModelCache } = await import("../../../src/llm/cache");
  const { hashFile } =
    await import("../../../evals/acceptance/capture-contract");
  const path = join(root, "model.gguf");
  const bytes = new Uint8Array(512);
  bytes.set([0x47, 0x47, 0x55, 0x46]);
  await Bun.write(path, bytes);
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const uri = `file:${path}`;
  try {
    const cache = new ModelCache(join(root, "cache"));
    const resolved = await cache.ensureModel(uri, "embed", {
      offline: true,
      allowDownload: false,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error.message);
    expect(await hashFile(resolved.value)).toBe(sha);
    expect(await hashFile(resolved.value)).toBe(sha);
    bytes[511] = 1;
    await Bun.write(path, bytes);
    const changed = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(changed).not.toBe(sha);
    expect(await hashFile(resolved.value)).toBe(changed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  "session-child.ts",
  "../agentic/canonical.ts",
  "../../scripts/package-smoke-isolation.ts",
])("snapshot harness installation preserves differing %s", async (name) => {
  const root = await mkdtemp(join(tmpdir(), "gno-session-snapshot-"));
  const { installSessionHarness } =
    await import("../../../evals/acceptance/session-driver");
  try {
    await installSessionHarness(root);
    const child = join(root, "evals/acceptance", name);
    await Bun.write(child, "existing changed harness");
    await expect(installSessionHarness(root)).rejects.toThrow(
      "Snapshot harness differs"
    );
    expect(await Bun.file(child).text()).toBe("existing changed harness");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("driver pins declared backend/build policy and only explicit canonical CUDA_PATH", async () => {
  const { root, options } = await fixture();
  const scope = new OwnedResources();
  const sourceRoot = join(root, "fake-protocol-source");
  await mkdir(join(sourceRoot, "evals/acceptance"), { recursive: true });
  // Protocol-only child reports its environment; it cannot produce native coverage.
  await Bun.write(
    join(sourceRoot, "evals/acceptance/session-child.ts"),
    `
    const {runId,directory}=await Bun.file(process.env.GNO_ACCEPTANCE_SESSION_CONFIG).json();
    process.on('message',async ({sequence,operation})=>{
      const resultPath=directory+'/'+sequence+'.reply.json.gz';
      await Bun.write(resultPath,Bun.gzipSync(JSON.stringify({runId,sequence,pid:process.pid,response:{loaded:false,env:{gpu:process.env.GNO_LLAMA_GPU,build:process.env.GNO_LLAMA_BUILD,cudaPath:process.env.CUDA_PATH??null}}})));
      process.send({runId,pid:process.pid,sequence,ok:true,resultPath});
      if(operation==='close'){process.disconnect();process.exit(0);}
    });
    process.send({runId,pid:process.pid,ready:true,ok:true});
  `
  );
  try {
    for (const explicit of [false, true]) {
      const session = await createSessionDriverFactory({
        ...options,
        sourceRoot,
        ...(explicit ? { cudaPath: root } : {}),
      }).open(scope);
      await session.modelState();
      const reply = JSON.parse(
        new TextDecoder().decode(
          Bun.gunzipSync(
            await Bun.file(
              join(session.processIdentity.directory, "1.reply.json.gz")
            ).arrayBuffer()
          )
        )
      );
      expect(reply.response.env).toEqual({
        gpu: "cuda",
        build: "never",
        cudaPath: explicit ? await realpath(root) : null,
      });
      await session.close();
    }
    expect(() =>
      createSessionDriverFactory({
        ...options,
        requests: [
          options.requests[0]!,
          { ...options.requests[0]!, expectedBackend: "metal" },
        ],
      })
    ).toThrow("one declared native backend");
    await expect(
      createSessionDriverFactory({
        ...options,
        cudaPath: join(sourceRoot, "evals/acceptance/session-child.ts"),
      }).open(scope)
    ).rejects.toThrow("requires a directory");
  } finally {
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed harness imports inside a fresh selected product root without native access", async () => {
  const root = await mkdtemp(join(tmpdir(), "gno-session-portable-"));
  const source = new URL("../../../", import.meta.url).pathname;
  const { installSessionHarness } =
    await import("../../../evals/acceptance/session-driver");
  try {
    // Copy actual product bytes: symlinking src would hide missing snapshot-relative imports.
    await cp(join(source, "src"), join(root, "src"), { recursive: true });
    await Bun.write(
      join(root, "package.json"),
      Bun.file(join(source, "package.json"))
    );
    await symlink(
      join(source, "node_modules"),
      join(root, "node_modules"),
      "dir"
    );
    const product = await Bun.file(join(root, "src/index.ts")).bytes();
    await installSessionHarness(root);
    await installSessionHarness(root); // Identical helpers remain reusable.
    expect(await Bun.file(join(root, "src/index.ts")).bytes()).toEqual(product);
    const probe = join(root, "probe.ts");
    await Bun.write(
      probe,
      `
const attempts = [];
const deny = name => { attempts.push(name); throw new Error("Forbidden native access: " + name); };
Bun.spawn = () => deny("spawn");
Bun.spawnSync = () => deny("spawnSync");
Bun.dlopen = () => deny("Bun.dlopen");
process.dlopen = () => deny("process.dlopen");
globalThis.fetch = () => deny("fetch");
const driver = await import("./evals/acceptance/session-driver.ts");
if (typeof driver.createSessionDriverFactory !== "function") throw new Error("Missing selected driver");
try {
  await import("./evals/acceptance/session-child.ts");
  throw new Error("Unexpected bootstrap acceptance");
} catch (error) {
  if (error.message !== "Acceptance session child requires owned IPC bootstrap") throw error;
}
console.log(JSON.stringify({ driver: true, childImports: true, attempts }));
`
    );
    const child = Bun.spawn([process.execPath, "--no-env-file", probe], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        TMPDIR: root,
        GNO_OFFLINE: "1",
        GNO_NO_AUTO_DOWNLOAD: "1",
        GNO_LLAMA_BUILD: "never",
        CUDA_VISIBLE_DEVICES: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      expect(await child.exited, await stderr).toBe(0);
      expect(JSON.parse(await stdout)).toEqual({
        driver: true,
        childImports: true,
        attempts: [],
      });
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

test("helper installation rejects a companion-directory symlink outside the selected root", async () => {
  const root = await mkdtemp(join(tmpdir(), "gno-session-contained-"));
  const source = join(root, "selected");
  const outside = join(root, "outside");
  const { installSessionHarness } =
    await import("../../../evals/acceptance/session-driver");
  try {
    await mkdir(source);
    await mkdir(outside);
    await symlink(outside, join(source, "scripts"), "dir");
    const failure = await installSessionHarness(source).catch(
      (error: unknown) => error
    );
    expect(failure instanceof Error && failure.message).toContain(
      "outside snapshot harness"
    );
    expect(
      await Bun.file(join(outside, "package-smoke-isolation.ts")).exists()
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
