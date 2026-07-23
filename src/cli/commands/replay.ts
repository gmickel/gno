/** Local read-only retrieval replay command. */

import type {
  ReplayRetrievalTraceResult,
  RetrievalReplayCandidate,
} from "../../core/retrieval-trace-management";
import type {
  EmbeddingPort,
  GenerationPort,
  RerankPort,
} from "../../llm/types";
import type { VectorIndexPort } from "../../store/vector";

import { RetrievalTraceManagementService } from "../../core/retrieval-trace-management";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../../llm/policy";
import { resolveModelUri } from "../../llm/registry";
import { createVectorIndexPort } from "../../store/vector";
import { CliError } from "../errors";
import { initStore } from "./shared";

export interface TraceReplayCommandOptions {
  configPath?: string;
  indexName?: string;
  format?: "json" | "md";
  offline?: boolean;
}

const unwrap = <T>(
  value: { ok: true; value: T } | { ok: false; error: { message: string } }
): T => {
  if (value.ok) return value.value;
  throw new CliError("RUNTIME", value.error.message);
};

const formatMarkdown = (value: ReplayRetrievalTraceResult): string => {
  const lines = [
    `# Retrieval replay \`${value.exportId}\``,
    "",
    `- Verdict: **${value.verdict}**`,
    `- Recommendation: **${value.recommendation}**`,
    `- Applied: **no**`,
  ];
  if (value.reason) lines.push(`- Reason: \`${value.reason}\``);
  lines.push(
    "",
    "| Case | Status | Verdict | Baseline recall | Candidate recall |",
    "|---|---|---|---:|---:|"
  );
  for (const item of value.cases) {
    lines.push(
      `| \`${item.caseId}\` | ${item.terminalStatus} | ${item.verdict} | ${item.metrics.baseline.recallAtK.toFixed(3)} | ${item.metrics.candidate.recallAtK.toFixed(3)} |`
    );
  }
  return `${lines.join("\n")}\n`;
};

export const traceReplay = async (
  exportId: string,
  candidate: RetrievalReplayCandidate,
  options: TraceReplayCommandOptions = {}
): Promise<string> => {
  const initialized = await initStore({
    configPath: options.configPath,
    indexName: options.indexName,
    syncConfig: false,
    allowEmptyCollections: true,
  });
  if (!initialized.ok) throw new CliError("RUNTIME", initialized.error);
  const { config, store } = initialized;
  let embedPort: EmbeddingPort | null = null;
  let expandPort: GenerationPort | null = null;
  let rerankPort: RerankPort | null = null;
  let vectorIndex: VectorIndexPort | null = null;
  try {
    const needsSemantic = candidate.type !== "bm25";
    const embedUri = needsSemantic
      ? resolveModelUri(config, "embed")
      : undefined;
    const expandUri =
      candidate.type === "hybrid" &&
      !candidate.noExpand &&
      !candidate.queryModes?.length
        ? resolveModelUri(config, "expand")
        : undefined;
    const rerankUri =
      candidate.type === "hybrid" && !candidate.noRerank
        ? resolveModelUri(config, "rerank")
        : undefined;
    const llm = new LlmAdapter(config);
    const policy = resolveDownloadPolicy(process.env, {
      offline: options.offline,
    });
    if (embedUri) {
      const created = await llm.createEmbeddingPort(embedUri, { policy });
      if (created.ok) embedPort = created.value;
    }
    if (expandUri) {
      const created = await llm.createExpansionPort(expandUri, { policy });
      if (created.ok) expandPort = created.value;
    }
    if (rerankUri) {
      const created = await llm.createRerankPort(rerankUri, { policy });
      if (created.ok) rerankPort = created.value;
    }
    if (embedPort && embedUri) {
      const initializedEmbed = await embedPort.init();
      if (initializedEmbed.ok) {
        const created = await createVectorIndexPort(store.getRawDb(), {
          model: embedUri,
          dimensions: embedPort.dimensions(),
        });
        if (created.ok) vectorIndex = created.value;
      }
    }
    const replayed = await new RetrievalTraceManagementService(store).replay(
      { exportId, candidate },
      {
        config,
        vectorIndex,
        embedPort,
        expandPort,
        rerankPort,
        indexName: options.indexName,
        modelUris: [embedUri, expandUri, rerankUri].filter(
          (value): value is string => Boolean(value)
        ),
      }
    );
    const value = unwrap(replayed);
    return options.format === "md"
      ? formatMarkdown(value)
      : `${JSON.stringify(value, null, 2)}\n`;
  } finally {
    await embedPort?.dispose();
    await expandPort?.dispose();
    await rerankPort?.dispose();
    await store.close();
  }
};
