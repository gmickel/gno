# Converter dependency repair

GNO imports the unchanged upstream distributions under `vendor/converters`.
These are ordinary source files in GNO's package, not installed npm dependency
packages. Their original manifests and licenses are retained verbatim for
provenance. No upstream manifest was patched. GNO's root dependencies supply
their external imports, including these corrected parser edges:

| Distribution         | Upstream dependency | GNO dependency                |
| -------------------- | ------------------- | ----------------------------- |
| markitdown-ts 0.0.10 | xlsx ^0.18.5        | SheetJS 0.20.3 (`@e965/xlsx`) |
| officeparser 7.8.0   | pdfjs-dist 6.1.200  | pdfjs-dist 6.3.289            |

SheetJS stopped publishing to npm after the vulnerable 0.18.5, and its official
distribution is the URL tarball
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. URL dependencies are
rejected by installers that block exotic transitive specifiers (pnpm, aube and
mise `blockExoticSubdeps`), so GNO resolves `xlsx` through the registry alias
`npm:@e965/xlsx@0.20.3`, an automated republish with npm build provenance from
`github.com/e965/sheetjs-npm-publisher`. Its integrity is
`sha512-703RN/3OdsRD5mtse2HBX7Um7xwaP9tlswEG6svOtjqokXoX7rJdQj7DyabD2I+xk22RgaIIU+R6BHgkpZGB/w==`.
Keep the version exact, never ranged: the republisher is a third party, so a
bump must be re-verified by extracting both tarballs and running `diff -r`.
For 0.20.3 only `package.json` (name, repository, whitespace) and `README.md`
(a republisher note and absolute links) differ; every code, type and dist file
is byte-identical to the official tarball.
It has no install lifecycle scripts. MarkItDown uses the retained `read` and
`utils.sheet_to_html` APIs for GNO's buffer conversion path. PDF-parse retains
its independent PDF.js 5.4.296 dependency; do not globally override it to 6.

## Reproduce upstream files

Run from the repository root, with a destination that does not exist:

```sh
python3 vendor/dependency-fixes/vendor-converters.py /path/to/new/converters
```

The script verifies pinned upstream tarball SHA512 values before copying any
distribution files. It copies every upstream `dist` file, original package
manifest, and license/notice unchanged. `upstream-manifest.json` records original
tarball SHA256, SHA512, byte counts, and each retained file's SHA256. MarkItDown
contributes 7 files; Officeparser contributes 92. The receipt is the 100th file.
No repacked upstream tarball is shipped. Never format the upstream files.

GNO's root manifest must retain the external dependencies required by these
distributions. The tested dependency set was @joplin/turndown-plugin-gfm 1.0.67,
@xmldom/xmldom 0.9.12, ai 6.0.277, jsdom 25.0.1, mammoth 1.12.2,
mime-types 2.1.35, pdf-parse 2.4.5, turndown 7.2.4, the SheetJS URL above,
fflate 0.8.3, file-type 22.0.2, pdfjs-dist 6.3.289, tesseract.js 7.0.0,
and zod 4.4.3. Existing GNO dependencies may advance under their own gates.

## Consumer feasibility evidence

An isolated parent tarball containing these distributions and normal root
dependencies was installed into fresh npm 11.17.0 and Bun 1.4.2 consumers with
installation scripts disabled. Both consumers resolved XLSX 0.20.3 from the
vendored MarkItDown location and PDF.js 6.3.289 from the vendored Officeparser
location. Both converted the real XLSX fixture (Widget/Gadget) and PPTX fixture
(presentation title/speaker notes). Native dependencies were installed normally
by each consumer; no platform-specific dependency tree was bundled.

Rejected approaches: nested `file:vendor/child.tgz` dependencies failed ENOENT in
both package managers; full dependency bundling added over 100 MB compressed
and captured platform-specific native dependencies; omitting the bundled
transitive closure left imports unresolved. Root overrides alone do not control
downstream npm consumers.

Focused repository verification:

```sh
bun test test/converters/vendored-dependencies.test.ts test/converters/integration.test.ts test/converters/protected-files.test.ts test/converters/pipeline.test.ts
```

The provenance/resolution regression checks every retained upstream file and the
two corrected parser versions. Integration coverage exercises PDF, DOCX, XLSX,
PPTX and protected-file behavior. Full GNO packed-consumer validation remains
part of the release gate; the isolated feasibility probe does not replace it.

Primary sources:

- https://docs.sheetjs.com/docs/getting-started/installation/nodejs/
- https://github.com/advisories/GHSA-5pgg-2g8v-p4x9
- https://registry.npmjs.org/markitdown-ts/0.0.10
- https://registry.npmjs.org/officeparser/7.8.0
- https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides
