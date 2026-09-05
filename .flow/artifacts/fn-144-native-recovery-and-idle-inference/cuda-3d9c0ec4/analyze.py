import collections
import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path(__file__).parent
evidence = root / 'evidence'
old = pathlib.Path('/home/gordon/.cache/agent-tmp/gno-fn147-nativeqa/evidence')
load = lambda path: json.loads(path.read_text())
summary = {'source': '3d9c0ec49c502ab0c3470c7df14ddac8123ad8d9', 'runs': {}, 'crossRunOwners': [], 'phaseSummary': {}}
owned = set()
for name in ['cli-update', 'cli-embed', 'cli-embed-capture-scope-fixed', 'sdk-matrix', 'cli-vsearch', 'mcp']:
    receipt = load(evidence / f'{name}.receipt.json')
    samples = [json.loads(line) for line in (evidence / f'{name}.process.jsonl').read_text().splitlines()]
    for sample in samples:
        owned.update(int(line.split()[0]) for line in sample['owned'])
    receipt['peakSampledOwnedRssKiB'] = max(sum(int(line.split()[3]) for line in sample['owned']) for sample in samples)
    receipt['stderrBytes'] = (evidence / f'{name}.stderr').stat().st_size
    capture_path = evidence / f'{name}.capture.json'
    if name == 'mcp':
        capture_path = evidence / 'mcp-child.capture.json'
    if capture_path.exists():
        capture = load(capture_path)
        requests = capture['nativeRequests']
        receipt['capture'] = {'requests': len(requests), 'incomplete': sum(not request['complete'] for request in requests), 'childPids': sorted(set(request['identity']['pid'] for request in requests)), 'backends': capture['backends'], 'errors': capture['errors'], 'parentNative': capture['parentNative']}
        owned.update(receipt['capture']['childPids'])
    summary['runs'][name] = receipt
for case in load(evidence / 'matrix-summary.json'):
    name = case['name']
    previous = load(old / f'matrix-{name}.json')
    current = load(evidence / f'matrix-{name}.json')
    summary['crossRunOwners'].append({'name': name, 'oldCompletePair': previous['embed']['ok'] and previous['cleanEmbed']['ok'], 'oldCurrentVsNewCurrentExact': previous['current']['owners'] == current['current']['owners'], 'oldRebuildVsNewRebuildExact': previous['rebuilt']['owners'] == current['rebuilt']['owners']})
phases = collections.Counter()
overlaps = []
unfinished = []
for file in (evidence / 'phases').glob('*.jsonl'):
    active = {}
    for line in file.read_text().splitlines():
        item = json.loads(line)
        if item['event'] == 'start':
            phases[item['kind']] += 1
            if item['kind'] == 'simulator-session-dispose':
                pending = [value for value in active.values() if value['kind'] in ('simulator-context-estimate', 'simulator-model-estimate')]
                if pending:
                    overlaps.append({'pid': item['pid'], 'time': item['time'], 'activeEstimates': len(pending)})
            active[item['eventId']] = item
        elif item['event'] in ('end', 'error'):
            active.pop(item['eventId'], None)
    if active:
        unfinished.append({'file': str(file), 'active': list(active.values())})
summary['phaseSummary'] = {'starts': dict(phases), 'sessionDisposalWhileEstimatesActive': overlaps, 'unfinished': unfinished}
cli = load(evidence / 'cli-vsearch.stdout')
mcp = load(evidence / 'mcp-gno_vsearch.json')['structuredContent']
summary['cliMcpExactPublicEquality'] = cli == mcp
summary['cliMcpVectorsUsed'] = cli['meta']['vectorsUsed'] and mcp['meta']['vectorsUsed']
summary['postRun'] = {'ownedPids': sorted(owned), 'stillPresent': [pid for pid in sorted(owned) if pathlib.Path(f'/proc/{pid}').exists()], 'gpu': subprocess.run(['nvidia-smi', '--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader'], capture_output=True, text=True).stdout}
helpers = ['prepare.ts', 'matrix.ts', 'run.py', 'phase-parent.ts', 'phase-child.ts', 'mcp-only.ts', 'compare-candidate.ts', 'analyze.py']
summary['helperHashes'] = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in helpers}
(evidence / 'analysis.json').write_text(json.dumps(summary, indent=2))
print(json.dumps({'stillPresent': summary['postRun']['stillPresent'], 'cliMcpExact': summary['cliMcpExactPublicEquality'], 'phaseOverlaps': len(overlaps), 'unfinishedPhases': len(unfinished), 'crossRunOwners': summary['crossRunOwners']}))
