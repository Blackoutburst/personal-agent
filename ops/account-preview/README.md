# Account-preview operator source

These are the reviewed sources for the owner-run account-only staging installer. The generated, SHA-pinned installer and manifest delivered through [Personal Agent task #5](https://board.blackoutburst.com/?project=f0ad83b792830c7cd190412ee8f48997&ticket=bc3bfb0f03fc3283718cd50884503bcc) identify the concrete approved inputs. The template contains hash placeholders and is not the command to run.

The application release remains `9d57d26203554e461e1271d2c9cca4421a54e308`, from the exact source archive with SHA256 `bd9325633bf323d5ed45e369f9f1672efd3872e8ad8c0a57b1697156ab208e9d`. Its raw archive member hashes include the export's line endings; a new checkout is not a substitute for that pinned artifact. This operator-source update changes verification and recovery tooling, not the staged application.

The 1 November v2 attempt failed its anonymous HTTP check and reported a completed rollback. Read-only checks confirmed the original root-vhost hash, absent unit/include, zero service PIDs/listeners, and retained valid private two-principal configuration. The exact failing HTTP leg/status was not recorded. An isolated probe reproduced the expected anonymous and invalid-cookie denials. A separate verifier defect used `/health` instead of the platform's `/healthz` endpoint.

V3 waits at most 15 seconds for the public account-mode status route after reload, retrying only the old configuration's 404. It still requires exact 401/no-store denial and refuses unexpected readiness or active provider/runtime states. Failures expose only a fixed leg, status, no-store boolean and allowlisted error code. [Nginx reload documentation](https://nginx.org/en/docs/control.html#reconfiguration) describes the asynchronous worker transition; that timing remains a possible explanation for v2, not an observed cause.

V3 accepts only the pinned v2 anonymous-denial attempt in a cleanly rolled-back state. It verifies prior source/configuration identities, complete restored nginx context and unchanged other sources; the restored target's inode is allowed to change. Separate v3 journal/backup paths preserve v2 evidence. The retained private pilot file is validated without re-prompting or rewriting identities. Shared platform/Games configuration stays unchanged. No provider or personal-runtime activation is included.

Run the four `test_*.py` files in this directory with Python 3 on Linux for focused operator checks. They use synthetic files/process responses and never invoke a privileged installation. The frozen `nginx_staging_context.py` supports compatibility fixtures. Actual privileged installation and two-owner sign-in/stability/logout observations remain separate acceptance gates.

Keep pilot UUIDs, cookies, private journals, platform account responses, database files and host configuration snapshots out of Git and Board payloads. Only the installer's printed sanitized result belongs in the ticket.
