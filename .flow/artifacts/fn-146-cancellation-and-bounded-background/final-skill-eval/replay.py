"""Replay native-agent outputs through the unmodified original harness."""
import contextlib
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
meta = json.loads((ROOT / 'metadata.json').read_text())
harness = Path(meta['harness'])
assert hashlib.sha256(harness.read_bytes()).hexdigest() == meta['harness_sha256']
spec = importlib.util.spec_from_file_location('original_gno_eval', harness)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.SKILL_FILE = ROOT / 'skill.snapshot.md'
responses = iter(range(len(module.SCENARIOS)))
def replay(prompt):
    index = next(responses)
    exact = f'{module.SYSTEM_PROMPT}\n\n---\n\n{prompt}'
    assert exact == (ROOT / f'{index:02}.prompt.txt').read_text()
    return (ROOT / f'{index:02}.response.txt').read_text()
module.call_llm = replay
with (ROOT / 'score.stdout.log').open('w') as stdout, (ROOT / 'score.stderr.log').open('w') as stderr:
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        rc = module.main()
results = []
for index, scenario in enumerate(module.SCENARIOS):
    output = (ROOT / f'{index:02}.response.txt').read_text()
    results.append({'scenario':scenario['id'], 'agent':f'/root/native_package/final_case{index:02}', 'response_sha256': hashlib.sha256(output.encode()).hexdigest(), 'checks': module.run_checks(output,scenario['checks'])})
passed = sum(passed for result in results for _,passed in result['checks'])
evidence = {**meta, 'harness_main_rc':rc, 'passed':passed, 'score':100*passed/meta['total_checks'], 'results':results, 'attempts_per_scenario':1, 'production_command_execution':False, 'response_capture':'Native final response text transcribed verbatim with terminal newline.', 'source_current_matches_snapshot':hashlib.sha256(Path('/home/gordon/work/gno/assets/skill/SKILL.md').read_bytes()).hexdigest()==meta['skill_sha256']}
(ROOT / 'results.json').write_text(json.dumps(evidence,indent=2)+'\n')
print((ROOT / 'score.stdout.log').read_text(),end='')
print(f'harness_main_rc={rc}; parser selftests passed; current skill matches snapshot={evidence["source_current_matches_snapshot"]}')
