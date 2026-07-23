import { describe, expect, test } from "bun:test";

import {
  recordContentMutation,
  recordIndexMutation,
} from "../../src/core/mutation-generations";

describe("resident mutation generations", () => {
  test("records startup, watcher, REST, and MCP sync mutations consistently", () => {
    let generation = 0;
    const mark = () => {
      generation += 1;
    };

    recordContentMutation({ totalFilesAdded: 1 }, mark);
    recordContentMutation({ filesUpdated: 1 }, mark);
    recordContentMutation({ collections: [{ filesMarkedInactive: 1 }] }, mark);
    recordContentMutation({ totalFilesAdded: 0, totalFilesUpdated: 0 }, mark);

    expect(generation).toBe(3);
  });

  test("records only embedding runs that changed the vector index", () => {
    let generation = 0;
    const mark = () => {
      generation += 1;
    };

    recordIndexMutation(0, mark);
    recordIndexMutation(2, mark);

    expect(generation).toBe(1);
  });
});
