"""Portable checksums plus lossless archive member identities, without native execution."""
import hashlib
import json
import pathlib
import sys
import tarfile

root = pathlib.Path(sys.argv[1])
for line in (root / 'SHA256SUMS').read_text().splitlines():
    expected, relative = line.split('  ', 1)
    assert hashlib.sha256((root / relative).read_bytes()).hexdigest() == expected, relative
sources = 0
for item in json.loads((root / 'inventory.json').read_text()):
    archive = root / item['archive']
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == item['sha256'], archive
    assert archive.read_bytes()[4:8] == b'\0\0\0\0', 'gzip mtime must be zero'
    with tarfile.open(archive, 'r:gz') as bundle:
        expected_paths = {row['path'] for row in item['rawFiles']}
        assert {entry.name for entry in bundle.getmembers() if entry.isfile()} == expected_paths
        for row in item['rawFiles']:
            content = bundle.extractfile(row['path']).read()
            assert len(content) == row['bytes'] and hashlib.sha256(content).hexdigest() == row['sha256'], row['path']
            sources += 1
print(json.dumps({'status': 'PASS', 'root': str(root), 'archivedSourceFiles': sources, 'nativeExecuted': False}))
