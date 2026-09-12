import type { ChunkingPolicyToken } from "../store/chunking";
import type { ChunkInput, StorePort, StoreResult } from "../store/types";
import type { ChunkerPort, SyncOptions } from "./types";

import {
  chunkingPolicyKey,
  DEFAULT_CHUNKING_POLICY_KEY,
  resolveChunkingParams,
} from "../config/chunking";
import { ChunkingPolicyConflictError } from "../store/chunking";

function unwrapChunking<T>(result: StoreResult<T>): T {
  if (result.ok) return result.value;
  if (result.error.code === "CHUNKING_POLICY_CONFLICT") {
    throw new ChunkingPolicyConflictError();
  }
  throw new Error(`Chunking failed: ${result.error.message}`);
}

/** One preparation per sync, including nested collection/path syncs. */
export async function prepareChunking(
  store: StorePort,
  chunker: ChunkerPort,
  options: SyncOptions
): Promise<{ options: SyncOptions; rechunkedMirrors: number }> {
  if (options.chunkingToken) return { options, rechunkedMirrors: 0 };
  const params = resolveChunkingParams(options.chunking);
  if (
    !(
      store.claimChunkingPolicy &&
      store.listPendingChunkingMirrors &&
      store.applyChunkLayout
    )
  ) {
    if (chunkingPolicyKey(params) !== DEFAULT_CHUNKING_POLICY_KEY) {
      throw new Error("This store does not support configurable chunking");
    }
    return { options, rechunkedMirrors: 0 };
  }

  const token = unwrapChunking(await store.claimChunkingPolicy(params));
  let rechunkedMirrors = 0;
  let afterHash = "";
  for (;;) {
    const mirrors = unwrapChunking(
      await store.listPendingChunkingMirrors(token, afterHash)
    );
    if (mirrors.length === 0) break;
    for (const mirror of mirrors) {
      const markdown = unwrapChunking(
        await store.getContent(mirror.mirrorHash)
      );
      if (markdown === null)
        throw new Error("Cached mirror disappeared during rechunking");
      const chunks: ChunkInput[] = chunker
        .chunk(markdown, token.params, mirror.languageHint, mirror.sourcePath)
        .map((chunk) => ({
          seq: chunk.seq,
          pos: chunk.pos,
          text: chunk.text,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          language: chunk.language ?? undefined,
          tokenCount: chunk.tokenCount ?? undefined,
        }));
      unwrapChunking(
        await store.applyChunkLayout(
          mirror.mirrorHash,
          chunks,
          token,
          mirror.sourcePath,
          mirror.languageHint
        )
      );
      rechunkedMirrors += 1;
      afterHash = mirror.mirrorHash;
    }
  }
  return {
    options: { ...options, chunking: token.params, chunkingToken: token },
    rechunkedMirrors,
  };
}

/** Preserve the original store contract for default-only test/alternate ports. */
export async function persistChunkLayout(
  store: StorePort,
  mirrorHash: string,
  chunks: ChunkInput[],
  token: ChunkingPolicyToken | undefined,
  sourcePath: string,
  languageHint?: string
): Promise<void> {
  if (token && store.applyChunkLayout) {
    unwrapChunking(
      await store.applyChunkLayout(
        mirrorHash,
        chunks,
        token,
        sourcePath,
        languageHint
      )
    );
    return;
  }
  unwrapChunking(await store.upsertChunks(mirrorHash, chunks));
  unwrapChunking(await store.rebuildFtsForHash(mirrorHash));
}
