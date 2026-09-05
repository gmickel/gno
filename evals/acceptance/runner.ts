/** Paired, serialized lifecycle screens. Factory readiness must not load models.
 * A fresh timer starts before process acquisition; all requests include transport,
 * native model acquisition, projection and capture overhead. No stage subtraction.
 */
import type { AcceptanceRecord } from "./records";
import type {
  LatencyState,
  PairedReport,
  RunSample,
  SessionProcessIdentity,
  Side,
} from "./report";

import { compareAcceptance } from "./compare";
import { type AcceptanceManifest, validateManifestPair } from "./manifest";
import { summarizeReport } from "./report";
import { OwnedResources } from "./resources";

export interface AcceptanceSession {
  processId: number;
  processIdentity?: SessionProcessIdentity;
  /** Observed native state: null means instrumentation unavailable. */
  modelState(): Promise<boolean | null>;
  run(caseId: string): Promise<{
    record: AcceptanceRecord;
    coverage: "complete" | "incomplete";
    reasons: string[];
    stages?: Record<string, number>;
  }>;
  close(): Promise<void>;
}
export interface AcceptanceSessionFactory {
  open(scope: OwnedResources): Promise<AcceptanceSession>;
}
export interface PairedRunnerOptions {
  baseline: AcceptanceManifest;
  candidate: AcceptanceManifest;
  factories: Record<Side, AcceptanceSessionFactory>;
  strata?: LatencyState[];
  observations?: number;
  seed: number;
  order?: "alternating" | "randomized";
  idleMs?: number;
  timeoutMs?: number;
  sampleIntervalMs?: number;
  sampleGpu?: boolean;
  hostLoadCaveats?: string[];
  clock?: () => number;
}

let active = false;
const STATES: LatencyState[] = [
  "fresh-process",
  "resident-model-cold",
  "warm",
  "post-idle",
];
function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
function qualityErrors(record: AcceptanceRecord): string[] {
  const state = record.deterministic.semanticState;
  const errors: string[] = [];
  if (state.status !== "ok" || state.error !== null || state.fallbacks.length)
    errors.push(
      "Failed/incomplete request or fallback cannot count as a speedup"
    );
  if (record.generatedAnswer !== null && !record.generatedAnswer.trim())
    errors.push("Empty answer cannot count as a speedup");
  return errors;
}

async function observe(
  options: PairedRunnerOptions,
  state: LatencyState,
  block: number,
  side: Side,
  order: Side[],
  caseId: string
): Promise<RunSample> {
  const clock = options.clock ?? (() => performance.now());
  const scope = new OwnedResources(options.sampleGpu);
  const sample: RunSample = {
    block,
    state,
    side,
    order,
    caseId,
    durationMs: null,
    stages: {},
    record: null,
    resources: scope.samples,
    overlap: null,
    beforeIdle: null,
    afterIdle: null,
    processId: null,
    processIdentity: null,
    modelStateBefore: null,
    primerCaseId: null,
    idleMs: state === "post-idle" ? (options.idleMs ?? 1000) : 0,
    errors: [],
    caveats: [...(options.hostLoadCaveats ?? [])],
  };
  let session: AcceptanceSession | undefined;
  let background: AcceptanceSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;
  const check = () => {
    if (aborted) throw new Error("Observation timed out");
  };
  const work = async () => {
    const backgroundCase = options.baseline.cases.find(
      (item) => item.caseId === caseId
    )?.configuration.backgroundCaseId;
    if (backgroundCase !== undefined) {
      if (
        typeof backgroundCase !== "string" ||
        !options.baseline.cases.some((item) => item.caseId === backgroundCase)
      )
        throw new Error("Unknown declared background case");
      background = await options.factories[side].open(scope);
      check();
      if (!scope.owns(background.processId))
        throw new Error("Background session is not owned");
    }
    const acquiredAt = clock();
    if (!Number.isFinite(acquiredAt)) throw new Error("Clock unavailable");
    session = await options.factories[side].open(scope);
    check();
    const readyAt = clock();
    sample.processId = session.processId;
    sample.processIdentity = session.processIdentity ?? null;
    if (!scope.owns(session.processId))
      throw new Error("Session is not a live owned process");
    scope.start(options.sampleIntervalMs);
    if (state === "warm" || state === "post-idle") {
      const declaredPrimer = options.baseline.cases.find(
        (item) => item.caseId === caseId
      )?.configuration.primerCaseId;
      const primerCaseId =
        typeof declaredPrimer === "string" ? declaredPrimer : caseId;
      if (!options.baseline.cases.some((item) => item.caseId === primerCaseId))
        throw new Error("Unknown declared primer case");
      sample.primerCaseId = primerCaseId;
      const primer = await session.run(primerCaseId);
      check();
      if (primer.coverage !== "complete" || qualityErrors(primer.record).length)
        throw new Error("Warm-up request incomplete or invalid");
      if ((await session.modelState()) !== true)
        throw new Error("Warm-up did not establish observed loaded models");
      if (state === "post-idle") {
        await scope.sample();
        sample.beforeIdle = scope.samples.at(-1) ?? null;
        await Bun.sleep(options.idleMs ?? 1000);
        check();
        await scope.sample();
        sample.afterIdle = scope.samples.at(-1) ?? null;
      }
    }
    sample.modelStateBefore = await session.modelState();
    check();
    if (sample.modelStateBefore === null)
      throw new Error("Native model state unavailable");
    if (
      (state === "fresh-process" || state === "resident-model-cold") &&
      sample.modelStateBefore !== false
    )
      throw new Error("Cold session already has loaded models");
    if (state === "warm" && sample.modelStateBefore !== true)
      throw new Error("Warm session lost loaded models");
    await scope.sample();
    const backgroundAt = background ? clock() : null;
    // Start a real second owned request. This measures two-session contention,
    // not fairness of a resident service's internal background scheduler.
    const backgroundRun =
      background && typeof backgroundCase === "string"
        ? background.run(backgroundCase).then(
            (result) => ({ result, endedAt: clock() }),
            (error: unknown) => ({ error })
          )
        : null;
    const requestAt = clock();
    const result = await session.run(caseId);
    const endedAt = clock();
    check();
    sample.record = result.record;
    sample.errors.push(...qualityErrors(result.record));
    if (result.coverage !== "complete")
      sample.errors.push("Native coverage incomplete", ...result.reasons);
    const start = state === "fresh-process" ? acquiredAt : requestAt;
    if (
      ![readyAt, requestAt, endedAt].every(Number.isFinite) ||
      readyAt < acquiredAt ||
      requestAt < readyAt ||
      endedAt < requestAt
    )
      throw new Error("Clock failed or moved backwards");
    sample.durationMs = endedAt - start;
    sample.stages = {
      ...result.stages,
      acquisitionMs: readyAt - acquiredAt,
      preparationMs: requestAt - readyAt,
      requestMs: endedAt - requestAt,
    };
    if (Object.values(sample.stages).some((n) => !Number.isFinite(n) || n < 0))
      throw new Error("Invalid stage clock");
    await scope.sample();
    if (
      backgroundRun &&
      background &&
      backgroundAt !== null &&
      typeof backgroundCase === "string"
    ) {
      const completed = await backgroundRun;
      check();
      if ("error" in completed)
        throw new Error(
          `Background request failed: ${String(completed.error)}`
        );
      const overlap =
        Math.min(endedAt, completed.endedAt) -
        Math.max(requestAt, backgroundAt);
      if (
        !Number.isFinite(completed.endedAt) ||
        completed.endedAt < backgroundAt ||
        overlap <= 0
      )
        throw new Error(
          "No valid foreground/background request overlap observed"
        );
      sample.overlap = {
        kind: "two-owned-sessions",
        caseId: backgroundCase,
        processId: background.processId,
        processIdentity: background.processIdentity ?? null,
        durationMs: completed.endedAt - backgroundAt,
        overlappingMs: overlap,
        record: completed.result.record,
      };
      sample.errors.push(...qualityErrors(completed.result.record));
      if (completed.result.coverage !== "complete")
        sample.errors.push(
          "Background native coverage incomplete",
          ...completed.result.reasons
        );
    }
  };
  try {
    await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          aborted = true;
          reject(new Error("Observation timeout"));
        }, options.timeoutMs ?? 60_000);
      }),
    ]);
  } catch (error) {
    sample.errors.push(String(error));
  } finally {
    clearTimeout(timer);
    await scope.stopSampling();
    // A timed-out native call may never resolve: terminate owned handles first.
    if (aborted) await scope.close();
    try {
      for (const owned of [session, background])
        if (owned && !aborted) {
          await Promise.race([
            owned.close(),
            Bun.sleep(2000).then(() => {
              throw new Error("Session cleanup timeout");
            }),
          ]);
        }
    } catch (error) {
      sample.errors.push(String(error));
    }
    await scope.close();
    sample.errors.push(...scope.errors);
  }
  return sample;
}

export async function runPairedAcceptance(
  options: PairedRunnerOptions
): Promise<PairedReport> {
  const manifests = validateManifestPair(options.baseline, options.candidate);
  const observations = options.observations ?? 30;
  const strata = options.strata ?? STATES;
  if (
    !Number.isInteger(observations) ||
    observations < 1 ||
    !Number.isInteger(options.seed) ||
    !strata.length ||
    new Set(strata).size !== strata.length ||
    strata.some((state) => !STATES.includes(state))
  )
    throw new Error("Invalid paired schedule");
  if (
    options.idleMs !== undefined &&
    (!Number.isFinite(options.idleMs) || options.idleMs < 0)
  )
    throw new Error("Invalid idle duration");
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  )
    throw new Error("Invalid observation timeout");
  if (active)
    throw new Error("Acceptance workloads must be serialized per host");
  active = true;
  const rng = random(options.seed);
  const report: PairedReport = {
    ...manifests,
    seed: options.seed,
    samples: [],
    comparisons: [],
    summaries: [],
    status: "incomplete",
    caveats: [
      "Screening is not proof of equivalence; percentiles are empirical and no universal regression allowance is applied.",
      "Host load is not isolated. Owned PID sampling excludes unrelated processes; transient peaks may be missed.",
      "RSS and GPU counters may overlap on unified memory and are never added.",
      "Fresh process does not mean cold OS filesystem cache. Capture and transport overhead remain included.",
    ],
  };
  try {
    for (const state of strata)
      for (let block = 0; block < observations; block++) {
        const candidateFirst =
          options.order === "randomized"
            ? rng() < 0.5
            : (block + (options.seed & 1)) % 2 === 1;
        const order: Side[] = candidateFirst
          ? ["candidate", "baseline"]
          : ["baseline", "candidate"];
        const rows: RunSample[] = [];
        for (const side of order)
          for (const item of manifests.baseline.cases) {
            rows.push(
              await observe(options, state, block, side, order, item.caseId)
            );
          }
        report.samples.push(...rows);
        const records = (side: Side) =>
          rows
            .filter((row) => row.side === side)
            .flatMap((row) => (row.record ? [row.record] : []));
        try {
          const result = compareAcceptance(
            manifests.baseline,
            manifests.candidate,
            records("baseline"),
            records("candidate")
          );
          // Equal bad outputs are still failures, not faster successful controls.
          for (const row of rows)
            if (row.record)
              for (const reason of qualityErrors(row.record))
                result.failures.push({
                  caseId: row.caseId,
                  field: "semanticState",
                  reason,
                });
          for (const row of rows.filter(
            (item) => item.side === "baseline" && item.overlap
          )) {
            const a = row.overlap;
            const b = rows.find(
              (item) => item.side === "candidate" && item.caseId === row.caseId
            )?.overlap;
            if (!(a && b)) continue; // Missing overlap already carries an incomplete observation error.
            const replace = (side: Side, record: AcceptanceRecord) =>
              records(side).map((value) =>
                value.caseId === record.caseId ? record : value
              );
            const overlapComparison = compareAcceptance(
              manifests.baseline,
              manifests.candidate,
              replace("baseline", a.record),
              replace("candidate", b.record)
            );
            result.failures.push(
              ...overlapComparison.failures.map((failure) => ({
                ...failure,
                field: `background.${failure.field}`,
              }))
            );
            for (const record of [a.record, b.record])
              for (const reason of qualityErrors(record))
                result.failures.push({
                  caseId: record.caseId,
                  field: "background.semanticState",
                  reason,
                });
          }
          result.passed = result.failures.length === 0;
          report.comparisons.push({ state, block, result });
        } catch (error) {
          report.comparisons.push({
            state,
            block,
            result: {
              passed: false,
              comparedCases: 0,
              generatedAnswerChanges: [],
              failures: [
                { caseId: "*", field: "record", reason: String(error) },
              ],
            },
          });
        }
      }
    // Missing records from measurement failures are incomplete, not quality evidence.
    if (report.samples.some((row) => row.record === null)) return report;
    return summarizeReport(report, strata, observations);
  } finally {
    active = false;
  }
}
