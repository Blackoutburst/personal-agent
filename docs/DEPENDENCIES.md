# Runtime, dependencies and licensing

| Component | Selected version / status | Reason and license boundary |
| --- | --- | --- |
| Node.js | **24.22.1**, with bundled npm | Aligns with the Node 24.22.1 runtime recorded in [account foundation #22](https://board.blackoutburst.com/?project=d03d401aee77dbf8708b0148a11dcee9&ticket=3e6b7b24b21aaf18d828eb9959442d7d). This is a local development pin, not a deployed companion claim. |
| Runtime libraries | Node built-ins only: `node:http`, `node:sqlite`, `node:fs`, `node:path`, `node:url` | No external npm runtime dependencies. SQLite usage provides local metadata/namespace scaffolding, not qualified private-user storage. |
| Tests | Built-in `node:test`, `node:assert/strict`, `node:os` and the runtime built-ins above | No external test framework or dependency install. |
| Web client | Original HTML/CSS/JavaScript | Direct static serving; no bundler, generated asset pipeline, downloaded fonts, external scripts or third-party assets. |
| Board | MCP contract source pinned to `25b35ad276cf9056f0cdd9d81791456a6499c189` | Protocol reference only. No Board executor source is adopted or bundled. |
| OpenClaw / Cindy | Not adopted | Prior planning compared them; this bootstrap imports no code, packages or assets from either. |

Node's official [v24.22.1 release directory](https://nodejs.org/dist/v24.22.1/) publishes [SHA-256 checksums](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt). Check the selected platform archive against that manifest when provisioning this exact version. Do not treat success on a different developer-host version as validation of the pin.

Node is MIT licensed and includes third-party components with their own notices. Retain its complete [v24.22.1 LICENSE](https://github.com/nodejs/node/blob/v24.22.1/LICENSE) and the notices supplied with any redistributed runtime. Using built-ins does not remove those distribution obligations. No Node runtime is licensed by this repository's product-code decision.

The license for the original companion product code is **undecided**. This bootstrap does not grant an MIT, Apache or other default open-source license to that code. Choose the product license explicitly before external distribution and review notices for anything introduced later.

Account, provider and private-runtime contracts remain unavailable. There are no live credentials, subscription connection, model calls or external Board requests in the skeleton. Production filesystem ACLs, encryption, tenant access, revocation/deletion and backup handling belong to companion #6 and the relevant upstream contracts; they are not established by SQLite persistence or a loopback bind.
