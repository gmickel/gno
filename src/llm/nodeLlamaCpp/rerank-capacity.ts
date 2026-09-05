/** Pinned native formatting contract; no context allocation or input clipping. */
import type { LlamaModel, Token } from "node-llama-cpp";

import { getModuleVersion } from "node-llama-cpp";

const installedVersion = await getModuleVersion();

export const RERANK_NATIVE_VERSION = "3.19.1";
export const RERANK_TEMPLATE =
  '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n<Instruct>: Given a web search query, retrieve relevant passages that answer the query\n<Query>: {query}\n<Document>: {document}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n';

type CapacityModel = Pick<
  LlamaModel,
  | "fileInfo"
  | "tokens"
  | "tokenize"
  | "tokenizer"
  | "trainContextSize"
  | "vocabularyType"
>;

export type RerankCapacity =
  | { kind: "empty" }
  | { kind: "auto"; reason: string }
  | { kind: "sized"; contextSize: number; requiredTokens: number };

function supported(model: CapacityModel, version: string): boolean {
  return (
    version === RERANK_NATIVE_VERSION &&
    model.fileInfo.metadata.general?.architecture === "qwen3" &&
    model.vocabularyType === "bpe" &&
    model.fileInfo.metadata.tokenizer?.["chat_template.rerank"] ===
      RERANK_TEMPLATE
  );
}

/** Mirrors 3.19.1 _getEvaluationInput for the one audited template/vocabulary. */
export function formatRerankPair(
  model: CapacityModel,
  query: string,
  document: string,
  version = installedVersion
): Token[] | null {
  if (!supported(model, version)) {
    return null;
  }
  const [prefix, rest = ""] = RERANK_TEMPLATE.split("{query}");
  const [middle, suffix = ""] = rest.split("{document}");
  const input = [
    ...model.tokenize(prefix ?? "", true, "trimLeadingSpace"),
    ...model.tokenizer(query, false, "trimLeadingSpace"),
    ...model.tokenize(middle ?? "", true, "trimLeadingSpace"),
    ...model.tokenizer(document, false, "trimLeadingSpace"),
    ...model.tokenize(suffix, true, "trimLeadingSpace"),
  ];
  const { bos, eos, shouldPrependBosToken, shouldAppendEosToken } =
    model.tokens;
  if (shouldPrependBosToken && bos != null && input.at(0) !== bos) {
    input.unshift(bos);
  }
  if (shouldAppendEosToken && eos != null && input.at(-1) !== eos) {
    // Native 3.19.1 prepends here despite calling this an end token. Preserve parity.
    input.unshift(eos);
  }
  return input;
}

export function getRerankCapacity(
  model: CapacityModel,
  query: string,
  documents: readonly string[],
  version = installedVersion
): RerankCapacity {
  if (documents.length === 0) {
    return { kind: "empty" };
  }
  if (!supported(model, version)) {
    return {
      kind: "auto",
      reason: "Unsupported native version, model or template",
    };
  }
  const maximum = model.trainContextSize;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    return { kind: "auto", reason: "Unknown model context limit" };
  }
  let requiredTokens = 0;
  for (const document of documents) {
    const tokens = formatRerankPair(model, query, document, version);
    if (tokens === null) {
      return { kind: "auto", reason: "Unsupported formatter" };
    }
    requiredTokens = Math.max(requiredTokens, tokens.length);
  }
  if (requiredTokens > maximum) {
    throw new RangeError(
      `Rerank input requires ${requiredTokens} tokens; model supports ${maximum}`
    );
  }
  // 3.19.1 config.contextSizePad is 256. The frozen native audit scored
  // ceil((full pair + 256) / 256) * 256 at exact parity; no smaller guard is proven.
  const contextSize = Math.ceil((requiredTokens + 256) / 256) * 256;
  if (contextSize > maximum) {
    return {
      kind: "auto",
      reason: "Padded capacity exceeds model context limit",
    };
  }
  return { kind: "sized", contextSize, requiredTokens };
}
