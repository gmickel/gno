import os,subprocess,time,json,signal,threading,socket,urllib.request,hashlib,traceback
from pathlib import Path
R=Path(__file__).parent; S=R/'source'; B='/home/gordon/.local/share/mise/installs/bun/1.3.14/bin/bun'; G=str(S/'src/index.ts'); C=Path('/tmp/gno-native-baseline-20260905-gmyi58ts/orchid-docs'); E=R/'evidence-fault';E.mkdir(exist_ok=True)
env=dict(os.environ,HOME=str(R/'home'),XDG_CONFIG_HOME=str(R/'config'),XDG_DATA_HOME=str(R/'data'),XDG_STATE_HOME=str(R/'state'),XDG_CACHE_HOME=str(R/'cache'),GNO_CONFIG_DIR=str(R/'config'),GNO_DATA_DIR=str(R/'data'),GNO_CACHE_DIR=str(R/'cache'),TMPDIR=str(R),GNO_OFFLINE='1',GNO_ALLOW_DOWNLOAD='0',GNO_LLAMA_GPU='cuda',GNO_LLAMA_BUILD='never',CUDA_PATH='/opt/cuda')
rows=[]
def save(name,value): (E/name).write_text(json.dumps(value,indent=2))
def gpu(): return subprocess.run(['nvidia-smi','--query-compute-apps=pid,used_memory','--format=csv,noheader'],capture_output=True,text=True).stdout
save('receipt.json',{'sourceCommit':'23ba2c258e2d6c27b03aa7504a7d28f88d1ae2cf','sourceArchiveSha256':hashlib.sha256((R/'source.tar').read_bytes()).hexdigest(),'runtime':B,'corpusPath':str(C),'corpus':[{ 'path':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(C.glob('*'))],'gpuBefore':gpu(),'env':{k:env[k] for k in ['HOME','GNO_CONFIG_DIR','GNO_DATA_DIR','GNO_CACHE_DIR','TMPDIR','GNO_LLAMA_GPU','CUDA_PATH']}})
def stop(p):
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=8)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
def run(name,args):
 start=time.monotonic()
 with (E/(name+'.stdout')).open('w') as out,(E/(name+'.stderr')).open('w') as err:
  p=subprocess.Popen([B,G,*args],env=env,stdout=out,stderr=err,start_new_session=True,cwd=S)
  try:code=p.wait(timeout=180)
  except subprocess.TimeoutExpired:stop(p);raise
 save(name+'.receipt.json',{'args':args,'pid':p.pid,'exit':code,'seconds':time.monotonic()-start})
 print(name,code,flush=True)
 assert code==0
config=R/'config/index.yml'
body={'query':'Who owns the meadow migration?','collection':'probe','noExpand':True,'noRerank':True}
def serve(name,ttl,stages):
 c=json.loads(config.read_text());c['models']['warmModelTtl']=ttl;config.write_text(json.dumps(c,indent=2));save(name+'.config.json',c)
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
 start=time.monotonic();samples=[];polls=[];done=threading.Event()
 with (E/(name+'.stdout')).open('w') as out,(E/(name+'.stderr')).open('w') as err:
  p=subprocess.Popen([B,G,'serve','--host','127.0.0.1','--port',str(port)],env=env,stdout=out,stderr=err,start_new_session=True,cwd=S)
  def watch():
   while not done.is_set():
    processes=subprocess.run(['ps','-eo','pid=,ppid=,rss=,etimes=,args='],capture_output=True,text=True).stdout.splitlines()
    parsed=[x.strip().split(None,4) for x in processes];owned={p.pid}
    for _ in range(4):
     owned.update(int(x[0]) for x in parsed if len(x)>=4 and int(x[1]) in owned)
    samples.append({'seconds':time.monotonic()-start,'processes':[x for x in parsed if int(x[0]) in owned],'gpu':gpu()})
    if time.monotonic()-start>180:stop(p);return
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
    if stage == 'fault-reload':
     def kill_new_child():
      deadline=time.monotonic()+10
      while time.monotonic()<deadline:
       children=subprocess.run(['ps','--ppid',str(p.pid),'-o','pid=,args='],capture_output=True,text=True).stdout.splitlines()
       for line in children:
        parts=line.strip().split(None,1)
        if len(parts)==2 and 'native-worker/entry.ts' in parts[1]:
         child=int(parts[0]);birth=Path(f'/proc/{child}/stat').read_text()
         save('injection.json',{'parentPid':p.pid,'childPid':child,'procStat':birth,'command':parts[1],'signal':'SIGKILL','seconds':time.monotonic()-start})
         os.kill(child,signal.SIGKILL);return
       time.sleep(.005)
      save('injection-missing.json',{'error':'child not observed'})
     threading.Thread(target=kill_new_child).start()
    req=urllib.request.Request(f'http://127.0.0.1:{port}/api/query',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=60) as resp:
     raw=resp.read();x=json.loads(raw);(E/(stage+'.response.json')).write_bytes(raw)
     row={'stage':stage,'ttl':ttl,'parentPid':p.pid,'status':resp.status,'ms':(time.monotonic()-queryStart)*1000,'request':body,'body':x};rows.append(row)
     print(json.dumps({'stage':stage,'status':resp.status,'ms':row['ms'],'count':len(x.get('results',[])),'meta':x.get('meta')}),flush=True)
     save('results.json',rows)
   time.sleep(.3)
  finally:
   stop(p);done.set();thread.join();save(name+'.process.json',{'parentPid':p.pid,'exit':p.returncode,'samples':samples,'statusPolls':polls,'gpuAfter':gpu()})
serve('fault',1200,[('fault-prime',0),('fault-reload',3.0),('fault-recovery',0)])
save('after.json',{'gpu':gpu()})
