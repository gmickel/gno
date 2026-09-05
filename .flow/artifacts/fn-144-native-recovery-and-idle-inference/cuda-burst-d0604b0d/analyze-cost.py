import collections, hashlib, json, math, pathlib, statistics

root=pathlib.Path(__file__).resolve().parent
load=lambda path:json.loads(path.read_text())
def percentile(values,p):
    ordered=sorted(values)
    return ordered[max(0,math.ceil(len(ordered)*p)-1)] if ordered else None
def explain_total(response):
    for line in response.get('meta',{}).get('explain',{}).get('lines',[]):
        if line['stage']=='timing':
            return float(line['message'].split('total=')[-1].removesuffix('ms'))
    return None
def without_timing(response):
    result=json.loads(json.dumps(response))
    lines=result.get('meta',{}).get('explain',{}).get('lines')
    if lines is not None:
        result['meta']['explain']['lines']=[line for line in lines if line['stage']!='timing']
    return result
references={}
for workload in ['warm30','original143']:
    references[workload]=load(root/'observations'/f'capture-{workload}-baseline-complete-helpers'/'result.json')['results'][0]['raw']
rows=[];groups=collections.defaultdict(list);all_calls=[]
for plan_path in load(root/'execution-order.json'):
    plan=load(pathlib.Path(plan_path));directory=pathlib.Path(plan['outputPath']).parent
    result=load(directory/'result.json');process=load(directory/'process-receipt.json')
    workload='original143' if plan['caseId']=='original143-expanded' else 'warm30'
    measured=[];errors=[];mismatches=[]
    for call in result['calls']:
        response=call.get('response',{});meta=response.get('meta',{})
        exact=response.get('results')==references[workload]['results']
        full_except_timing=call['ok'] and without_timing(response)==without_timing(references[workload])
        valid=bool(call['ok'] and exact and meta.get('vectorsUsed') and meta.get('reranked') and (workload!='original143' or meta.get('expanded')))
        item={'observation':directory.name,'index':call['index'],'phase':call['phase'],'ok':call['ok'],'valid':valid,'durationMs':call['durationMs'],'fullResultArrayExact':exact,'fullPublicPayloadExceptExplainTimingExact':full_except_timing,'expanded':meta.get('expanded'),'reranked':meta.get('reranked'),'vectorsUsed':meta.get('vectorsUsed'),'candidateLimit':meta.get('candidateLimit'),'explainPipelineTotalMs':explain_total(response),'error':call.get('error')}
        if item['explainPipelineTotalMs'] is not None:item['outsideExplainPipelineMs']=item['durationMs']-item['explainPipelineTotalMs']
        all_calls.append(item)
        if not call['ok']:errors.append(item)
        elif not valid:mismatches.append(item)
        if call['phase']==plan['mode']:
            measured.append(item);groups[(workload,plan['mode'],plan['role'])].append(item)
    phase=result['phases'][0]
    row={'observation':directory.name,'workload':workload,'role':plan['role'],'mode':plan['mode'],'offered':plan['count'],'settled':len(measured),'transportCompleted':sum(item['ok'] for item in measured),'validCompleted':sum(item['valid'] for item in measured),'makespanMs':phase['makespanMs'],'validThroughputPerSecond':sum(item['valid'] for item in measured)*1000/phase['makespanMs'],'completeColdPenaltyMs':process['firstResponse'][0]['spawnToFirstResponseMs'],'firstRequestMs':result['calls'][0]['durationMs'],'warmP50Ms':statistics.median(item['durationMs'] for item in measured if item['valid']),'warmP95Ms':percentile([item['durationMs'] for item in measured if item['valid']],.95),'errors':errors,'invalidSuccessfulCalls':mismatches,'exitCode':process['exitCode']}
    rows.append(row)
aggregate=[]
for (workload,mode,role),calls in groups.items():
    selected=[row for row in rows if (row['workload'],row['mode'],row['role'])==(workload,mode,role)]
    valid=[call for call in calls if call['valid']]
    aggregate.append({'workload':workload,'mode':mode,'role':role,'offered':sum(row['offered'] for row in selected),'settled':len(calls),'validCompleted':len(valid),'makespanMs':sum(row['makespanMs'] for row in selected),'validThroughputPerSecond':len(valid)*1000/sum(row['makespanMs'] for row in selected),'validP50Ms':statistics.median(call['durationMs'] for call in valid),'validP95Ms':percentile([call['durationMs'] for call in valid],.95),'outsideExplainPipelineMedianMs':statistics.median(call['outsideExplainPipelineMs'] for call in valid)})
hash_events=[json.loads(line) for path in (root/'observations/hash-diagnostic-candidate/hash-streams').glob('*.jsonl') for line in path.read_text().splitlines()]
hash_ends=[item for item in hash_events if item['event']=='stream-end']
diagnostic={'classification':'separate instrumented diagnostic, excluded from plain timing totals','events':hash_events,'completedFullFileReads':len(hash_ends),'bytesPerRead':sorted(set(item['bytes'] for item in hash_ends)),'streamDurationsMs':[item['durationMs'] for item in hash_ends]}
owned=set()
for path in (root/'observations').glob('*/process.jsonl'):
    for line in path.read_text().splitlines():
        owned.update(int(item.split()[0]) for item in json.loads(line)['owned'])
output={'productCandidate':'d0604b0d7b0c888653390618ab498187bf71b397','candidatePackageSha256':'f42dfdddd6296e527f3c4bf01d21bb8a685a33996edcfd1c7624e60fe13320bd','baseline':'270c3a74f4f7a3aeb8a60462b4c8e1b4adf45462','helper':'9244d715','plainDeclaredCalls':324,'plainRecordedCalls':len(all_calls),'plainTransportFailures':sum(not item['ok'] for item in all_calls),'successfulFullResultArrayMismatches':sum(item['ok'] and not item['fullResultArrayExact'] for item in all_calls),'successfulFullPublicPayloadExceptTimingMismatches':sum(item['ok'] and not item['fullPublicPayloadExceptExplainTimingExact'] for item in all_calls),'aggregate':aggregate,'observations':rows,'calls':all_calls,'captureComparisons':load(root/'control-comparisons.json'),'hashDiagnostic':diagnostic,'postRun':{'observedOwnedPids':sorted(owned),'remainingObservedOwnedPids':[pid for pid in sorted(owned) if pathlib.Path(f'/proc/{pid}').exists()]},'limits':['Baseline concurrent cells have errors and cannot support a valid matched speedup claim.','Model hashes are outside native stage timings but inside public request latency.','Primed SDK burst measurements are plain; per-call native coverage comes only from the separate captured controls.','All public payloads retained; only nondeterministic explain timing lines excluded for the explicitly labelled whole-payload check.','No cold OS-cache or stable p99 claim.']}
(root/'cost-analysis.json').write_text(json.dumps(output,indent=2))
print(json.dumps({key:output[key] for key in ['plainRecordedCalls','plainTransportFailures','successfulFullResultArrayMismatches','successfulFullPublicPayloadExceptTimingMismatches','aggregate']}))
