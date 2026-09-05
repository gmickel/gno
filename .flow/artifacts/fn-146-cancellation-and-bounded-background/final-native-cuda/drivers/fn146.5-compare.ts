/** Canonical fn143 comparator, response-only scope; actual native captures stay separate. */
export async function compareResponses(source: string, originalManifest: any, caseId: string, request: unknown, left: any, right: any) {
  const { compareAcceptance } = await import(`${source}/evals/acceptance/compare.ts`);
  const { freezeAcceptanceManifest, acceptanceManifestFingerprint } = await import(`${source}/evals/acceptance/manifest.ts`);
  const { canonicalFingerprint } = await import(`${source}/evals/agentic/canonical.ts`);
  if (!Array.isArray(left.results) || !Array.isArray(right.results)) throw Error("Full result arrays required; missing bilateral output cannot pass");
  const common = { ...originalManifest, cases: [{ ...originalManifest.cases[0], caseId, surface: "api", configuration: { request, scope: "within-freeze idle/background response quality; native capture independently retained" } }] };
  const a = freezeAcceptanceManifest({ ...common, role: "baseline" });
  const b = freezeAcceptanceManifest({ ...common, role: "candidate" });
  const record = (manifest: any, raw: any) => {
    const verification = structuredClone(raw.verification ?? null);
    // Exact telemetry path already authorized by canonical fn143 native-adapter projection.
    const durationMs = verification?.semantic?.durationMs;
    if (verification?.semantic) delete verification.semantic.durationMs;
    return {
      schemaVersion: "gno-acceptance-v1", manifestSha256: acceptanceManifestFingerprint(manifest), caseId,
      deterministic: {
        scope: { request, scope: "response-only", sourceManifestFingerprint: canonicalFingerprint(originalManifest), fullUnmodifiedCitations: raw.citations ?? [] },
        results: raw.results.map((result: any) => ({ uri: result.uri, score: result.score, scores: {}, passage: null, provenance: { fullUnmodifiedResult: result } })),
        citations: [], modelInputs: [],
        semanticState: { status: "incomplete", vectorsUsed: Boolean(raw.meta?.vectorsUsed), vectorStatus: raw.meta?.vectorsUsed ? "used" : "unavailable", error: "Response-only public-reported vector status, not native proof; inspect independent actual child-native receipt for native coverage", fallbacks: [], verification },
      }, generatedAnswer: raw.answer ?? null, transport: durationMs === undefined ? {} : { verificationSemanticDurationMs: durationMs },
    };
  };
  const baseline = record(a, left), candidate = record(b, right);
  return { scope: "response-only, not full-port native acceptance", comparison: compareAcceptance(a, b, [baseline], [candidate]), manifests: [a, b], records: [baseline, candidate] };
}
