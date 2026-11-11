#!/bin/bash
# Install or update C-chan's agent sandbox (#71, docs/SANDBOX.md). Idempotent; run as root from a checkout:
#   sudo ops/sandbox/setup.sh
# Creates the cchan-agents user and /var/lib/cchan-agents, installs the slice, the run wrapper, the hardening list,
# the worktree tool, and root-owned copies of node and claude (agents cannot replace their own tools).
# Never copies any credential: the sandbox's Claude login (CLAUDE_CONFIG_DIR=/var/lib/cchan-agents/claude) is made by
# the owner signing in once (#72).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
SRC=$(cd "$(dirname "$0")/../.." && pwd)
U=cchan-agents R=/var/lib/cchan-agents LIB=/usr/local/lib/cchan-sandbox
NODE=${CCHAN_NODE:-/opt/blackoutburst-platform-runtime/node-v24.22.1}
CLAUDE=${CCHAN_CLAUDE:-$(readlink -f /home/ubuntu/.local/bin/claude)}

getent group $U >/dev/null || groupadd --system $U
id -u $U >/dev/null 2>&1 || useradd --system --gid $U --home-dir $R/home --no-create-home \
  --shell /usr/sbin/nologin --comment "C-chan agent sandbox (#71)" $U
passwd -l $U >/dev/null

install -d -o $U -g $U -m 0750 $R
for d in home repos worktrees claude logs; do install -d -o $U -g $U -m 0750 $R/$d; done
install -d -o root -g root -m 0755 $R/bin
install -o root -g root -m 0755 "$NODE" $R/bin/node
install -o root -g root -m 0755 "$CLAUDE" $R/bin/claude

install -d -o root -g root -m 0755 $LIB $LIB/src $LIB/ops/sandbox
install -o root -g root -m 0644 "$SRC/src/sandbox.mjs" $LIB/src/sandbox.mjs
install -o root -g root -m 0644 "$SRC/ops/sandbox/worktree.mjs" $LIB/ops/sandbox/worktree.mjs
install -o root -g root -m 0644 "$SRC/ops/sandbox/properties" $LIB/properties
install -o root -g root -m 0755 "$SRC/ops/sandbox/verify.sh" $LIB/verify.sh
install -o root -g root -m 0755 "$SRC/ops/sandbox/cchan-sandbox-run" /usr/local/sbin/cchan-sandbox-run
install -o root -g root -m 0644 "$SRC/ops/sandbox/cchan-agents.slice" /etc/systemd/system/cchan-agents.slice
systemctl daemon-reload

# Agents commit under their own name; publishing to GitHub happens outside the sandbox (docs/SANDBOX.md).
gitcfg() { runuser -u $U -- env HOME=$R/home git config --global "$@"; }
gitcfg user.name "C-chan agents"
gitcfg user.email "cchan-agents@blackoutburst.dev"
gitcfg init.defaultBranch main

# The owner account reads results (branches, logs) through the group, without sudo.
id -nG ubuntu | tr ' ' '\n' | grep -qx $U || usermod -aG $U ubuntu
echo "cchan sandbox installed: user $U, root $R, slice cchan-agents.slice"
