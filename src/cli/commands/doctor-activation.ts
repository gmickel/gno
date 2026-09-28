/** Passive retrieval activation diagnostics shared by `gno doctor`. */

import type { Config } from "../../config/types";
import type { ActivationStatus } from "../../core/activation-status";
import type { StorePort } from "../../store/types";
import type { DoctorCheck } from "./doctor";

import { getIndexDbPath, getModelsCachePath } from "../../app/constants";
import {
  classifyConnectorProof,
  describeOmittedConnectorPairs,
  omittedConnectorSummary,
} from "../../core/activation-connector-health";
import { isEmptyActivationCollection } from "../../core/activation-empty";
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
  const opened = await store.open(
    dbPath,
    config.ftsTokenizer,
    config.busyTimeoutMs
  );
  if (!opened.ok) {
    return unavailableActivation(config);
  }

  try {
    const indexStatus = await store.getStatus();
    const embedCached = await new ModelCache(getModelsCachePath()).isCached(
      getActivePreset(config).embed
    );
    return await buildActivationStatus(
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

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export function checkRetrievalActivation(
  activation: ActivationStatus
): DoctorCheck {
  const ready = activation.collections.filter((collection) => collection.ready);
  const empty = activation.collections.filter(isEmptyActivationCollection);
  const emptyDetails = empty.flatMap(({ collection, remediation }) => [
    `${collection}: no documents indexed yet (informational)`,
    `Add files, then run: ${remediation?.command ?? "gno update"}`,
  ]);

  if (activation.healthy) {
    const semanticStates = [
      ...new Set(
        ready.map(({ semanticAvailability }) => semanticAvailability.code)
      ),
    ];
    const semanticDetail =
      ready.length > 0
        ? [
            `Semantic retrieval remains separate (${semanticStates.join(", ")}).`,
          ]
        : [];
    if (empty.length === 0) {
      return {
        name: "retrieval-activation",
        status: "ok",
        message: `${plural(ready.length, "collection")} passed lexical retrieval proof`,
        details: semanticDetail,
      };
    }
    return {
      name: "retrieval-activation",
      status: "info",
      message:
        ready.length > 0
          ? `${plural(ready.length, "collection")} passed lexical retrieval proof; ${plural(empty.length, "collection")} with no documents yet`
          : `No documents indexed yet in ${plural(empty.length, "collection")}`,
      details: [...emptyDetails, ...semanticDetail],
    };
  }

  const failed = activation.collections.filter(
    (collection) =>
      !collection.ready && !isEmptyActivationCollection(collection)
  );
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
          ? `${plural(failed.length, "collection")} failed lexical retrieval proof`
          : "No configured collection passed lexical retrieval proof",
    details: [...details, ...emptyDetails],
  };
}

export function checkConnectorActivation(
  activation: ActivationStatus
): DoctorCheck | null {
  const { projected, total, truncated } = activation.connectorProjection;
  const omitted = omittedConnectorSummary(activation);
  const observed = activation.connectors.filter(
    (connector) => classifyConnectorProof(connector) !== "notApplicable"
  );
  const omittedObserved = omitted
    ? omitted.passed + omitted.failed + omitted.incomplete
    : 0;
  if (observed.length === 0 && omittedObserved === 0 && omitted) {
    return null;
  }
  const incomplete = observed.filter(({ status }) => status !== "passed");
  const details = incomplete.map(
    ({ collection, target, status, code, remediation }) =>
      `${target}/${collection}: ${status}${code ? `/${code}` : ""}${remediation ? `. ${remediation}` : ""}`
  );
  const omittedDetail = describeOmittedConnectorPairs(activation);
  if (omittedDetail) {
    details.unshift(omittedDetail);
  }
  const unresolved =
    incomplete.length + (omitted ? omitted.failed + omitted.incomplete : 0);
  const passed = observed.length - incomplete.length + (omitted?.passed ?? 0);
  const listing = truncated ? ` (${projected} of ${total} checks listed)` : "";
  return {
    name: "connector-activation",
    status: unresolved > 0 || !omitted ? "warn" : "ok",
    message:
      unresolved > 0
        ? `${unresolved} connector proof${unresolved === 1 ? "" : "s"} pending or failed${listing}`
        : omitted
          ? `${passed} connector proof${passed === 1 ? "" : "s"} passed${listing}`
          : `${projected} of ${total} connector target/collection checks projected`,
    details,
  };
}
