import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile

root = Path('/home/gordon/work/gno')
rows = []
for platform in ('cuda', 'metal'):
    base = root / '.flow/artifacts/fn-146-cancellation-and-bounded-background' / f'final-native-{platform}'
    check = subprocess.run(['sha256sum', '--check', 'SHA256SUMS'], cwd=base, capture_output=True, text=True)
    (root / 'notes' / f'fn146.5-host-{platform}-sha.log').write_text(check.stdout + check.stderr)
    check.check_returncode()
    total = 0
    for record in json.loads((base / 'inventory.json').read_text()):
        archive = base / record['archive']
        with archive.open('rb') as stream:
            assert hashlib.file_digest(stream, 'sha256').hexdigest() == record['sha256'], archive
        expected = {item['path']: item for item in record['rawFiles']}
        assert len(expected) == len(record['rawFiles'])
        with tarfile.open(archive, 'r|gz') as tar:
            for member in tar:
                path = PurePosixPath(member.name)
                assert not path.is_absolute() and '..' not in path.parts, member.name
                if member.isdir():
                    continue
                assert member.isfile(), member.name
                item = expected.pop(member.name)
                assert member.size == item['bytes'], member.name
                with tar.extractfile(member) as stream:
                    assert hashlib.file_digest(stream, 'sha256').hexdigest() == item['sha256'], member.name
                total += 1
        assert not expected, list(expected)
    rows.append({'platform': platform, 'archives': len(json.loads((base / 'inventory.json').read_text())), 'verifiedRawFiles': total, 'checksumsPassed': True})
print(json.dumps(rows, indent=2))
(root / 'notes/fn146.5-host-verification.json').write_text(json.dumps(rows, indent=2) + '\n')
