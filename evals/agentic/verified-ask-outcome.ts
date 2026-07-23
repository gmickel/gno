import type { Config } from "../../src/config";
import type { GenerationPort, LlmResult } from "../../src/llm/types";
import type { AskOptions, Citation } from "../../src/pipeline/types";
import type { LoadedAgenticFixture } from "./fixture-db";
import type { AgentTask, ClaimValue, HiddenOracle } from "./types";
import type {
  VerifiedAskOutcomeCitation,
  VerifiedAskOutcomeReceipt,
  VerifiedAskOutcomeScore,
  VerifiedAskPromotionArtifact,
} from "./verified-ask-promotion";

import { buildVerifiedAsk } from "../../src/app/verified-ask";
import { DEFAULT_FTS_TOKENIZER } from "../../src/config";
import {
  generateGroundedAnswer,
  processAnswerResult,
} from "../../src/pipeline/answer";
import { searchHybrid } from "../../src/pipeline/hybrid";
import { CITATION_TRACE_METADATA } from "../../src/pipeline/types";
import { SqliteAdapter } from "../../src/store";
import { canonicalFingerprint } from "./canonical";
import { buildFixtureSearchQuery } from "./fixture-agent";
import {
  cleanupNativeIndexPreparation,
  prepareGnoNativeIndex,
} from "./native-index";
import {
  evaluateVerifiedAskPromotion,
  VERIFIED_ASK_AGENT_ID,
  VERIFIED_ASK_BENCHMARK_ID,
  VERIFIED_ASK_SEED,
  VERIFIED_ASK_TRIAL_ID,
  verifiedAskArtifactFingerprint,
  verifiedAskClaimValuesMatch,
} from "./verified-ask-promotion";

export type {
  VerifiedAskOutcomeCitation,
  VerifiedAskOutcomeReceipt,
  VerifiedAskOutcomeScore,
  VerifiedAskPromotionArtifact,
} from "./verified-ask-promotion";
export {
  evaluateVerifiedAskPromotion,
  renderVerifiedAskPromotionMarkdown,
} from "./verified-ask-promotion";

const ADVERSARIAL_TASK_IDS = new Set([
  "t0a1b2c3",
  "t6071829",
  "t8293a4b",
  "te8f901a",
]);

const adversarialValue = (value: ClaimValue): ClaimValue => {
  switch (value.type) {
    case "boolean":
      return { type: "boolean", value: !value.value };
    case "number":
      return { type: "number", value: value.value + 1 };
    case "string[]":
      return { type: "string[]", value: [...value.value, "incorrect"] };
    case "date":
      return { type: "date", value: "2099-12-31" };
    case "identifier":
      return { type: "identifier", value: `${value.value}-WRONG` };
    case "string":
      return { type: "string", value: `${value.value} (incorrect)` };
  }
};

const displayValue = (value: ClaimValue): string =>
  (Array.isArray(value.value) ? value.value.join(", ") : String(value.value))
    .replace(/[.;]/g, ",")
    .trim();

const compatibleTask = (
  task: AgentTask,
  oracle: HiddenOracle
): { compatible: true } | { compatible: false; reason: string } => {
  if (oracle.expectedMissing.length > 0 || oracle.completion.expectAbstention)
    return { compatible: false, reason: "expected_missing_evidence" };
  if (
    task.claims.length !== 1 ||
    oracle.claims.length !== 1 ||
    !task.claims[0]?.required ||
    !task.claims[0].substantive ||
    task.claims[0].claimKey !== oracle.claims[0]?.claimKey
  )
    return { compatible: false, reason: "not_one_required_substantive_claim" };
  return { compatible: true };
};

const generationPort = (
  claimKey: string,
  value: ClaimValue,
  supported: boolean
): GenerationPort => ({
  modelUri: "fixture:verified-ask-answer-agent-v1",
  structuredOutput: "json_schema",
  async generate(_prompt, params): Promise<LlmResult<string>> {
    if (!params?.jsonSchema) {
      return {
        ok: true,
        value: `${claimKey}: ${displayValue(value)} [1].`,
      };
    }
    const schema = params.jsonSchema as {
      properties: {
        judgments: {
          items: {
            properties: {
              claimId: { enum: string[] };
              evidenceIds: { items: { enum: string[] } };
            };
          };
        };
      };
    };
    const properties = schema.properties.judgments.items.properties;
    const claimId = properties.claimId.enum[0];
    const evidenceId = properties.evidenceIds.items.enum[0];
    if (!(claimId && evidenceId))
      throw new Error("Semantic verifier schema omitted closed identities");
    return {
      ok: true,
      value: JSON.stringify({
        judgments: [
          {
            claimId,
            verdict: supported ? "supported" : "contradicted",
            confidence: 0.99,
            evidenceIds: [evidenceId],
            rationaleCode: supported
              ? "semantic_entailment"
              : "semantic_contradiction",
          },
        ],
        unresolvedClaimIds: [],
      }),
    };
  },
  async dispose() {},
});

const citationProjection = (
  citations: readonly Citation[]
): VerifiedAskOutcomeCitation[] =>
  citations.map((citation) => {
    const metadata = citation[CITATION_TRACE_METADATA];
    if (
      !metadata ||
      citation.startLine === undefined ||
      citation.endLine === undefined
    )
      throw new Error("Ask outcome omitted exact citation trace metadata");
    return {
      evidenceId: citation.evidenceId ?? null,
      uri: citation.uri,
      startLine: citation.startLine,
      endLine: citation.endLine,
      sourceHash: metadata.sourceHash,
      mirrorHash: metadata.mirrorHash,
      passageHash: metadata.passageHash,
    };
  });

const receiptWithFingerprint = (
  receipt: Omit<VerifiedAskOutcomeReceipt, "canonicalFingerprint">
): VerifiedAskOutcomeReceipt => ({
  ...receipt,
  canonicalFingerprint: canonicalFingerprint(receipt),
});

const scoreOutcome = (
  receipt: VerifiedAskOutcomeReceipt,
  oracle: HiddenOracle
): VerifiedAskOutcomeScore => {
  const expected = oracle.claims[0];
  if (!expected) throw new Error(`Oracle claim missing for ${receipt.taskId}`);
  const accurate =
    receipt.declaredClaim !== null &&
    verifiedAskClaimValuesMatch(
      receipt.declaredClaim.value,
      expected.expectedValue,
      expected.normalizer.id
    );
  return {
    taskId: receipt.taskId,
    lane: receipt.lane,
    trialId: receipt.trialId,
    seed: receipt.seed,
    agentId: receipt.agentId,
    answerAccuracy: accurate ? 1 : 0,
    unsupportedSubstantiveClaims:
      receipt.declaredClaim && !accurate ? [expected.claimKey] : [],
  };
};

export const runVerifiedAskOutcomeBenchmark = async (
  fixture: LoadedAgenticFixture
): Promise<VerifiedAskPromotionArtifact> => {
  const native = await prepareGnoNativeIndex(fixture.snapshot);
  const store = new SqliteAdapter();
  try {
    const opened = await store.open(native.dbPath, DEFAULT_FTS_TOKENIZER);
    if (!opened.ok)
      throw new Error(`open verified Ask fixture: ${opened.error.message}`);
    const receipts: VerifiedAskOutcomeReceipt[] = [];
    const scores: VerifiedAskOutcomeScore[] = [];
    const excludedTasks: VerifiedAskPromotionArtifact["excludedTasks"] = [];
    for (const taskId of [...fixture.tasks.keys()].sort()) {
      const task = fixture.tasks.get(taskId)!;
      const oracle = fixture.oracles.get(taskId);
      if (!oracle) throw new Error(`Oracle missing for ${taskId}`);
      const compatibility = compatibleTask(task, oracle);
      if (!compatibility.compatible) {
        excludedTasks.push({ taskId, reason: compatibility.reason });
        continue;
      }
      const oracleClaim = oracle.claims[0]!;
      const supported = !ADVERSARIAL_TASK_IDS.has(taskId);
      const value = supported
        ? structuredClone(oracleClaim.expectedValue)
        : adversarialValue(oracleClaim.expectedValue);
      const collection = task.corpus.collections[0];
      if (!collection) throw new Error(`Collection missing for ${taskId}`);
      const config: Config = {
        version: "1.0",
        ftsTokenizer: DEFAULT_FTS_TOKENIZER,
        collections: [
          {
            name: collection,
            path: `${native.rootPath}/corpus-snapshot/${taskId}/${collection}`,
            pattern: "**/*.md",
            include: [],
            exclude: [],
          },
        ],
        contexts: [],
        contentTypes: [],
      };
      const options: AskOptions = {
        collection,
        limit: 5,
        noExpand: true,
        noRerank: true,
        queryModes: [{ mode: "term", text: buildFixtureSearchQuery(task) }],
      };
      const requestFingerprint = canonicalFingerprint({
        goal: task.brief.goal,
        collection,
        options,
      });
      const modelFingerprint = canonicalFingerprint({
        agentId: VERIFIED_ASK_AGENT_ID,
        modelUri: "fixture:verified-ask-answer-agent-v1",
        seed: VERIFIED_ASK_SEED,
      });
      const rawSearch = await searchHybrid(
        {
          store,
          config,
          vectorIndex: null,
          embedPort: null,
          expandPort: null,
          rerankPort: null,
        },
        task.brief.goal,
        options
      );
      if (!rawSearch.ok || rawSearch.value.results.length === 0)
        throw new Error(`Raw Ask retrieval failed for ${taskId}`);
      const rawGenerated = await generateGroundedAnswer(
        {
          genPort: generationPort(oracleClaim.claimKey, value, supported),
          store,
        },
        task.brief.goal,
        rawSearch.value.results,
        512
      );
      if (!rawGenerated)
        throw new Error(`Raw Ask generation failed for ${taskId}`);
      const raw = processAnswerResult(rawGenerated);
      if (raw.citations.length === 0)
        throw new Error(`Raw Ask citation processing failed for ${taskId}`);
      const rawReceipt = receiptWithFingerprint({
        taskId,
        lane: "raw_ask",
        trialId: VERIFIED_ASK_TRIAL_ID,
        seed: VERIFIED_ASK_SEED,
        agentId: VERIFIED_ASK_AGENT_ID,
        fixtureFingerprint: fixture.snapshot.fingerprint,
        indexFingerprint: native.indexFingerprint,
        requestFingerprint,
        modelFingerprint,
        draftKind: supported ? "supported" : "adversarial",
        declaredClaim: { claimKey: oracleClaim.claimKey, value },
        answer: raw.answer,
        answerFingerprint: canonicalFingerprint(raw.answer),
        abstained: false,
        citations: citationProjection(raw.citations),
        verification: { requested: false, answerStatus: "raw" },
      });
      receipts.push(rawReceipt);
      scores.push(scoreOutcome(rawReceipt, oracle));

      const verified = await buildVerifiedAsk(
        task.brief.goal,
        { ...options, verify: true },
        {
          store,
          config,
          indexName: "agentic",
          vectorIndex: null,
          embedPort: null,
          rerankPort: null,
          genPort: generationPort(oracleClaim.claimKey, value, supported),
        }
      );
      const verifiedStatus = verified.verification?.claims.answerStatus;
      if (verifiedStatus !== (supported ? "verified" : "abstained"))
        throw new Error(
          `Verified Ask status mismatch for ${taskId}: ${String(verifiedStatus)}`
        );
      const verifiedReceipt = receiptWithFingerprint({
        taskId,
        lane: "verified_ask",
        trialId: VERIFIED_ASK_TRIAL_ID,
        seed: VERIFIED_ASK_SEED,
        agentId: VERIFIED_ASK_AGENT_ID,
        fixtureFingerprint: fixture.snapshot.fingerprint,
        indexFingerprint: native.indexFingerprint,
        requestFingerprint,
        modelFingerprint,
        draftKind: supported ? "supported" : "adversarial",
        declaredClaim: supported
          ? { claimKey: oracleClaim.claimKey, value }
          : null,
        answer: verified.answer ?? "",
        answerFingerprint: canonicalFingerprint(verified.answer ?? ""),
        abstained: Boolean(verified.meta.abstained),
        citations: citationProjection(verified.citations ?? []),
        verification: {
          requested: true,
          answerStatus: verifiedStatus,
        },
      });
      if (supported && verifiedReceipt.citations.length === 0)
        throw new Error(
          `Verified Ask omitted supported citation for ${taskId}`
        );
      if (
        !supported &&
        (!verifiedReceipt.abstained || verifiedReceipt.citations.length > 0)
      )
        throw new Error(`Verified Ask did not safely abstain for ${taskId}`);
      receipts.push(verifiedReceipt);
      scores.push(scoreOutcome(verifiedReceipt, oracle));
    }
    if (
      canonicalFingerprint(excludedTasks) !==
        canonicalFingerprint([
          { taskId: "t234cd5e", reason: "expected_missing_evidence" },
          { taskId: "t345de6f", reason: "expected_missing_evidence" },
        ]) ||
      receipts.length !== 44 ||
      scores.length !== 44
    )
      throw new Error(
        "Verified Ask compatible cohort differs from frozen fn-97 contract"
      );
    const promotion = evaluateVerifiedAskPromotion(receipts, scores);
    const partial: Omit<VerifiedAskPromotionArtifact, "canonicalFingerprint"> =
      {
        schemaVersion: "1.0",
        benchmarkId: VERIFIED_ASK_BENCHMARK_ID,
        fixtureFingerprint: fixture.snapshot.fingerprint,
        indexFingerprint: native.indexFingerprint,
        methodology: [
          "Production raw Ask (searchHybrid, generateGroundedAnswer, processAnswerResult) is the baseline.",
          "Production buildVerifiedAsk with closed-Capsule semantic claim verification is the candidate.",
          "Both lanes share one immutable fixture index, task goal, collection, search modes, deterministic answer agent, model fingerprint, and declared draft.",
          "The compatible cohort is deterministic: exactly one required substantive claim and no expected-missing/abstention case.",
          "Four fixed adversarial drafts test whether unsupported substantive claims escape the product boundary; this is enforcement evidence, not a model-quality claim.",
          "Promotion requires no pairwise or aggregate answer-accuracy regression and strictly fewer unsupported substantive claims.",
        ],
        excludedTasks,
        receipts: receipts.sort((left, right) =>
          `${left.taskId}\0${left.lane}`.localeCompare(
            `${right.taskId}\0${right.lane}`,
            "en"
          )
        ),
        scores: scores.sort((left, right) =>
          `${left.taskId}\0${left.lane}`.localeCompare(
            `${right.taskId}\0${right.lane}`,
            "en"
          )
        ),
        promotion,
      };
    return {
      ...partial,
      canonicalFingerprint: verifiedAskArtifactFingerprint(partial),
    };
  } finally {
    await store.close();
    await cleanupNativeIndexPreparation(native);
  }
};
