import pathlib,json,gzip
root=pathlib.Path(__file__).resolve().parent
def read(path):
 p=root/path
 return json.loads(p.read_bytes() if p.exists() else gzip.decompress(pathlib.Path(str(p)+'.gz').read_bytes()))
def lines(path):
 p=root/path
 b=p.read_bytes() if p.exists() else gzip.decompress(pathlib.Path(str(p)+'.gz').read_bytes())
 return [json.loads(x) for x in b.splitlines()]
out={}
for role in ['baseline','candidate']:
 result=read(role+'/result.json');phases=lines(role+'/phases.jsonl')
 paced=[x for x in result['results'] if x['label'].startswith('paced-')]
 ids={n['request']['requestId'] for x in paced for n in x['receipt']['nativeRequests'] if n['request']['op']=='embed'}
 snapshots=[x for x in phases if x['kind']=='request-end' and x['request']['requestId'] in ids]
 start,end=snapshots[0]['at'],snapshots[-1]['at']
 disposals=[x for x in phases if x['kind']=='dispose-end']
 public=[x for x in result['results'] if 'projected' in x]
 file_entries=[v for x in phases if x['kind']=='request-end' for uri,v in x['files'] if 'Embedding' in uri]
 signatures={json.dumps(v,sort_keys=True) for v in file_entries}
 asks=[]
 for x in public:
  if x['label'].startswith('verified'):
   sem=x['raw']['verification']['semantic'];asks.append({'caseId':x['label'],'semantic':{k:v for k,v in sem.items() if k!='durationMs'},'answerStatus':x['raw']['verification']['result']['answerStatus'] if 'result' in x['raw']['verification'] else None})
 out[role]={'pacedRequests':sorted(ids),'pacedSpanMs':end-start,'pacedSnapshots':snapshots,'disposeCompletions':disposals,'loadReturns':[x for x in phases if x['kind']=='load-return'],'oneChildPid':sorted({x['pid'] for x in phases}),'embeddingFileIdentityAndFingerprintStable':len(signatures)==1,'embeddingFileEntry':file_entries[0],'asks':asks,'contexts':{x['label']:[v for v in x['receipt']['contextEvents'] if v['method']=='createRankingContext'] for x in public},'nativeReceiptCount':sum(len(x['receipt']['nativeRequests']) for x in result['results']),'driverErrors':[x for x in result['events'] if x['kind']=='driver-error']}
(root/'residency-analysis.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({role:{'pacedSpanMs':v['pacedSpanMs'],'oneChildPid':v['oneChildPid'],'embeddingFingerprintStable':v['embeddingFileIdentityAndFingerprintStable'],'nativeReceiptCount':v['nativeReceiptCount'],'driverErrors':v['driverErrors']} for role,v in out.items()}))

