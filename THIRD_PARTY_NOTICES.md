# Third-Party Notices

This project includes the following third-party components:

## node-llama-cpp simulator lifetime guards

- **Source**: `src/llm/nodeLlamaCpp/simulator-session.ts` and `simulator-handle.ts`
- **License**: MIT
- **Copyright**: (c) 2023 Gilad S.
- **Upstream**: https://github.com/withcatai/node-llama-cpp/commit/3f686d75aa9cda1b20b80465883f5f7358e42880 (PR 636)

The guarded simulator session/model-handle implementation is backported for
node-llama-cpp 3.19.1. GNO adds a local finalizer helper, shared disposal promises,
and cleanup when native model initialization or handle acquisition fails. The
factory is installed in memory; dependency files and native binaries are unchanged.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## less-pager-mini

- **License**: MIT
- **Copyright**: Dawson Huang
- **Project URL**: https://github.com/dawsonhuang0/Less-Pager-Mini

Installed as a runtime dependency to provide the built-in Windows terminal pager.

## char-width

- **License**: MIT
- **Copyright**: Dawson Huang
- **Project URL**: https://github.com/legend80s/char-width

Installed transitively by `less-pager-mini` for terminal display-width calculation.

## fts5-snowball

- **Source**: vendored under `vendor/fts5-snowball/`
- **License**: BSD-3-Clause
- **Copyright**: (c) 2016 Abilio Marques
- **Project URL**: https://github.com/abiliojr/fts5-snowball

See `vendor/fts5-snowball/LICENSE` for the full license text.

## Snowball Stemmer Library

Bundled within fts5-snowball.

- **License**: BSD-3-Clause
- **Copyright**: (c) 2001-2025 Dr Martin Porter and Richard Boulton
- **Project URL**: https://github.com/snowballstem/snowball

See `vendor/fts5-snowball/LICENSE` for the full license text.
