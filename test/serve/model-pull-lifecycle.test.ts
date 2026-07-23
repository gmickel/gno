import { afterEach, expect, mock, test } from "bun:test";

import type { ContextHolder } from "../../src/serve/routes/api";

import { downloadState, resetDownloadState } from "../../src/serve/context";
import { handleModelPull } from "../../src/serve/routes/api";

afterEach(() => {
  resetDownloadState();
});

test("resident model pull is tracked and cancellation suppresses context reload", async () => {
  let background: ((signal: AbortSignal) => Promise<void>) | undefined;
  const reload = mock(async (current: unknown) => current);
  const modelsPull = mock(async (options: { signal?: AbortSignal }) => {
    await new Promise<void>((resolve) => {
      options.signal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    return { results: [], failed: 0, skipped: 0 };
  });
  const ctxHolder = {
    current: {},
    config: {
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections: [],
      contexts: [],
    },
    scheduler: null,
    eventBus: null,
    watchService: null,
    startBackgroundWork: (
      operation: (signal: AbortSignal) => Promise<void>
    ) => {
      background = operation;
      return true;
    },
  } as unknown as ContextHolder;

  const response = handleModelPull(ctxHolder, {
    modelsPullFn: modelsPull as never,
    reloadServerContextFn: reload as never,
  });
  expect(response.status).toBe(200);
  expect(downloadState.active).toBe(true);
  expect(background).toBeDefined();

  const controller = new AbortController();
  const running = background?.(controller.signal);
  controller.abort();
  await running;

  expect(modelsPull).toHaveBeenCalledTimes(1);
  expect(reload).toHaveBeenCalledTimes(0);
  expect(downloadState.active).toBe(false);
});

test("resident model pull fails closed once background admission closes", async () => {
  const ctxHolder = {
    current: {},
    config: {
      version: "1.0",
      ftsTokenizer: "unicode61",
      collections: [],
      contexts: [],
    },
    scheduler: null,
    eventBus: null,
    watchService: null,
    startBackgroundWork: () => false,
  } as unknown as ContextHolder;

  const response = handleModelPull(ctxHolder);
  expect(response.status).toBe(503);
  expect(downloadState.active).toBe(false);
});
