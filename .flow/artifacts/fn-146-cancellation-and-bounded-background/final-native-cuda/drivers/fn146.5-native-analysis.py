"""Read-only actual child receipt comparison. No inference, mutations, or normalized model inputs."""
import gzip
import hashlib
import json
import io
import pathlib
import sys

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/home/gordon/.cache/agent-tmp/fn1465-surfaces-1788594094769')
prefix = sys.argv[2] if len(sys.argv) > 2 else 'notes/fn146.5-cuda'
fixture_path = pathlib.Path(sys.argv[3]) if len(sys.argv) > 3 else pathlib.Path(json.loads((root / 'run.json').read_text())['spec']['fixturePath'])
model_pins = {row['id']: row['sha256'] for row in json.loads(fixture_path.read_text())['models']}
launch = root / 'launch-1'
load = lambda p: json.loads(pathlib.Path(p).read_text())
phases = [json.loads(line) for line in (launch / 'phases.jsonl').read_text().splitlines()]
owners = [json.loads(line) for line in (launch / 'owner.jsonl').read_text().splitlines()]
classes = {}
dispatch = []
for row in owners:
    value = row['value']
    owner = value.get('owner', {})
    for item in owner.get('pending', []):
        if isinstance(item.get('background'), bool):
            classes[(owner['generation'], item['requestId'])] = item['background']
    if value.get('kind') == 'native-transition-before' and value.get('method') == 'sendNext':
        if not owner.get('busy') and owner.get('pending'):
            dispatch.append({'at': row['at'], 'owner': owner})

receipts = {}
for path in (launch / 'capture').glob('native-*/*-*.json'):
    row = load(path)
    identity, request = row['identity'], row['request']
    receipts[(identity['pid'], request['generation'], request['requestId'])] = (path, row)

def selected(name):
    public = load(launch / f'{name}.json')
    selected_rows = []
    for event in phases:
        request = event['event'].get('request', {})
        if event['event']['kind'] != 'request-start' or not public['start'] <= event['at'] <= public['settled']:
            continue
        key = (event['pid'], request['generation'], request['requestId'])
        if classes.get(key[1:]) is not False:
            continue
        path, row = receipts[key]
        capture = row['capture']
        if request['op'] == 'init':
            continue
        selected_rows.append({'identity': key, 'receipt': str(path), 'complete': row['complete'], 'at': event['at'],
            'selectedModelPinsValid': all(any(model['id'] == item['modelId'] and model['sha256'] == model_pins.get(item['modelId']) for model in capture['models']) for item in capture['modelInputs']),
            'payload': {k: capture[k] for k in ['modelInputs', 'modelOutputs', 'models', 'backends', 'errors']},
            'op': request['op'], 'modelId': request['modelId'], 'contextEvents': capture.get('contextEvents', [])})
    return {'publicWindow': [public['start'], public['settled']], 'requests': selected_rows}

comparisons = {}
for kind in ['query', 'ask']:
    left, right = selected(f'idle-{kind}'), selected(f'background-{kind}')
    payload = lambda x: [{k: r[k] for k in ['payload', 'op', 'modelId']} for r in x['requests']]
    comparisons[kind] = {'baseline': left, 'background': right,
        'actualNativePayloadExact': bool(left['requests']) and payload(left) == payload(right),
        'actualModelInputsOutputsExact': bool(left['requests']) and len(left['requests']) == len(right['requests']) and all(all(a['payload'][field] == b['payload'][field] for field in ['modelInputs', 'modelOutputs', 'backends', 'errors']) and a['op'] == b['op'] and a['modelId'] == b['modelId'] for a, b in zip(left['requests'], right['requests'])),
        'complete': all(r['complete'] for r in left['requests'] + right['requests']),
        'selectedModelPinsValid': all(r['selectedModelPinsValid'] for r in left['requests'] + right['requests']),
        'roleCounts': {side: [r['op'] for r in value['requests']] for side, value in [('idle', left), ('background', right)]}}

batches = []
for key, (path, row) in receipts.items():
    if row['request']['op'] == 'embedBatch':
        starts = [p for p in phases if p['event']['kind'] == 'request-start' and p['pid'] == key[0] and p['event'].get('request', {}).get('requestId') == key[2]]
        batches.append({'identity': key, 'background': classes.get(key[1:]), 'chunks': len(starts[0]['event']['request']['texts']) if starts else None, 'receipt': str(path)})

summary = {'source': str(root), 'nativeEvidence': 'Actual child request-start and validated canonical child receipts; foreground class observed on parent pending transitions, not inferred from timing alone',
    'comparisons': {k: {field: value[field] for field in ['actualNativePayloadExact', 'actualModelInputsOutputsExact', 'selectedModelPinsValid', 'complete', 'roleCounts']} for k, value in comparisons.items()},
    'backgroundBatches': batches, 'batchCap32': bool(batches) and all(b['chunks'] is not None and b['chunks'] <= 32 for b in batches),
    'dispatches': dispatch, 'eightCompletionFairness': 'Unexercised unless an actual pending background request survives eight foreground completions; this one foreground query+Ask pair does not establish that condition.',
    'projections': 'Request IDs, PID and public times correlate receipts. actualNativePayloadExact also compares accumulated model-load inventories and is false because cold/warm load inventories differ. actualModelInputsOutputsExact compares every unmodified actual model input/output/backend/error plus operation/modelId. Full model-load inventories and context events remain retained, not harmonized or dropped.'}
out = pathlib.Path(prefix + '-native-inputs.json.gz')
with out.open('wb') as raw_output, gzip.GzipFile(filename='', mode='wb', fileobj=raw_output, mtime=0) as compressed, io.TextIOWrapper(compressed) as f:
    json.dump({'summary': summary, 'comparisons': comparisons}, f)
pathlib.Path(prefix + '-native-summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps({'comparisons': summary['comparisons'], 'batchCap32': summary['batchCap32'], 'batches': len(batches), 'raw': str(out)}))
