# Fresh final GNO skill evaluation

Result: **46/47 checks, 19/20 scenarios, 97.9%** under the unchanged evaluator. One retained failure: check_status / uses_status. The fresh final response was:

```bash
gno peek --json
```

The original check did not accept that command. The prior47/47 run remains a distinct historical observation; it was not replayed as new generation. No retries, coaching, expected-check feedback, skill changes, evaluator changes, or execution of generated commands occurred.

## Exact stratum and identities

- Model: gpt-6-astra; reasoning medium;20 fresh native default agents with fork_turns none, at most4 active concurrently.
- Each agent was instructed only to read its own exact prompt file and return command blocks without executing commands or reading other files. Its file contains the original SYSTEM_PROMPT, original scenario text and complete current repository skill. Native system/developer harness instructions and tools remain present, so this is the same declared native-Astra transport as fn148's prior run, not standard Haiku/Anthropic transport.
- Skill snapshot: assets/skill/SKILL.md SHA25678d946003b7ab9ea306aead6784b316b9b6cbbd2572d41f4283a1645b1f4bf3a. It still matched at scoring.
- Original evaluator: /home/gordon/work/autoresearch-experiments/gno-skill/eval.py SHA256a1f30d1be734e9aee46a4e868b57a691882acb6df48ebcf2d72b8c4b252a35da. No harness/scenario/check/threshold edit.
- All20 prompt files are byte-identical to the original run because both skill and evaluator hashes are unchanged. Responses are newly generated native final messages, transcribed verbatim with a terminal newline.
- Agent identities, generation window and per-response hashes are retained in metadata.json, generation-ledger.json and results.json.

## Scoring and evidence

replay.py imports the unchanged evaluator, verifies its hash, points SKILL_FILE at the snapshot and replaces only call_llm with these newly captured responses. It asserts exact full prompt equality on every original main() invocation, then scores the same outputs with original run_checks(). Original command-parser selftests pass. The harness main() exits0 even with a failed check; process success is not a100% score.

Command: python3 .flow/artifacts/fn-146-cancellation-and-bounded-background/final-skill-eval/replay.py

score.stdout.log preserves aggregate97.9 /46 /47; score.stderr.log preserves every original per-check result. 00–19.prompt.txt and00–19.response.txt retain all inputs and outputs. SHA256SUMS.json covers all other artifacts. No original fn148 skill-eval artifact changed.

## Limits

This is command-generation screening of the existing20 scenarios, mostly regex checks. It does not exercise CLI/MCP cancellation, prove generated command execution, or establish new native/background/shutdown correctness. The lone failure remains a measured regression in this fresh response set, not a demonstrated product regression or a statistical estimate of model reliability. No100% or final2.0 acceptance claim. A later skill hash change requires a fresh evaluation for that snapshot.
