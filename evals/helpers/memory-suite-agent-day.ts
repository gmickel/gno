/**
 * Memory eval suite 6: the scripted agent day (session loop). Drives the
 * fixture through remember / supersede / recall / replay turns and compares
 * the path-free end state against the committed golden.
 *
 * @module evals/helpers/memory-suite-agent-day
 */

import type { MemoryFact, RecallResult } from "../../src/core/memory";
import type {
  AgentDayFixture,
  AgentDayGolden,
  NormalizedRecord,
} from "./memory-fixtures";

import {
  getMemoryEvalClient,
  recall,
  renderLineDiff,
  snapshotCollection,
  stableJson,
  supersede,
  tryRemember,
} from "./memory-harness";

export interface AgentDayOutcome {
  turns: Array<{
    id: string;
    op: string;
    expected: string;
    outcome: string;
    ok: boolean;
  }>;
  turnAccuracy: number;
  actual: AgentDayGolden;
  goldenMatch: boolean;
  diff: string;
}

/** Drive the scripted day; `golden` null means "produce the state" (fixture authoring). */
export async function runAgentDay(
  fixture: AgentDayFixture,
  golden: AgentDayGolden | null
): Promise<AgentDayOutcome> {
  const ctx = await getMemoryEvalClient();
  const collection = "mem-day";
  const scopes = [fixture.scope];
  const labels = new Map<string, MemoryFact>();
  const recalls = new Map<string, RecallResult>();
  const recallTexts: Record<string, string[]> = {};
  const turns: AgentDayOutcome["turns"] = [];
  const labelOf = (fact: MemoryFact) =>
    [...labels.entries()].find(([, record]) => record.uri === fact.uri)?.[0];

  for (const turn of fixture.turns) {
    let outcome: string;
    let ok: boolean;
    let expected: string;
    switch (turn.op) {
      case "remember": {
        expected = turn.expect;
        const attempt = await tryRemember(ctx.client, {
          collection,
          scopes,
          text: turn.text,
          ...(turn.decision ? { decision: turn.decision } : {}),
        });
        outcome = attempt.outcome;
        ok = outcome === expected;
        if (
          attempt.kind === "result" &&
          attempt.outcome === "candidates" &&
          turn.likely
        ) {
          const wanted = labels.get(turn.likely);
          ok =
            ok &&
            attempt.result.candidates.some(
              (candidate) =>
                candidate.match === "likely" && candidate.uri === wanted?.uri
            );
        }
        if (
          attempt.kind === "result" &&
          attempt.outcome !== "candidates" &&
          turn.label
        ) {
          labels.set(turn.label, attempt.result.record);
        }
        break;
      }
      case "supersede": {
        expected = turn.expect;
        const predecessor = labels.get(turn.predecessor);
        if (!predecessor)
          throw new Error(`${turn.id}: unknown label ${turn.predecessor}`);
        const attempt = await supersede(
          ctx.client,
          collection,
          scopes,
          predecessor,
          turn.text
        );
        outcome = attempt.outcome;
        ok = outcome === expected;
        if (
          attempt.kind === "result" &&
          attempt.outcome === "superseded" &&
          turn.label
        ) {
          labels.set(turn.label, attempt.result.record);
        }
        break;
      }
      case "recall": {
        const result = await recall(ctx.client, {
          query: turn.query,
          collection,
          scopes: turn.scopes ?? scopes,
        });
        recalls.set(turn.id, result);
        recallTexts[turn.id] = result.facts.map((fact) => fact.text);
        const got = result.facts.map((fact) => labelOf(fact) ?? fact.text);
        const includes = turn.expect.includes ?? [];
        const excludes = turn.expect.excludes ?? [];
        expected = turn.expect.empty
          ? "empty"
          : `includes ${includes.join(",")}${excludes.length ? ` excludes ${excludes.join(",")}` : ""}`;
        outcome = got.length === 0 ? "empty" : got.join(",");
        ok = turn.expect.empty
          ? result.facts.length === 0
          : includes.every((label) => got.includes(label)) &&
            excludes.every((label) => !got.includes(label));
        break;
      }
      case "replay": {
        expected = turn.expect;
        const source = recalls.get(turn.from);
        const fact = source?.facts[0];
        if (!source || !fact)
          throw new Error(`${turn.id}: recall ${turn.from} has no fact`);
        const attempt = await tryRemember(ctx.client, {
          collection,
          scopes,
          text: fact.text,
          decision: "add",
          receipt: source.receipt,
        });
        outcome = attempt.outcome;
        ok = outcome === expected;
        break;
      }
    }
    turns.push({ id: turn.id, op: turn.op, expected, outcome, ok });
  }

  const records: NormalizedRecord[] = await snapshotCollection(ctx, collection);
  const actual: AgentDayGolden = { records, recalls: recallTexts };
  const expectedJson = golden ? stableJson(golden) : stableJson(actual);
  const actualJson = stableJson(actual);
  const goldenMatch = expectedJson === actualJson;
  const diff = goldenMatch ? "" : renderLineDiff(expectedJson, actualJson);
  if (!goldenMatch && golden) {
    // Evalite's table truncates cells; the readable diff goes to stderr.
    console.error(
      `\nMemory agent day diverged from agent-day.golden.json:\n${diff}\n`
    );
  }
  return {
    turns,
    turnAccuracy: turns.filter((turn) => turn.ok).length / turns.length,
    actual,
    goldenMatch,
    diff,
  };
}
