"""Reuse the existing owned SSH master; never start/stop/reconfigure it."""
import pathlib
import shlex
import subprocess
import sys

socket = '/home/gordon/.cache/agent-tmp/gno-fn144-childcapture/ivan-lan.sock'
ssh = ['ssh', '-S', socket, '-o', 'HostKeyAlias=ivan', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-o', 'ProxyCommand=false', '-o', 'ControlMaster=no', 'gordon@192.168.0.30']
if not pathlib.Path(socket).is_socket():
    raise SystemExit('Owned SSH master socket unavailable; no alternate route started')
if len(sys.argv) == 2 and sys.argv[1] == '--check':
    raise SystemExit(subprocess.call(ssh[:-1]+['-O', 'check', ssh[-1]]))
if len(sys.argv) != 4 or sys.argv[1] != '--run' or sys.argv[3] != '--native':
    raise SystemExit('Usage: --check | --run /private/tmp/fn1465-tools-ID/metal-run.json --native (host grant required)')
config = pathlib.PurePosixPath(sys.argv[2])
if not str(config.parent).startswith('/private/tmp/fn1465-tools-') or config.name not in {'metal-run.json', 'metal-fairness-run.json'} or '..' in config.parts:
    raise SystemExit('Owned remote QA configuration required')
command = ['python3', str(config.parent/'fn146.5-supervise.py'), str(config), '--native']
# Foreground SSH keeps its result; remote supervisor independently owns and bounds its group.
raise SystemExit(subprocess.call(ssh+[shlex.join(command)]))
