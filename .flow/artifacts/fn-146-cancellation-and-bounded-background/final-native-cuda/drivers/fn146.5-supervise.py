"""Owned process-group resource/termination supervisor; physical invocation opt-in."""
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import sys
import time
import ctypes

if len(sys.argv) != 3 or sys.argv[2] != '--native':
    raise SystemExit('Usage: python3 notes/fn146.5-supervise.py CONFIG.json --native (host GPU grant required)')
config_path = pathlib.Path(sys.argv[1]).resolve()
config = json.loads(config_path.read_text())
root = pathlib.Path(config['root'])
metal = config['backend'] == 'metal'
allowed_prefix = '/private/tmp/fn1465-' if metal else '/home/gordon/.cache/agent-tmp/fn1465-'
if not str(root).startswith(allowed_prefix) or root.exists() or str(root.parent.resolve()/root.name) != str(root):
    raise SystemExit('New task-cache root required')
pressure_key = b'kern.memorystatus_vm_pressure_level'
def pressure():
    library = ctypes.CDLL(None, use_errno=True)
    value = ctypes.c_int()
    size = ctypes.c_size_t(ctypes.sizeof(value))
    if library.sysctlbyname(pressure_key, ctypes.byref(value), ctypes.byref(size), None, 0):
        raise OSError(ctypes.get_errno(), 'pressure unavailable')
    return value.value
preflight_pressure = pressure() if metal else None
if metal and preflight_pressure != 1:
    raise SystemExit('Normal-pressure preflight required: '+str(preflight_pressure))
root.mkdir(mode=0o700)
env = {key: value for key, value in os.environ.items() if key in ['PATH', 'LANG']}
env.update(TMPDIR=str(root), GNO_QA_SUPERVISED='1')
command = [config['bun'], '--no-env-file', str(pathlib.Path(__file__).with_name('fn146.5-run.ts')), '--config', str(config_path), '--native']
started = time.monotonic()
observed_pids = set()
reason = None
phase_id = 'preparation'
phase_started = started
previous_tick = started
previous_level = preflight_pressure
phase_warning = 0.0
total_warning = 0.0
policy = {'stratum': 'capacity-warning30-v1', 'normal': 1, 'warning': 2, 'critical': 4, 'warningBudgetSeconds': 30, 'phaseWallSeconds': 120, 'ownedGroupRssMiB': 6144, 'maxSampleIntervalSeconds': .25} if metal else {'wallSeconds': 600, 'ownedGroupRssMiB': 8192}
with (root/'supervisor.stdout').open('w') as stdout, (root/'supervisor.stderr').open('w') as stderr, (root/'resources.jsonl').open('w') as samples:
    child = subprocess.Popen(command, cwd=str(pathlib.Path(__file__).parent.parent), env=env, stdout=stdout, stderr=stderr, start_new_session=True)
    try:
        while child.poll() is None:
            tick = time.monotonic()
            level = pressure() if metal else None
            dt = tick-previous_tick
            if previous_level == 2:
                phase_warning += dt
                total_warning += dt
            previous_tick, previous_level = tick, level
            marker = root/'supervisor-phase.json'
            if marker.exists():
                current = json.loads(marker.read_text())
                if current['id'] != phase_id:
                    if metal and (phase_warning >= 30 or tick-phase_started >= 120):
                        reason = 'previous_phase_budget_exceeded'
                    if not current['previousReleased']:
                        reason = 'previous_phase_not_released'
                    samples.write(json.dumps({'event': 'phase-boundary', 'previous': phase_id, 'elapsedSeconds': tick-phase_started, 'warningSeconds': phase_warning, 'next': current})+'\n')
                    phase_id, phase_started, phase_warning = current['id'], tick-max(0, time.time()-current['startedAt']/1000), 0.0
                    if metal and level != 1:
                        reason = 'next_phase_requires_normal_pressure'
            rows = subprocess.run(['ps', '-axo', 'pid=,ppid=,pgid=,rss=,comm='], capture_output=True, text=True, timeout=.2 if metal else 2, check=True).stdout.splitlines()
            owned = [row.split(None, 4) for row in rows if len(row.split(None, 4)) == 5 and int(row.split(None, 4)[2]) == child.pid]
            pids = {int(row[0]) for row in owned}
            observed_pids.update(pids)
            rss = sum(int(row[3]) for row in owned)
            gpu = []
            if config['backend'] == 'cuda':
                result = subprocess.run(['nvidia-smi', '--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], capture_output=True, text=True)
                gpu = [line for line in result.stdout.splitlines() if line.split(',')[0].strip().isdigit() and int(line.split(',')[0]) in pids]
            elapsed = time.monotonic()-started
            phase_elapsed = tick-phase_started
            samples.write(json.dumps({'elapsedSeconds': elapsed, 'phase': phase_id, 'phaseElapsedSeconds': phase_elapsed, 'sampleIntervalSeconds': dt, 'pressure': level, 'phaseWarningSeconds': phase_warning, 'totalWarningSeconds': total_warning, 'owned': owned, 'ownedRssKiB': rss, 'ownedGpu': gpu})+'\n'); samples.flush()
            if elapsed > 600:
                reason = 'supervisor-time-bound'
            elif rss > (6144 if metal else 8192)*1024:
                reason = 'owned-rss-limit'
            elif metal and level == 4:
                reason = 'critical_pressure'
            elif metal and level not in (1, 2):
                reason = 'unexpected_pressure'
            elif metal and phase_warning >= 30:
                reason = 'warning_budget'
            elif metal and phase_elapsed >= 120:
                reason = 'phase_timeout'
            elif metal and dt > .25:
                reason = 'poll_interval_exceeded'
            if reason:
                break
            delay = (.2 if metal else .25)-(time.monotonic()-tick)
            if delay > 0:
                time.sleep(delay)
    except BaseException as error:
        reason = "governor_error:"+repr(error)
    # This group belongs only to this supervisor; clean descendants even if root exited.
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    end = time.monotonic()+5
    while time.monotonic() < end:
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(.1)
    else:
        os.killpg(child.pid, signal.SIGKILL)
    code = child.wait()
receipt = {'command': command, 'rootPid': child.pid, 'exit': code, 'stopReason': reason, 'elapsedSeconds': time.monotonic()-started, 'observedOwnedPids': sorted(observed_pids), 'configSha256': hashlib.sha256(config_path.read_bytes()).hexdigest(), 'policy': policy, 'totalWarningSeconds': total_warning, 'finalPressure': pressure() if metal else None}
(root/'supervisor.json').write_text(json.dumps(receipt, indent=2))
print(json.dumps(receipt))
raise SystemExit(code if code else (1 if reason else 0))
