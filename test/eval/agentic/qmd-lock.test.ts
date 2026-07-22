import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises: temporary lifecycle and permission changes have no Bun equivalent.
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
// node:os: temporary directory discovery has no Bun equivalent.
import { tmpdir } from "node:os";
// node:path: path construction has no Bun equivalent.
import { join } from "node:path";

import { AgenticHarnessError } from "../../../evals/agentic/adapter";
import { sha256Bytes } from "../../../evals/agentic/canonical";
import { loadQmdLock, validateQmdLock } from "../../../evals/agentic/qmd-lock";
import {
  hashQmdFile,
  preflightQmd,
  type QmdCommandRunner,
} from "../../../evals/agentic/qmd-preflight";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true }))
  );
});

const harnessCode = (error: unknown): string | null =>
  error instanceof AgenticHarnessError ? error.code : null;

const expectRejectCode = async (
  promise: Promise<unknown>,
  code: string
): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected rejection ${code}`);
  } catch (error) {
    expect(harnessCode(error)).toBe(code);
  }
};

const expectRejectMessage = async (
  promise: Promise<unknown>,
  message: string
): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected rejection containing ${message}`);
  } catch (error) {
    expect((error as Error).message).toContain(message);
  }
};

describe("qmd lock", () => {
  test("loads every exact repository, package, tool, and model field", async () => {
    const lock = await loadQmdLock();
    expect(lock.repository.commit).toBe(
      "e428df76bc0274d9e93eb7ca3e95673315c42e90"
    );
    expect(lock.repository.tree).toBe(
      "96aa633ac64f23e87e094af8c160026d70d6c783"
    );
    expect(lock.package).toEqual({
      name: "@tobilu/qmd",
      version: "2.6.3",
      packageJsonSha256:
        "a29706170438bf7a7e544f4c63cf3e661a1b5c99344d395885de57a076a5fc68",
      bunLockSha256:
        "ad07cccd59e39b363ba2092e142f1c465051da1e954e0f479f6f06e8b2c9f036",
    });
    expect(Object.keys(lock.tools).sort()).toEqual([
      "contractsSha256",
      "get",
      "inputSchemasSha256",
      "multi_get",
      "query",
      "status",
    ]);
    expect(lock.models.generate.bytes).toBe(1_282_438_912);
    expect(lock.models.embed.cacheFile).toBe(
      "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf"
    );
    expect(lock.models.rerank.cacheFile).toBe(
      "hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf"
    );
    expect(lock.models.generate.cacheFile).toBe(
      "hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf"
    );
  });

  test("rejects placeholders, short revisions, extra fields, and duplicate keys", async () => {
    const lock = structuredClone(await loadQmdLock()) as unknown as Record<
      string,
      unknown
    >;
    const repository = lock.repository as Record<string, unknown>;
    repository.commit = "TODO";
    expect(() => validateQmdLock(lock)).toThrow("non-placeholder string");

    const valid = structuredClone(await loadQmdLock()) as unknown as Record<
      string,
      unknown
    >;
    valid.extra = true;
    expect(() => validateQmdLock(valid)).toThrow("fields differ");

    const traversing = structuredClone(await loadQmdLock());
    traversing.models.embed.file = "../model.gguf";
    expect(() => validateQmdLock(traversing)).toThrow(
      "unambiguous cache filename"
    );

    const root = await mkdtemp(join(tmpdir(), "qmd-lock-duplicate-"));
    tempPaths.push(root);
    const path = join(root, "qmd.lock.json");
    await Bun.write(path, '{"schemaVersion":"1.0","schemaVersion":"1.0"}');
    await expectRejectMessage(loadQmdLock(path), "Duplicate JSON key");
  });
});

const createExactFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "qmd-preflight-"));
  tempPaths.push(root);
  const repoPath = join(root, "repo");
  const modelCachePath = join(root, "models");
  await Promise.all([
    mkdir(join(repoPath, ".git"), { recursive: true }),
    mkdir(join(repoPath, "bin"), { recursive: true }),
    mkdir(join(repoPath, "src"), { recursive: true }),
    mkdir(modelCachePath, { recursive: true }),
  ]);
  await Bun.write(join(repoPath, ".git/HEAD"), "ref: refs/heads/main\n");
  const lock = structuredClone(await loadQmdLock());
  const packageText = JSON.stringify({
    name: lock.package.name,
    version: lock.package.version,
    repository: { url: `git+${lock.repository.url}` },
  });
  const bunLockText = "fixture bun lock\n";
  const entrypointText = "#!/usr/bin/env node\n";
  lock.package.packageJsonSha256 = sha256Bytes(packageText);
  lock.package.bunLockSha256 = sha256Bytes(bunLockText);
  lock.entrypoint.sha256 = sha256Bytes(entrypointText);
  await Promise.all([
    Bun.write(join(repoPath, "package.json"), packageText),
    Bun.write(join(repoPath, "bun.lock"), bunLockText),
    Bun.write(join(repoPath, "bin/qmd"), entrypointText),
    Bun.write(
      join(repoPath, "src/llm.ts"),
      Object.values(lock.models)
        .map(({ uri }) => JSON.stringify(uri))
        .join("\n")
    ),
  ]);
  await chmod(join(repoPath, "bin/qmd"), 0o755);
  for (const [role, model] of Object.entries(lock.models)) {
    const content = `${role}-model`;
    model.bytes = new TextEncoder().encode(content).byteLength;
    model.sha256 = sha256Bytes(content);
    await Bun.write(join(modelCachePath, model.cacheFile), content);
  }
  const lockPath = join(root, "qmd.lock.json");
  await Bun.write(lockPath, JSON.stringify(lock));

  let dirty = false;
  let commit = lock.repository.commit;
  const commandRunner: QmdCommandRunner = async ({ args }) => {
    const key = args.join(" ");
    if (key === "rev-parse HEAD^{commit}")
      return { exitCode: 0, stdout: `${commit}\n`, stderr: "" };
    if (key === "rev-parse HEAD^{tree}")
      return { exitCode: 0, stdout: `${lock.repository.tree}\n`, stderr: "" };
    if (key.startsWith("status "))
      return {
        exitCode: 0,
        stdout: dirty ? " M package.json\n" : "",
        stderr: "",
      };
    if (key === "config --get remote.origin.url") {
      return { exitCode: 0, stdout: `${lock.repository.url}\n`, stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected git command" };
  };
  return {
    repoPath,
    modelCachePath,
    lockPath,
    lock,
    commandRunner,
    setDirty(value: boolean) {
      dirty = value;
    },
    setCommit(value: string) {
      commit = value;
    },
  };
};

describe("qmd static preflight", () => {
  test("accepts only a clean exact checkout with all pinned cached models", async () => {
    const fixture = await createExactFixture();
    const result = await preflightQmd(fixture);
    expect(result.repoPath).toBe(fixture.repoPath);
    expect(result.modelPaths.generate).toBe(
      join(fixture.modelCachePath, fixture.lock.models.generate.cacheFile)
    );
    expect(result.lockFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("requires an executable locked entrypoint", async () => {
    const fixture = await createExactFixture();
    await chmod(join(fixture.repoPath, "bin/qmd"), 0o644);
    await expectRejectCode(preflightQmd(fixture), "qmd_entrypoint_invalid");
  });

  test("stops file hashing before reading when cancelled", async () => {
    const fixture = await createExactFixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled qmd preflight"));
    await expectRejectMessage(
      hashQmdFile(join(fixture.repoPath, "bun.lock"), controller.signal),
      "cancelled qmd preflight"
    );
  });

  test("fails closed on dirty or revision-mismatched checkouts", async () => {
    const fixture = await createExactFixture();
    fixture.setDirty(true);
    await expectRejectCode(preflightQmd(fixture), "qmd_checkout_dirty");
    fixture.setDirty(false);
    fixture.setCommit("1".repeat(40));
    await expectRejectCode(preflightQmd(fixture), "qmd_revision_mismatch");
  });

  test("fails closed on missing, stale, and real currently unavailable model caches", async () => {
    const fixture = await createExactFixture();
    await Bun.write(
      join(fixture.modelCachePath, fixture.lock.models.generate.cacheFile),
      "stale"
    );
    await expectRejectCode(preflightQmd(fixture), "qmd_model_preflight_failed");

    await expectRejectCode(
      preflightQmd({
        repoPath: "/Users/gordon/repos/qmd",
        modelCachePath: join(fixture.modelCachePath, "absent"),
      }),
      "qmd_model_preflight_failed"
    );
  });

  test("does not use PATH when QMD_REPO is absent or relative", async () => {
    await expectRejectCode(
      preflightQmd({ repoPath: "qmd" }),
      "qmd_repo_missing"
    );
  });
});
