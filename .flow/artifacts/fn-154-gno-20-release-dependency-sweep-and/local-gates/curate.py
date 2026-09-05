"""Archive the explicitly selected local receipts without installed project trees."""

import gzip
import hashlib
import json
from pathlib import Path

BASE = Path('/home/gordon/.cache/agent-tmp')
OUT = Path(__file__).resolve().parent
GATES = [
    'gno-release-64400ffe-tests.log',
    'gno-release-lint-final.log',
    'gno-release-lint-final2.log',
    'gno-release-typecheck-final.log',
    'gno-release-docs-final.log',
    'gno-release-frozen-final.log',
    'gno-release-shell-frozen.log',
    'gno-release-clipper-build.log',
    'gno-release-clipper-verify.log',
    'gno-release-64400ffe-package-smoke.log',
    'gno-release-64400ffe-package-smoke-isolated.log',
    'gno-release-package-comparison.json',
]


def direct(root):
    return sorted(p for p in root.iterdir() if p.is_file() and not p.is_symlink())


consumer = BASE / 'gno-final-consumers-6cp7uhwr'
evalite = BASE / 'fn154-evalite-compat'
frontend = BASE / 'fn154-frontend-qa'
groups = {
    'gates': (BASE, [BASE / name for name in GATES]),
    'consumers': (consumer, direct(consumer)),
    'evalite': (evalite, direct(evalite) + sorted((evalite / 'files').glob('*.png'))),
    'frontend': (frontend, sorted(p for p in frontend.rglob('*') if p.is_file() and not p.is_symlink())),
}
summary = {}
for name, (root, files) in groups.items():
    entries = []
    for source in files:
        relative = source.relative_to(root)
        assert not any(part in {'node_modules', 'scoped', '.git'} for part in relative.parts)
        raw = source.read_bytes()
        packed = gzip.compress(raw, compresslevel=9, mtime=0)
        destination = OUT / name / (str(relative) + '.gz')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(packed)
        assert gzip.decompress(destination.read_bytes()) == raw
        assert destination.read_bytes()[4:8] == bytes(4)
        entries.append({
            'source': str(source), 'logical_path': str(relative),
            'archive_path': str(destination.relative_to(OUT)),
            'raw_bytes': len(raw), 'raw_sha256': hashlib.sha256(raw).hexdigest(),
            'gzip_bytes': len(packed), 'gzip_sha256': hashlib.sha256(packed).hexdigest(),
        })
    manifest = {'gzip_mtime': 0, 'files': entries, 'count': len(entries),
                'raw_bytes': sum(e['raw_bytes'] for e in entries),
                'gzip_bytes': sum(e['gzip_bytes'] for e in entries)}
    (OUT / name / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    summary[name] = {key: manifest[key] for key in ('count', 'raw_bytes', 'gzip_bytes')}
totals = {key: sum(group[key] for group in summary.values()) for key in ('count', 'raw_bytes', 'gzip_bytes')}
(OUT / 'manifest.json').write_text(json.dumps({
    'candidate_commit': '64400ffeffa59ddb58dfd10f1e6386a7eb81f6a6',
    'package_sha256': '94581ea58f100a6d1e50c311d14addb158b0defa3771e87aace603df4f52e224',
    'groups': summary, 'totals': totals,
    'verification': 'Every archived payload was decompressed and compared byte-for-byte to its source; gzip mtime is zero.'
}, indent=2) + '\n')
print(json.dumps({'groups': summary, 'totals': totals}, indent=2))
