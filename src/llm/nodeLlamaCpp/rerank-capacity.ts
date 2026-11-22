/** Pinned native formatting contract; no context allocation or input clipping. */
import type { LlamaModel, Token } from "node-llama-cpp";

import { getNativePackageVersion } from "../native-worker/embedding-identity";

export const RERANK_NATIVE_VERSION = "3.20.0";
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

const [RERANK_PREFIX = "", RERANK_REST = ""] = RERANK_TEMPLATE.split("{query}");
const [RERANK_MIDDLE = "", RERANK_SUFFIX = ""] =
  RERANK_REST.split("{document}");

interface CachedTemplateTokens {
  tokenizeFn: CapacityModel["tokenize"];
  prefix: readonly Token[];
  middle: readonly Token[];
  suffix: readonly Token[];
}

const TEMPLATE_TOKEN_CACHE = new WeakMap<object, CachedTemplateTokens>();

function getStaticTemplateTokens(model: CapacityModel): CachedTemplateTokens {
  const cached = TEMPLATE_TOKEN_CACHE.get(model as object);
  if (cached && cached.tokenizeFn === model.tokenize) {
    return cached;
  }
  const entry: CachedTemplateTokens = {
    tokenizeFn: model.tokenize,
    prefix: model.tokenize(RERANK_PREFIX, true, "trimLeadingSpace"),
    middle: model.tokenize(RERANK_MIDDLE, true, "trimLeadingSpace"),
    suffix: model.tokenize(RERANK_SUFFIX, true, "trimLeadingSpace"),
  };
  TEMPLATE_TOKEN_CACHE.set(model as object, entry);
  return entry;
}

/** 3.20.0 LlamaRankingContext.js is byte-identical to the audited 3.19.1 source.
 * Mirrors 3.20.0 _getEvaluationInput for the one audited template/vocabulary. */
export function formatRerankPair(
  model: CapacityModel,
  query: string,
  document: string,
  version = getNativePackageVersion()
): Token[] | null {
  if (!supported(model, version)) {
    return null;
  }
  const tpl = getStaticTemplateTokens(model);
  const input = [
    ...tpl.prefix,
    ...model.tokenizer(query, false, "trimLeadingSpace"),
    ...tpl.middle,
    ...model.tokenizer(document, false, "trimLeadingSpace"),
    ...tpl.suffix,
  ];
  const { bos, eos, shouldPrependBosToken, shouldAppendEosToken } =
    model.tokens;
  if (shouldPrependBosToken && bos != null && input.at(0) !== bos) {
    input.unshift(bos);
  }
  if (shouldAppendEosToken && eos != null && input.at(-1) !== eos) {
    // Native 3.20.0 prepends here despite calling this an end token. Preserve parity.
    input.unshift(eos);
  }
  return input;
}

export interface PreparedRerankBatch {
  capacity: RerankCapacity;
  /** Pre-tokenized query and documents when the model/template is supported. */
  queryTokens?: Token[];
  documentTokens?: Token[][];
}

export function prepareRerankBatch(
  model: CapacityModel,
  query: string,
  documents: readonly string[],
  version = getNativePackageVersion()
): PreparedRerankBatch {
  if (documents.length === 0) {
    return { capacity: { kind: "empty" } };
  }
  if (!supported(model, version)) {
    return {
      capacity: {
        kind: "auto",
        reason: "Unsupported native version, model or template",
      },
    };
  }
  const maximum = model.trainContextSize;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    return {
      capacity: { kind: "auto", reason: "Unknown model context limit" },
    };
  }
  const tpl = getStaticTemplateTokens(model);
  const queryTokens = model.tokenizer(query, false, "trimLeadingSpace");
  const baseLength =
    tpl.prefix.length +
    queryTokens.length +
    tpl.middle.length +
    tpl.suffix.length;
  const fixedFirst =
    tpl.prefix[0] ?? queryTokens[0] ?? tpl.middle[0] ?? undefined;
  const fixedLast = tpl.suffix.at(-1);
  const fallbackLastBeforeDoc =
    tpl.middle.at(-1) ?? queryTokens.at(-1) ?? tpl.prefix.at(-1);
  const { bos, eos, shouldPrependBosToken, shouldAppendEosToken } =
    model.tokens;

  const documentTokens: Token[][] = [];
  let requiredTokens = 0;
  for (const document of documents) {
    const docTokens = model.tokenizer(document, false, "trimLeadingSpace");
    documentTokens.push(docTokens);
    let length = baseLength + docTokens.length;
    let firstToken =
      fixedFirst !== undefined ? fixedFirst : (docTokens[0] ?? tpl.suffix[0]);
    let lastToken =
      fixedLast !== undefined
        ? fixedLast
        : (docTokens.at(-1) ?? fallbackLastBeforeDoc);
    if (shouldPrependBosToken && bos != null && firstToken !== bos) {
      length += 1;
      if (length === 1) {
        lastToken = bos;
      }
      firstToken = bos;
    }
    if (shouldAppendEosToken && eos != null && lastToken !== eos) {
      length += 1;
    }
    if (length > requiredTokens) {
      requiredTokens = length;
    }
  }
  if (requiredTokens > maximum) {
    throw new RangeError(
      `Rerank input requires ${requiredTokens} tokens; model supports ${maximum}`
    );
  }
  // 3.20.0 config.contextSizePad is 256. The frozen native audit scored
  // ceil((full pair + 256) / 256) * 256 at exact parity; no smaller guard is proven.
  const contextSize = Math.ceil((requiredTokens + 256) / 256) * 256;
  if (contextSize > maximum) {
    return {
      capacity: {
        kind: "auto",
        reason: "Padded capacity exceeds model context limit",
      },
      queryTokens,
      documentTokens,
    };
  }
  return {
    capacity: { kind: "sized", contextSize, requiredTokens },
    queryTokens,
    documentTokens,
  };
}

export function getRerankCapacity(
  model: CapacityModel,
  query: string,
  documents: readonly string[],
  version = getNativePackageVersion()
): RerankCapacity {
  return prepareRerankBatch(model, query, documents, version).capacity;
}
