import os,subprocess,time,json,signal,threading,socket,urllib.request,hashlib,traceback
from pathlib import Path
R=Path(__file__).parent; S=R/'source'; B='/tmp/gno-native-tools-1314.KrONBb/bun-darwin-aarch64/bun'; G=str(S/'src/index.ts'); C=Path('/tmp/gno-native-baseline-20260905.VQtXt5/orchid-docs'); E=R/'evidence';E.mkdir(exist_ok=True)
env=dict(os.environ,HOME=str(R/'home'),XDG_CONFIG_HOME=str(R/'config'),XDG_DATA_HOME=str(R/'data'),XDG_STATE_HOME=str(R/'state'),XDG_CACHE_HOME=str(R/'cache'),GNO_CONFIG_DIR=str(R/'config'),GNO_DATA_DIR=str(R/'data'),GNO_CACHE_DIR=str(R/'cache'),TMPDIR=str(R),GNO_OFFLINE='1',GNO_ALLOW_DOWNLOAD='0',GNO_LLAMA_GPU='metal',GNO_LLAMA_BUILD='never')
rows=[]
def save(name,value): (E/name).write_text(json.dumps(value,indent=2))
def gpu(): return subprocess.run(['sysctl','vm.swapusage','kern.memorystatus_vm_pressure_level'],capture_output=True,text=True).stdout
save('receipt.json',{'sourceCommit':'23ba2c258e2d6c27b03aa7504a7d28f88d1ae2cf','sourceArchiveSha256':hashlib.sha256((R/'source.tar').read_bytes()).hexdigest(),'runtime':B,'corpusPath':str(C),'corpus':[{ 'path':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(C.glob('*'))],'gpuBefore':gpu(),'env':{k:env[k] for k in ['HOME','GNO_CONFIG_DIR','GNO_DATA_DIR','GNO_CACHE_DIR','TMPDIR','GNO_LLAMA_GPU']}})
def stop(p):
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=8)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
def run(name,args):
 start=time.monotonic()
 with (E/(name+'.stdout')).open('w') as out,(E/(name+'.stderr')).open('w') as err:
  p=subprocess.Popen([B,G,*args],env=env,stdout=out,stderr=err,start_new_session=True,cwd=S)
  try:
   while p.poll() is None:
    if time.monotonic()-start>180 or 'kern.memorystatus_vm_pressure_level: 1' not in gpu():stop(p);raise RuntimeError('setup timeout or memory pressure')
    time.sleep(.25)
   code=p.wait()
  except subprocess.TimeoutExpired:stop(p);raise
 save(name+'.receipt.json',{'args':args,'pid':p.pid,'exit':code,'seconds':time.monotonic()-start})
 print(name,code,flush=True)
 assert code==0
run('init',['init',str(C),'--name','probe','--tokenizer','unicode61','--yes'])
config=R/'config/index.yml'
patch="""const p=process.argv[1];const c=Bun.YAML.parse(await Bun.file(p).text());const base='file:/Users/gordon/Library/Caches/gno/models/';c.models={activePreset:'audit-default-equivalent',warmModelTtl:300000,presets:[{id:'audit-default-equivalent',name:'Pinned slim-tuned file URI equivalent',embed:base+'hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf',rerank:base+'hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf',expand:base+'hf_guiltylemon_gno-expansion-slim-retrieval-v1_gno-expansion-auto-entity-lock-default-mix-lr95-.gguf',gen:base+'hf_unsloth_Qwen3-1.7B-Q4_K_M.gguf'}]};await Bun.write(p,JSON.stringify(c,null,2));"""
subprocess.run([B,'--eval',patch,str(config)],env=env,check=True)
run('index',['index','--no-embed','--json']);run('embed',['embed','--json'])
body={'query':'Who owns the meadow migration?','collection':'probe','noExpand':True,'noRerank':True}
def serve(name,ttl,stages):
 c=json.loads(config.read_text());c['models']['warmModelTtl']=ttl;config.write_text(json.dumps(c,indent=2));save(name+'.config.json',c)
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 start=time.monotonic();samples=[];polls=[];stopReasons=[];done=threading.Event()
 with (E/(name+'.stdout')).open('w') as out,(E/(name+'.stderr')).open('w') as err:
  p=subprocess.Popen([B,G,'serve','--host','127.0.0.1','--port',str(port)],env=env,stdout=out,stderr=err,start_new_session=True,cwd=S)
  def watch():
   while not done.is_set():
    processes=subprocess.run(['ps','-eo','pid=,ppid=,rss=,etime=,args='],capture_output=True,text=True).stdout.splitlines()
    parsed=[x.strip().split(None,4) for x in processes];owned={p.pid}
    for _ in range(4):
     owned.update(int(x[0]) for x in parsed if len(x)>=4 and int(x[1]) in owned)
    samples.append({'seconds':time.monotonic()-start,'processes':[x for x in parsed if int(x[0]) in owned],'gpu':gpu()})
    if time.monotonic()-start>180 or 'kern.memorystatus_vm_pressure_level: 1' not in gpu() or sum(int(x[2]) for x in parsed if int(x[0]) in owned)>6144*1024:stopReasons.append('timeout_or_pressure_or_rss');stop(p);return
    done.wait(.2)
  thread=threading.Thread(target=watch);thread.start()
  def status():
   with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/status',timeout=3) as response:return json.load(response)
  try:
   for _ in range(200):
    if p.poll() is not None:raise RuntimeError('serve exited')
    try:ready=status();break
    except Exception:time.sleep(.1)
   else:raise RuntimeError('readiness timeout')
   save(name+'.ready.json',{'parentPid':p.pid,'seconds':time.monotonic()-start,'response':ready})
   for stage,delay in stages:
    until=time.monotonic()+delay
    while time.monotonic()<until:
     polls.append({'seconds':time.monotonic()-start,'stage':stage,'response':status()});time.sleep(.15)
    queryStart=time.monotonic()
    req=urllib.request.Request(f'http://127.0.0.1:{port}/api/query',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=60) as resp:
     raw=resp.read();x=json.loads(raw);(E/(stage+'.response.json')).write_bytes(raw)
     row={'stage':stage,'ttl':ttl,'parentPid':p.pid,'status':resp.status,'ms':(time.monotonic()-queryStart)*1000,'request':body,'body':x};rows.append(row)
     print(json.dumps({'stage':stage,'status':resp.status,'ms':row['ms'],'count':len(x.get('results',[])),'meta':x.get('meta')}),flush=True)
     save('results.json',rows)
   time.sleep(.3)
  finally:
   stop(p);done.set();thread.join();save(name+'.process.json',{'parentPid':p.pid,'exit':p.returncode,'samples':samples,'statusPolls':polls,'stopReasons':stopReasons,'gpuAfter':gpu()})
serve('default',300000,[('default-first',0),('default-warm',0)])
serve('expiry',1200,[('expiry-first',0),('expiry-warm',0),('expiry-cycle1',3.0),('expiry-cycle1-warm',0),('expiry-cycle2',3.0)])
serve('fresh-control',1200,[('fresh-control',0)])
reference=rows[0]['body']['results']
save('comparison.json',{'normalizations':[], 'comparison':'exact full results arrays (all keys, scores, ordering, source IDs and provenance); metadata retained separately without normalization', 'rows':[{'stage':r['stage'],'count':len(r['body']['results']),'equal':r['body']['results']==reference,'vectorsUsed':r['body'].get('meta',{}).get('vectorsUsed')} for r in rows]})
save('after.json',{'gpu':gpu()})
