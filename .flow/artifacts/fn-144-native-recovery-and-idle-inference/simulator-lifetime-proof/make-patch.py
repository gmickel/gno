"""Generate a Bun patchedDependencies-compatible proposal; scratch paths only."""

from pathlib import Path
import difflib
import hashlib
import json
import shutil

root = Path(__file__).resolve().parent
module = "dist/gguf/insights/GgufInsights.js"
original = (root / "original" / module).read_bytes()
patched = (root / "patched" / module).read_bytes()
expected = "d848a262376282ec803817bde6a3083dd0d5a1607fecef937a7357ee29f74490"
assert hashlib.sha256(original).hexdigest() == expected, "Original 3.19.1 module changed"
lines = difflib.unified_diff(
        original.decode().splitlines(keepends=True),
        patched.decode().splitlines(keepends=True),
        fromfile=f"a/{module}",
        tofile=f"b/{module}",
)
diff = f"diff --git a/{module} b/{module}\n" + "".join(
    line if line.endswith("\n") else line + "\n\\ No newline at end of file\n"
    for line in lines
)
patch = root / "node-llama-cpp@3.19.1.patch"
patch.write_text(diff)
target = root / "verify" / module
target.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(root / "original" / module, target)
manifest = {
    "upstream": "https://github.com/withcatai/node-llama-cpp/commit/3f686d75aa9cda1b20b80465883f5f7358e42880",
    "package": "node-llama-cpp@3.19.1",
    "native_release": "b10068",
    "license": "MIT, Copyright (c) 2023 Gilad S.",
    "changed_package_files": [module],
    "original_sha256": expected,
    "patched_sha256": hashlib.sha256(patched).hexdigest(),
    "patch_sha256": hashlib.sha256(patch.read_bytes()).hexdigest(),
    "upstream_source_sha256": hashlib.sha256((root / "upstream-GgufInsights.ts").read_bytes()).hexdigest(),
    "tests": {
        "original": "SIMULATOR_SIDE=original bun --no-env-file test ./notes/fn144-simulator-patch/lifetime.test.ts -t 'paused speculative context'",
        "original_exit": 1,
        "original_result": "1 expected failure: model free occurred while context init was paused",
        "patched": "SIMULATOR_SIDE=patched bun --no-env-file test ./notes/fn144-simulator-patch/lifetime.test.ts",
        "patched_exit": 0,
        "patched_result": "5 pass, 0 fail, 19 assertions",
    },
    "native_probe": "none",
    "installed_mutations": "none",
}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"patch_sha256": manifest["patch_sha256"], "patched_sha256": manifest["patched_sha256"]}))
