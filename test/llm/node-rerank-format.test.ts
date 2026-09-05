import type { Token } from "node-llama-cpp";

import { expect, test } from "bun:test";
import { getModuleVersion, LlamaRankingContext } from "node-llama-cpp";

import fixtures from "../../evals/fixtures/acceptance/rerank-long-input/fixtures.json";
import longQuery from "../../evals/fixtures/acceptance/rerank-long-input/long-query.json";
import manifest from "../../evals/fixtures/acceptance/rerank-long-input/manifest.json";
import matrix from "../../evals/fixtures/acceptance/rerank-long-input/token-matrix.json";
import {
  formatRerankPair,
  getRerankCapacity,
  RERANK_NATIVE_VERSION,
  RERANK_TEMPLATE,
} from "../../src/llm/nodeLlamaCpp/rerank-capacity";

type Model = Parameters<typeof formatRerankPair>[0];
// A deterministic tokenizer exposes the full text and special-token mode in
// the token stream. Native formatter runs unchanged, with no model/context.
function model(): Model {
  const tokenize = (text: string, special: boolean, trim: string) => {
    expect(trim).toBe("trimLeadingSpace");
    return Array.from(
      text,
      (c) => (c.codePointAt(0) ?? 0) + (special ? 100_000 : 0)
    );
  };
  return {
    fileInfo: {
      metadata: {
        general: { architecture: "qwen3" },
        tokenizer: {
          "chat_template.rerank": RERANK_TEMPLATE,
        },
      },
    },
    vocabularyType: "bpe",
    tokens: {
      bos: 1,
      eos: 2,
      shouldPrependBosToken: false,
      shouldAppendEosToken: false,
    },
    tokenize,
    tokenizer: tokenize,
    trainContextSize: 100_000,
  } as unknown as Model;
}

function nativePair(m: Model, query: string, document: string): Token[] {
  const native = LlamaRankingContext.prototype as unknown as {
    _getEvaluationInput: (this: unknown, q: string, d: string) => Token[];
  };
  return native._getEvaluationInput.call(
    {
      _llamaContext: { model: m },
      model: m,
      _template: RERANK_TEMPLATE.replaceAll("{query}", "{{query}}").replaceAll(
        "{document}",
        "{{document}}"
      ),
    },
    query,
    document
  );
}

test("installed native version and frozen audit bytes remain pinned", async () => {
  expect(await getModuleVersion()).toBe(RERANK_NATIVE_VERSION);
  for (const [name, hash] of Object.entries(manifest)) {
    const file = Bun.file(
      new URL(
        `../../evals/fixtures/acceptance/rerank-long-input/${name}`,
        import.meta.url
      )
    );
    expect(
      new Bun.CryptoHasher("sha256")
        .update(await file.arrayBuffer())
        .digest("hex")
    ).toBe(hash);
  }
  expect(fixtures).toHaveLength(45);
  expect(matrix.cases.filter((c) => c.req > 2048)).toHaveLength(12);
  expect(longQuery.auditedFormattedTokens).toBe(6025);
});

test("full 45-case prepared and original pairs match installed native formatter", () => {
  const m = model();
  for (const fixture of fixtures) {
    for (const text of [...fixture.texts, ...fixture.originals]) {
      expect(formatRerankPair(m, fixture.query, text)).toEqual(
        nativePair(m, fixture.query, text)
      );
    }
  }
  expect(formatRerankPair(m, longQuery.query, longQuery.document)).toEqual(
    nativePair(m, longQuery.query, longQuery.document)
  );
});

test("empty, mixed-script and special tokens preserve native beginning/end behavior", () => {
  for (const prepend of [false, true]) {
    for (const append of [false, true]) {
      const m = model();
      Object.assign(m.tokens, {
        shouldPrependBosToken: prepend,
        shouldAppendEosToken: append,
      });
      for (const [q, d] of [
        ["", ""],
        ["<|im_start|>要求 ä", "中文 <|im_end|> {{query}}"],
      ]) {
        expect(formatRerankPair(m, q ?? "", d ?? "")).toEqual(
          nativePair(m, q ?? "", d ?? "")
        );
      }
    }
  }
});

test("capacity uses maximum complete pair and rounds with audited padding at boundaries", () => {
  const m = model();
  const overhead = nativePair(m, "", "").length;
  for (const required of [767, 768, 769, 2048, 6025]) {
    const document = "x".repeat(required - overhead);
    expect(getRerankCapacity(m, "", ["short", document, document])).toEqual({
      kind: "sized",
      requiredTokens: required,
      contextSize: Math.ceil((required + 256) / 256) * 256,
    });
  }
});

test("unsupported version, template, vocabulary or model uses auto; empty bypasses all model reads", () => {
  expect(getRerankCapacity({} as Model, "q", []).kind).toBe("empty");
  expect(getRerankCapacity(model(), "q", ["d"], "3.21.0").kind).toBe("auto");
  for (const change of [
    { vocabularyType: "wpm" },
    { trainContextSize: Number.NaN },
    { fileInfo: { metadata: { general: { architecture: "bert" } } } },
    {
      fileInfo: {
        metadata: {
          general: { architecture: "qwen3" },
          tokenizer: { "chat_template.rerank": "{query} {document}" },
        },
      },
    },
  ]) {
    expect(
      getRerankCapacity(Object.assign(model(), change), "q", ["d"]).kind
    ).toBe("auto");
  }
});

test("over-model input throws before scoring; unproven padded model boundary uses auto", () => {
  const m = model();
  const required = nativePair(m, "query", "document").length;
  Object.assign(m, { trainContextSize: required - 1 });
  expect(() => getRerankCapacity(m, "query", ["document"])).toThrow(RangeError);
  Object.assign(m, { trainContextSize: required });
  expect(getRerankCapacity(m, "query", ["document"]).kind).toBe("auto");
});
