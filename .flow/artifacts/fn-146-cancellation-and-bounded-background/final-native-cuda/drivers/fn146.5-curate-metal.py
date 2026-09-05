import gzip
import hashlib
import json
import pathlib
import shutil
import tarfile

target = pathlib.Path('.flow/artifacts/fn-146-cancellation-and-bounded-background/final-native-metal')
target.mkdir(parents=True, exist_ok=True)
inventory = []
for label, path in [('all-phases', 'notes/fn146.5-metal-raw'), ('fairness1024', 'notes/fn146.5-metal-fairness-raw')]:
    root = pathlib.Path(path)
    output = target / f'{label}-raw.tar.gz'
    sources = []
    with output.open('wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w') as bundle:
        for item in sorted(root.rglob('*')):
            if not item.is_file():
                continue
            relative = str(item.relative_to(root))
            bundle.add(item, arcname=relative, recursive=False)
            sources.append({'path': relative, 'sha256': hashlib.sha256(item.read_bytes()).hexdigest(), 'bytes': item.stat().st_size})
    inventory.append({'label': label, 'archive': output.name, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'rawFiles': sources})
for name in ['fn146.5-metal-native-summary.json', 'fn146.5-metal-native-inputs.json.gz', 'fn146.5-metal-fairness.json', 'fn146.5-metal-durable.json', 'fn146.5-metal-extraction.log', 'fn146.5-metal-staging.json', 'fn146.5-ivan-route-headroom.json', 'fn146.5-ivan-route-headroom.md']:
    shutil.copy2(pathlib.Path('notes') / name, target / name)
(target / 'inventory.json').write_text(json.dumps(inventory, indent=2))
print(json.dumps({'target': str(target), 'files': sum(p.is_file() for p in target.rglob('*')), 'bytes': sum(p.stat().st_size for p in target.rglob('*') if p.is_file())}))
