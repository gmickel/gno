import { afterEach, expect, mock, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContextHolder } from "../../src/serve/routes/api";

import {
  modelsPull,
  type ModelsPullOptions,
} from "../../src/cli/commands/models/pull";
import { ModelCache } from "../../src/llm/cache";
import { downloadState, resetDownloadState } from "../../src/serve/context";
import { ResidentBackgroundWork } from "../../src/serve/resident-background-work";
import { handleModelPull } from "../../src/serve/routes/api";
import { safeRm } from "../helpers/cleanup";

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

test("resident shutdown aborts a blocked model download without reloading", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "gno-model-pull-abort-"));
  let downloadStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    downloadStarted = resolve;
  });
  const cache = new ModelCache(tempDir, {
    resolveModelFile: (async (
      _uri: string,
      options?: { signal?: AbortSignal }
    ) => {
      downloadStarted?.();
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true }
        );
      });
      throw new Error("unreachable");
    }) as never,
  });
  const backgroundWork = new ResidentBackgroundWork(() => true);
  const reload = mock(async (current: unknown) => current);
  const config = {
    version: "1.0" as const,
    ftsTokenizer: "unicode61" as const,
    collections: [],
    contexts: [],
    models: {
      activePreset: "blocked-download",
      presets: [
        {
          id: "blocked-download",
          name: "Blocked Download",
          embed: "hf:test/models/embed.gguf",
          rerank: "hf:test/models/rerank.gguf",
          expand: "hf:test/models/expand.gguf",
          gen: "hf:test/models/gen.gguf",
        },
      ],
    },
  };
  const ctxHolder = {
    current: {},
    config,
    scheduler: null,
    eventBus: null,
    watchService: null,
    startBackgroundWork: (operation: (signal: AbortSignal) => Promise<void>) =>
      backgroundWork.start(operation),
  } as unknown as ContextHolder;

  try {
    const response = handleModelPull(ctxHolder, {
      modelsPullFn: ((options: ModelsPullOptions) =>
        modelsPull(options, { cache })) as never,
      reloadServerContextFn: reload as never,
    });
    expect(response.status).toBe(200);
    await started;

    const shutdown = backgroundWork.cancelAndDrain();
    await Promise.race([
      shutdown,
      Bun.sleep(250).then(() => {
        throw new Error("resident background shutdown timed out");
      }),
    ]);

    expect(reload).not.toHaveBeenCalled();
    expect(downloadState.active).toBe(false);
    expect(await cache.list()).toEqual([]);
  } finally {
    await safeRm(tempDir);
  }
});
