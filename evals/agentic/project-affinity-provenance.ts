// node:path provides path composition; Bun has no path utilities.
import { join } from "node:path";

import { canonicalFingerprint, sha256Bytes } from "./canonical";

const REPOSITORY_ROOT = join(import.meta.dir, "../..");

export const PROJECT_AFFINITY_IMPLEMENTATION_FILES = [
  "evals/agentic/canonical.ts",
  "evals/agentic/project-affinity-contract.ts",
  "evals/agentic/project-affinity-outcome.ts",
  "evals/agentic/project-affinity-promotion.ts",
  "evals/agentic/project-affinity-provenance.ts",
  "evals/agentic/project-affinity-runtime.ts",
  "src/core/project-affinity-surface.ts",
  "src/core/project-affinity.ts",
  "src/pipeline/project-affinity.ts",
  "src/pipeline/vsearch.ts",
] as const;

export interface ProjectAffinityProvenance {
  producer: "runProjectAffinityOutcomeBenchmark";
  pipeline: "searchVectorWithEmbedding";
  store: "SqliteAdapter";
  vectorModel: "fixture:project-affinity-vector-v1";
  implementation: {
    fingerprint: string;
    files: Array<{ path: string; sha256: string }>;
  };
}

export const projectAffinityProvenance =
  async (): Promise<ProjectAffinityProvenance> => {
    const files = await Promise.all(
      PROJECT_AFFINITY_IMPLEMENTATION_FILES.map(async (path) => ({
        path,
        sha256: sha256Bytes(
          new Uint8Array(
            await Bun.file(join(REPOSITORY_ROOT, path)).arrayBuffer()
          )
        ),
      }))
    );
    return {
      producer: "runProjectAffinityOutcomeBenchmark",
      pipeline: "searchVectorWithEmbedding",
      store: "SqliteAdapter",
      vectorModel: "fixture:project-affinity-vector-v1",
      implementation: {
        fingerprint: canonicalFingerprint(files),
        files,
      },
    };
  };
