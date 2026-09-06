import { afterEach, expect, test } from "bun:test";
// node:fs/promises and node:os/path — structural operations and path helpers have no Bun equivalents.
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  publishIdentityRegistryPath,
  resolvePublishNoteIds,
} from "../../src/publish/identities";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gno-publish-ids-"));
  roots.push(root);
  const collectionRoot = join(root, "source");
  await mkdir(collectionRoot);
  return {
    root,
    collectionRoot,
    configPath: join(root, "config", "custom.yml"),
    sourceRelPaths: ["folder/note.md"],
  };
}

test("registry survives source edits, index deletion and normalized source aliases with private permissions", async () => {
  const input = await fixture();
  const source = join(input.collectionRoot, "folder/note.md");
  await Bun.write(source, "First title and content");
  const first = await resolvePublishNoteIds(input);
  await Bun.write(source, "Different title and body");
  const index = join(input.root, "index");
  await mkdir(index);
  await Bun.write(join(index, "gno.db"), "disposable");
  await rm(index, { recursive: true });
  expect(
    await resolvePublishNoteIds({
      ...input,
      sourceRelPaths: ["folder/../folder/note.md"],
    })
  ).toEqual(first);
  expect(await Bun.file(source).text()).toBe("Different title and body");
  const registry = publishIdentityRegistryPath(input.configPath);
  expect(registry).toBe(join(input.root, "config/publish-identities.json"));
  if (process.platform !== "win32")
    expect((await stat(registry)).mode & 0o777).toBe(0o600);
});

test("concurrent allocations share existing identity without losing distinct note IDs", async () => {
  const input = await fixture();
  const [first, second] = await Promise.all([
    resolvePublishNoteIds({ ...input, sourceRelPaths: ["same.md", "one.md"] }),
    resolvePublishNoteIds({ ...input, sourceRelPaths: ["same.md", "two.md"] }),
  ]);
  expect(first[0]).toBe(second[0]);
  expect(first[1]).not.toBe(second[1]);
  expect(
    await resolvePublishNoteIds({
      ...input,
      sourceRelPaths: ["one.md", "two.md"],
    })
  ).toEqual([first[1]!, second[1]!]);
});

test("source moves and independent config directories allocate new identities", async () => {
  const input = await fixture();
  const first = await resolvePublishNoteIds(input);
  expect(
    await resolvePublishNoteIds({ ...input, sourceRelPaths: ["moved.md"] })
  ).not.toEqual(first);
  expect(
    await resolvePublishNoteIds({
      ...input,
      configPath: join(input.root, "other/config.yml"),
    })
  ).not.toEqual(first);
});

test("canonical collection roots preserve identity through a symlink", async () => {
  if (process.platform === "win32") return; // Windows symlink creation requires extra privileges.
  const input = await fixture();
  const first = await resolvePublishNoteIds(input);
  const alias = join(input.root, "alias");
  await symlink(input.collectionRoot, alias);
  expect(
    await resolvePublishNoteIds({ ...input, collectionRoot: alias })
  ).toEqual(first);
});

test("corrupt registry never silently resets IDs", async () => {
  const input = await fixture();
  await resolvePublishNoteIds(input);
  const registry = publishIdentityRegistryPath(input.configPath);
  for (const contents of [
    "{",
    '{"version":2,"identities":{}}',
    '{"version":1,"identities":{"bad":"not-uuid"}}',
  ]) {
    await Bun.write(registry, contents);
    const failure = await resolvePublishNoteIds(input).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("export aborted");
    expect(await Bun.file(registry).text()).toBe(contents);
  }
});

test("unwritable registry location fails without returning a new identity", async () => {
  const input = await fixture();
  await Bun.write(join(input.root, "blocked"), "file");
  const failure = await resolvePublishNoteIds({
    ...input,
    configPath: join(input.root, "blocked/config.yml"),
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
});

test("config-directory override resolves independently of index settings", async () => {
  const input = await fixture();
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      'import { publishIdentityRegistryPath } from "./src/publish/identities"; process.stdout.write(publishIdentityRegistryPath());',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GNO_CONFIG_DIR: join(input.root, "override"),
        GNO_DATA_DIR: join(input.root, "index"),
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  expect(await proc.exited).toBe(0);
  expect(await new Response(proc.stdout).text()).toBe(
    join(input.root, "override/publish-identities.json")
  );
});

test("missing collection root reports actionable guidance without creating a registry", async () => {
  const input = await fixture();
  const failure = await resolvePublishNoteIds({
    ...input,
    collectionRoot: join(input.root, "missing"),
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(
    "Collection root must exist and be accessible to resolve publish identities"
  );
  expect(
    await Bun.file(publishIdentityRegistryPath(input.configPath)).exists()
  ).toBe(false);
});
