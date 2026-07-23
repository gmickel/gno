# Agentic Retrieval Benchmark — fixture-agent-v1

Canonical fingerprint: `0725a8c7a5d3a468e6c80e1a3313b2dd01fc434dd1335f0c38c3c711ba7780ab`
Fixture: `2026-07-22.1` / `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`
Adapters: `capsule`, `gno-mcp`, `lexical`
Attempted/scored/successful: 144/144/138
Excluded: 0

## Capsule promotion

Verdict: **PASS**
Pairs: 48
Baseline/Capsule success: 0.9583333333333334 / 1
Agent-call reduction: 0.4893617021276596
Context-byte reduction: 0.499475208866871
Claim linkage: 1
Failures: none

## Adapter-native indexes

- `capsule`: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a` (corpus `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`, preparation 754.193 ms)
- `gno-mcp`: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a` (corpus `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`, preparation 3898.367 ms)
- `lexical`: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a` (corpus `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`, preparation 44.547 ms)

## Cohort accounting

| Adapter | Lifecycle | Attempted | Scored | Success | Excluded | agentCalls | backendInvocations | Model-visible bytes |
| ------- | --------- | --------: | -----: | ------: | -------: | ---------: | -----------------: | ------------------: |
| capsule | cold      |        24 |     24 |      24 |        0 |         24 |                246 |               23844 |
| capsule | warm      |        24 |     24 |      24 |        0 |         24 |                246 |               23844 |
| gno-mcp | cold      |        24 |     24 |      23 |        0 |         47 |                 95 |               47638 |
| gno-mcp | warm      |        24 |     24 |      23 |        0 |         47 |                 95 |               47638 |
| lexical | cold      |        24 |     24 |      22 |        0 |         47 |                 76 |               49947 |
| lexical | warm      |        24 |     24 |      22 |        0 |         47 |                 76 |               49947 |

## Lifecycle timings

Measured totals and explicit unavailable counts/reasons; milliseconds.

| Adapter/lifecycle | Startup                                                  | Model load                                                         | Tool                  | Driver            | End-to-end            |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------ | --------------------- | ----------------- | --------------------- |
| capsule/cold      | 7.848 ms / null 0                                        | 0.000 ms / null 24 (one or more model-load components unavailable) | 27.959 ms / null 0    | 1.720 ms / null 0 | 51.239 ms / null 0    |
| capsule/warm      | 0.000 ms / null 24 (completed before scored warm cohort) | 0.000 ms / null 24 (completed before scored warm cohort)           | 14.529 ms / null 0    | 0.663 ms / null 0 | 17.680 ms / null 0    |
| gno-mcp/cold      | 2736.657 ms / null 0                                     | 0.000 ms / null 24 (one or more model-load components unavailable) | 27932.680 ms / null 0 | 2.962 ms / null 0 | 30795.278 ms / null 0 |
| gno-mcp/warm      | 0.000 ms / null 24 (completed before scored warm cohort) | 0.000 ms / null 24 (completed before scored warm cohort)           | 14941.297 ms / null 0 | 2.342 ms / null 0 | 14951.803 ms / null 0 |
| lexical/cold      | 5.597 ms / null 0                                        | 0.000 ms / null 24 (one or more model-load components unavailable) | 7.120 ms / null 0     | 0.549 ms / null 0 | 18.023 ms / null 0    |
| lexical/warm      | 0.000 ms / null 24 (completed before scored warm cohort) | 0.000 ms / null 24 (completed before scored warm cohort)           | 3.092 ms / null 0     | 0.388 ms / null 0 | 5.463 ms / null 0     |

## Capsule replay hashes

| Task/trial/lifecycle     | First SHA-256                                                      | Replay SHA-256                                                     | Equal |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ----- |
| t012ab3c/fixture-01/cold | `e097f3252ffb9feb2c3dde463b7e74ef652071d3c83453ea487589d551578659` | `e097f3252ffb9feb2c3dde463b7e74ef652071d3c83453ea487589d551578659` | yes   |
| t012ab3c/fixture-01/warm | `e097f3252ffb9feb2c3dde463b7e74ef652071d3c83453ea487589d551578659` | `e097f3252ffb9feb2c3dde463b7e74ef652071d3c83453ea487589d551578659` | yes   |
| t0a1b2c3/fixture-01/cold | `dce6da1d5d1f9652a08a7f4266b3a618bda3a1bbb2bd41040043d5277db66c33` | `dce6da1d5d1f9652a08a7f4266b3a618bda3a1bbb2bd41040043d5277db66c33` | yes   |
| t0a1b2c3/fixture-01/warm | `dce6da1d5d1f9652a08a7f4266b3a618bda3a1bbb2bd41040043d5277db66c33` | `dce6da1d5d1f9652a08a7f4266b3a618bda3a1bbb2bd41040043d5277db66c33` | yes   |
| t123bc4d/fixture-01/cold | `558d8439ac25426fa3839f9385c5e08d54862240636a273617c710b705f3cce6` | `558d8439ac25426fa3839f9385c5e08d54862240636a273617c710b705f3cce6` | yes   |
| t123bc4d/fixture-01/warm | `558d8439ac25426fa3839f9385c5e08d54862240636a273617c710b705f3cce6` | `558d8439ac25426fa3839f9385c5e08d54862240636a273617c710b705f3cce6` | yes   |
| t1b2c3d4/fixture-01/cold | `a53457c79d8916fc5772dd8dc6e1d5e046fc5e00f92c8b1bb856cf26a082aadd` | `a53457c79d8916fc5772dd8dc6e1d5e046fc5e00f92c8b1bb856cf26a082aadd` | yes   |
| t1b2c3d4/fixture-01/warm | `a53457c79d8916fc5772dd8dc6e1d5e046fc5e00f92c8b1bb856cf26a082aadd` | `a53457c79d8916fc5772dd8dc6e1d5e046fc5e00f92c8b1bb856cf26a082aadd` | yes   |
| t234cd5e/fixture-01/cold | `991243fd67c389b251760b05acb3e5836c2fca0c8c89d98fa166a195bcfaeeb7` | `991243fd67c389b251760b05acb3e5836c2fca0c8c89d98fa166a195bcfaeeb7` | yes   |
| t234cd5e/fixture-01/warm | `991243fd67c389b251760b05acb3e5836c2fca0c8c89d98fa166a195bcfaeeb7` | `991243fd67c389b251760b05acb3e5836c2fca0c8c89d98fa166a195bcfaeeb7` | yes   |
| t2c3d4e5/fixture-01/cold | `6660ae19e06a592c0d8936065513a1a688d739cb8d40dd9049c1210fc8be197a` | `6660ae19e06a592c0d8936065513a1a688d739cb8d40dd9049c1210fc8be197a` | yes   |
| t2c3d4e5/fixture-01/warm | `6660ae19e06a592c0d8936065513a1a688d739cb8d40dd9049c1210fc8be197a` | `6660ae19e06a592c0d8936065513a1a688d739cb8d40dd9049c1210fc8be197a` | yes   |
| t345de6f/fixture-01/cold | `c1d9de950d39170de414528483f49e4071e88deb71e42a2c1a0306b0ca3adfca` | `c1d9de950d39170de414528483f49e4071e88deb71e42a2c1a0306b0ca3adfca` | yes   |
| t345de6f/fixture-01/warm | `c1d9de950d39170de414528483f49e4071e88deb71e42a2c1a0306b0ca3adfca` | `c1d9de950d39170de414528483f49e4071e88deb71e42a2c1a0306b0ca3adfca` | yes   |
| t3d4e5f6/fixture-01/cold | `4e82aae3f061b732f4b64e4d822f8a1621705f4d75c4022c1e75ebedc8f48555` | `4e82aae3f061b732f4b64e4d822f8a1621705f4d75c4022c1e75ebedc8f48555` | yes   |
| t3d4e5f6/fixture-01/warm | `4e82aae3f061b732f4b64e4d822f8a1621705f4d75c4022c1e75ebedc8f48555` | `4e82aae3f061b732f4b64e4d822f8a1621705f4d75c4022c1e75ebedc8f48555` | yes   |
| t456ef70/fixture-01/cold | `ee83c51b611176dd220280ee05d039c4b43ee1f91dedd271fa13d13f99eb9c41` | `ee83c51b611176dd220280ee05d039c4b43ee1f91dedd271fa13d13f99eb9c41` | yes   |
| t456ef70/fixture-01/warm | `ee83c51b611176dd220280ee05d039c4b43ee1f91dedd271fa13d13f99eb9c41` | `ee83c51b611176dd220280ee05d039c4b43ee1f91dedd271fa13d13f99eb9c41` | yes   |
| t4e5f607/fixture-01/cold | `297467759428f2291389b92d2b57ada99add875bb59abb086a2d08b7c9a38f5f` | `297467759428f2291389b92d2b57ada99add875bb59abb086a2d08b7c9a38f5f` | yes   |
| t4e5f607/fixture-01/warm | `297467759428f2291389b92d2b57ada99add875bb59abb086a2d08b7c9a38f5f` | `297467759428f2291389b92d2b57ada99add875bb59abb086a2d08b7c9a38f5f` | yes   |
| t567f081/fixture-01/cold | `aeba567741b0720315f07ea852afd4d7f75b7a41545eb807189d7c03085ed4cb` | `aeba567741b0720315f07ea852afd4d7f75b7a41545eb807189d7c03085ed4cb` | yes   |
| t567f081/fixture-01/warm | `aeba567741b0720315f07ea852afd4d7f75b7a41545eb807189d7c03085ed4cb` | `aeba567741b0720315f07ea852afd4d7f75b7a41545eb807189d7c03085ed4cb` | yes   |
| t5f60718/fixture-01/cold | `e747f7e74eba688c6994d99925e344daa9943a11d41a7ad8774899c7c1fbdd1f` | `e747f7e74eba688c6994d99925e344daa9943a11d41a7ad8774899c7c1fbdd1f` | yes   |
| t5f60718/fixture-01/warm | `e747f7e74eba688c6994d99925e344daa9943a11d41a7ad8774899c7c1fbdd1f` | `e747f7e74eba688c6994d99925e344daa9943a11d41a7ad8774899c7c1fbdd1f` | yes   |
| t6071829/fixture-01/cold | `306df8dc47ad62f04c5ab1acaaa49b47857779cfbe75799ecbbb97d173b0202f` | `306df8dc47ad62f04c5ab1acaaa49b47857779cfbe75799ecbbb97d173b0202f` | yes   |
| t6071829/fixture-01/warm | `306df8dc47ad62f04c5ab1acaaa49b47857779cfbe75799ecbbb97d173b0202f` | `306df8dc47ad62f04c5ab1acaaa49b47857779cfbe75799ecbbb97d173b0202f` | yes   |
| t6780192/fixture-01/cold | `c506dd3fe994ffb0748e10226c175623565a0e9bd99ebf2b040c295d00a48b30` | `c506dd3fe994ffb0748e10226c175623565a0e9bd99ebf2b040c295d00a48b30` | yes   |
| t6780192/fixture-01/warm | `c506dd3fe994ffb0748e10226c175623565a0e9bd99ebf2b040c295d00a48b30` | `c506dd3fe994ffb0748e10226c175623565a0e9bd99ebf2b040c295d00a48b30` | yes   |
| t718293a/fixture-01/cold | `423d5da7b698d7d936066de79c3b13563136c4dc572eae0cc1cff8003dc9db05` | `423d5da7b698d7d936066de79c3b13563136c4dc572eae0cc1cff8003dc9db05` | yes   |
| t718293a/fixture-01/warm | `423d5da7b698d7d936066de79c3b13563136c4dc572eae0cc1cff8003dc9db05` | `423d5da7b698d7d936066de79c3b13563136c4dc572eae0cc1cff8003dc9db05` | yes   |
| t7891a03/fixture-01/cold | `d480b2b3b300497817cf4808f4b792d008a6c913c426f952b72d3a1623016602` | `d480b2b3b300497817cf4808f4b792d008a6c913c426f952b72d3a1623016602` | yes   |
| t7891a03/fixture-01/warm | `d480b2b3b300497817cf4808f4b792d008a6c913c426f952b72d3a1623016602` | `d480b2b3b300497817cf4808f4b792d008a6c913c426f952b72d3a1623016602` | yes   |
| t8293a4b/fixture-01/cold | `1533e59533218158caf853ac401bcb2c7961bf71d7623d6599b8ab82bc450f48` | `1533e59533218158caf853ac401bcb2c7961bf71d7623d6599b8ab82bc450f48` | yes   |
| t8293a4b/fixture-01/warm | `1533e59533218158caf853ac401bcb2c7961bf71d7623d6599b8ab82bc450f48` | `1533e59533218158caf853ac401bcb2c7961bf71d7623d6599b8ab82bc450f48` | yes   |
| t93a4b5c/fixture-01/cold | `b57dfee854b5ddeba5297a5d98c3bc52e89c59c756c5e1f07a91ee58707ef186` | `b57dfee854b5ddeba5297a5d98c3bc52e89c59c756c5e1f07a91ee58707ef186` | yes   |
| t93a4b5c/fixture-01/warm | `b57dfee854b5ddeba5297a5d98c3bc52e89c59c756c5e1f07a91ee58707ef186` | `b57dfee854b5ddeba5297a5d98c3bc52e89c59c756c5e1f07a91ee58707ef186` | yes   |
| ta4b5c6d/fixture-01/cold | `650bd9d50a09c3f23c2183c51d544be621cfa6d79d4e9d38a8ca2dfed73418ea` | `650bd9d50a09c3f23c2183c51d544be621cfa6d79d4e9d38a8ca2dfed73418ea` | yes   |
| ta4b5c6d/fixture-01/warm | `650bd9d50a09c3f23c2183c51d544be621cfa6d79d4e9d38a8ca2dfed73418ea` | `650bd9d50a09c3f23c2183c51d544be621cfa6d79d4e9d38a8ca2dfed73418ea` | yes   |
| tb5c6d7e/fixture-01/cold | `a0d381fa72fb4cbd5040dbc727a2d982301a02af2c0e650fbfaf29c5afe529f9` | `a0d381fa72fb4cbd5040dbc727a2d982301a02af2c0e650fbfaf29c5afe529f9` | yes   |
| tb5c6d7e/fixture-01/warm | `a0d381fa72fb4cbd5040dbc727a2d982301a02af2c0e650fbfaf29c5afe529f9` | `a0d381fa72fb4cbd5040dbc727a2d982301a02af2c0e650fbfaf29c5afe529f9` | yes   |
| tc6d7e8f/fixture-01/cold | `b87208d7d773ea23efec350337b4ad78c8923812263c168fe5cfa667861ff677` | `b87208d7d773ea23efec350337b4ad78c8923812263c168fe5cfa667861ff677` | yes   |
| tc6d7e8f/fixture-01/warm | `b87208d7d773ea23efec350337b4ad78c8923812263c168fe5cfa667861ff677` | `b87208d7d773ea23efec350337b4ad78c8923812263c168fe5cfa667861ff677` | yes   |
| td7e8f90/fixture-01/cold | `c239cf854efa2997a675440a7e8e334eb358932f0f9df7143cd4074151aea2e4` | `c239cf854efa2997a675440a7e8e334eb358932f0f9df7143cd4074151aea2e4` | yes   |
| td7e8f90/fixture-01/warm | `c239cf854efa2997a675440a7e8e334eb358932f0f9df7143cd4074151aea2e4` | `c239cf854efa2997a675440a7e8e334eb358932f0f9df7143cd4074151aea2e4` | yes   |
| te8f901a/fixture-01/cold | `bf3c0ad33cc612eee1770abe17c3538912f8d5819b9351fb26704d8ec67df129` | `bf3c0ad33cc612eee1770abe17c3538912f8d5819b9351fb26704d8ec67df129` | yes   |
| te8f901a/fixture-01/warm | `bf3c0ad33cc612eee1770abe17c3538912f8d5819b9351fb26704d8ec67df129` | `bf3c0ad33cc612eee1770abe17c3538912f8d5819b9351fb26704d8ec67df129` | yes   |
| tf901a2b/fixture-01/cold | `790c1003720ef588011bd3319b944172260266b9e0870fb23a4075671a98ad0c` | `790c1003720ef588011bd3319b944172260266b9e0870fb23a4075671a98ad0c` | yes   |
| tf901a2b/fixture-01/warm | `790c1003720ef588011bd3319b944172260266b9e0870fb23a4075671a98ad0c` | `790c1003720ef588011bd3319b944172260266b9e0870fb23a4075671a98ad0c` | yes   |

## Methodology

- One pinned outer-agent schedule runs identical visible tasks and tool schemas across adapters.
- Cold and warm cohorts reuse each adapter native immutable index; warm uses one discarded readiness probe.
- Deterministic hidden-oracle scoring binds typed claims to exact source lines and hashes without an LLM judge.
- Capsule promotion compares gno-mcp and capsule only on exact paired identities and unchanged-input payload replays.
- Capsule content is the exact production gno-context-agent-v1 MCP text projection; full structuredContent remains application-only.

## Limitations

- Controlled fixtures are regression evidence, not a representative workload claim.
- Fixture-agent behavior is deterministic and narrower than a general model.
- UTF-8 bytes are the primary context measure; tokens are null without one pinned tokenizer.
- Latency is environment-specific and comparable only within a matching lifecycle.
- qmd is optional, exact-revision pinned, and non-authoritative for Capsule promotion.
- Capsule retrieval is a fixture prototype; its model-visible serializer and omission accounting are the production MCP contract.
