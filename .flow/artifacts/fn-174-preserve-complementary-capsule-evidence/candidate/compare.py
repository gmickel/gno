"""Compare completed, unchanged keyed runs; no rescoring or threshold changes."""
import hashlib
import json
from pathlib import Path
import statistics

root=Path.cwd()
base=root/'.flow/artifacts/fn-169-compiled-project-context-from-verified/eval'
post=Path(__file__).resolve().parent
old=json.loads((base/'report.json').read_text())
new=json.loads((post/'report.json').read_text())
registration=json.loads((post/'registration.json').read_text())
unchanged={path:hashlib.sha256((root/path).read_bytes()).hexdigest()==value for path,value in registration['hashes'].items()}
rows=[]
for name,current in new['metrics'].items():
    before=old['metrics'][name]
    rows.append({'case':name,'before':{a:sum(r['groundedSuccess'] for r in data) for a,data in before.items()},'after':{a:sum(r['groundedSuccess'] for r in data) for a,data in current.items()}})
preservation=[]
for record in new['preparation']['records']:
    case=record['id'];capsule=json.loads((post/f'{case}.capsule.txt').read_text());compiled=(post/f'{case}.compiled.txt').read_text()
    preservation.append({'case':case,'allProvidedTextAndUrisPreserved':all(e['text'] in compiled and e['uri'] in compiled for e in capsule['evidence']),'sourceCount':len(capsule['evidence'])})
summary={'preRegisteredGate':new['gatePassed'],'valid':new['valid'],'unchangedRuntimeAndFixtureHashes':unchanged,'sourceFrozenThroughoutRun':all(unchanged.values()),'rows':rows,'guardBefore':old['guardsPassed'],'guardAfter':new['guardsPassed'],'perCaseNoRegression':new['nonRegression'],'postfixAbstentionOriginalKey':new['abstention'],'superiority':new['superiority'],'preservation':preservation,'medianCost':{a:statistics.median(r[field] for r in new['preparation']['records']) for a,field in [('capsule','baselineBytes'),('compiled','compiledBytes')]},'retainsOriginalFailedStudy':True,'supplementalProbeNotPooled':True}
(post/'comparison.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary,indent=2))
