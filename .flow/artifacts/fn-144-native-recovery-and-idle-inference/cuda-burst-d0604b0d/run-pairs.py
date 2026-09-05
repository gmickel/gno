import json, pathlib, subprocess, sys

root = pathlib.Path(__file__).resolve().parent
plans = json.loads((root/'execution-order.json').read_text())
receipts = []
for plan in plans:
    result = subprocess.run([sys.executable,str(root/'run-observation.py'),plan], check=False)
    receipts.append({'plan':plan,'exitCode':result.returncode})
    (root/'execution-receipts.json').write_text(json.dumps(receipts,indent=2))
    print(pathlib.Path(plan).stem, result.returncode, flush=True)
sys.exit(0 if all(item['exitCode']==0 for item in receipts) else 1)
