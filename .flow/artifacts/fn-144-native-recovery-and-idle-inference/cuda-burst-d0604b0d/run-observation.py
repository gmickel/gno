import json, os, pathlib, signal, subprocess, sys, threading, time

root = pathlib.Path(__file__).resolve().parent
plan_path = pathlib.Path(sys.argv[1]).resolve()
plan = json.loads(plan_path.read_text())
out = pathlib.Path(plan['outputPath']).parent
out.mkdir(parents=True, exist_ok=True)
if (out / 'process-receipt.json').exists():
    raise RuntimeError('Observation already exists')
isolated = out / 'isolation'
isolated.mkdir(mode=0o700)
env = dict(os.environ)
env.update(HOME=str(isolated/'home'), XDG_CONFIG_HOME=str(isolated/'config'), XDG_DATA_HOME=str(isolated/'data'), XDG_STATE_HOME=str(isolated/'state'), XDG_CACHE_HOME=str(isolated/'cache'), GNO_CONFIG_DIR=str(isolated/'config'), GNO_DATA_DIR=str(isolated/'data'), GNO_CACHE_DIR=plan['cacheDir'], GNO_OFFLINE='1', GNO_ALLOW_DOWNLOAD='0', GNO_LLAMA_GPU='cuda', GNO_LLAMA_BUILD='never', CUDA_PATH='/opt/cuda', TMPDIR=str(isolated))
for key in ['GNO_ACCEPTANCE_CAPTURE', 'GNO_ACCEPTANCE_CHILD_BOOTSTRAP', 'QA_SOURCE', 'QA_PHASE_SOURCE', 'QA_PHASE_DIRECTORY']:
    env.pop(key, None)
driver = root / ('seed.ts' if plan.get('seed') else ('capture-control.ts' if plan.get('capture') else 'burst-driver.ts'))
command = ['bun', '--no-env-file', str(driver), str(plan_path)]
if plan.get('hashDiagnostic'):
    directory = out / 'hash-streams'
    directory.mkdir(mode=0o700)
    env['GNO_HASH_DIAGNOSTIC_DIRECTORY'] = str(directory)
    command = ['bun', '--no-env-file', '--preload', str(root/'hash-parent.ts'), str(driver), str(plan_path)]
started = time.monotonic()
first_response = []
with (out/'stdout.log').open('w') as stdout, (out/'stderr.log').open('w') as stderr:
    process = subprocess.Popen(command, cwd=plan['sourceRoot'], env=env, stdout=subprocess.PIPE, stderr=stderr, text=True, start_new_session=True)
    def consume():
        for line in process.stdout:
            received = time.monotonic()
            stdout.write(line); stdout.flush()
            try:
                value = json.loads(line)
                if value.get('event') == 'first-response':
                    first_response.append({'spawnToFirstResponseMs': (received-started)*1000, 'event': value})
            except (ValueError, AttributeError):
                pass
    reader = threading.Thread(target=consume)
    reader.start()
    stop = None
    with (out/'process.jsonl').open('w') as samples:
        while process.poll() is None:
            ps = subprocess.run(['ps','-eo','pid=,ppid=,pgid=,rss=,args='], capture_output=True, text=True).stdout
            owned = [line.strip() for line in ps.splitlines() if len(line.split()) >= 4 and line.split()[2] == str(process.pid)]
            gpu = subprocess.run(['nvidia-smi','--query-compute-apps=pid,process_name,used_memory','--format=csv,noheader'], capture_output=True, text=True).stdout
            elapsed = time.monotonic()-started
            rss = sum(int(line.split()[3]) for line in owned)
            samples.write(json.dumps({'elapsed':elapsed,'rootPid':process.pid,'owned':owned,'ownedRssKiB':rss,'gpu':gpu})+'\n'); samples.flush()
            if elapsed > (600 if plan.get('seed') else 180): stop='time-bound'
            elif rss > 8192*1024: stop='owned-rss-bound'
            if stop:
                os.killpg(process.pid, signal.SIGTERM)
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGKILL); process.wait()
                break
            time.sleep(.5)
    code = process.wait()
    reader.join(timeout=10)
receipt = {'command':command,'pid':process.pid,'exitCode':code,'stopReason':stop,'wallMs':(time.monotonic()-started)*1000,'firstResponse':first_response}
(out/'process-receipt.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps(receipt))
sys.exit(code if code else (1 if stop else 0))
