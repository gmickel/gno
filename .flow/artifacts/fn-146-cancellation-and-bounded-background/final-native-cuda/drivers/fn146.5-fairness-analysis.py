"""Analyze actual synchronous dispatch/ACK receipts; never infer fairness from sample timing."""
import hashlib
import json
import pathlib
import sys

root, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
rows = [json.loads(line) for line in (root / 'launch-1/owner.jsonl').read_text().splitlines()]
before, last_ack = None, None
dispatch = []
for index, row in enumerate(rows):
    value = row['value']
    if value['kind'] == 'native-ack-send-after':
        last_ack = {'eventIndex': index, 'requestId': value['ack'], 'at': row['at']}
    if value.get('method') == 'sendNext' and value['kind'] == 'native-transition-before':
        before = (index, row['at'], value['owner'])
    if value.get('method') == 'sendNext' and value['kind'] == 'native-transition-after' and before:
        event_index, at, prior = before
        owner = value['owner']
        chosen = [pending for pending in owner['pending'] if pending['ownsNative']]
        if not prior['busy'] and owner['busy'] and chosen:
            dispatch.append({'eventIndex': event_index, 'at': at, 'credit': prior['foregroundCompletions'],
                'queuedBackground': any(p['background'] for p in prior['pending']),
                'queuedForeground': any(p['background'] is False and p['op'] not in ['init', 'dispose'] for p in prior['pending']),
                'selected': chosen[0], 'queueDepth': len(prior['pending']), 'previousAck': last_ack})
        before = None
earned = [row for row in dispatch if row['credit'] >= 8 and row['queuedBackground']]
starts = [json.loads(line) for line in (root / 'launch-1/phases.jsonl').read_text().splitlines()]
batches = []
for row in starts:
    event = row['event']
    if event['kind'] == 'request-start' and event.get('request', {}).get('op') == 'embedBatch':
        request = event['request']
        batches.append({'pid': row['pid'], 'generation': request['generation'], 'requestId': request['requestId'],
            'chunks': len(request['texts']), 'inputSha256': [hashlib.sha256(text.encode()).hexdigest() for text in request['texts']]})
responses = json.loads((root / 'result.json').read_text())['exactResponseComparisons']
summary = {'root': str(root), 'foregroundResponses': responses, 'allTwelveResponsesExact': len(responses) == 12 and all(row['passed'] for row in responses),
    'dispatches': dispatch, 'earnedDebtCases': earned,
    'eightCompletionGate': bool(earned) and all(row['selected']['background'] for row in earned),
    'debtCasesWithCompetingForeground': sum(row['queuedForeground'] for row in earned),
    'actualAckBeforeEarnedDispatch': bool(earned) and all(row['previousAck'] and row['previousAck']['eventIndex'] < row['eventIndex'] for row in earned),
    'maxObservedQueue': max(row['queueDepth'] for row in dispatch), 'backgroundBatches': batches,
    'allNativeBatchesAtMost32': bool(batches) and all(row['chunks'] <= 32 for row in batches),
    'totalBatchChunks': sum(row['chunks'] for row in batches),
    'release': json.loads((root / 'fairness-shutdown-phase-release.json').read_text())}
output.write_text(json.dumps(summary, indent=2))
print(json.dumps({key: summary[key] for key in ['allTwelveResponsesExact', 'eightCompletionGate', 'debtCasesWithCompetingForeground', 'actualAckBeforeEarnedDispatch', 'maxObservedQueue', 'allNativeBatchesAtMost32', 'totalBatchChunks']}))
