import type {
  AgentAdapter,
  AgentAdapterFactory,
  AdapterPreparation,
  AgentToolDefinition,
} from "./adapter";
import type { LoadedAgenticFixture } from "./fixture-db";
import type { AgentTask } from "./types";

import {
  AgenticHarnessError,
  validateAdapterCapabilities,
  validateAdapterPreparation,
} from "./adapter";
import { assertSha256, canonicalJson } from "./canonical";
import { projectAgentVisibleTask } from "./validation";

export const selectAgenticTasks = (
  fixture: LoadedAgenticFixture,
  taskIds: readonly string[] | undefined
): Readonly<AgentTask>[] => {
  const ids = taskIds ? [...taskIds] : [...fixture.tasks.keys()];
  if (
    ids.length === 0 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new AgenticHarnessError(
      "invalid_task_schedule",
      "Task schedule must be nonempty and unique"
    );
  }
  return ids.sort().map((taskId) => {
    const task = fixture.tasks.get(taskId);
    if (!task) {
      throw new AgenticHarnessError(
        "task_not_found",
        `Unknown task: ${taskId}`
      );
    }
    return projectAgentVisibleTask(task);
  });
};

export const withAbortTimeout = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  error: Error
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const disposeWithin = async (
  operation: () => Promise<void>,
  timeoutMs: number
): Promise<void> => {
  await withAbortTimeout(
    () => operation(),
    timeoutMs,
    new AgenticHarnessError("dispose_timeout", "Lifecycle disposal timed out")
  ).catch(() => {});
};

export const listToolsWithin = (
  adapter: AgentAdapter,
  timeoutMs: number
): Promise<readonly AgentToolDefinition[]> =>
  withAbortTimeout(
    () => adapter.listTools(),
    timeoutMs,
    new AgenticHarnessError(
      "list_tools_timeout",
      "Adapter tool listing timed out"
    )
  );

export interface ExpectedAdapterContract {
  adapterId: string;
  configFingerprint: string;
  capabilities: AgentAdapter["capabilities"];
}

const validateAdapterContract = (
  adapter: AgentAdapter,
  expected: ExpectedAdapterContract
): void => {
  validateAdapterCapabilities(adapter.capabilities);
  assertSha256(adapter.configFingerprint, "Adapter config fingerprint");
  if (
    adapter.adapterId !== expected.adapterId ||
    adapter.configFingerprint !== expected.configFingerprint ||
    canonicalJson(adapter.capabilities) !== canonicalJson(expected.capabilities)
  ) {
    throw new AgenticHarnessError(
      "adapter_identity_mismatch",
      "Attached adapter identity, config, or capabilities changed"
    );
  }
};

export const attachPreparedAdapter = async (
  factory: AgentAdapterFactory,
  fixture: LoadedAgenticFixture,
  preparation: AdapterPreparation,
  timeoutMs: number,
  expected: ExpectedAdapterContract
): Promise<AgentAdapter> => {
  const adapter = factory();
  try {
    validateAdapterContract(adapter, expected);
    const attached = await withAbortTimeout(
      (signal) =>
        adapter.prepare({
          snapshot: fixture.snapshot,
          prepared: preparation,
          signal,
        }),
      timeoutMs,
      new AgenticHarnessError(
        "adapter_attach_timeout",
        "Adapter timed out attaching the prepared index"
      )
    );
    validateAdapterPreparation(attached, expected.adapterId, fixture.snapshot);
    if (attached.indexFingerprint !== preparation.indexFingerprint) {
      throw new AgenticHarnessError(
        "index_fingerprint_changed",
        "Cold/warm adapter did not attach the prepared immutable index"
      );
    }
    return adapter;
  } catch (error) {
    await disposeWithin(() => adapter.dispose(), timeoutMs);
    throw error;
  }
};
