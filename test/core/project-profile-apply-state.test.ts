/** fn-207: applying a project profile keeps a collection's updateCmd limit. */

import { expect, test } from "bun:test";

import type { Config, ProjectProfileBinding } from "../../src/config/types";
import type { ProjectProfileDesiredState } from "../../src/core/project-profile";

import { DEFAULT_FTS_TOKENIZER } from "../../src/config/types";
import { applyProjectProfileDesiredState } from "../../src/core/project-profile-apply-state";

test("an existing updateCmd and its timeout survive a profile apply", () => {
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
  expect(notes?.exclude).toEqual(["drafts"]);
});
