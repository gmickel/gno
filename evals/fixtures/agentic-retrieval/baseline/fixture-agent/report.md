# Agentic Retrieval Benchmark — fixture-agent-v1

Canonical fingerprint: `1e0da3af3f658893238f8570bed5566101a90d3db83db3ca4e108c0eb2e8da8c`
Fixture: `2026-07-22.1` / `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`
Adapters: `capsule`, `gno-mcp`, `lexical`
Attempted/scored/successful: 144/144/138
Excluded: 0

## Capsule promotion

Verdict: **PASS**
Pairs: 48
Baseline/Capsule success: 0.9583333333333334 / 1
Agent-call reduction: 0.4893617021276596
Context-byte reduction: 0.3643939711994626
Claim linkage: 1
Failures: none

## Adapter-native indexes

- `capsule`: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a` (corpus `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`, preparation 478.889 ms)
- `gno-mcp`: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a` (corpus `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`, preparation 3887.88 ms)
- `lexical`: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a` (corpus `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`, preparation 43.09 ms)

## Cohort accounting

| Adapter | Lifecycle | Attempted | Scored | Success | Excluded | agentCalls | backendInvocations | Model-visible bytes |
| ------- | --------- | --------: | -----: | ------: | -------: | ---------: | -----------------: | ------------------: |
| capsule | cold      |        24 |     24 |      24 |        0 |         24 |                246 |               30279 |
| capsule | warm      |        24 |     24 |      24 |        0 |         24 |                246 |               30279 |
| gno-mcp | cold      |        24 |     24 |      23 |        0 |         47 |                 95 |               47638 |
| gno-mcp | warm      |        24 |     24 |      23 |        0 |         47 |                 95 |               47638 |
| lexical | cold      |        24 |     24 |      22 |        0 |         47 |                 76 |               49947 |
| lexical | warm      |        24 |     24 |      22 |        0 |         47 |                 76 |               49947 |

## Lifecycle timings

Measured totals and explicit unavailable counts/reasons; milliseconds.

| Adapter/lifecycle | Startup                                                  | Model load                                                         | Tool                  | Driver            | End-to-end            |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------ | --------------------- | ----------------- | --------------------- |
| capsule/cold      | 7.576 ms / null 0                                        | 0.000 ms / null 24 (one or more model-load components unavailable) | 27.089 ms / null 0    | 1.493 ms / null 0 | 49.197 ms / null 0    |
| capsule/warm      | 0.000 ms / null 24 (completed before scored warm cohort) | 0.000 ms / null 24 (completed before scored warm cohort)           | 13.488 ms / null 0    | 0.604 ms / null 0 | 16.373 ms / null 0    |
| gno-mcp/cold      | 2604.498 ms / null 0                                     | 0.000 ms / null 24 (one or more model-load components unavailable) | 28232.718 ms / null 0 | 2.877 ms / null 0 | 30962.693 ms / null 0 |
| gno-mcp/warm      | 0.000 ms / null 24 (completed before scored warm cohort) | 0.000 ms / null 24 (completed before scored warm cohort)           | 14945.795 ms / null 0 | 2.196 ms / null 0 | 14956.093 ms / null 0 |
| lexical/cold      | 5.352 ms / null 0                                        | 0.000 ms / null 24 (one or more model-load components unavailable) | 6.771 ms / null 0     | 0.559 ms / null 0 | 17.177 ms / null 0    |
| lexical/warm      | 0.000 ms / null 24 (completed before scored warm cohort) | 0.000 ms / null 24 (completed before scored warm cohort)           | 3.638 ms / null 0     | 0.449 ms / null 0 | 6.449 ms / null 0     |

## Capsule replay hashes

| Task/trial/lifecycle     | First SHA-256                                                      | Replay SHA-256                                                     | Equal |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ----- |
| t012ab3c/fixture-01/cold | `57a7dc289fc72faf96311365c77be7a490c23cef7ce180beb30403486add4573` | `57a7dc289fc72faf96311365c77be7a490c23cef7ce180beb30403486add4573` | yes   |
| t012ab3c/fixture-01/warm | `57a7dc289fc72faf96311365c77be7a490c23cef7ce180beb30403486add4573` | `57a7dc289fc72faf96311365c77be7a490c23cef7ce180beb30403486add4573` | yes   |
| t0a1b2c3/fixture-01/cold | `58687522423ab479b7f1facc158742d9cb72129b315c781640b25aef2e7db858` | `58687522423ab479b7f1facc158742d9cb72129b315c781640b25aef2e7db858` | yes   |
| t0a1b2c3/fixture-01/warm | `58687522423ab479b7f1facc158742d9cb72129b315c781640b25aef2e7db858` | `58687522423ab479b7f1facc158742d9cb72129b315c781640b25aef2e7db858` | yes   |
| t123bc4d/fixture-01/cold | `7fe4718d6894f4346576ddc580e39cce94558f01af82510710f453914e86fe25` | `7fe4718d6894f4346576ddc580e39cce94558f01af82510710f453914e86fe25` | yes   |
| t123bc4d/fixture-01/warm | `7fe4718d6894f4346576ddc580e39cce94558f01af82510710f453914e86fe25` | `7fe4718d6894f4346576ddc580e39cce94558f01af82510710f453914e86fe25` | yes   |
| t1b2c3d4/fixture-01/cold | `fe689ea766c73a0e774630ecb388533738d3e4cfe6e6a7f9d03b0d2887658495` | `fe689ea766c73a0e774630ecb388533738d3e4cfe6e6a7f9d03b0d2887658495` | yes   |
| t1b2c3d4/fixture-01/warm | `fe689ea766c73a0e774630ecb388533738d3e4cfe6e6a7f9d03b0d2887658495` | `fe689ea766c73a0e774630ecb388533738d3e4cfe6e6a7f9d03b0d2887658495` | yes   |
| t234cd5e/fixture-01/cold | `340dc27af121ffafd51ceb61008c0a244eb94113e9c3ec6e17d7ff7255690b78` | `340dc27af121ffafd51ceb61008c0a244eb94113e9c3ec6e17d7ff7255690b78` | yes   |
| t234cd5e/fixture-01/warm | `340dc27af121ffafd51ceb61008c0a244eb94113e9c3ec6e17d7ff7255690b78` | `340dc27af121ffafd51ceb61008c0a244eb94113e9c3ec6e17d7ff7255690b78` | yes   |
| t2c3d4e5/fixture-01/cold | `91bcf42e33afc0ce28031a8a3334a63d8674161a2572676f6582e9681234f4ad` | `91bcf42e33afc0ce28031a8a3334a63d8674161a2572676f6582e9681234f4ad` | yes   |
| t2c3d4e5/fixture-01/warm | `91bcf42e33afc0ce28031a8a3334a63d8674161a2572676f6582e9681234f4ad` | `91bcf42e33afc0ce28031a8a3334a63d8674161a2572676f6582e9681234f4ad` | yes   |
| t345de6f/fixture-01/cold | `2b36ca847f60801a4db8d32ede4ab4d9f3e8f44da2763827eac34c188f9632d7` | `2b36ca847f60801a4db8d32ede4ab4d9f3e8f44da2763827eac34c188f9632d7` | yes   |
| t345de6f/fixture-01/warm | `2b36ca847f60801a4db8d32ede4ab4d9f3e8f44da2763827eac34c188f9632d7` | `2b36ca847f60801a4db8d32ede4ab4d9f3e8f44da2763827eac34c188f9632d7` | yes   |
| t3d4e5f6/fixture-01/cold | `c0837b3db806572e4609906401b139f08cc0a17616216ee0e92813ab00ef6a5a` | `c0837b3db806572e4609906401b139f08cc0a17616216ee0e92813ab00ef6a5a` | yes   |
| t3d4e5f6/fixture-01/warm | `c0837b3db806572e4609906401b139f08cc0a17616216ee0e92813ab00ef6a5a` | `c0837b3db806572e4609906401b139f08cc0a17616216ee0e92813ab00ef6a5a` | yes   |
| t456ef70/fixture-01/cold | `a4e4605a6b9a55917bced8e9cc9153f0390a19e492349e24cf133eb028b4e776` | `a4e4605a6b9a55917bced8e9cc9153f0390a19e492349e24cf133eb028b4e776` | yes   |
| t456ef70/fixture-01/warm | `a4e4605a6b9a55917bced8e9cc9153f0390a19e492349e24cf133eb028b4e776` | `a4e4605a6b9a55917bced8e9cc9153f0390a19e492349e24cf133eb028b4e776` | yes   |
| t4e5f607/fixture-01/cold | `6f070e77ada23803c76eb1ca9f28fad0c4293453153e48c839f5ac975ce2825e` | `6f070e77ada23803c76eb1ca9f28fad0c4293453153e48c839f5ac975ce2825e` | yes   |
| t4e5f607/fixture-01/warm | `6f070e77ada23803c76eb1ca9f28fad0c4293453153e48c839f5ac975ce2825e` | `6f070e77ada23803c76eb1ca9f28fad0c4293453153e48c839f5ac975ce2825e` | yes   |
| t567f081/fixture-01/cold | `eeede5ae1d6e0983d3235f959d92ac8250e321a6bcf64175bad84eefa6ad8ac3` | `eeede5ae1d6e0983d3235f959d92ac8250e321a6bcf64175bad84eefa6ad8ac3` | yes   |
| t567f081/fixture-01/warm | `eeede5ae1d6e0983d3235f959d92ac8250e321a6bcf64175bad84eefa6ad8ac3` | `eeede5ae1d6e0983d3235f959d92ac8250e321a6bcf64175bad84eefa6ad8ac3` | yes   |
| t5f60718/fixture-01/cold | `9c223a6535f4d8fb8034bd5b0ae6bbaba38cb8a9ff94b6a7fc4c9802a79b5499` | `9c223a6535f4d8fb8034bd5b0ae6bbaba38cb8a9ff94b6a7fc4c9802a79b5499` | yes   |
| t5f60718/fixture-01/warm | `9c223a6535f4d8fb8034bd5b0ae6bbaba38cb8a9ff94b6a7fc4c9802a79b5499` | `9c223a6535f4d8fb8034bd5b0ae6bbaba38cb8a9ff94b6a7fc4c9802a79b5499` | yes   |
| t6071829/fixture-01/cold | `b6d79d7627c15402ca2b9954aaf6c2b03670ac18326aed935da2dc9f4127a69a` | `b6d79d7627c15402ca2b9954aaf6c2b03670ac18326aed935da2dc9f4127a69a` | yes   |
| t6071829/fixture-01/warm | `b6d79d7627c15402ca2b9954aaf6c2b03670ac18326aed935da2dc9f4127a69a` | `b6d79d7627c15402ca2b9954aaf6c2b03670ac18326aed935da2dc9f4127a69a` | yes   |
| t6780192/fixture-01/cold | `01a5a3e292380e68e6bdcdc807bd1d20b99c05d5a3330b65fc96489a3eb2cc76` | `01a5a3e292380e68e6bdcdc807bd1d20b99c05d5a3330b65fc96489a3eb2cc76` | yes   |
| t6780192/fixture-01/warm | `01a5a3e292380e68e6bdcdc807bd1d20b99c05d5a3330b65fc96489a3eb2cc76` | `01a5a3e292380e68e6bdcdc807bd1d20b99c05d5a3330b65fc96489a3eb2cc76` | yes   |
| t718293a/fixture-01/cold | `918e6d171a063cd6ee96a491060e48dee9fd0d4c5df37225ca366b3c34d9caa5` | `918e6d171a063cd6ee96a491060e48dee9fd0d4c5df37225ca366b3c34d9caa5` | yes   |
| t718293a/fixture-01/warm | `918e6d171a063cd6ee96a491060e48dee9fd0d4c5df37225ca366b3c34d9caa5` | `918e6d171a063cd6ee96a491060e48dee9fd0d4c5df37225ca366b3c34d9caa5` | yes   |
| t7891a03/fixture-01/cold | `c8dcbd41fef4cc7fc326bd6724e56fd10f729f157b0be4c41402d504bee885e5` | `c8dcbd41fef4cc7fc326bd6724e56fd10f729f157b0be4c41402d504bee885e5` | yes   |
| t7891a03/fixture-01/warm | `c8dcbd41fef4cc7fc326bd6724e56fd10f729f157b0be4c41402d504bee885e5` | `c8dcbd41fef4cc7fc326bd6724e56fd10f729f157b0be4c41402d504bee885e5` | yes   |
| t8293a4b/fixture-01/cold | `5546d58d2de0af30509e69723873efe220a3d297941220f8d517f287ad00e2cf` | `5546d58d2de0af30509e69723873efe220a3d297941220f8d517f287ad00e2cf` | yes   |
| t8293a4b/fixture-01/warm | `5546d58d2de0af30509e69723873efe220a3d297941220f8d517f287ad00e2cf` | `5546d58d2de0af30509e69723873efe220a3d297941220f8d517f287ad00e2cf` | yes   |
| t93a4b5c/fixture-01/cold | `ad1fb2fae31fc583d6e9404e8a1832e99bea34bc96c639e7a16ac2f2f886322d` | `ad1fb2fae31fc583d6e9404e8a1832e99bea34bc96c639e7a16ac2f2f886322d` | yes   |
| t93a4b5c/fixture-01/warm | `ad1fb2fae31fc583d6e9404e8a1832e99bea34bc96c639e7a16ac2f2f886322d` | `ad1fb2fae31fc583d6e9404e8a1832e99bea34bc96c639e7a16ac2f2f886322d` | yes   |
| ta4b5c6d/fixture-01/cold | `88ead531003e38ed6b5b798f25837ead073f6bec3b84d8234ab7d7a22bc421a4` | `88ead531003e38ed6b5b798f25837ead073f6bec3b84d8234ab7d7a22bc421a4` | yes   |
| ta4b5c6d/fixture-01/warm | `88ead531003e38ed6b5b798f25837ead073f6bec3b84d8234ab7d7a22bc421a4` | `88ead531003e38ed6b5b798f25837ead073f6bec3b84d8234ab7d7a22bc421a4` | yes   |
| tb5c6d7e/fixture-01/cold | `b9e668f0d15df725896e75811d48cb09f5928cfc8e3f874ce92a45c9ac9c38c9` | `b9e668f0d15df725896e75811d48cb09f5928cfc8e3f874ce92a45c9ac9c38c9` | yes   |
| tb5c6d7e/fixture-01/warm | `b9e668f0d15df725896e75811d48cb09f5928cfc8e3f874ce92a45c9ac9c38c9` | `b9e668f0d15df725896e75811d48cb09f5928cfc8e3f874ce92a45c9ac9c38c9` | yes   |
| tc6d7e8f/fixture-01/cold | `d65a6bc5e1f4fac8277ac6cbaed7fca763b1363e7020859f45fb77686e99cf49` | `d65a6bc5e1f4fac8277ac6cbaed7fca763b1363e7020859f45fb77686e99cf49` | yes   |
| tc6d7e8f/fixture-01/warm | `d65a6bc5e1f4fac8277ac6cbaed7fca763b1363e7020859f45fb77686e99cf49` | `d65a6bc5e1f4fac8277ac6cbaed7fca763b1363e7020859f45fb77686e99cf49` | yes   |
| td7e8f90/fixture-01/cold | `f6e5d8f861fdedc0e81a3edfac6e0a453b067c18ce11a1fe114e4c63ffb67da0` | `f6e5d8f861fdedc0e81a3edfac6e0a453b067c18ce11a1fe114e4c63ffb67da0` | yes   |
| td7e8f90/fixture-01/warm | `f6e5d8f861fdedc0e81a3edfac6e0a453b067c18ce11a1fe114e4c63ffb67da0` | `f6e5d8f861fdedc0e81a3edfac6e0a453b067c18ce11a1fe114e4c63ffb67da0` | yes   |
| te8f901a/fixture-01/cold | `ab8bf29a27bd248b9497b7e103dc8aeef944c996e2bcac1987f1361776bf908d` | `ab8bf29a27bd248b9497b7e103dc8aeef944c996e2bcac1987f1361776bf908d` | yes   |
| te8f901a/fixture-01/warm | `ab8bf29a27bd248b9497b7e103dc8aeef944c996e2bcac1987f1361776bf908d` | `ab8bf29a27bd248b9497b7e103dc8aeef944c996e2bcac1987f1361776bf908d` | yes   |
| tf901a2b/fixture-01/cold | `be459e42c098a17c2e2e253d22b7523894712a778331076492c8aa4746ff2d94` | `be459e42c098a17c2e2e253d22b7523894712a778331076492c8aa4746ff2d94` | yes   |
| tf901a2b/fixture-01/warm | `be459e42c098a17c2e2e253d22b7523894712a778331076492c8aa4746ff2d94` | `be459e42c098a17c2e2e253d22b7523894712a778331076492c8aa4746ff2d94` | yes   |

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
