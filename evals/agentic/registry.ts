import type { AgentAdapterFactory } from "./adapter";

import { AgenticHarnessError } from "./adapter";
import { createCapsulePrototypeAdapterFactory } from "./adapters/capsule-prototype";
import { createGnoMcpAdapterFactory } from "./adapters/gno-mcp";
import { createLexicalAdapterFactory } from "./adapters/lexical";
import { createQmdAdapterFactory } from "./adapters/qmd";

export const DEFAULT_AGENTIC_ADAPTER_IDS = [
  "gno-mcp",
  "lexical",
  "capsule",
] as const;

export const ALL_AGENTIC_ADAPTER_IDS = [
  ...DEFAULT_AGENTIC_ADAPTER_IDS,
  "qmd",
] as const;

export type AgenticAdapterId = (typeof ALL_AGENTIC_ADAPTER_IDS)[number];

const isAdapterId = (value: string): value is AgenticAdapterId =>
  ALL_AGENTIC_ADAPTER_IDS.includes(value as AgenticAdapterId);

export const createAgenticAdapterFactories = (
  adapterIds: readonly string[]
): Record<string, AgentAdapterFactory> => {
  const factories: Record<string, AgentAdapterFactory> = {};
  for (const adapterId of adapterIds) {
    if (!isAdapterId(adapterId)) {
      throw new AgenticHarnessError(
        "adapter_not_registered",
        `Unknown agentic adapter: ${adapterId}`
      );
    }
    factories[adapterId] =
      adapterId === "gno-mcp"
        ? createGnoMcpAdapterFactory()
        : adapterId === "lexical"
          ? createLexicalAdapterFactory()
          : adapterId === "capsule"
            ? createCapsulePrototypeAdapterFactory()
            : createQmdAdapterFactory({ repoPath: process.env.QMD_REPO });
  }
  return factories;
};
