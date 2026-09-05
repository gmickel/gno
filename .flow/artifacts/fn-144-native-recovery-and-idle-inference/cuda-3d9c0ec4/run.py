import subprocess,os,time,json,pathlib,sys
r=pathlib.Path(__file__).parent
E=dict(os.environ)
E.update(HOME=str(r/'home'),XDG_CONFIG_HOME=str(r/'config'),XDG_DATA_HOME=str(r/'data'),XDG_STATE_HOME=str(r/'state'),XDG_CACHE_HOME=str(r/'cache'),GNO_CONFIG_DIR=str(r/'config'),GNO_DATA_DIR=str(r/'data'),GNO_CACHE_DIR=str(r/'cache'),GNO_OFFLINE='1',GNO_ALLOW_DOWNLOAD='0',GNO_LLAMA_GPU='cuda',GNO_LLAMA_BUILD='never',TMPDIR=str(r),QA_SOURCE=str(r/'source'))
name=sys.argv[1]; args=sys.argv[2:]
cmd=['bun',str(r/'source/src/index.ts'),*args] if args[0]!='script' else ['bun',str(r/args[1])]
capture=r/"evidence"/f"{name}.capture.json"
model="file:/home/gordon/.cache/gno/models/hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf"
json.dump({"runId":"simulator-3d9c0ec4-"+name,"caseId":name,"models":[{"role":"embedding","id":model,"sha256":"06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439","tokenizerSha256":"06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"}]},open(str(capture)+".request.json","w"))
E["GNO_ACCEPTANCE_CAPTURE"]=str(capture)
cmd=[cmd[0],"--preload",str(r/"phase-parent.ts"),"--preload",str(r/"source/evals/acceptance/parent-capture.ts"),*cmd[1:]]
out=open(r/'evidence'/f'{name}.stdout','w'); err=open(r/'evidence'/f'{name}.stderr','w')
start=time.time(); p=subprocess.Popen(cmd,cwd=r/'source',env=E,stdout=out,stderr=err,start_new_session=True)
with open(r/'evidence'/f'{name}.process.jsonl','w') as samples:
 while p.poll() is None:
  ps=subprocess.run(['ps','-eo','pid=,ppid=,pgid=,rss=,args='],capture_output=True,text=True).stdout
  owned=[line.strip() for line in ps.splitlines() if len(line.split())>=3 and line.split()[2]==str(p.pid)]
  gpu=subprocess.run(['nvidia-smi','--query-compute-apps=pid,process_name,used_memory','--format=csv,noheader'],capture_output=True,text=True).stdout
  samples.write(json.dumps({'elapsed':time.time()-start,'rootPid':p.pid,'owned':owned,'gpu':gpu})+'\n');samples.flush()
  if time.time()-start>600 or sum(int(line.split()[3]) for line in owned)>8192*1024:
   import signal
   os.killpg(p.pid,signal.SIGTERM)
   try:p.wait(timeout=15)
   except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
   break
  time.sleep(.5)
rc=p.wait();json.dump({'command':cmd,'pid':p.pid,'exitCode':rc,'elapsed':time.time()-start},open(r/'evidence'/f'{name}.receipt.json','w'),indent=2)
print(name,rc,round(time.time()-start,2));sys.exit(rc)
