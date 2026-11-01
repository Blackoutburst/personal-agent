# Runtime, dependencies and licensing

| Component | Selected version / status | Reason and license boundary |
| --- | --- | --- |
| Node.js | **24.22.1**, with bundled npm | Development/test pin shared by the reviewed account-preview unit and [account foundation #22](https://board.blackoutburst.com/?project=d03d401aee77dbf8708b0148a11dcee9&ticket=3e6b7b24b21aaf18d828eb9959442d7d). Verify the exact runtime separately from application deployment and runtime-ownership acceptance. |
| Runtime libraries | Node built-ins only: `node:http`, `node:sqlite`, `node:fs`, `node:path`, `node:url`, `node:crypto` | No external npm runtime dependencies. SQLite backs stable companion identities and the local owner-scoped private-state candidate; crypto supports identity keys, cursor/replay authentication and generated identifiers. |
| Tests | Built-in `node:test`, `node:assert/strict`, `node:os` and the runtime built-ins above | No external test framework or dependency install. |
| Web client | Original HTML/CSS/JavaScript | Direct static serving; no bundler, generated asset pipeline, downloaded fonts, external scripts or third-party assets. |
| Board | MCP contract source pinned to `25b35ad276cf9056f0cdd9d81791456a6499c189` | Protocol reference only. No Board executor source is adopted or bundled. |
| Personal Codex runtime | Native personal route selected; integration remains unqualified | No Codex installation/version, credential home or connected provider is established by this source. The in-progress binding candidate is unwired and its verifier defaults unavailable. See [PERSONAL-RUNTIME.md](PERSONAL-RUNTIME.md). |
| OpenClaw / Cindy | Not adopted | Prior planning compared them; this bootstrap imports no code, packages or assets from either. |

Node's official [v24.22.1 release directory](https://nodejs.org/dist/v24.22.1/) publishes [SHA-256 checksums](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt). Check the selected platform archive against that manifest when provisioning this exact version. Do not treat success on a different developer-host version as validation of the pin.

Node is MIT licensed and includes third-party components with their own notices. Retain its complete [v24.22.1 LICENSE](https://github.com/nodejs/node/blob/v24.22.1/LICENSE) and the notices supplied with any redistributed runtime. Using built-ins does not remove those distribution obligations. No Node runtime is licensed by this repository's product-code decision.

The license for the original companion product code is **undecided**. This bootstrap does not grant an MIT, Apache or other default open-source license to that code. Choose the product license explicitly before external distribution and review notices for anything introduced later.

Account integration is implemented in `src/account-validator.mjs`, `src/account-http.mjs`, `src/provisioning.mjs` and `server.mjs`; #5 completed the approved account-only split. The running account preview remains pinned to `9d57d26`, healthy and disabled at boot. Owner-reported admission/non-expiry passes and accepted isolated exact-source expiry proof do not constitute observation of an actual pilot timeout.

The #6 private-state implementation at `8eecd11` completed its accepted local split and is not deployed. See [PRIVATE-STATE.md](PRIVATE-STATE.md) for storage, deletion and platform-specific verification limits. Actual personal-runtime homes, binding, native authentication, inference, lifecycle and isolation remain with active #7 and #8; #20/#21 retain deployment and real cross-device/full-pilot gates. Provider credentials, model execution and live Board transport are absent from this candidate. Completed #3/#4 interface/source decisions remain reference history, not proof that those later integrations are qualified.
