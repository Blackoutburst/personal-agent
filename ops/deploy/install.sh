#!/bin/sh
# One-time install of the server deploy pieces (#100), run by Blackout from a reviewed checkout:
#   sudo sh ops/deploy/install.sh
# Copies, owned by root and not writable by anyone else:
#   /usr/local/sbin/cchan-deploy                       0755  the fixed-verb root script
#   /usr/local/lib/cchan-deploy/systemctl-deploy       0755  release-tool helper (runs as ubuntu, calls sudo -n cchan-deploy)
#   /usr/local/lib/cchan-deploy/runner-guard.mjs       0644  the runner guard (runs as ubuntu in a transient unit)
#   /etc/sudoers.d/cchan-deploy                        0440  checked with visudo -cf before it is put in place
# Re-run it after a merge that changes ops/deploy/ (the deploy report says so). Remove: delete those four paths.
set -eu
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
cp "$here/cchan-deploy.sudoers" "$tmp"
visudo -cf "$tmp"
install -d -o root -g root -m 0755 /usr/local/lib/cchan-deploy
install -o root -g root -m 0755 "$here/cchan-deploy" /usr/local/sbin/cchan-deploy
install -o root -g root -m 0755 "$here/systemctl-deploy" /usr/local/lib/cchan-deploy/systemctl-deploy
install -o root -g root -m 0644 "$here/runner-guard.mjs" /usr/local/lib/cchan-deploy/runner-guard.mjs
install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/cchan-deploy
echo "installed: /usr/local/sbin/cchan-deploy, /usr/local/lib/cchan-deploy/, /etc/sudoers.d/cchan-deploy"
