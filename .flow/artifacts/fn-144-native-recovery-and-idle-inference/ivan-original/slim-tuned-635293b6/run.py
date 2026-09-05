import pathlib,tarfile,hashlib,json,os,subprocess,time,signal
R=pathlib.Path(__file__).resolve().parent;S=R/'source';E=R/'evidence';E.mkdir();B='/tmp/gno-native-tools-1314.KrONBb/bun-darwin-aarch64/bun'
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for x in iter(lambda:f.read(1048576),b''):h.update(x)
 return h.hexdigest()
assert sha(R/'source.tar')=='7cd87d3e3ee540ded98538871e67d32ee302b33c9ffa8add7db41a8cd9ad6034'
with tarfile.open(R/'source.tar') as archive:
 commit=archive.pax_headers['comment'];S.mkdir();archive.extractall(S,filter='data')
(S/'node_modules').symlink_to('/Users/gordon/.bun/install/global/node_modules')
env=dict(os.environ,GNO_OFFLINE='1',GNO_ALLOW_DOWNLOAD='0',GNO_LLAMA_GPU='metal',GNO_LLAMA_BUILD='never',GNO_ORIGINAL_QA_ROOT=str(R))
for key,name in {'HOME':'home','XDG_CONFIG_HOME':'config','XDG_DATA_HOME':'data','XDG_STATE_HOME':'state','XDG_CACHE_HOME':'cache','GNO_CONFIG_DIR':'config','GNO_DATA_DIR':'data','GNO_CACHE_DIR':'cache','TMPDIR':'tmp'}.items():
 d=R/name;d.mkdir(exist_ok=True);env[key]=str(d)
config=json.loads((R/'original-config.json').read_text());assert config['models']['warmModelTtl']==300000
config['models']['activePreset']='slim-tuned'
config['models']['presets'][0]['id']='slim-tuned'
(R/'config/index.yml').write_text(json.dumps(config,indent=2))
manifest=json.loads((R/'fixtures-manifest.json').read_text());original=pathlib.Path('/tmp/gno-native-baseline-20260905.VQtXt5')
fixture=[x for x in manifest if x['path'].startswith('index-trace-vault/')];assert len(fixture)==143
for x in fixture:assert sha(original/x['path'])==x['sha256'],x['path']
models=[{'role':k,'uri':v,'sha256':sha(pathlib.Path(v[5:]))} for k,v in config['models']['presets'][0].items() if k in ['embed','rerank','expand','gen']]
(E/'pins.json').write_text(json.dumps({'commit':commit,'archiveSha256':sha(R/'source.tar'),'bun':B,'bunSha256':sha(pathlib.Path(B)),'config':config,'configSha256':sha(R/'config/index.yml'),'corpus':fixture,'models':models,'configurationStratum':'corrected slim-tuned depth-policy; same four role files, original scope; historical exact preset unknown'},indent=2))
def pressure():return subprocess.run(['sysctl','vm.swapusage','kern.memorystatus_vm_pressure_level'],capture_output=True,text=True).stdout
def stop(p):
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
def run(name,args,seconds=180,hook=False):
 start=time.monotonic();samples=[];reason=None;childenv=dict(env,GNO_ORIGINAL_QA_PHASE=name)
 command=[B]+(['--preload',str(R/'parent-preload.ts')] if hook else [])+[str(S/'src/index.ts'),*args]
 with (E/(name+'.stdout')).open('w') as out,(E/(name+'.stderr')).open('w') as err:
  p=subprocess.Popen(command,env=childenv,stdout=out,stderr=err,cwd=S,start_new_session=True)
  while p.poll() is None:
   parsed=[x.split(None,4) for x in subprocess.run(['ps','-axo','pid=,ppid=,rss=,etime=,args='],capture_output=True,text=True).stdout.splitlines()];owned={p.pid}
   for _ in range(5):owned.update(int(x[0]) for x in parsed if len(x)>=4 and int(x[1]) in owned)
   rows=[x for x in parsed if len(x)>=4 and int(x[0]) in owned];state=pressure();rss=sum(int(x[2]) for x in rows)
   samples.append({'seconds':time.monotonic()-start,'processes':rows,'rssKiB':rss,'pressure':state})
   if 'kern.memorystatus_vm_pressure_level: 1' not in state:reason='memory_pressure'
   elif rss>6144*1024:reason='rss_limit'
   elif time.monotonic()-start>seconds:reason='timeout'
   if reason:stop(p);break
   time.sleep(.25)
  code=p.wait()
 receipt={'command':command,'pid':p.pid,'exit':code,'stopReason':reason,'seconds':time.monotonic()-start,'samples':samples}
 (E/(name+'.receipt.json')).write_text(json.dumps(receipt,indent=2));print(json.dumps({k:v for k,v in receipt.items() if k!='samples'}),flush=True)
 return code==0 and reason is None
assert run('index',['index','--no-embed','--json'])
assert run('embed',['embed','--json'],300)
results=[]
for i in range(1,4):
 name=f'query-{i}';ok=run(name,['query','what retry budget did we decide and why','-n','5','--json'],180,True)
 if ok:
  response=json.loads((E/(name+'.stdout')).read_text());meta=response.get('meta',{});ok=meta.get('expanded') is True and meta.get('reranked') is True
  results.append({'name':name,'meta':meta,'enabledStagesActuallyUsed':ok})
 else:results.append({'name':name,'completed':False})
 (E/'cli-result.json').write_text(json.dumps({'attempts':results,'passed3of3':len(results)==3 and all(x.get('enabledStagesActuallyUsed') for x in results)},indent=2))
 if not ok:break
