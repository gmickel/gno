/** Immutable development-only acceptance contract; never refresh pins to hide drift. */
import { z } from "zod";

import { canonicalFingerprint, canonicalJson } from "../agentic/canonical";

export const ACCEPTANCE_SCHEMA_VERSION = "gno-acceptance-v1";
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const name = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Expected nonblank identity");

const identitySchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  indexId: name,
  indexSha256: sha256Schema,
  bunVersion: name,
  nativeDependencies: z.record(name, name),
  platform: name,
  architecture: name,
});

export const acceptanceManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(ACCEPTANCE_SCHEMA_VERSION),
    role: z.enum(["baseline", "candidate"]),
    identity: identitySchema,
    fixtureVersion: name,
    fixtures: z
      .array(z.strictObject({ path: name, sha256: sha256Schema }))
      .min(1),
    models: z.array(
      z.strictObject({
        role: z.enum(["embedding", "reranking", "generation"]),
        id: name,
        sha256: sha256Schema,
        tokenizerSha256: sha256Schema,
      })
    ),
    cases: z
      .array(
        z.strictObject({
          caseId: name,
          fixtureSha256: sha256Schema,
          surface: z.enum(["cli", "mcp", "api", "sdk"]),
          preset: name,
          configuration: z.record(z.string(), z.json()),
        })
      )
      .min(1),
    // Both manifests must predeclare the same complete baseline/candidate oracle.
    // Hashes cover the ENTIRE deterministic record, not an allowed-field wildcard.
    intendedDeltas: z.array(
      z.strictObject({
        caseId: name,
        reason: name,
        oracleSha256: sha256Schema,
        baselineRecordSha256: sha256Schema,
        candidateRecordSha256: sha256Schema,
      })
    ),
  })
  .superRefine((manifest, context) => {
    for (const [field, ids] of [
      ["fixtures", manifest.fixtures.map((item) => item.path)],
      [
        "models",
        manifest.models.map((item) => canonicalJson([item.role, item.id])),
      ],
      ["cases", manifest.cases.map((item) => item.caseId)],
      ["intendedDeltas", manifest.intendedDeltas.map((item) => item.caseId)],
    ] as const) {
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Duplicate identity",
        });
      }
    }
    for (const delta of manifest.intendedDeltas) {
      if (!manifest.cases.some((item) => item.caseId === delta.caseId)) {
        context.addIssue({
          code: "custom",
          path: ["intendedDeltas"],
          message: `Unknown case ${delta.caseId}`,
        });
      }
    }
  });

export type AcceptanceManifest = z.infer<typeof acceptanceManifestSchema>;

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function freezeAcceptanceManifest(value: unknown): AcceptanceManifest {
  return freezeDeep(acceptanceManifestSchema.parse(value));
}

export function acceptanceManifestFingerprint(
  value: AcceptanceManifest
): string {
  return canonicalFingerprint(acceptanceManifestSchema.parse(value));
}

/** Must run before reading/scoring candidate records. Runtime versions are retained
 * per side: a runtime optimization may change them; model and fixture pins may not. */
export function validateManifestPair(
  baselineValue: unknown,
  candidateValue: unknown
): {
  baseline: AcceptanceManifest;
  candidate: AcceptanceManifest;
} {
  const baseline = freezeAcceptanceManifest(baselineValue);
  const candidate = freezeAcceptanceManifest(candidateValue);
  if (baseline.role !== "baseline" || candidate.role !== "candidate") {
    throw new Error("manifest.role: expected baseline/candidate pair");
  }
  for (const field of [
    "schemaVersion",
    "fixtureVersion",
    "fixtures",
    "models",
    "cases",
    "intendedDeltas",
  ] as const) {
    if (canonicalJson(baseline[field]) !== canonicalJson(candidate[field])) {
      throw new Error(
        `manifest.${field}: incompatible baseline/candidate identity`
      );
    }
  }
  return { baseline, candidate };
}
