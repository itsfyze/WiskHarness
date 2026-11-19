# Third-party notices

WiskHarness source uses the MIT license as stated in LICENSE. The approved WiskHarness logo is supplied by the project owner for product branding.

The Electron distribution contains Chromium and Electron notices, including `LICENSE.electron.txt` and `LICENSES.chromium.html`. Runtime npm packages keep the license files shipped with their respective distributions. The locked production dependency set includes MIT, ISC, BSD-3-Clause, and Apache-2.0 components.

Markdown rendering uses Marked (MIT), DOMPurify (Apache-2.0 or MPL-2.0) and Highlight.js CDN assets (BSD-3-Clause). The packaged runtime retains their upstream license files.

Agent Internet access uses the Model Context Protocol TypeScript SDK, Zod, html-to-text and ipaddr.js, each under MIT. The packaged runtime retains their upstream notices.

Ollama and model weights are managed separately. The optional portable Goose download comes from the official [Goose v1.59.2 release](https://github.com/aaif-goose/goose/releases/tag/v1.59.2) and is stored in the WiskHarness profile. Goose is distributed upstream under the [Apache License 2.0](https://github.com/aaif-goose/goose/blob/v1.59.2/LICENSE). The Windows packages do not bundle Goose, Ollama or model weights.
