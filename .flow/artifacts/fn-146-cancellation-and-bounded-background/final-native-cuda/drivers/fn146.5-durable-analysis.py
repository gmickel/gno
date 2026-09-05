"""Separate physically committed shadow rows from active retrieval eligibility."""
import json
import pathlib
import sys
import re
from collections import Counter

root, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
def table(stage, name):
    return next(row['rows'] for row in json.loads((root / f'{stage}.json').read_text())['tables'] if row['name'] == name)

documents = table('after-shutdown', 'documents')
background = {row['id'] for row in documents if row['collection'] == 'qa-background' and row['active']}
before = table('after-shutdown', 'vector_owners')
after = table('after-resume', 'vector_owners')
after_set = {json.dumps(row, sort_keys=True) for row in after}
physical = [row for row in before if row['document_id'] in background]
coverage = json.loads((root / 'after-shutdown-coverage.json').read_text())
key = lambda row: (row.get('id', row.get('document_id')), row['seq'], row['mirror_hash'])
physical_keys = {key(row) for row in physical}
missing_physical = [row for row in coverage['expected'] if key(row) not in physical_keys]
doc_by_id = {row['id']: row for row in documents}
expected_paths = [doc_by_id[row['id']]['rel_path'] for row in missing_physical]
resumed_paths = []
def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)

for path in (root / 'launch-2/capture').glob('native-*/*-*.json'):
    receipt = json.loads(path.read_text())
    if receipt['request']['op'] not in ['embed', 'embedBatch']:
        continue
    for item in receipt['capture']['modelInputs']:
        for text in strings(item['input']):
            ids = set(re.findall(r'Synthetic (?:background|shutdown) record (\d+)', text))
            resumed_paths.extend(f'record-{record_id}.md' for record_id in ids)
result = {'root': str(root), 'activeEligibleMissingAfterExit': len(coverage['missing']),
    'physicallyCommittedBackgroundOwnersAfterExit': len(physical), 'physicallyMissingBackgroundChunksAfterExit': missing_physical,
    'allCommittedOwnerRowsExactlyRetainedAfterResume': all(json.dumps(row, sort_keys=True) in after_set for row in before),
    'legacyVectorsUnchanged': table('before-shutdown', 'content_vectors') == table('after-resume', 'content_vectors'),
    'partitionsAfterExit': table('after-shutdown', 'vector_partitions'),
    'resumeActualBackgroundInputPaths': resumed_paths,
    'resumeInputsExactlyMissingOnce': Counter(resumed_paths) == Counter(expected_paths),
    'resumeMissingExpectedPaths': expected_paths,
    'finalCoverage': json.loads((root / 'after-resume-coverage.json').read_text()),
    'interpretation': 'Shadow-owner persistence is physical completed work. A shadow partition makes all its chunks ineligible; active-eligibility missing count is not the physical unembedded count.'}
output.write_text(json.dumps(result, indent=2))
print(json.dumps({key: value for key, value in result.items() if key not in ['finalCoverage', 'partitionsAfterExit', 'physicallyMissingBackgroundChunksAfterExit']}, indent=2))
