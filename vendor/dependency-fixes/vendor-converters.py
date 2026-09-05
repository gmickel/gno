#!/usr/bin/env python3
"""Copy pinned upstream converter distributions verbatim into a NEW output root.

Usage: python3 vendor/dependency-fixes/vendor-converters.py OUTPUT_DIRECTORY
No installation, lifecycle scripts, package manifest edits, or Git operations.
The caller promotes external dependencies into GNO's root manifest and imports
these distributions directly; their upstream package manifests stay unchanged.
"""

import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile
import urllib.request

PACKAGES = (
    (
        "markitdown-ts",
        "0.0.10",
        "sha512-QcGD+ilrtgBli+XH7YoEURfE345SYsOmxlB40HYGCccbkJb1DTf09iW7rMFcsQQ7mpEVEyYsvgDWVFC1sTp+4w==",
    ),
    (
        "officeparser",
        "7.8.0",
        "sha512-z3stbbcwTA4HsGuUz2XJEBbl6WV1X2qCvuiokc2D0593wnu8H7kaD9UY5YAHc8uMjMhH07FxXikzP0BFLSna4A==",
    ),
)


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=False)
    receipt = {"schemaVersion": 1, "packages": []}
    for name, version, integrity in PACKAGES:
        url = f"https://registry.npmjs.org/{name}/-/{name}-{version}.tgz"
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
        actual = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
        if actual != integrity:
            raise RuntimeError(f"Upstream integrity mismatch: {name}")
        record = {
            "name": name,
            "version": version,
            "url": url,
            "integrity": actual,
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "files": {},
        }
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            for member in archive:
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or path.parts[0] != "package":
                    raise RuntimeError(f"Unsafe archive entry: {member.name}")
                relative = PurePosixPath(*path.parts[1:])
                selected = (
                    relative.parts and relative.parts[0] == "dist"
                    or str(relative) == "package.json"
                    or relative.name.upper().startswith(("LICENSE", "NOTICE"))
                )
                if not selected or member.isdir():
                    continue
                if not member.isfile():
                    raise RuntimeError(f"Nonregular distribution entry: {member.name}")
                payload = archive.extractfile(member).read()
                destination = output / name / str(relative)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(payload)
                record["files"][str(relative)] = hashlib.sha256(payload).hexdigest()
        receipt["packages"].append(record)
    (output / "upstream-manifest.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    )
    print(json.dumps({"output": str(output), "packages": len(PACKAGES)}))


if __name__ == "__main__":
    main()
