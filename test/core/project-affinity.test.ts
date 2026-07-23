import { afterAll, describe, expect, test } from "bun:test";
// node:fs/promises for temporary directory structure operations (no Bun equivalent)
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
// node:os for tmpdir (no Bun os utils)
import { tmpdir } from "node:os";
// node:path for path utilities (no Bun path utils)
import { join } from "node:path";

import type { Collection } from "../../src/config/types";

import {
  resolveProjectAffinity,
  type ProjectAffinityResolverDependencies,
} from "../../src/core/project-affinity";
import { safeRm } from "../helpers/cleanup";

const tempRoot = await mkdtemp(join(tmpdir(), "gno-project-affinity-"));

afterAll(async () => {
  await safeRm(tempRoot);
});

const collection = (name: string, path: string): Collection => ({
  name,
  path,
  pattern: "**/*",
  include: [],
  exclude: [],
});

describe("resolveProjectAffinity", () => {
  test("resolves direct and nested roots with segment-safe containment", async () => {
    const project = join(tempRoot, "direct-project");
    const nested = join(project, "src", "feature");
    const prefixCollision = join(tempRoot, "direct-project-old");
    await Promise.all([
      mkdir(nested, { recursive: true }),
      mkdir(prefixCollision, { recursive: true }),
    ]);

    const result = await resolveProjectAffinity(
      {
        roots: [
          { source: "cli_explicit", path: project },
          { source: "cli_explicit", path: nested },
          { source: "cli_explicit", path: prefixCollision },
        ],
      },
      [collection("project", project)],
      { channel: "local" }
    );

    expect(
      result.roots.map(({ status, reason }) => ({ status, reason }))
    ).toEqual([
      { status: "matched", reason: null },
      { status: "matched", reason: null },
      { status: "zero", reason: "no_collection_match" },
    ]);
    expect(result.matches.map((match) => match.relation)).toEqual([
      "exact",
      "collection_contains_root",
    ]);
    expect(JSON.stringify(result)).not.toContain(project);
    expect(JSON.stringify(result)).not.toContain(prefixCollision);
  });

  test.skipIf(process.platform === "win32")(
    "canonicalizes symlinks to one stable redacted root alias",
    async () => {
      const project = join(tempRoot, "symlink-project");
      const link = join(tempRoot, "symlink-project-link");
      await mkdir(project, { recursive: true });
      await symlink(project, link, "dir");

      const result = await resolveProjectAffinity(
        {
          roots: [
            { source: "cli_explicit", path: project },
            { source: "cli_explicit", path: link },
          ],
        },
        [collection("symlinked", project)],
        { channel: "local" }
      );

      expect(result.roots[0]?.rootAlias).toBe(result.roots[1]?.rootAlias);
      expect(result.matches.map((match) => match.collection)).toEqual([
        "symlinked",
        "symlinked",
      ]);
    }
  );

  test("discovers a worktree repository root through the injected boundary", async () => {
    const worktree = join(tempRoot, "worktree");
    const nested = join(worktree, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(worktree, ".git"),
      "gitdir: /redacted/main/.git/worktrees/app\n"
    );
    const discovered: string[] = [];

    const defaultResult = await resolveProjectAffinity(
      { roots: [{ source: "cli_worktree", path: nested }] },
      [collection("worktree", worktree)],
      { channel: "local" }
    );
    const injectedResult = await resolveProjectAffinity(
      { roots: [{ source: "cli_worktree", path: nested }] },
      [collection("worktree", worktree)],
      { channel: "local" },
      {
        discoverRepositoryRoot: async (path) => {
          discovered.push(path);
          return worktree;
        },
      }
    );

    expect(discovered).toEqual([await realpath(nested)]);
    expect(defaultResult.matches[0]).toMatchObject({
      collection: "worktree",
      relation: "exact",
      source: "cli_worktree",
    });
    expect(defaultResult.roots[0]?.repositoryRootDiscovered).toBe(true);
    expect(injectedResult).toEqual(defaultResult);
  });

  test("orders overlapping collections by the closest canonical relationship", async () => {
    const workspace = join(tempRoot, "overlap");
    const packageRoot = join(workspace, "packages", "api");
    const cwd = join(packageRoot, "src");
    await mkdir(cwd, { recursive: true });

    const result = await resolveProjectAffinity(
      { roots: [{ source: "cli_explicit", path: cwd }] },
      [
        collection("workspace", workspace),
        collection("api", packageRoot),
        collection("unrelated", join(tempRoot, "overlap-old")),
      ],
      { channel: "local" }
    );

    expect(result.matches.map((match) => match.collection)).toEqual([
      "api",
      "workspace",
    ]);
    expect(result.matches.map((match) => match.distance)).toEqual([1, 3]);
    expect(result.roots[0]?.collectionAliases).toEqual(
      result.matches.map((match) => match.collectionAlias)
    );
  });

  test("supports injected case canonicalization without weakening containment", async () => {
    const canonicalRoot = "/virtual/Project";
    const dependencies: Partial<ProjectAffinityResolverDependencies> = {
      canonicalizePath: async (path) => path.toLowerCase(),
      discoverRepositoryRoot: async () => null,
    };

    const result = await resolveProjectAffinity(
      {
        roots: [
          { source: "cli_explicit", path: "/VIRTUAL/PROJECT/src" },
          { source: "cli_explicit", path: "/VIRTUAL/PROJECT-old" },
        ],
      },
      [collection("case-project", canonicalRoot)],
      { channel: "local" },
      dependencies
    );

    expect(result.roots.map((root) => root.status)).toEqual([
      "matched",
      "zero",
    ]);
    expect(result.matches).toHaveLength(1);
  });

  test("returns a deterministic zero reason for a deleted trusted root", async () => {
    const deleted = join(tempRoot, "deleted-root");
    const result = await resolveProjectAffinity(
      { roots: [{ source: "cli_cwd", path: deleted }] },
      [collection("existing", tempRoot)],
      { channel: "local" }
    );

    expect(result).toEqual({
      matches: [],
      roots: [
        {
          collectionAliases: [],
          reason: "root_unavailable",
          repositoryRootDiscovered: false,
          rootAlias: expect.stringMatching(/^root_[a-f0-9]{12}$/),
          source: "cli_cwd",
          status: "zero",
        },
      ],
    });
  });

  test("never probes or reflects opaque remote hints", async () => {
    const calls: string[] = [];
    const dependencies: Partial<ProjectAffinityResolverDependencies> = {
      canonicalizePath: async (path) => {
        calls.push(`canonicalize:${path}`);
        return path;
      },
      discoverRepositoryRoot: async (path) => {
        calls.push(`discover:${path}`);
        return path;
      },
    };
    const secretPath = "/Users/private/acquisition-target";

    const first = await resolveProjectAffinity(
      { roots: [{ source: "remote_hint", hint: secretPath }] },
      [collection("secret", secretPath)],
      { channel: "remote" },
      dependencies
    );
    const second = await resolveProjectAffinity(
      { roots: [{ source: "remote_hint", hint: secretPath }] },
      [collection("secret", secretPath)],
      { channel: "remote" },
      dependencies
    );

    expect(calls).toEqual([]);
    expect(first).toEqual(second);
    expect(first.matches).toEqual([]);
    expect(first.roots[0]).toMatchObject({
      collectionAliases: [],
      reason: "untrusted_remote_hint",
      repositoryRootDiscovered: false,
      source: "remote_hint",
      status: "zero",
    });
    expect(JSON.stringify(first)).not.toContain(secretPath);
    expect(JSON.stringify(first)).not.toContain("secret");
  });

  test("remote trust context defeats a forged trusted source discriminator", async () => {
    const calls: string[] = [];
    const dependencies: Partial<ProjectAffinityResolverDependencies> = {
      canonicalizePath: async (path) => {
        calls.push(`canonicalize:${path}`);
        return path;
      },
      discoverRepositoryRoot: async (path) => {
        calls.push(`discover:${path}`);
        return path;
      },
    };
    const secretPath = "/srv/private/customer-project";
    const collections = [collection("customer-secret", secretPath)];

    const forged = await resolveProjectAffinity(
      { roots: [{ source: "cli_explicit", path: secretPath }] },
      collections,
      { channel: "remote" },
      dependencies
    );
    const opaque = await resolveProjectAffinity(
      { roots: [{ source: "remote_hint", hint: secretPath }] },
      collections,
      { channel: "remote" },
      dependencies
    );

    expect(calls).toEqual([]);
    expect(forged).toEqual(opaque);
    expect(forged.roots[0]).toMatchObject({
      reason: "untrusted_remote_hint",
      source: "remote_hint",
      status: "zero",
    });
    expect(JSON.stringify(forged)).not.toContain(secretPath);
    expect(JSON.stringify(forged)).not.toContain("cli_explicit");
    expect(JSON.stringify(forged)).not.toContain("customer-secret");
  });
});
