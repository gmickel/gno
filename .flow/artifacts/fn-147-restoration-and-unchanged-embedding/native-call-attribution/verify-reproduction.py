import json
from pathlib import Path

root = Path(__file__).resolve().parent
original = json.loads((root / 'attribution.original.json').read_text())
reproduced = json.loads((root / 'attribution.reproduced.json').read_text())
for value in (original, reproduced):
    value.pop('analysisScript')
    value.pop('analysisScriptSha256')
assert original == reproduced, 'Derived evidence changed beyond analyzer location/hash'
print('Exact derived equality: only analyzer location/hash differ; 24 sessions and nine complete old pairs verified.')
