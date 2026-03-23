import { describe, expect, test } from "bun:test";

import {
  activateWorkspaceTab,
  closeWorkspaceTab,
  createWorkspaceTab,
  loadWorkspaceState,
  saveWorkspaceState,
  updateActiveTabLocation,
  type WorkspaceStorageLike,
} from "../../../src/serve/public/lib/workspace-tabs";

function createStorage(): WorkspaceStorageLike {
  const data = new Map<string, string>();
  return {
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

describe("workspace tabs", () => {
  test("loads fallback tab when storage is empty", () => {
    const storage = createStorage();
    const state = loadWorkspaceState("/search", storage);
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.location).toBe("/search");
  });

  test("restores stored tabs when reopening root route", () => {
    const storage = createStorage();
    const initial = loadWorkspaceState("/search", storage);
    const withSecond = createWorkspaceTab(initial, "/browse?collection=notes");
    saveWorkspaceState(withSecond, storage);

    const restored = loadWorkspaceState("/", storage);
    expect(restored.tabs).toHaveLength(2);
    expect(restored.activeTabId).toBe(withSecond.activeTabId);
  });

  test("injects explicit current route when it is missing from restored tabs", () => {
    const storage = createStorage();
    const initial = loadWorkspaceState("/search", storage);
    saveWorkspaceState(initial, storage);

    const restored = loadWorkspaceState(
      "/doc?uri=gno%3A%2F%2Fnotes%2Fa.md",
      storage
    );
    expect(
      restored.tabs.some(
        (tab) => tab.location === "/doc?uri=gno%3A%2F%2Fnotes%2Fa.md"
      )
    ).toBe(true);
  });

  test("updates active tab location and label", () => {
    const storage = createStorage();
    const state = loadWorkspaceState("/search", storage);
    const next = updateActiveTabLocation(
      state,
      "/doc?uri=gno%3A%2F%2Fnotes%2Fa.md"
    );
    expect(next.tabs[0]?.label).toContain("a.md");
  });

  test("close active tab activates a neighbor", () => {
    const storage = createStorage();
    const first = loadWorkspaceState("/search", storage);
    const second = createWorkspaceTab(first, "/browse");
    const third = createWorkspaceTab(second, "/ask");
    const activated = activateWorkspaceTab(third, second.tabs[0]!.id);
    const next = closeWorkspaceTab(activated, activated.activeTabId);

    expect(next.tabs).toHaveLength(2);
    expect(next.activeTabId).not.toBe(activated.activeTabId);
  });
});
