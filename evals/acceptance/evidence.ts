import {
  canonicalFingerprint,
  exactLineSpan,
  sha256Bytes,
} from "../agentic/canonical";
import {
  evidenceFixturesSchema,
  evidenceObservationSchema,
  evidenceReportSchema,
  evidenceRunSchema,
  evidenceStages,
  type EvidenceFixtures,
  type EvidenceObservation,
  type EvidenceScore,
  type ObservedPassage,
  type SpanOutcome,
} from "./evidence-schema";

function unique(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label}`);
}

export function validateEvidenceFixtures(input: unknown): EvidenceFixtures {
  const fixture = evidenceFixturesSchema.parse(input);
  unique(
    fixture.documents.map((d) => d.uri),
    "document URI"
  );
  unique(
    fixture.spans.map((s) => s.id),
    "span ID"
  );
  unique(
    fixture.cases.map((c) => c.caseId),
    "case ID"
  );
  for (const doc of fixture.documents) {
    if (
      doc.content.includes("\r") ||
      sha256Bytes(doc.content) !== doc.sourceHash
    )
      throw new Error(`Stale source hash or noncanonical newlines: ${doc.uri}`);
  }
  for (const span of fixture.spans) {
    const doc = fixture.documents.find((d) => d.uri === span.uri);
    if (
      !doc ||
      doc.sourceHash !== span.sourceHash ||
      sha256Bytes(exactLineSpan(doc.content, span.startLine, span.endLine)) !==
        span.spanHash
    )
      throw new Error(`Invalid gold span: ${span.id}`);
  }
  for (const item of fixture.cases) {
    if (item.expectAbstention !== (item.requiredSets.length === 0))
      throw new Error(`Answerability/evidence mismatch: ${item.caseId}`);
    if (item.expectAbstention && item.expectedValues.length)
      throw new Error(`Abstention has answer values: ${item.caseId}`);
    for (const set of item.requiredSets) {
      unique(set, "required span");
      for (const name of set) {
        const span = fixture.spans.find((s) => s.id === name);
        if (!span || !span.uri.startsWith(`gno://${item.collection}/`))
          throw new Error(`Unknown or out-of-scope gold span: ${name}`);
      }
    }
    for (const value of item.expectedValues) {
      if (
        fixture.documents.some((doc) =>
          `${doc.uri} ${doc.title}`.toLowerCase().includes(value.toLowerCase())
        )
      )
        throw new Error(`Answer-bearing fixture name: ${item.caseId}`);
    }
  }
  return fixture;
}

export function goldExtent(fixture: EvidenceFixtures, id: string) {
  const span = fixture.spans.find((s) => s.id === id);
  if (!span) throw new Error(`Unknown span ${id}`);
  const doc = fixture.documents.find((d) => d.uri === span.uri)!;
  const start = doc.content
    .split("\n")
    .slice(0, span.startLine - 1)
    .reduce((offset, line) => offset + line.length + 1, 0);
  return {
    ...span,
    start,
    end:
      start + exactLineSpan(doc.content, span.startLine, span.endLine).length,
  };
}

function covers(
  passages: ObservedPassage[],
  start: number,
  end: number
): boolean {
  let cursor = start;
  for (const passage of passages.toSorted((a, b) => a.start - b.start)) {
    if (passage.start > cursor) return false;
    cursor = Math.max(cursor, passage.end);
    if (cursor >= end) return true;
  }
  return false;
}

function spanOutcome(
  fixture: EvidenceFixtures,
  id: string,
  passages: ObservedPassage[] | null
): SpanOutcome {
  if (passages === null) return "unknown";
  const gold = goldExtent(fixture, id);
  const relevant = passages.filter(
    (p) =>
      p.uri === gold.uri &&
      p.sourceHash === gold.sourceHash &&
      p.end > gold.start &&
      p.start < gold.end
  );
  for (const inputId of new Set(relevant.map((p) => p.inputId))) {
    if (
      covers(
        relevant.filter((p) => p.inputId === inputId),
        gold.start,
        gold.end
      )
    )
      return "complete";
  }
  if (covers(relevant, gold.start, gold.end)) return "split-across-inputs";
  if (
    passages.some(
      (p) =>
        p.uri === gold.uri &&
        p.start <= gold.start &&
        p.end < gold.end &&
        p.selectedEnd !== null &&
        p.selectedEnd >= gold.end
    )
  )
    return "clipped";
  return relevant.length ? "partial" : "missing";
}

function observationErrors(
  fixture: EvidenceFixtures,
  observation: EvidenceObservation
): string[] {
  const item = fixture.cases.find((c) => c.caseId === observation.caseId);
  if (!item) throw new Error(`Unknown case: ${observation.caseId}`);
  const errors = [...observation.reasons];
  if (observation.fixtureSha256 !== canonicalFingerprint(fixture))
    errors.push("fixture_identity_mismatch");
  if (observation.noExpand !== (observation.arm === "noExpand"))
    errors.push("arm_option_mismatch");
  if (
    observation.tokenBudget !== item.tokenBudget ||
    observation.byteBudget !== item.byteBudget
  )
    errors.push("budget_identity_mismatch");
  if (
    observation.cost.visibleBytes > item.byteBudget ||
    observation.cost.usedTokens > item.tokenBudget
  )
    errors.push("delivery_budget_exceeded");
  if (observation.coverage !== "complete") errors.push("coverage_incomplete");
  if (
    observation.cost.estimator === "unicode_conservative" &&
    observation.cost.usedTokens !== observation.cost.visibleBytes
  )
    errors.push("conservative_token_accounting_mismatch");
  if (observation.stages.delivery === null) errors.push("delivery_unobserved");
  if (new Set(observation.stages.delivery?.map((p) => p.inputId)).size > 1)
    errors.push("multiple_delivery_inputs");
  for (const name of evidenceStages) {
    for (const passage of observation.stages[name] ?? []) {
      const doc = fixture.documents.find((d) => d.uri === passage.uri);
      if (
        !doc ||
        doc.sourceHash !== passage.sourceHash ||
        passage.end <= passage.start ||
        passage.end > doc.content.length ||
        passage.text !== doc.content.slice(passage.start, passage.end) ||
        (passage.selectedEnd !== null &&
          (passage.selectedEnd < passage.end ||
            passage.selectedEnd > doc.content.length))
      )
        errors.push(`invalid_passage:${name}`);
      if (!passage.uri.startsWith(`gno://${item.collection}/`))
        errors.push(`scope_leak:${name}`);
    }
  }
  const deliveredBytes = (observation.stages.delivery ?? []).reduce(
    (sum, p) => sum + Buffer.byteLength(p.text),
    0
  );
  if (deliveredBytes > observation.cost.visibleBytes)
    errors.push("delivery_bytes_underreported");
  return [...new Set(errors)];
}

export function scoreEvidence(
  fixture: EvidenceFixtures,
  value: unknown
): EvidenceScore {
  const observation = evidenceObservationSchema.parse(value);
  const item = fixture.cases.find((c) => c.caseId === observation.caseId);
  if (!item) throw new Error(`Unknown case: ${observation.caseId}`);
  const required = [...new Set(item.requiredSets.flat())];
  const stages = Object.fromEntries(
    evidenceStages.map((name) => {
      const spans = Object.fromEntries(
        required.map((id) => [
          id,
          spanOutcome(fixture, id, observation.stages[name]),
        ])
      );
      return [
        name,
        {
          all:
            item.expectAbstention || observation.stages[name] === null
              ? null
              : item.requiredSets.some((set) =>
                  set.every((id) => spans[id] === "complete")
                ),
          any:
            item.expectAbstention || observation.stages[name] === null
              ? null
              : Object.values(spans).some((outcome) => outcome === "complete"),
          spans,
        },
      ];
    })
  ) as EvidenceScore["stages"];
  const reasons = observationErrors(fixture, observation);
  const reader = observation.reader;
  const correctAbstention = reader
    ? reader.abstained === item.expectAbstention
    : null;
  const groundedTaskSuccess = reader
    ? item.expectAbstention
      ? reader.abstained && !reader.answer.trim()
      : !reader.abstained &&
        reader.verified &&
        stages.delivery.all === true &&
        item.expectedValues.every((v) =>
          reader.answer.toLowerCase().includes(v.toLowerCase())
        )
    : null;
  return {
    caseId: item.caseId,
    arm: observation.arm,
    valid: reasons.length === 0,
    reasons,
    stages,
    firstLossStage:
      evidenceStages.find((stage) => stages[stage].all === false) ?? null,
    groundedTaskSuccess,
    correctAbstention,
    cost: observation.cost,
  };
}

export function evaluateEvidenceRun(
  fixtureValue: unknown,
  runValue: unknown,
  execution: "replay" | "native" = "replay"
) {
  const fixture = validateEvidenceFixtures(fixtureValue);
  const run = evidenceRunSchema.parse(runValue);
  if (execution === "native" && run.kind !== "native")
    throw new Error("Replay observations cannot certify native execution");
  unique(
    run.observations.map((o) => `${o.caseId}:${o.arm}`),
    "observation"
  );
  const scores = run.observations.map((o) => scoreEvidence(fixture, o));
  const reasons: string[] = [];
  const paired = fixture.cases.map((item) => {
    const observations = run.observations.filter(
      (o) => o.caseId === item.caseId
    );
    const baseline = scores.find(
      (s) => s.caseId === item.caseId && s.arm === "current"
    );
    const candidate = scores.find(
      (s) => s.caseId === item.caseId && s.arm === "noExpand"
    );
    if (!baseline || !candidate)
      throw new Error(`Missing paired case: ${item.caseId}`);
    const compatible = !(
      new Set(observations.map((o) => o.identitySha256)).size !== 1 ||
      new Set(observations.map((o) => o.reader === null)).size !== 1 ||
      new Set(observations.map((o) => o.cost.estimator)).size !== 1
    );
    if (!compatible) reasons.push(`pair_identity_mismatch:${item.caseId}`);
    const nativeObserved =
      run.kind !== "native" ||
      observations.every((o) => Boolean(o.cost.tokenizations?.length));
    if (!nativeObserved)
      reasons.push(`native_token_observations_missing:${item.caseId}`);
    const a = baseline.stages.delivery.all;
    const b = candidate.stages.delivery.all;
    const taskA = baseline.groundedTaskSuccess;
    const taskB = candidate.groundedTaskSuccess;
    if (
      item.mustCover &&
      (item.expectAbstention
        ? taskA !== true || taskB !== true
        : a !== true || b !== true)
    )
      reasons.push(`must_cover_miss:${item.caseId}`);
    const comparable =
      compatible && nativeObserved && baseline.valid && candidate.valid;
    const allEvidenceDelta =
      !comparable || a === null || b === null ? null : Number(b) - Number(a);
    const groundedTaskDelta =
      !comparable || taskA === null || taskB === null
        ? null
        : Number(taskB) - Number(taskA);
    if (
      item.split === "held-out" &&
      (allEvidenceDelta === -1 || groundedTaskDelta === -1)
    )
      reasons.push(`held_out_regression:${item.caseId}`);
    return {
      caseId: item.caseId,
      allEvidenceDelta,
      groundedTaskDelta,
      baselineMiss: a === false || taskA === false,
      candidateMiss: b === false || taskB === false,
    };
  });
  const valid =
    scores.every((score) => score.valid) &&
    !reasons.some((r) => r.includes("mismatch") || r.startsWith("native_"));
  return evidenceReportSchema.parse({
    schemaVersion: "gno-evidence-report-v1",
    kind: execution,
    fixtureSha256: canonicalFingerprint(fixture),
    valid,
    passed: valid && reasons.length === 0,
    reasons,
    scores,
    paired,
  });
}
