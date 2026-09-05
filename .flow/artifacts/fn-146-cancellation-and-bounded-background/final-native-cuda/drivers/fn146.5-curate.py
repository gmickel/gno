"""Curate synthetic final native evidence; model/index/cache payloads remain task-local."""
import hashlib
import gzip
import json
import pathlib
import shutil
import tarfile

target = pathlib.Path('.flow/artifacts/fn-146-cancellation-and-bounded-background/final-native-cuda')
target.mkdir(parents=True, exist_ok=True)
specs = [
    ('v1', 'notes/fn146.5-final-run-config.json', 'Harness capture scope overlap; only embedding init completed. Original stdout drain invalid.'),
    ('v2', 'notes/fn146.5-final-v2-run-config.json', 'HTTP partial coverage; harness redundant pending-phase read missed a completed stage.'),
    ('v3', 'notes/fn146.5-final-v3-run-config.json', 'MCP notification accepted/native settled; raw caller not retired. Owned run stopped at91.98s.'),
    ('v4', 'notes/fn146.5-final-v4-run-config.json', 'MCP notification recovery captured; repeated session initialize rejected.'),
    ('v5-http', 'notes/fn146.5-final-v5-run-config.json', 'All HTTP cancellation and idle/background query+verified Ask captured. Shutdown precondition incorrectly awaited sync embedding completion.'),
    ('v6-continuation', 'notes/fn146.5-final-v6-run-config.json', 'Six actual API/restart/stdio/packaged CLI phases completed with owned descendant absence.'),
    ('pending1024', 'notes/fn146.5-final-backlog1024-run-config.json', '1088 durable pending after default shutdown; restart completes1088/1088 with no missing/duplicate owners.'),
    ('fairness1024', 'notes/fn146.5-final-fairness-run-config.json', 'Twelve concurrent unchanged queries; actual eight-completion background demand dispatch and33 bounded native batches.'),
]
excluded = {'data', 'home', 'cache', 'state', 'config', 'bun', 'backlog'}
inventory = []
for label, config_path, status in specs:
    config = json.loads(pathlib.Path(config_path).read_text())
    root = pathlib.Path(config['root'])
    archive = target / f'{label}-raw.tar.gz'
    raw_files = []
    with archive.open('wb') as raw_output, gzip.GzipFile(filename='', mode='wb', fileobj=raw_output, mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w') as bundle:
        for path in sorted(root.rglob('*')):
            relative = path.relative_to(root)
            if not path.is_file() or excluded.intersection(relative.parts):
                continue
            bundle.add(path, arcname=str(relative), recursive=False)
            raw_files.append({'path': str(relative), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size})
        bundle.add(config_path, arcname='pinned-launch-config.json')
    inventory.append({'label': label, 'status': status, 'originalRoot': str(root), 'archive': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'rawFiles': raw_files, 'supervisor': json.loads((root / 'supervisor.json').read_text())})

helpers = target / 'drivers'
helpers.mkdir(exist_ok=True)
for path in pathlib.Path('notes').glob('fn146.5-*.ts'):
    shutil.copy2(path, helpers / path.name)
for name in ['fn146.5-supervise.py', 'fn146.5-ivan-transport.py', 'fn146.5-native-analysis.py', 'fn146.5-curate.py']:
    shutil.copy2(pathlib.Path('notes') / name, helpers / name)
for name in ['fn146.5-cuda-native-summary.json', 'fn146.5-cuda-native-inputs.json.gz', 'fn146.5-cuda-fairness.json', 'fn146.5-first-negative.json', 'fn146.5-v2-response-reanalysis.json', 'fn146.5-final-prepared.md', 'fn146.5-final-binding-preflight.json', 'fn146.5-final-shutdown-source-pins.json', 'fn146.5-scope-v2-preflight.log']:
    shutil.copy2(pathlib.Path('notes') / name, target / name)
package = pathlib.Path('/home/gordon/.cache/agent-tmp/gno-final-package-f64c41c9')
shutil.copy2(package / 'manifest.json', target / 'package-manifest.json')
shutil.copy2(package / 'helpers-8b45a54d.tar', target / 'helpers-8b45a54d.tar')
fixture = target / 'synthetic-foreground'
fixture.mkdir(exist_ok=True)
original = pathlib.Path('/home/gordon/.cache/agent-tmp/gno-fn144-packed-surfaces-98252a9c/ask29')
for name in ['original-manifest.json', 'config.json', 'prep-provenance.json']:
    shutil.copy2(original / name, fixture / name)
for path in (original / 'corpus/probe').glob('*.md'):
    shutil.copy2(path, fixture / path.name)
(target / 'inventory.json').write_text(json.dumps(inventory, indent=2))
checksums = [f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(target)}' for p in sorted(target.rglob('*')) if p.is_file() and p.name != 'SHA256SUMS']
(target / 'SHA256SUMS').write_text('\n'.join(checksums) + '\n')
print(json.dumps({'target': str(target), 'files': len(checksums)+1, 'bytes': sum(p.stat().st_size for p in target.rglob('*') if p.is_file()), 'rawArchives': len(specs)}))
