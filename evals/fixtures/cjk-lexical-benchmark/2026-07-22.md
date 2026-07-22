# CJK Lexical Degradation Benchmark

Generated: 2026-07-22T13:19:03.508Z

This deterministic same-language benchmark measures Chinese, Japanese, and Korean retrieval when no embedding, expansion, or reranking model is available. It is a small synthetic diagnostic corpus, not a claim of complete CJK coverage.

## Reproducibility

- Schema: 1
- Corpus: 21 documents, 24 queries
- Corpus fingerprint: `5a780ba2d7d8e33190e1468ac1f4d5499b5012820e6b9085ee7112eb3eb45504`
- Configuration fingerprint: `fa077cfe5ce65773ff646492e0590432cad3dc80f1e355ba528abfce34518c5a`
- Runtime fingerprint: `18f5bd4226355d82961d1b739bcd163f9fae96722b5d230e386e4a74dac94872`
- Tokenizer fingerprint: `7c079447fed5ba49dcbe3c1934d41be3a99bd430852dc48ff80d990f46daba96`
- Stable result fingerprint: `15fa566ae8f262fbf1108d1dc74df5f2adc2b1eac05b616eb8551f88e41edb60`
- Tokenizer: `snowball english`
- Runtime: Bun 1.3.5, darwin-arm64, SQLite 3.53.3
- Provenance: Original synthetic documents and judgments authored for GNO; no upstream corpus text was copied

The stable result fingerprint excludes `generatedAt` and all millisecond timing fields. Timings remain machine-specific evidence. All positive qrels currently use relevance 3, so nDCG measures rank placement but not distinctions among multiple positive gain grades.

## Index cost

|     Build |         Size | Pages | Page size | Vocabulary terms | Vocabulary documents | Token occurrences |
| --------: | -----------: | ----: | --------: | ---------------: | -------------------: | ----------------: |
| 487.71 ms | 323584 bytes |    79 |      4096 |              402 |                  485 |               548 |

## Per-language quality

| Lane             | Language | Queries | Recall@5 | Recall@10 |    MRR | nDCG@10 | Zero-result |
| ---------------- | -------- | ------: | -------: | --------: | -----: | ------: | ----------: |
| bm25             | zh       |       8 |   12.50% |    12.50% | 0.1250 |  0.1250 |      87.50% |
| bm25             | ja       |       8 |   12.50% |    12.50% | 0.1250 |  0.1250 |      87.50% |
| bm25             | ko       |       8 |   50.00% |    50.00% | 0.5000 |  0.5000 |      50.00% |
| hybrid-no-models | zh       |       8 |   12.50% |    12.50% | 0.1250 |  0.1250 |      87.50% |
| hybrid-no-models | ja       |       8 |   12.50% |    12.50% | 0.1250 |  0.1250 |      87.50% |
| hybrid-no-models | ko       |       8 |   50.00% |    50.00% | 0.5000 |  0.5000 |      50.00% |
| substring-raw    | zh       |       8 |   37.50% |    37.50% | 0.3750 |  0.3750 |      62.50% |
| substring-raw    | ja       |       8 |   87.50% |    87.50% | 0.8750 |  0.8750 |      12.50% |
| substring-raw    | ko       |       8 |   87.50% |    87.50% | 0.8750 |  0.8750 |      12.50% |
| substring-nfc    | zh       |       8 |   37.50% |    37.50% | 0.3750 |  0.3750 |      62.50% |
| substring-nfc    | ja       |       8 |   87.50% |    87.50% | 0.8750 |  0.8750 |      12.50% |
| substring-nfc    | ko       |       8 |  100.00% |   100.00% | 1.0000 |  1.0000 |       0.00% |

## Latency

| Lane             | Cold query | Warm p50 | Warm p95 | Warm mean |
| ---------------- | ---------: | -------: | -------: | --------: |
| bm25             |    2.69 ms |  0.45 ms |  0.67 ms |   0.48 ms |
| hybrid-no-models |    2.50 ms |  0.46 ms |  0.77 ms |   0.50 ms |
| substring-raw    |    0.31 ms |  0.05 ms |  0.07 ms |   0.05 ms |
| substring-nfc    |    0.07 ms |  0.05 ms |  0.06 ms |   0.05 ms |

Cold query is the first timed request for each lane after index construction. Warm latency is measured after one untimed full-corpus pass.

## Categorized failures

| Lane             | Language | Query   | Category       | Reason      | Query text                       | Expected   | Top documents |
| ---------------- | -------- | ------- | -------------- | ----------- | -------------------------------- | ---------- | ------------- |
| bm25             | zh       | zh-q001 | ranking        | zero-result | 北辰物流 冷链温控报警            | zh/d001.md | —             |
| bm25             | zh       | zh-q002 | identifier     | zero-result | TW-0317 古籍除湿                 | zh/d002.md | —             |
| bm25             | zh       | zh-q003 | mixed-script   | zero-result | QinglanPay ZH_API-77 回调失败    | zh/d003.md | —             |
| bm25             | zh       | zh-q004 | token-boundary | zero-result | 机器学习模型 登记责任人          | zh/d004.md | —             |
| bm25             | zh       | zh-q005 | normalization  | zero-result | ＡＣＣＴ－９９ 账户迁移          | zh/d005.md | —             |
| bm25             | zh       | zh-q006 | ranking        | zero-result | 供应商 华北 乙类 合同修订        | zh/d006.md | —             |
| bm25             | zh       | zh-q007 | ranking        | zero-result | 值班计划\_夏季版.md 夜班交接     | zh/d007.md | —             |
| bm25             | ja       | ja-q001 | identifier     | zero-result | 北浜倉庫 冷凍機 JP-771           | ja/d001.md | —             |
| bm25             | ja       | ja-q002 | ranking        | zero-result | さくら配送センター 封印番号      | ja/d002.md | —             |
| bm25             | ja       | ja-q003 | mixed-script   | zero-result | KumoPay JP_API-42 Webhook 再送   | ja/d003.md | —             |
| bm25             | ja       | ja-q004 | normalization  | zero-result | ガラス乾板 保管温度            | ja/d004.md | —             |
| bm25             | ja       | ja-q005 | ranking        | zero-result | 青葉 二組 河口 観測              | ja/d005.md | —             |
| bm25             | ja       | ja-q007 | ranking        | zero-result | 当番表\_夜間版.md 引き継ぎ       | ja/d007.md | —             |
| bm25             | ja       | ja-q008 | ranking        | zero-result | ガラス乾板 乳剤面 順応           | ja/d004.md | —             |
| bm25             | ko       | ko-q001 | identifier     | zero-result | 북항 창고 냉동기 KR-882          | ko/d001.md | —             |
| bm25             | ko       | ko-q003 | mixed-script   | zero-result | DuriPay KO_API-31 Webhook 재전송 | ko/d003.md | —             |
| bm25             | ko       | ko-q004 | normalization  | zero-result | 가속기 실험 안전 절차        | ko/d004.md | —             |
| bm25             | ko       | ko-q007 | ranking        | zero-result | 당직표\_야간판.md 인계           | ko/d007.md | —             |
| hybrid-no-models | zh       | zh-q001 | ranking        | zero-result | 北辰物流 冷链温控报警            | zh/d001.md | —             |
| hybrid-no-models | zh       | zh-q002 | identifier     | zero-result | TW-0317 古籍除湿                 | zh/d002.md | —             |
| hybrid-no-models | zh       | zh-q003 | mixed-script   | zero-result | QinglanPay ZH_API-77 回调失败    | zh/d003.md | —             |
| hybrid-no-models | zh       | zh-q004 | token-boundary | zero-result | 机器学习模型 登记责任人          | zh/d004.md | —             |
| hybrid-no-models | zh       | zh-q005 | normalization  | zero-result | ＡＣＣＴ－９９ 账户迁移          | zh/d005.md | —             |
| hybrid-no-models | zh       | zh-q006 | ranking        | zero-result | 供应商 华北 乙类 合同修订        | zh/d006.md | —             |
| hybrid-no-models | zh       | zh-q007 | ranking        | zero-result | 值班计划\_夏季版.md 夜班交接     | zh/d007.md | —             |
| hybrid-no-models | ja       | ja-q001 | identifier     | zero-result | 北浜倉庫 冷凍機 JP-771           | ja/d001.md | —             |
| hybrid-no-models | ja       | ja-q002 | ranking        | zero-result | さくら配送センター 封印番号      | ja/d002.md | —             |
| hybrid-no-models | ja       | ja-q003 | mixed-script   | zero-result | KumoPay JP_API-42 Webhook 再送   | ja/d003.md | —             |
| hybrid-no-models | ja       | ja-q004 | normalization  | zero-result | ガラス乾板 保管温度            | ja/d004.md | —             |
| hybrid-no-models | ja       | ja-q005 | ranking        | zero-result | 青葉 二組 河口 観測              | ja/d005.md | —             |
| hybrid-no-models | ja       | ja-q007 | ranking        | zero-result | 当番表\_夜間版.md 引き継ぎ       | ja/d007.md | —             |
| hybrid-no-models | ja       | ja-q008 | ranking        | zero-result | ガラス乾板 乳剤面 順応           | ja/d004.md | —             |
| hybrid-no-models | ko       | ko-q001 | identifier     | zero-result | 북항 창고 냉동기 KR-882          | ko/d001.md | —             |
| hybrid-no-models | ko       | ko-q003 | mixed-script   | zero-result | DuriPay KO_API-31 Webhook 재전송 | ko/d003.md | —             |
| hybrid-no-models | ko       | ko-q004 | normalization  | zero-result | 가속기 실험 안전 절차        | ko/d004.md | —             |
| hybrid-no-models | ko       | ko-q007 | ranking        | zero-result | 당직표\_야간판.md 인계           | ko/d007.md | —             |
| substring-raw    | zh       | zh-q002 | identifier     | zero-result | TW-0317 古籍除湿                 | zh/d002.md | —             |
| substring-raw    | zh       | zh-q003 | mixed-script   | zero-result | QinglanPay ZH_API-77 回调失败    | zh/d003.md | —             |
| substring-raw    | zh       | zh-q004 | token-boundary | zero-result | 机器学习模型 登记责任人          | zh/d004.md | —             |
| substring-raw    | zh       | zh-q005 | normalization  | zero-result | ＡＣＣＴ－９９ 账户迁移          | zh/d005.md | —             |
| substring-raw    | zh       | zh-q007 | ranking        | zero-result | 值班计划\_夏季版.md 夜班交接     | zh/d007.md | —             |
| substring-raw    | ja       | ja-q004 | normalization  | zero-result | ガラス乾板 保管温度            | ja/d004.md | —             |
| substring-raw    | ko       | ko-q004 | normalization  | zero-result | 가속기 실험 안전 절차        | ko/d004.md | —             |
| substring-nfc    | zh       | zh-q002 | identifier     | zero-result | TW-0317 古籍除湿                 | zh/d002.md | —             |
| substring-nfc    | zh       | zh-q003 | mixed-script   | zero-result | QinglanPay ZH_API-77 回调失败    | zh/d003.md | —             |
| substring-nfc    | zh       | zh-q004 | token-boundary | zero-result | 机器学习模型 登记责任人          | zh/d004.md | —             |
| substring-nfc    | zh       | zh-q005 | normalization  | zero-result | ＡＣＣＴ－９９ 账户迁移          | zh/d005.md | —             |
| substring-nfc    | zh       | zh-q007 | ranking        | zero-result | 值班计划\_夏季版.md 夜班交接     | zh/d007.md | —             |
| substring-nfc    | ja       | ja-q004 | normalization  | zero-result | ガラス乾板 保管温度            | ja/d004.md | —             |

Diagnostic substring lanes inspect title and document content only; opaque corpus paths never participate in matching. They are benchmark-only and do not change production tokenization or retrieval.
