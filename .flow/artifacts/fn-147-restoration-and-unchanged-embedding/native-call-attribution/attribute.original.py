import collections
import hashlib
import json
import pathlib
import struct

repo = pathlib.Path('/home/gordon/work/gno')
root = repo / 'notes/fn144-native-artifacts/cuda-3d9c0ec4'
evidence = root / 'evidence'
old = pathlib.Path('/home/gordon/.cache/agent-tmp/gno-fn147-nativeqa/evidence')
load = lambda path: json.loads(path.read_text())
sha = lambda value: hashlib.sha256(value).hexdigest()
matrix_sha = 'b63d7857fac2ebaf705e8ce6f9b248ae1b19de3e99a9eb5da8b421f844fd9634'
assert sha((root / 'matrix.ts').read_bytes()) == matrix_sha
for path, expected in load(root.parent / 'cuda-3d9c0ec4.sha256.json').items():
    assert sha((root / path).read_bytes()) == expected, path
capture = load(evidence / 'sdk-matrix.capture.json')
children = evidence / 'sdk-matrix.capture.json.children'
events = load(children / 'children.json')
ledger = load(children / 'requests.json')['requests']
requests = capture['nativeRequests']
assert len(requests) == len(ledger) == 138
assert not capture['errors'] and capture['backends'] == ['cuda']
for receipt, sent in zip(requests, ledger):
    assert receipt['identity'] == sent['identity']
    assert receipt['request'] == sent['request']
    assert receipt['complete'] and not receipt['capture']['errors']
cases = [item['name'] for item in load(evidence / 'matrix-summary.json')]
stdout = [json.loads(line) for line in (evidence / 'sdk-matrix.stdout').read_text().splitlines()]
assert [item['name'] for item in stdout] == cases
assert len(cases) == 12 and len(events) == 48
births = []
for birth, death in zip(events[::2], events[1::2]):
    assert birth['event'] == 'birth' and death['event'] == 'exit' and death['exitCode'] == 0
    assert birth['identity'] == death['identity']
    assert birth['identity']['generation'] == 1 and birth['identity']['parentPid'] == 180407
    births.append(birth['identity']['pid'])
assert len(set(births)) == 24
groups = collections.OrderedDict()
for offset, receipt in enumerate(requests):
    groups.setdefault(receipt['identity']['pid'], []).append((offset, receipt))
assert list(groups) == births
previous_exit = 0
query = 'Instruct: Retrieve relevant documents for the given query\nQuery: cobalt observatory dawn'
rows = []
cross_run = []
query_hashes = set()
for ordinal, (pid, group) in enumerate(groups.items()):
    case = cases[ordinal // 2]
    side = 'incremental' if ordinal % 2 == 0 else 'clean'
    current = load(evidence / f'matrix-{case}.json')
    previous = load(old / f'matrix-{case}.json')
    owners = current['current' if side == 'incremental' else 'rebuilt']['owners']
    old_owners = previous['current' if side == 'incremental' else 'rebuilt']['owners']
    phase_path = evidence / 'phases' / f'{pid}.jsonl'
    phases = [json.loads(line) for line in phase_path.read_text().splitlines()]
    assert phases[0]['event'] == 'phase-ready'
    assert phases[-1]['event'] == 'process-exit' and phases[-1]['code'] == 0
    assert phases[0]['time'] > previous_exit
    previous_exit = phases[-1]['time']
    assert [item['request']['requestId'] for _, item in group] == list(range(1, len(group) + 1))
    counts = collections.Counter()
    calls = []
    for offset, item in group:
        request = item['request']
        captured = item['capture']
        op = request['op']
        counts[op] += 1
        native = [entry['input'] for entry in captured['modelInputs'] if isinstance(entry['input'], dict) and entry['input'].get('nativeMethod') == 'getEmbeddingFor']
        if op not in ('embed', 'embedBatch'):
            assert not native and not captured['modelOutputs']
            continue
        texts = request['texts'] if op == 'embedBatch' else [request['text']]
        assert len(native) == len(texts)
        assert captured['modelInputs'][0]['input'] == [texts if op == 'embedBatch' else texts[0]]
        tokenizations = [entry for entry in captured['contextEvents'] if entry['method'] == 'tokenize']
        assert len(tokenizations) == len(texts)
        output = captured['modelOutputs']
        assert len(output) == 1 and output[0]['ok']
        vectors = output[0]['value'] if op == 'embedBatch' else [output[0]['value']]
        assert len(vectors) == len(texts)
        passages = []
        for text, invocation, tokenization, vector in zip(texts, native, tokenizations, vectors):
            assert tokenization['arguments'] == [text]
            assert invocation['arguments'] == [tokenization['result']]
            vector_sha = sha(struct.pack(f'<{len(vector)}f', *vector))
            input_sha = sha(text.encode())
            value = {'input': text, 'inputSha256': input_sha, 'vectorFloat32LeSha256': vector_sha, 'dimensions': len(vector), 'tokenIds': invocation['arguments'][0], 'nativeContext': invocation['context']}
            if op == 'embed':
                assert text == query
                query_hashes.add(vector_sha)
            else:
                matches = [owner for owner in owners if owner['input_hash'] == input_sha]
                assert matches and all(owner['embedding'] == vector_sha for owner in matches)
                value['matchingOwners'] = [{'collection': owner['collection'], 'relPath': owner['rel_path'], 'seq': owner['seq']} for owner in matches]
                value['oldMatchingInputAndVector'] = any(owner['input_hash'] == input_sha and owner['embedding'] == vector_sha for owner in old_owners)
            passages.append(value)
        calls.append({'captureArrayOffset': offset, 'requestId': request['requestId'], 'operation': op, 'classification': 'passage' if op == 'embedBatch' else 'query', 'actualGetEmbeddingForCalls': len(native), 'inputsAndOutputHashes': passages})
    assert counts['embed'] == 1
    row = {'case': case, 'side': side, 'pid': pid, 'birthOrdinal': ordinal + 1, 'firstCaptureOffset': group[0][0], 'lastCaptureOffset': group[-1][0], 'phaseStartMs': phases[0]['time'], 'phaseExitMs': phases[-1]['time'], 'requestCounts': dict(counts), 'passageBatchRequests': counts['embedBatch'], 'actualPassageGetEmbeddingForCalls': sum(call['actualGetEmbeddingForCalls'] for call in calls if call['classification'] == 'passage'), 'actualQueryGetEmbeddingForCalls': sum(call['actualGetEmbeddingForCalls'] for call in calls if call['classification'] == 'query'), 'calls': calls}
    if case == 'collection-global-catchup' and side == 'incremental':
        row['scopeCaveat'] = 'This client first embeds collection identity before checkpoint, then global catchup. Request 2 is the identity Scope passage; request 5 is the other Scope passage. Their attribution follows exact source order and unique input bytes.'
    rows.append(row)
    if side == 'clean':
        assert {passage['inputSha256'] for call in calls if call['classification'] == 'passage' for passage in call['inputsAndOutputHashes']} == {owner['input_hash'] for owner in owners}
        complete = previous['embed']['ok'] and previous['cleanEmbed']['ok']
        exact = previous['current']['owners'] == current['current']['owners'] and previous['rebuilt']['owners'] == current['rebuilt']['owners']
        if complete:
            assert exact
            assert all(passage['oldMatchingInputAndVector'] for call in calls if call['classification'] == 'passage' for passage in call['inputsAndOutputHashes'])
        cross_run.append({'case': case, 'oldPairComplete': complete, 'bothSidesAllOwnerFieldsExact': exact, 'oldIncrementalOwnerCount': len(previous['current']['owners']), 'oldCleanOwnerCount': len(previous['rebuilt']['owners']), 'newCleanActualPassageCalls': row['actualPassageGetEmbeddingForCalls'], 'newCleanNativeInputAndOutputMatchOldPersistedHashes': all(passage['oldMatchingInputAndVector'] for call in calls if call['classification'] == 'passage' for passage in call['inputsAndOutputHashes']) if complete else None})
assert sum(item['oldPairComplete'] for item in cross_run) == 9
assert len(query_hashes) == 1
output = {'analysisScript': str(pathlib.Path(__file__)), 'analysisScriptSha256': sha(pathlib.Path(__file__).read_bytes()), 'sourceCommit': '3d9c0ec49c502ab0c3470c7df14ddac8123ad8d9', 'matrixSha256': matrix_sha, 'captureSha256': sha((evidence / 'sdk-matrix.capture.json').read_bytes()), 'childrenLedgerSha256': sha((children / 'children.json').read_bytes()), 'requestsLedgerSha256': sha((children / 'requests.json').read_bytes()), 'mapping': 'Derived uniquely from exact sequential matrix, 24 ordered birth/exit pairs, 24 single-query client sessions, complete sent/received request bijection, contiguous request IDs and nonoverlapping child phase intervals. Not an originally emitted per-case scope.', 'rows': rows, 'crossRunNineCompletePairs': cross_run, 'allQueryVectorHash': next(iter(query_hashes)), 'limits': ['Old baseline has persisted input/vector hashes, not raw per-call native capture. No old raw token/context equality claim.', 'Counts refer to recorded embedding-port and getEmbeddingFor invocations, not speculative simulator allocation or GPU kernel counts.', 'Metadata init/dispose and one query inference remain in zero-passage cases.', 'Collection-global-catchup original session includes the preceding collection-scoped embedding; preserved as separate requests.']}
destination = repo / 'notes/fn147-native-call-attribution.json'
destination.write_text(json.dumps(output, indent=2))
print(json.dumps({'rows': [{key: row[key] for key in ('case', 'side', 'pid', 'passageBatchRequests', 'actualPassageGetEmbeddingForCalls', 'actualQueryGetEmbeddingForCalls')} for row in rows], 'nineCompletePairsExact': sum(item['oldPairComplete'] and item['bothSidesAllOwnerFieldsExact'] for item in cross_run)}))
