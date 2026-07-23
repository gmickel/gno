# Agentic Retrieval Benchmark — fixture-agent-v1

Canonical fingerprint: `e3b02d8776ca32c9f7352ee2172c79e56469cc7ad5b4894467de55239240b489`
Fixture: `2026-07-22.1` / `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`
Adapters: `capsule`, `gno-mcp`, `lexical`
Attempted/scored/successful: 144/144/138
Excluded: 0

## Capsule promotion

Verdict: **PASS**
Pairs: 48
Baseline/Capsule success: 0.9583333333333334 / 1
Agent-call reduction: 0.4893617021276596
Context-byte reduction: 0.4412024014442252
Claim linkage: 1
Unsupported substantive claims (baseline/Capsule): 2 / 0
Unsupported substantive-claim reduction: 1
Failures: none

## Adapter-native indexes

- `capsule`: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a` (corpus `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`, preparation 504.003 ms)
- `gno-mcp`: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a` (corpus `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`, preparation 4279.926 ms)
- `lexical`: `9c4a65f08850a70ff6d2ec6fe069b4cd38c9cbf3481583afd76a74264cf0591a` (corpus `68027bb0248c09507dbdba9d8cf2433f1b9b7b547ba5db8811db338982f9d08b`, preparation 45.294 ms)

## Cohort accounting

| Adapter | Lifecycle | Attempted | Scored | Success | Excluded | agentCalls | backendInvocations | Model-visible bytes |
| ------- | --------- | --------: | -----: | ------: | -------: | ---------: | -----------------: | ------------------: |
| capsule | cold      |        24 |     24 |      24 |        0 |         24 |                246 |               26620 |
| capsule | warm      |        24 |     24 |      24 |        0 |         24 |                246 |               26620 |
| gno-mcp | cold      |        24 |     24 |      23 |        0 |         47 |                 95 |               47638 |
| gno-mcp | warm      |        24 |     24 |      23 |        0 |         47 |                 95 |               47638 |
| lexical | cold      |        24 |     24 |      22 |        0 |         47 |                 76 |               49947 |
| lexical | warm      |        24 |     24 |      22 |        0 |         47 |                 76 |               49947 |

## Lifecycle timings

Measured totals and explicit unavailable counts/reasons; milliseconds.

| Adapter/lifecycle | Startup                                                  | Model load                                                         | Tool                  | Driver            | End-to-end            |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------ | --------------------- | ----------------- | --------------------- |
| capsule/cold      | 12.624 ms / null 0                                       | 0.000 ms / null 24 (one or more model-load components unavailable) | 35.287 ms / null 0    | 1.752 ms / null 0 | 64.602 ms / null 0    |
| capsule/warm      | 0.000 ms / null 24 (completed before scored warm cohort) | 0.000 ms / null 24 (completed before scored warm cohort)           | 16.069 ms / null 0    | 0.826 ms / null 0 | 19.818 ms / null 0    |
| gno-mcp/cold      | 2796.249 ms / null 0                                     | 0.000 ms / null 24 (one or more model-load components unavailable) | 29599.237 ms / null 0 | 3.443 ms / null 0 | 32536.343 ms / null 0 |
| gno-mcp/warm      | 0.000 ms / null 24 (completed before scored warm cohort) | 0.000 ms / null 24 (completed before scored warm cohort)           | 16043.489 ms / null 0 | 2.775 ms / null 0 | 16055.243 ms / null 0 |
| lexical/cold      | 9.271 ms / null 0                                        | 0.000 ms / null 24 (one or more model-load components unavailable) | 8.632 ms / null 0     | 0.838 ms / null 0 | 24.529 ms / null 0    |
| lexical/warm      | 0.000 ms / null 24 (completed before scored warm cohort) | 0.000 ms / null 24 (completed before scored warm cohort)           | 3.768 ms / null 0     | 0.472 ms / null 0 | 6.613 ms / null 0     |

## Capsule replay hashes

| Task/trial/lifecycle     | First SHA-256                                                      | Replay SHA-256                                                     | Equal |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ----- |
| t012ab3c/fixture-01/cold | `64517a98c4e118fd402e282b4c86c82df28baa969c227781c3746c933bc0f57e` | `64517a98c4e118fd402e282b4c86c82df28baa969c227781c3746c933bc0f57e` | yes   |
| t012ab3c/fixture-01/warm | `64517a98c4e118fd402e282b4c86c82df28baa969c227781c3746c933bc0f57e` | `64517a98c4e118fd402e282b4c86c82df28baa969c227781c3746c933bc0f57e` | yes   |
| t0a1b2c3/fixture-01/cold | `18ca2241875c88ea40cac35c587b5501f1e1b78d105c9e6eb7d5093b69995045` | `18ca2241875c88ea40cac35c587b5501f1e1b78d105c9e6eb7d5093b69995045` | yes   |
| t0a1b2c3/fixture-01/warm | `18ca2241875c88ea40cac35c587b5501f1e1b78d105c9e6eb7d5093b69995045` | `18ca2241875c88ea40cac35c587b5501f1e1b78d105c9e6eb7d5093b69995045` | yes   |
| t123bc4d/fixture-01/cold | `a4f90fdaed1f6e6f57aa31a980b602b2f11e426f8cc9c761d9d19e68aca1af58` | `a4f90fdaed1f6e6f57aa31a980b602b2f11e426f8cc9c761d9d19e68aca1af58` | yes   |
| t123bc4d/fixture-01/warm | `a4f90fdaed1f6e6f57aa31a980b602b2f11e426f8cc9c761d9d19e68aca1af58` | `a4f90fdaed1f6e6f57aa31a980b602b2f11e426f8cc9c761d9d19e68aca1af58` | yes   |
| t1b2c3d4/fixture-01/cold | `8dc33c8a6b3318e735786d859acc2fc13f831815cb239adb9ba77b26733edfa5` | `8dc33c8a6b3318e735786d859acc2fc13f831815cb239adb9ba77b26733edfa5` | yes   |
| t1b2c3d4/fixture-01/warm | `8dc33c8a6b3318e735786d859acc2fc13f831815cb239adb9ba77b26733edfa5` | `8dc33c8a6b3318e735786d859acc2fc13f831815cb239adb9ba77b26733edfa5` | yes   |
| t234cd5e/fixture-01/cold | `719aaa68d262901e4b11c5c59b2ba242090929725e0363818a65ab912b23c0b2` | `719aaa68d262901e4b11c5c59b2ba242090929725e0363818a65ab912b23c0b2` | yes   |
| t234cd5e/fixture-01/warm | `719aaa68d262901e4b11c5c59b2ba242090929725e0363818a65ab912b23c0b2` | `719aaa68d262901e4b11c5c59b2ba242090929725e0363818a65ab912b23c0b2` | yes   |
| t2c3d4e5/fixture-01/cold | `75f8b11dc465ce0ed91f5ac168f7252ee3d1da6636af1dfc8b5f6f929113d0ad` | `75f8b11dc465ce0ed91f5ac168f7252ee3d1da6636af1dfc8b5f6f929113d0ad` | yes   |
| t2c3d4e5/fixture-01/warm | `75f8b11dc465ce0ed91f5ac168f7252ee3d1da6636af1dfc8b5f6f929113d0ad` | `75f8b11dc465ce0ed91f5ac168f7252ee3d1da6636af1dfc8b5f6f929113d0ad` | yes   |
| t345de6f/fixture-01/cold | `cb901d762913323d882545dac3478b81060cfd84f5bdfe6c496114ab637452f5` | `cb901d762913323d882545dac3478b81060cfd84f5bdfe6c496114ab637452f5` | yes   |
| t345de6f/fixture-01/warm | `cb901d762913323d882545dac3478b81060cfd84f5bdfe6c496114ab637452f5` | `cb901d762913323d882545dac3478b81060cfd84f5bdfe6c496114ab637452f5` | yes   |
| t3d4e5f6/fixture-01/cold | `e83b9e874f30a36cf709b1f068b246ce518ac332d5bb2e737edc26e72d1a9d7f` | `e83b9e874f30a36cf709b1f068b246ce518ac332d5bb2e737edc26e72d1a9d7f` | yes   |
| t3d4e5f6/fixture-01/warm | `e83b9e874f30a36cf709b1f068b246ce518ac332d5bb2e737edc26e72d1a9d7f` | `e83b9e874f30a36cf709b1f068b246ce518ac332d5bb2e737edc26e72d1a9d7f` | yes   |
| t456ef70/fixture-01/cold | `0eb4bf0515cc7fb14c6bb99295f19d719e63ef38cc80c8976b9bf99eb7a2a9e1` | `0eb4bf0515cc7fb14c6bb99295f19d719e63ef38cc80c8976b9bf99eb7a2a9e1` | yes   |
| t456ef70/fixture-01/warm | `0eb4bf0515cc7fb14c6bb99295f19d719e63ef38cc80c8976b9bf99eb7a2a9e1` | `0eb4bf0515cc7fb14c6bb99295f19d719e63ef38cc80c8976b9bf99eb7a2a9e1` | yes   |
| t4e5f607/fixture-01/cold | `bdda9838f0bf16c134d4ec8bbd1204419182a177424d4860c123066da682d9cd` | `bdda9838f0bf16c134d4ec8bbd1204419182a177424d4860c123066da682d9cd` | yes   |
| t4e5f607/fixture-01/warm | `bdda9838f0bf16c134d4ec8bbd1204419182a177424d4860c123066da682d9cd` | `bdda9838f0bf16c134d4ec8bbd1204419182a177424d4860c123066da682d9cd` | yes   |
| t567f081/fixture-01/cold | `0eff8ea44674693b9aba08641de23dc6015453fe1fec3c7f310b4b5f4c68d852` | `0eff8ea44674693b9aba08641de23dc6015453fe1fec3c7f310b4b5f4c68d852` | yes   |
| t567f081/fixture-01/warm | `0eff8ea44674693b9aba08641de23dc6015453fe1fec3c7f310b4b5f4c68d852` | `0eff8ea44674693b9aba08641de23dc6015453fe1fec3c7f310b4b5f4c68d852` | yes   |
| t5f60718/fixture-01/cold | `ad40b1abdea6a69e39d17f8bcb31a67a5382b2e846a179194c839d87b2ef0563` | `ad40b1abdea6a69e39d17f8bcb31a67a5382b2e846a179194c839d87b2ef0563` | yes   |
| t5f60718/fixture-01/warm | `ad40b1abdea6a69e39d17f8bcb31a67a5382b2e846a179194c839d87b2ef0563` | `ad40b1abdea6a69e39d17f8bcb31a67a5382b2e846a179194c839d87b2ef0563` | yes   |
| t6071829/fixture-01/cold | `62e207d015af3aecd2d0c206e02e0ca1a3ddece4e5c5e01924874f605e513c3e` | `62e207d015af3aecd2d0c206e02e0ca1a3ddece4e5c5e01924874f605e513c3e` | yes   |
| t6071829/fixture-01/warm | `62e207d015af3aecd2d0c206e02e0ca1a3ddece4e5c5e01924874f605e513c3e` | `62e207d015af3aecd2d0c206e02e0ca1a3ddece4e5c5e01924874f605e513c3e` | yes   |
| t6780192/fixture-01/cold | `6b17efafd7764dd2504a819b0abd0f235089869972b02fc190d8a3b8a766cda6` | `6b17efafd7764dd2504a819b0abd0f235089869972b02fc190d8a3b8a766cda6` | yes   |
| t6780192/fixture-01/warm | `6b17efafd7764dd2504a819b0abd0f235089869972b02fc190d8a3b8a766cda6` | `6b17efafd7764dd2504a819b0abd0f235089869972b02fc190d8a3b8a766cda6` | yes   |
| t718293a/fixture-01/cold | `c565bf3835bd88cfdbbec0fad8f135d30f92750051a58977a739341297363418` | `c565bf3835bd88cfdbbec0fad8f135d30f92750051a58977a739341297363418` | yes   |
| t718293a/fixture-01/warm | `c565bf3835bd88cfdbbec0fad8f135d30f92750051a58977a739341297363418` | `c565bf3835bd88cfdbbec0fad8f135d30f92750051a58977a739341297363418` | yes   |
| t7891a03/fixture-01/cold | `e189fe94ad57e495605ce89fee1df419cd61c57f070c1d54a494e568afa44358` | `e189fe94ad57e495605ce89fee1df419cd61c57f070c1d54a494e568afa44358` | yes   |
| t7891a03/fixture-01/warm | `e189fe94ad57e495605ce89fee1df419cd61c57f070c1d54a494e568afa44358` | `e189fe94ad57e495605ce89fee1df419cd61c57f070c1d54a494e568afa44358` | yes   |
| t8293a4b/fixture-01/cold | `555dd2e11bff1fdc8343cc1b24a3e84f5c963d194b1a4be73d9193aaef7d97c4` | `555dd2e11bff1fdc8343cc1b24a3e84f5c963d194b1a4be73d9193aaef7d97c4` | yes   |
| t8293a4b/fixture-01/warm | `555dd2e11bff1fdc8343cc1b24a3e84f5c963d194b1a4be73d9193aaef7d97c4` | `555dd2e11bff1fdc8343cc1b24a3e84f5c963d194b1a4be73d9193aaef7d97c4` | yes   |
| t93a4b5c/fixture-01/cold | `51bf38b0a3eabb0874c58ec032f2a3e564b49d72048b28842fd7790534b61306` | `51bf38b0a3eabb0874c58ec032f2a3e564b49d72048b28842fd7790534b61306` | yes   |
| t93a4b5c/fixture-01/warm | `51bf38b0a3eabb0874c58ec032f2a3e564b49d72048b28842fd7790534b61306` | `51bf38b0a3eabb0874c58ec032f2a3e564b49d72048b28842fd7790534b61306` | yes   |
| ta4b5c6d/fixture-01/cold | `167dd71fb092a75054ef1cfe5c76e059c183117c625a3b5272874f76ab01abda` | `167dd71fb092a75054ef1cfe5c76e059c183117c625a3b5272874f76ab01abda` | yes   |
| ta4b5c6d/fixture-01/warm | `167dd71fb092a75054ef1cfe5c76e059c183117c625a3b5272874f76ab01abda` | `167dd71fb092a75054ef1cfe5c76e059c183117c625a3b5272874f76ab01abda` | yes   |
| tb5c6d7e/fixture-01/cold | `8802e088a27969f918351db386ffd16488a5784115a85c397c3c673292e9fb7c` | `8802e088a27969f918351db386ffd16488a5784115a85c397c3c673292e9fb7c` | yes   |
| tb5c6d7e/fixture-01/warm | `8802e088a27969f918351db386ffd16488a5784115a85c397c3c673292e9fb7c` | `8802e088a27969f918351db386ffd16488a5784115a85c397c3c673292e9fb7c` | yes   |
| tc6d7e8f/fixture-01/cold | `87a58123612b17946beabfbd3cee1668369244b877d35b50194c521ec61b57cf` | `87a58123612b17946beabfbd3cee1668369244b877d35b50194c521ec61b57cf` | yes   |
| tc6d7e8f/fixture-01/warm | `87a58123612b17946beabfbd3cee1668369244b877d35b50194c521ec61b57cf` | `87a58123612b17946beabfbd3cee1668369244b877d35b50194c521ec61b57cf` | yes   |
| td7e8f90/fixture-01/cold | `490ccc4a40d7107eb561654fd2d2578f384861292aedab99f72501ead9ba7b1c` | `490ccc4a40d7107eb561654fd2d2578f384861292aedab99f72501ead9ba7b1c` | yes   |
| td7e8f90/fixture-01/warm | `490ccc4a40d7107eb561654fd2d2578f384861292aedab99f72501ead9ba7b1c` | `490ccc4a40d7107eb561654fd2d2578f384861292aedab99f72501ead9ba7b1c` | yes   |
| te8f901a/fixture-01/cold | `49cb29eba9a505a7e0584c8e93304ea149cbf49b79e7e1bca2e5cf5193b9819d` | `49cb29eba9a505a7e0584c8e93304ea149cbf49b79e7e1bca2e5cf5193b9819d` | yes   |
| te8f901a/fixture-01/warm | `49cb29eba9a505a7e0584c8e93304ea149cbf49b79e7e1bca2e5cf5193b9819d` | `49cb29eba9a505a7e0584c8e93304ea149cbf49b79e7e1bca2e5cf5193b9819d` | yes   |
| tf901a2b/fixture-01/cold | `478b271e9e9fd962c9c2bc0957ffbb15314d178af767ee9210718733dd56f626` | `478b271e9e9fd962c9c2bc0957ffbb15314d178af767ee9210718733dd56f626` | yes   |
| tf901a2b/fixture-01/warm | `478b271e9e9fd962c9c2bc0957ffbb15314d178af767ee9210718733dd56f626` | `478b271e9e9fd962c9c2bc0957ffbb15314d178af767ee9210718733dd56f626` | yes   |

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
