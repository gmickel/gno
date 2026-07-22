/** Passive retrieval activation diagnostics shared by `gno doctor`. */

import type { Config } from "../../config/types";
import type { ActivationStatus } from "../../core/activation-status";
import type { StorePort } from "../../store/types";
import type { DoctorCheck } from "./doctor";

import { getIndexDbPath, getModelsCachePath } from "../../app/constants";
import { buildActivationStatus } from "../../core/activation-status";
import { ModelCache } from "../../llm/cache";
import { getActivePreset } from "../../llm/registry";
import { getConnectorVerificationTargets } from "../../serve/connectors";
import { SqliteAdapter } from "../../store/sqlite/adapter";

export interface DoctorActivationOptions {
  configPath?: string;
  indexName?: string;
}

async function unavailableActivation(
  config: Config
): Promise<ActivationStatus> {
  return buildActivationStatus(
    {} as StorePort,
    config.collections.map(({ name }) => name),
    {
      verifyCollection: async () => ({
        ok: false,
        error: { code: "QUERY_FAILED", message: "Activation unavailable" },
      }),
    }
  );
}

export async function buildDoctorActivation(
  config: Config,
  options: DoctorActivationOptions
): Promise<ActivationStatus> {
  const dbPath = getIndexDbPath(options.indexName);
  if (!(await Bun.file(dbPath).exists())) {
    return unavailableActivation(config);
  }

  const store = new SqliteAdapter();
  store.setConfigPath(options.configPath ?? "");
  const opened = await store.open(dbPath, config.ftsTokenizer);
  if (!opened.ok) {
    return unavailableActivation(config);
  }

  try {
    const indexStatus = await store.getStatus();
    const embedCached = await new ModelCache(getModelsCachePath()).isCached(
      getActivePreset(config).embed
    );
    return buildActivationStatus(
      store,
      config.collections.map(({ name }) => name),
      {
        semantic: {
          modelsCached: embedCached,
          embeddingBacklog: indexStatus.ok
            ? indexStatus.value.embeddingBacklog
            : 0,
        },
        connectorTargets: await getConnectorVerificationTargets(),
      }
    );
  } finally {
    await store.close();
  }
}

export function checkRetrievalActivation(
  activation: ActivationStatus
): DoctorCheck {
  if (activation.healthy) {
    const semanticPending = activation.collections.filter(
      ({ semanticAvailability }) =>
        semanticAvailability.code !== "semantic_not_checked"
    ).length;
    return {
      name: "retrieval-activation",
      status: "ok",
      message: `${activation.collections.length} collection${activation.collections.length === 1 ? "" : "s"} passed lexical retrieval proof`,
      details:
        semanticPending > 0
          ? [
              `Semantic availability remains pending in ${semanticPending} collection${semanticPending === 1 ? "" : "s"}.`,
            ]
          : undefined,
    };
  }

  const failed = activation.collections.filter(({ ready }) => !ready);
  const details = failed.flatMap(({ collection, remediation }) =>
    remediation
      ? [
          `${collection}: ${remediation.stage}/${remediation.code}`,
          `Run: ${remediation.command}`,
        ]
      : [`${collection}: activation unavailable`]
  );
  return {
    name: "retrieval-activation",
    status: "error",
    message:
      activation.collections.length === 0
        ? "No collections configured. Run: gno collection add"
        : activation.usable
          ? `${failed.length} collection${failed.length === 1 ? "" : "s"} failed lexical retrieval proof`
          : "No configured collection passed lexical retrieval proof",
    details,
  };
}

export function checkConnectorActivation(
  activation: ActivationStatus
): DoctorCheck | null {
  const { projected, total, truncated } = activation.connectorProjection;
  const omitted = total - projected;
  const observed = activation.connectors.filter(
    ({ code }) =>
      code !== "connector_not_configured" &&
      code !== "target_runtime_unverifiable"
  );
  if (observed.length === 0 && !truncated) {
    return null;
  }
  const incomplete = observed.filter(({ status }) => status !== "passed");
  const details = incomplete.map(
    ({ collection, target, status, code, remediation }) =>
      `${target}/${collection}: ${status}${code ? `/${code}` : ""}${remediation ? `. ${remediation}` : ""}`
  );
  if (truncated) {
    details.unshift(
      `${omitted} target/collection checks were omitted by the bounded status projection; no result is claimed for them.`
    );
  }
  return {
    name: "connector-activation",
    status: incomplete.length > 0 || truncated ? "warn" : "ok",
    message:
      incomplete.length > 0
        ? `${incomplete.length} connector proof${incomplete.length === 1 ? "" : "s"} pending or failed`
        : truncated
          ? `${projected} of ${total} connector target/collection checks projected`
          : `${observed.length} connector proof${observed.length === 1 ? "" : "s"} passed`,
    details,
  };
}
