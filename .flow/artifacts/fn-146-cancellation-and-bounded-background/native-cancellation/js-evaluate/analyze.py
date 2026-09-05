"""CPU-only analysis; supports original raw files or compressed curated files."""
import gzip
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent


def read(name):
    path = ROOT / name
    return path.read_text() if path.exists() else gzip.decompress(path.with_name(path.name + '.gz').read_bytes()).decode()


def load(name):
    return json.loads(read(name))


data = load('result.json')
phases = [json.loads(line) for line in read('phases.jsonl').splitlines()]
events = data['events']
query = load('fixture.json')['query']


def without_timing(raw):
    result = json.loads(json.dumps(raw))
    result['meta']['explain']['lines'] = [line for line in result['meta']['explain']['lines'] if line['stage'] != 'timing']
    return result


def query_native(receipt):
    # Select actual dispatched query operations, excluding the separately
    # cancelled long operation. Never reconstruct an input or remove a field.
    rows = [row for row in receipt['nativeRequests'] if row['request']['op'] == 'embed' or row['request']['op'] == 'rerank' and row['request']['query'] == query]
    return {'inputs': [value for row in rows for value in row['capture']['modelInputs']], 'outputs': [value for row in rows for value in row['capture']['modelOutputs']]}


control = data['results'][0]
reference = control['control']['value']
native_reference = query_native(control['receipt'])
comparisons = []
for row in data['results'][1:]:
    recovery = row['recovery']
    comparisons.append({'case': row['label'], 'publicResolved': recovery['resolved'], 'fullResultsExact': recovery.get('value', {}).get('results') == reference['results'], 'fullPayloadExceptTimingExact': recovery['resolved'] and without_timing(recovery['value']) == without_timing(reference), 'actualNativeQueryInputsOutputsExact': query_native(row['receipt']) == native_reference, 'vectorsUsed': recovery.get('value', {}).get('meta', {}).get('vectorsUsed'), 'reranked': recovery.get('value', {}).get('meta', {}).get('reranked')})

cancellation = []
for label in ['queued', 'active-rerank', 'active-generate']:
    abort = next(event for event in events if event['kind'] == 'abort' and event['label'] == label)
    caller = next(event for event in events if event['kind'] in ['caller-settled', 'caller-rejected'] and event['label'] == ('queued-cancelled' if label == 'queued' else label))
    request_id = abort['state']['pending'][-1]['requestId']
    ends = [row for row in phases if row['event']['kind'] == 'request-end' and row['event']['request']['requestId'] == request_id]
    iterator_ends = [row for row in phases if row['event']['kind'] in ['evaluation-end', 'evaluation-error'] and row['event'].get('evaluationId') == abort.get('phase', {}).get('event', {}).get('evaluationId') and row['event'].get('id') == abort.get('phase', {}).get('event', {}).get('id')]
    until = ends[0]['at'] if ends else caller['at']
    states = [event['state'] for event in events if event['kind'] == 'ownership' and abort['at'] <= event['at'] <= until + 10]
    cancellation.append({'case': label, 'exercised': abort['exercised'], 'requestId': request_id, 'callerLatencyMs': caller['at'] - abort['at'], 'callerState': caller['state'], 'nativeDispatcherSettlementAfterAbortMs': ends[0]['at'] - abort['at'] if ends else None, 'evaluationSettledAfterAbortMs': iterator_ends[0]['at'] - abort['at'] if iterator_ends else None, 'queuedRequestReachedChild': bool(ends) if label == 'queued' else None, 'externalWaiterPeakObserved': max([state.get('externalWaiters', 0) for state in states], default=0), 'callerDeliveryEvents': sum(event['kind'] in ['caller-settled', 'caller-rejected'] and event.get('label') == caller['label'] for event in events), 'cancelledResult': caller.get('value')})

queued = next(row for row in data['results'] if row['label'] == 'queued')
output = {'status': 'bounded-native-cancellation-exercised', 'comparisons': comparisons, 'cancellation': cancellation, 'queuedPrimaryExactHistorical': queued['primary']['value'] == load('long-reference.json')['rows'][0]['result'], 'preAbortedNoRequestIdAdvance': data['results'][1]['beforeId'] == data['results'][1]['afterId'], 'allScopesDrained': all(row['didDrain'] for row in data['results']), 'postRun': load('post-run.json')}
(ROOT / 'analysis.reproduced.json').write_text(json.dumps(output, indent=2) + '\n')
assert output == load('analysis.json'), 'Derived analysis differs from original'
print(json.dumps({'exactReproduction': True, 'recoveryComparisons': len(comparisons), 'allRecoveryFieldsTrue': all(all(value is True for key, value in row.items() if key != 'case') for row in comparisons)}))
