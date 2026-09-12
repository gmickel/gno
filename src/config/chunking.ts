import { z } from "zod";

/** Existing character-based chunker defaults. */
export const DEFAULT_CHUNKING_PARAMS = {
  maxTokens: 800,
  overlapPercent: 0.15,
};

export const MAX_CHUNK_TOKENS = Math.floor(Number.MAX_SAFE_INTEGER / 4);

export const ChunkingConfigSchema = z
  .object({
    maxTokens: z
      .number()
      .int()
      .min(10)
      .max(MAX_CHUNK_TOKENS)
      .default(DEFAULT_CHUNKING_PARAMS.maxTokens),
    overlapPercent: z
      .number()
      .finite()
      .min(0)
      .max(0.5)
      .default(DEFAULT_CHUNKING_PARAMS.overlapPercent),
  })
  .strict();

export type ChunkingParams = z.infer<typeof ChunkingConfigSchema>;

export function resolveChunkingParams(
  input?: Partial<ChunkingParams>
): ChunkingParams {
  return ChunkingConfigSchema.parse(input ?? {});
}

/** Canonical JSON is the policy identity, including partial/default aliases. */
export function chunkingPolicyKey(params: ChunkingParams): string {
  return JSON.stringify({
    maxTokens: params.maxTokens,
    overlapPercent: params.overlapPercent,
  });
}

export const DEFAULT_CHUNKING_POLICY_KEY = chunkingPolicyKey(
  DEFAULT_CHUNKING_PARAMS
);
