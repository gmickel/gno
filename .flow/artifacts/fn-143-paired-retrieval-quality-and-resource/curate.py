"""Copy bounded synthetic QA artifacts; originals and existing artifacts preserved."""
import gzip,hashlib,json,shutil
from pathlib import Path
repo=Path('/home/gordon/work/gno')
out=Path(__file__).resolve().parent
notes=repo/'notes/fn143-native-tmp'
qa=notes/'qa-prep'
mapping={}
def copy(src,name,compress=False):
 target=out/name
 if target.exists():raise RuntimeError(f'Preserve existing artifact: {target}')
 data=src.read_bytes()
 target.write_bytes(gzip.compress(data,mtime=0) if compress else data)
 mapping[name]={'source':str(src),'sourceSha256':hashlib.sha256(data).hexdigest(),'gzip':compress}
copy(qa/'QA-SUMMARY.md','native-QA-SUMMARY.md')
copy(qa/'evidence-sha256.json','native-original-checksums.json')
for platform in ['cuda','metal']:
 root=qa/'runs'/f'{platform}-control-01'
 copy(root/'surface-comparison-final.json',f'{platform}-surface-comparisons.json')
 warm='warm30' if platform=='cuda' else 'warm30-embedding-only'
 copy(root/warm/'report.json',f'{platform}-warm30-report.json.gz',True)
 orchid=qa/'runs'/f'{platform}-orchid-01'
 copy(orchid/'orchid-verified-comparison.json',f'{platform}-verified-comparison.json')
 for side in ['baseline','candidate']:
  copy(orchid/side/'orchid-verified.json.gz',f'{platform}-{side}-verified-raw.json.gz')
  copy(orchid/side/'manifest-orchid-verified.json',f'{platform}-{side}-verified-manifest.json')
copy(qa/'runs/cuda-orchid-01/expanded-semantic-comparison.json','cuda-expanded-comparison.json')
for side in ['baseline','candidate']:
 copy(qa/f'runs/cuda-orchid-01/{side}/expanded-semantic.json.gz',f'cuda-{side}-expanded-raw.json.gz')
copy(qa/'runs/metal-orchid-01/baseline-expanded-semantic.receipt.json','metal-expanded-pressure-receipt.json')
copy(qa/'runs/metal-control-01/embedding-only-comparison.json','metal-embedding-only-comparison.json')
copy(qa/'lifecycle/LIFECYCLE-SUMMARY.md','metal-lifecycle-summary.md')
copy(qa/'lifecycle/summary.json','metal-lifecycle-observations.json')
for name in ['warm','cold-default','ttl1200']:
 copy(qa/f'lifecycle/completed/{name}/report.json',f'metal-lifecycle-{name}-report.json.gz',True)
copy(notes/'state-screens/results.md','cuda-lifecycle-summary.md')
copy(notes/'state-screens/observations.json','cuda-lifecycle-observations.json')
for name in ['cold','novel','overlap','post-idle-default','post-idle-expiry']:
 copy(notes/f'state-screens/{name}/report.json',f'cuda-lifecycle-{name}-report.json.gz',True)
for src,name in [(notes/'full-tests-owned.log','gate-full-tests.log.gz'),(notes/'full-lint-settled.log','gate-full-lint.log.gz'),(Path('/tmp/fn143-publictruth-docs.log'),'gate-docs.log.gz'),(Path('/tmp/fn143-prerequisite-memory.log'),'gate-memory.log.gz'),(Path('/tmp/gno-fn143-baseline-hybrid.log'),'gate-lexical-hybrid.log.gz'),(Path('/tmp/gno-fn143-baseline-vsearch.log'),'gate-lexical-vsearch.log.gz')]:copy(src,name,True)
(out/'curation-sources.json').write_text(json.dumps(mapping,indent=2)+'\n')
