/** Applying a project profile keeps collection settings it does not own. */

import { expect, test } from "bun:test";

import type { Config, ProjectProfileBinding } from "../../src/config/types";
import type { ProjectProfileDesiredState } from "../../src/core/project-profile";

import { DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { applyProjectProfileDesiredState } from "../../src/core/project-profile-apply-state";

test("an existing updateCmd, its timeout and audit survive a profile apply", () => {
  const config: Config = {
    version: "1.0",
    ftsTokenizer: DEFAULT_FTS_TOKENIZER,
    collections: [
      {
        name: "notes",
        path: "/work/notes",
        pattern: "**/*.md",
        include: [],
        exclude: [],
        updateCmd: "git pull",
        updateCmdTimeoutMs: 120_000,
        audit: { externalUrls: "report", paths: ["**/*.md"] },
      },
    ],
    contexts: [],
  };
  const desired = {
    schemaVersion: "1.0",
    collection: {
      name: "notes",
      root: ".",
      include: ["**/*.md"],
      exclude: ["drafts"],
    },
    contexts: [],
    contentTypes: [],
    affinityDefaults: {},
  } as unknown as ProjectProfileDesiredState;

  const next = applyProjectProfileDesiredState(
    config,
    desired,
    "/work/notes",
    {} as ProjectProfileBinding
  );
  const notes = next.collections.find(({ name }) => name === "notes");
  expect(notes?.updateCmd).toBe("git pull");
  expect(notes?.updateCmdTimeoutMs).toBe(120_000);
  expect(notes?.audit).toEqual({
    externalUrls: "report",
    paths: ["**/*.md"],
  });
  expect(notes?.exclude).toEqual(["drafts"]);
});

const baseConfig = (collection: Partial<Config["collections"][number]>) =>
  ({
    version: "1.0",
    ftsTokenizer: DEFAULT_FTS_TOKENIZER,
    collections: [
      {
        name: "notes",
        path: "/work/notes",
        pattern: "**/*.md",
        include: [],
        exclude: [],
        ...collection,
      },
    ],
    contexts: [],
  }) as Config;

const profileState = (
  collection: Record<string, unknown> = {}
): ProjectProfileDesiredState =>
  ({
    schemaVersion: "1.0",
    collection: {
      name: "notes",
      root: ".",
      include: ["**/*.md"],
      exclude: ["drafts"],
      ...collection,
    },
    contexts: [],
    contentTypes: [],
    affinityDefaults: {},
  }) as unknown as ProjectProfileDesiredState;

test("settings a profile does not own survive a profile apply", () => {
  const kept = {
    egressPolicy: "remote",
    egressPolicyRevision: 7,
    sourceAvailability: "local",
    workspaceRoot: false,
    memoryManaged: true,
  } as const;
  const next = applyProjectProfileDesiredState(
    baseConfig(kept),
    profileState(),
    "/work/notes",
    {} as ProjectProfileBinding
  );
  const notes = next.collections.find(({ name }) => name === "notes");
  expect(notes).toMatchObject(kept);
});

test("profile-owned fields still come from the profile", () => {
  const next = applyProjectProfileDesiredState(
    baseConfig({
      path: "/old/notes",
      pattern: "**/*.txt",
      include: [".txt"],
      exclude: ["old"],
      languageHint: "de",
      workspaceRoot: "/work",
    }),
    profileState({ languageHint: "en" }),
    "/work/notes",
    {} as ProjectProfileBinding
  );
  const notes = next.collections.find(({ name }) => name === "notes");
  expect(notes?.path).toBe("/work/notes");
  expect(notes?.pattern).toBe("**/*.md");
  expect(notes?.include).toEqual([]);
  expect(notes?.exclude).toEqual(["drafts"]);
  expect(notes?.languageHint).toBe("en");
  expect(notes?.workspaceRoot).toBe("/work");
});

test("a collection created from a profile carries only profile fields", () => {
  const config = baseConfig({});
  config.collections = [];
  const next = applyProjectProfileDesiredState(
    config,
    profileState(),
    "/work/notes",
    {} as ProjectProfileBinding
  );
  expect(next.collections).toEqual([
    {
      name: "notes",
      path: "/work/notes",
      pattern: "**/*.md",
      include: [],
      exclude: ["drafts"],
    },
  ]);
});
