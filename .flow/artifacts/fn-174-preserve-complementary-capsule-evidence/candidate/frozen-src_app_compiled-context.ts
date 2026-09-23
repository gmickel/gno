/** Verification and caller authority shared by all compiled-context surfaces. */
import type { ContextCapsuleV1 } from "../core/context-capsule";
import type {
  EgressCallerContext,
  EgressDestinationZone,
} from "../core/egress-policy";
import type {
  ContextCapsuleBuildInput,
  ContextCapsuleRuntimeDeps,
} from "./context-runtime";

import { currentEgressSources } from "../core/collection-egress-policy-service";
import {
  compiledContextPreviewInputSchema,
  compiledContextCheckInputSchema,
  COMPILED_CONTEXT_MAX_BYTES,
  readCompiledContextMetadata,
  compiledContextBodyMatches,
  renderCompiledContext,
  type CompiledContextCheck,
  type CompiledContextPreview,
} from "../core/compiled-context";
import { sha256Text } from "../core/context-capsule-validation";
import {
  parseCanonicalContextCapsuleForVerification,
  rawCanonicalContextJson,
} from "../core/context-verifier-input";
import { evaluateEgressPolicy } from "../core/egress-policy";
import { resolveEgressLineage } from "../core/egress-provenance";
import {
  verifyContextCapsuleRuntime,
  canonicalVerifiedContextCapsuleJson,
} from "./context-runtime";
export interface CompiledContextRuntimeDeps extends ContextCapsuleRuntimeDeps {
  destinationZone?: EgressDestinationZone;
  caller?: EgressCallerContext;
}
class CompiledContextStateError extends Error {
  constructor(
    readonly state: "stale" | "unverifiable",
    message: string
  ) {
    super(message);
    this.name = "CompiledContextStateError";
  }
}
function parse(
  input: unknown,
  deps: CompiledContextRuntimeDeps
): ContextCapsuleV1 {
  if (
    new TextEncoder().encode(rawCanonicalContextJson(input)).byteLength >
    COMPILED_CONTEXT_MAX_BYTES
  )
    throw new Error("Capsule exceeds 4 MiB");
  const capsule = parseCanonicalContextCapsuleForVerification(input, deps);
  if (capsule.schemaVersion === "1.0")
    throw new Error(
      "Rebuild legacy Capsule with current provenance before compiling"
    );
  return capsule;
}
function authorize(
  capsule: ContextCapsuleV1,
  deps: CompiledContextRuntimeDeps
): string {
  if (capsule.schemaVersion === "1.0")
    throw new Error("Capsule lineage unavailable");
  const names = [
    ...new Set([
      ...capsule.scope.collections,
      ...capsule.evidence.map((item) => item.collection),
      ...capsule.egressLineage.sources.map((item) => item.collection),
    ]),
  ];
  if (
    names.some(
      (name) =>
        !deps.config.collections.some((collection) => collection.name === name)
    )
  )
    throw new CompiledContextStateError(
      "unverifiable",
      "Collection scope is no longer configured; rebuild within eligible scope"
    );
  const sources = currentEgressSources(deps.config, names);
  const decision = evaluateEgressPolicy({
    collections: sources,
    action: "export",
    destination: { zone: deps.destinationZone ?? "local_process" },
    caller: deps.caller ?? { authenticated: true, operationAuthorized: true },
    contentClass: "capsule",
  });
  if (!decision.allowed)
    throw new CompiledContextStateError(
      "unverifiable",
      "Current collection policy or caller authority denies this context"
    );
  const lineage = resolveEgressLineage(sources, names);
  if (lineage.digest !== capsule.egressLineage.digest)
    throw new CompiledContextStateError(
      "stale",
      "Collection policy changed; rebuild and verify the Capsule"
    );
  return lineage.digest;
}
async function verified(
  capsule: ContextCapsuleV1,
  deps: CompiledContextRuntimeDeps
): Promise<{ verificationDigest: string; lineageDigest: string }> {
  const lineageDigest = authorize(capsule, deps);
  const receipt = await verifyContextCapsuleRuntime(capsule, deps);
  if (
    receipt.contentStatus !== "unchanged" ||
    receipt.fingerprintStatus !== "unchanged"
  )
    throw new CompiledContextStateError(
      "stale",
      `Capsule requires refresh: ${[receipt.contentCode, ...receipt.fingerprintReasons].join(", ")}`
    );
  authorize(capsule, deps);
  return {
    verificationDigest: sha256Text(
      canonicalVerifiedContextCapsuleJson(receipt)
    ),
    lineageDigest,
  };
}
export async function previewCompiledContext(
  input: unknown,
  deps: CompiledContextRuntimeDeps
): Promise<CompiledContextPreview> {
  const settings = compiledContextPreviewInputSchema.parse(input);
  const capsule = parse(settings.capsule, deps);
  const identity = await verified(capsule, deps);
  const preview = renderCompiledContext(
    capsule,
    settings,
    identity.verificationDigest,
    identity.lineageDigest,
    deps.countTokens
  );
  const finalIdentity = await verified(capsule, deps);
  if (finalIdentity.verificationDigest !== identity.verificationDigest)
    throw new CompiledContextStateError(
      "stale",
      "Index changed during compilation; retry after indexing completes"
    );
  return preview;
}
export async function checkCompiledContext(
  input: unknown,
  deps: CompiledContextRuntimeDeps
): Promise<CompiledContextCheck> {
  const result = (
    status: CompiledContextCheck["status"],
    reasons: string[],
    digest: string | null = null,
    capsuleId: string | null = null
  ): CompiledContextCheck => ({
    schemaVersion: "1.0",
    status,
    reasons,
    digest,
    capsuleId,
  });
  try {
    const { capsule: raw, markdown } =
      compiledContextCheckInputSchema.parse(input);
    const capsule = parse(raw, deps);
    // Authorize before reporting identifiers from supplied private evidence.
    authorize(capsule, deps);
    const meta = readCompiledContextMetadata(markdown);
    if (!compiledContextBodyMatches(markdown))
      return result("conflict", [
        "Output bytes were edited; preserve edits before recompiling",
      ]);
    const expected = await previewCompiledContext(
      {
        capsule,
        budgetTokens: meta.budgetTokens,
        budgetBytes: meta.budgetBytes,
      },
      deps
    );
    if (expected.markdown !== markdown)
      return result("conflict", [
        "Artifact metadata, renderer settings, or Capsule identity differs",
      ]);
    return result("current", [], expected.digest, capsule.capsuleId);
  } catch (error) {
    if (error instanceof CompiledContextStateError)
      return result(error.state, [error.message]);
    // Do not echo parser paths/values or supplied private source material.
    return result("unverifiable", [
      "Invalid or unavailable Capsule, artifact metadata, index, or recorded tokenizer; rebuild or supply the original matching inputs",
    ]);
  }
}
export function compiledContextRefreshRequest(
  input: unknown,
  authority: Pick<
    CompiledContextRuntimeDeps,
    "countTokens" | "tokenizerFingerprint"
  > = {}
): ContextCapsuleBuildInput {
  // Refresh cannot trust stale fingerprints, but must preserve the saved request exactly.
  const capsule = parseCanonicalContextCapsuleForVerification(input, authority);
  if (capsule.schemaVersion === "1.0")
    throw new Error("Rebuild legacy Capsule before refresh");
  const request = capsule.retrieval.request;
  return {
    goal: capsule.goal,
    query: capsule.query,
    indexName: capsule.scope.indexName,
    collections: capsule.scope.collections,
    uriPrefix: capsule.scope.uriPrefix,
    tagsAll: capsule.scope.tagsAll,
    tagsAny: capsule.scope.tagsAny,
    categories: capsule.scope.categories,
    since: capsule.scope.since ?? undefined,
    until: capsule.scope.until ?? undefined,
    filter: "filter" in capsule.scope ? capsule.scope.filter : undefined,
    author: request.author ?? undefined,
    lang: request.lang ?? undefined,
    intent: request.intent ?? undefined,
    exclude: request.exclude,
    minScore: request.minScore ?? undefined,
    queryModes: request.queryModes,
    limit: request.limit,
    candidateLimit: request.candidateLimit,
    graph: request.graphRequested,
    noRerank: request.rerankRequested === false,
    depthPolicy: capsule.retrieval.depthPolicy,
    budgetTokens: capsule.budget.requestedTokens,
    budgetBytes: capsule.budget.requestedBytes,
    safetyMarginTokens: capsule.budget.safetyMarginTokens,
    safetyMarginBytes: capsule.budget.safetyMarginBytes,
  };
}
