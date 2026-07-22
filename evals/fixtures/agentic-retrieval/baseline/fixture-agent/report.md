# Agentic Retrieval Benchmark — fixture-agent-v1

Canonical fingerprint: `05895be6133d636ce2b0d571748f678e19c2714c0b9c938f9f01ce7b07801330`
Fixture: `2026-07-22.1` / `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`
Adapters: `capsule`, `gno-mcp`, `lexical`
Attempted/scored/successful: 144/144/138
Excluded: 0

## Capsule promotion

Verdict: **FAIL**
Pairs: 48
Baseline/Capsule success: 0.9583333333333334 / 1
Agent-call reduction: 0.4893617021276596
Context-byte reduction: -0.6570175070322011
Claim linkage: 1
Failures: context_byte_reduction_below_0.35_or_zero_denominator

## Adapter-native indexes

- `capsule`: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a` (corpus `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`, preparation 497.259 ms)
- `gno-mcp`: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a` (corpus `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`, preparation 3918.65 ms)
- `lexical`: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a` (corpus `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`, preparation 58.099 ms)

## Cohort accounting

| Adapter | Lifecycle | Attempted | Scored | Success | Excluded | agentCalls | backendInvocations | Model-visible bytes |
| ------- | --------- | --------: | -----: | ------: | -------: | ---------: | -----------------: | ------------------: |
| capsule | cold      |        24 |     24 |      24 |        0 |         24 |                246 |               78937 |
| capsule | warm      |        24 |     24 |      24 |        0 |         24 |                246 |               78937 |
| gno-mcp | cold      |        24 |     24 |      23 |        0 |         47 |                 95 |               47638 |
| gno-mcp | warm      |        24 |     24 |      23 |        0 |         47 |                 95 |               47638 |
| lexical | cold      |        24 |     24 |      22 |        0 |         47 |                 76 |               49947 |
| lexical | warm      |        24 |     24 |      22 |        0 |         47 |                 76 |               49947 |

## Lifecycle timings

Measured totals and explicit unavailable counts/reasons; milliseconds.

| Adapter/lifecycle | Startup                                                  | Model load                                                         | Tool                  | Driver            | End-to-end            |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------ | --------------------- | ----------------- | --------------------- |
| capsule/cold      | 7.113 ms / null 0                                        | 0.000 ms / null 24 (one or more model-load components unavailable) | 28.937 ms / null 0    | 1.332 ms / null 0 | 50.060 ms / null 0    |
| capsule/warm      | 0.000 ms / null 24 (completed before scored warm cohort) | 0.000 ms / null 24 (completed before scored warm cohort)           | 15.581 ms / null 0    | 0.594 ms / null 0 | 18.839 ms / null 0    |
| gno-mcp/cold      | 2603.698 ms / null 0                                     | 0.000 ms / null 24 (one or more model-load components unavailable) | 28699.566 ms / null 0 | 2.739 ms / null 0 | 31419.127 ms / null 0 |
| gno-mcp/warm      | 0.000 ms / null 24 (completed before scored warm cohort) | 0.000 ms / null 24 (completed before scored warm cohort)           | 15700.740 ms / null 0 | 2.710 ms / null 0 | 15711.576 ms / null 0 |
| lexical/cold      | 6.093 ms / null 0                                        | 0.000 ms / null 24 (one or more model-load components unavailable) | 7.768 ms / null 0     | 0.670 ms / null 0 | 19.418 ms / null 0    |
| lexical/warm      | 0.000 ms / null 24 (completed before scored warm cohort) | 0.000 ms / null 24 (completed before scored warm cohort)           | 3.549 ms / null 0     | 0.450 ms / null 0 | 6.061 ms / null 0     |

## Capsule replay hashes

| Task/trial/lifecycle     | First SHA-256                                                      | Replay SHA-256                                                     | Equal |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ----- |
| t012ab3c/fixture-01/cold | `b8086cbd2d8e0b4e14bbbc40397489bb7d08e5db2459aadcbbac6e1e6e52e91c` | `b8086cbd2d8e0b4e14bbbc40397489bb7d08e5db2459aadcbbac6e1e6e52e91c` | yes   |
| t012ab3c/fixture-01/warm | `b8086cbd2d8e0b4e14bbbc40397489bb7d08e5db2459aadcbbac6e1e6e52e91c` | `b8086cbd2d8e0b4e14bbbc40397489bb7d08e5db2459aadcbbac6e1e6e52e91c` | yes   |
| t0a1b2c3/fixture-01/cold | `77a79eda6844f6c44cef86870c6036efad7edb4aff80b2c6ea57bc7929a7fb45` | `77a79eda6844f6c44cef86870c6036efad7edb4aff80b2c6ea57bc7929a7fb45` | yes   |
| t0a1b2c3/fixture-01/warm | `77a79eda6844f6c44cef86870c6036efad7edb4aff80b2c6ea57bc7929a7fb45` | `77a79eda6844f6c44cef86870c6036efad7edb4aff80b2c6ea57bc7929a7fb45` | yes   |
| t123bc4d/fixture-01/cold | `3f6b3fcaa576b9a50feba437b0a9061880f601a9267a566f08fa551faec9a294` | `3f6b3fcaa576b9a50feba437b0a9061880f601a9267a566f08fa551faec9a294` | yes   |
| t123bc4d/fixture-01/warm | `3f6b3fcaa576b9a50feba437b0a9061880f601a9267a566f08fa551faec9a294` | `3f6b3fcaa576b9a50feba437b0a9061880f601a9267a566f08fa551faec9a294` | yes   |
| t1b2c3d4/fixture-01/cold | `e7cad33e7f0abeed95f8e185798721ff937adf6ba2cbfa6f847070c63795e245` | `e7cad33e7f0abeed95f8e185798721ff937adf6ba2cbfa6f847070c63795e245` | yes   |
| t1b2c3d4/fixture-01/warm | `e7cad33e7f0abeed95f8e185798721ff937adf6ba2cbfa6f847070c63795e245` | `e7cad33e7f0abeed95f8e185798721ff937adf6ba2cbfa6f847070c63795e245` | yes   |
| t234cd5e/fixture-01/cold | `e2fc1153aa19eba15dba55847ace48778d96cba4aa0b005e620e65b1d6a3bc18` | `e2fc1153aa19eba15dba55847ace48778d96cba4aa0b005e620e65b1d6a3bc18` | yes   |
| t234cd5e/fixture-01/warm | `e2fc1153aa19eba15dba55847ace48778d96cba4aa0b005e620e65b1d6a3bc18` | `e2fc1153aa19eba15dba55847ace48778d96cba4aa0b005e620e65b1d6a3bc18` | yes   |
| t2c3d4e5/fixture-01/cold | `5a9c14b0c0a3a7bb2350b90089b99957e120c49d2850a24499025eb793571743` | `5a9c14b0c0a3a7bb2350b90089b99957e120c49d2850a24499025eb793571743` | yes   |
| t2c3d4e5/fixture-01/warm | `5a9c14b0c0a3a7bb2350b90089b99957e120c49d2850a24499025eb793571743` | `5a9c14b0c0a3a7bb2350b90089b99957e120c49d2850a24499025eb793571743` | yes   |
| t345de6f/fixture-01/cold | `a5de7683cf751283d3b4c9b5b944496383f3f41ccae1025177a3d823be293f1f` | `a5de7683cf751283d3b4c9b5b944496383f3f41ccae1025177a3d823be293f1f` | yes   |
| t345de6f/fixture-01/warm | `a5de7683cf751283d3b4c9b5b944496383f3f41ccae1025177a3d823be293f1f` | `a5de7683cf751283d3b4c9b5b944496383f3f41ccae1025177a3d823be293f1f` | yes   |
| t3d4e5f6/fixture-01/cold | `32b9b4cde466e58fc6ca76e2d01db1798838cfd9cad48d2d7e01409fc2c87b4c` | `32b9b4cde466e58fc6ca76e2d01db1798838cfd9cad48d2d7e01409fc2c87b4c` | yes   |
| t3d4e5f6/fixture-01/warm | `32b9b4cde466e58fc6ca76e2d01db1798838cfd9cad48d2d7e01409fc2c87b4c` | `32b9b4cde466e58fc6ca76e2d01db1798838cfd9cad48d2d7e01409fc2c87b4c` | yes   |
| t456ef70/fixture-01/cold | `cfc18351b2dc35173fa6f7b9478327eeeb617f4e01b67f91c5ab52c992f8eda0` | `cfc18351b2dc35173fa6f7b9478327eeeb617f4e01b67f91c5ab52c992f8eda0` | yes   |
| t456ef70/fixture-01/warm | `cfc18351b2dc35173fa6f7b9478327eeeb617f4e01b67f91c5ab52c992f8eda0` | `cfc18351b2dc35173fa6f7b9478327eeeb617f4e01b67f91c5ab52c992f8eda0` | yes   |
| t4e5f607/fixture-01/cold | `112b1a4a3ab760c0dc43e68fb2e5a1d97fdb978a31d7c15a7dc718fda823878e` | `112b1a4a3ab760c0dc43e68fb2e5a1d97fdb978a31d7c15a7dc718fda823878e` | yes   |
| t4e5f607/fixture-01/warm | `112b1a4a3ab760c0dc43e68fb2e5a1d97fdb978a31d7c15a7dc718fda823878e` | `112b1a4a3ab760c0dc43e68fb2e5a1d97fdb978a31d7c15a7dc718fda823878e` | yes   |
| t567f081/fixture-01/cold | `5816abdcb5eeb2ecd209480489f4b26e2a8a8b9493ad9703605a6b020828a637` | `5816abdcb5eeb2ecd209480489f4b26e2a8a8b9493ad9703605a6b020828a637` | yes   |
| t567f081/fixture-01/warm | `5816abdcb5eeb2ecd209480489f4b26e2a8a8b9493ad9703605a6b020828a637` | `5816abdcb5eeb2ecd209480489f4b26e2a8a8b9493ad9703605a6b020828a637` | yes   |
| t5f60718/fixture-01/cold | `52392aa9a32fc4c86189ae7295c478a96b20779d9b23ca79f9217811c792915c` | `52392aa9a32fc4c86189ae7295c478a96b20779d9b23ca79f9217811c792915c` | yes   |
| t5f60718/fixture-01/warm | `52392aa9a32fc4c86189ae7295c478a96b20779d9b23ca79f9217811c792915c` | `52392aa9a32fc4c86189ae7295c478a96b20779d9b23ca79f9217811c792915c` | yes   |
| t6071829/fixture-01/cold | `d2a42e5848b4ee64703a63f082437908964496fe5e9003eef7ee5b367a4e2ce9` | `d2a42e5848b4ee64703a63f082437908964496fe5e9003eef7ee5b367a4e2ce9` | yes   |
| t6071829/fixture-01/warm | `d2a42e5848b4ee64703a63f082437908964496fe5e9003eef7ee5b367a4e2ce9` | `d2a42e5848b4ee64703a63f082437908964496fe5e9003eef7ee5b367a4e2ce9` | yes   |
| t6780192/fixture-01/cold | `09f497bee560f2c4d0a949a4dd16b0663dbd9981618b27765963422b73886704` | `09f497bee560f2c4d0a949a4dd16b0663dbd9981618b27765963422b73886704` | yes   |
| t6780192/fixture-01/warm | `09f497bee560f2c4d0a949a4dd16b0663dbd9981618b27765963422b73886704` | `09f497bee560f2c4d0a949a4dd16b0663dbd9981618b27765963422b73886704` | yes   |
| t718293a/fixture-01/cold | `2bc43ce29b9b5a2fea8fa682cf16bbf316889482ce3aee4a9059b2326001fd4d` | `2bc43ce29b9b5a2fea8fa682cf16bbf316889482ce3aee4a9059b2326001fd4d` | yes   |
| t718293a/fixture-01/warm | `2bc43ce29b9b5a2fea8fa682cf16bbf316889482ce3aee4a9059b2326001fd4d` | `2bc43ce29b9b5a2fea8fa682cf16bbf316889482ce3aee4a9059b2326001fd4d` | yes   |
| t7891a03/fixture-01/cold | `73652f111d6d39528d13c1f598c2e8af0ec682df0b4081e91d8560e8daac621b` | `73652f111d6d39528d13c1f598c2e8af0ec682df0b4081e91d8560e8daac621b` | yes   |
| t7891a03/fixture-01/warm | `73652f111d6d39528d13c1f598c2e8af0ec682df0b4081e91d8560e8daac621b` | `73652f111d6d39528d13c1f598c2e8af0ec682df0b4081e91d8560e8daac621b` | yes   |
| t8293a4b/fixture-01/cold | `258fc0e189e339175475b41d0e4188bc48355f6b252d0b777d908d9aebb2602f` | `258fc0e189e339175475b41d0e4188bc48355f6b252d0b777d908d9aebb2602f` | yes   |
| t8293a4b/fixture-01/warm | `258fc0e189e339175475b41d0e4188bc48355f6b252d0b777d908d9aebb2602f` | `258fc0e189e339175475b41d0e4188bc48355f6b252d0b777d908d9aebb2602f` | yes   |
| t93a4b5c/fixture-01/cold | `8952f2123efcb286423e7d1a8367cf21057e0a2b8f58287d1f8b316cdafec813` | `8952f2123efcb286423e7d1a8367cf21057e0a2b8f58287d1f8b316cdafec813` | yes   |
| t93a4b5c/fixture-01/warm | `8952f2123efcb286423e7d1a8367cf21057e0a2b8f58287d1f8b316cdafec813` | `8952f2123efcb286423e7d1a8367cf21057e0a2b8f58287d1f8b316cdafec813` | yes   |
| ta4b5c6d/fixture-01/cold | `b21dc0894b01c0ddf634bc8a2e4ab5db5cedb4bf7dc9b3bd986428b3a7e75b9f` | `b21dc0894b01c0ddf634bc8a2e4ab5db5cedb4bf7dc9b3bd986428b3a7e75b9f` | yes   |
| ta4b5c6d/fixture-01/warm | `b21dc0894b01c0ddf634bc8a2e4ab5db5cedb4bf7dc9b3bd986428b3a7e75b9f` | `b21dc0894b01c0ddf634bc8a2e4ab5db5cedb4bf7dc9b3bd986428b3a7e75b9f` | yes   |
| tb5c6d7e/fixture-01/cold | `63cde5cd399c6de48e5498d5bef58ac0b202e86b990e78f997cfbb6846e8d096` | `63cde5cd399c6de48e5498d5bef58ac0b202e86b990e78f997cfbb6846e8d096` | yes   |
| tb5c6d7e/fixture-01/warm | `63cde5cd399c6de48e5498d5bef58ac0b202e86b990e78f997cfbb6846e8d096` | `63cde5cd399c6de48e5498d5bef58ac0b202e86b990e78f997cfbb6846e8d096` | yes   |
| tc6d7e8f/fixture-01/cold | `71e7779e5b62ba17bc7de1e167454fb01199135bfeeb2cf4523d78d32274f9ff` | `71e7779e5b62ba17bc7de1e167454fb01199135bfeeb2cf4523d78d32274f9ff` | yes   |
| tc6d7e8f/fixture-01/warm | `71e7779e5b62ba17bc7de1e167454fb01199135bfeeb2cf4523d78d32274f9ff` | `71e7779e5b62ba17bc7de1e167454fb01199135bfeeb2cf4523d78d32274f9ff` | yes   |
| td7e8f90/fixture-01/cold | `583b593d5b92456b2888c24ea5db4d4c9c4ff299e3768d6e0dc9c38a670950b9` | `583b593d5b92456b2888c24ea5db4d4c9c4ff299e3768d6e0dc9c38a670950b9` | yes   |
| td7e8f90/fixture-01/warm | `583b593d5b92456b2888c24ea5db4d4c9c4ff299e3768d6e0dc9c38a670950b9` | `583b593d5b92456b2888c24ea5db4d4c9c4ff299e3768d6e0dc9c38a670950b9` | yes   |
| te8f901a/fixture-01/cold | `fa702ccf87efb90915ad907e9789cc7ce6368053a38931636d46f2da1c18986a` | `fa702ccf87efb90915ad907e9789cc7ce6368053a38931636d46f2da1c18986a` | yes   |
| te8f901a/fixture-01/warm | `fa702ccf87efb90915ad907e9789cc7ce6368053a38931636d46f2da1c18986a` | `fa702ccf87efb90915ad907e9789cc7ce6368053a38931636d46f2da1c18986a` | yes   |
| tf901a2b/fixture-01/cold | `23a13508f2c27562faf4100690988ad9eb93951215aabc09e03ddaf129772f78` | `23a13508f2c27562faf4100690988ad9eb93951215aabc09e03ddaf129772f78` | yes   |
| tf901a2b/fixture-01/warm | `23a13508f2c27562faf4100690988ad9eb93951215aabc09e03ddaf129772f78` | `23a13508f2c27562faf4100690988ad9eb93951215aabc09e03ddaf129772f78` | yes   |

## Methodology

- One pinned outer-agent schedule runs identical visible tasks and tool schemas across adapters.
- Cold and warm cohorts reuse each adapter native immutable index; warm uses one discarded readiness probe.
- Deterministic hidden-oracle scoring binds typed claims to exact source lines and hashes without an LLM judge.
- Capsule promotion compares gno-mcp and capsule only on exact paired identities and unchanged-input payload replays.

## Limitations

- Controlled fixtures are regression evidence, not a representative workload claim.
- Fixture-agent behavior is deterministic and narrower than a general model.
- UTF-8 bytes are the primary context measure; tokens are null without one pinned tokenizer.
- Latency is environment-specific and comparable only within a matching lifecycle.
- qmd is optional, exact-revision pinned, and non-authoritative for Capsule promotion.
- The Capsule adapter is eval-only and does not define the production fn-98 contract.
