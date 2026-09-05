import pathlib,hashlib,json
r=pathlib.Path(__file__).parent
c=json.loads((r/'config/index.yml').read_text());models=[]
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
 return h.hexdigest()
for role,uri in c['models']['presets'][0].items():
 if role not in ['embed','gen','expand','rerank']:continue
 models.append({'role':role,'uri':uri,'sha256':sha(pathlib.Path(uri[5:]))})
b=pathlib.Path('/tmp/gno-native-tools-1314.KrONBb/bun-darwin-aarch64/bun')
out={'models':models,'bunSha256':sha(b),'dbSha256AfterRun':sha(r/'data/index-default.sqlite'),'configSha256':{p.name:sha(p) for p in (r/'evidence').glob('*.config.json')}}
(r/'evidence/pins.json').write_text(json.dumps(out,indent=2))
