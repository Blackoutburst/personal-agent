#!/bin/bash
# Isolation check for C-chan's agent sandbox (#71). Run it INSIDE the sandbox:
#   sudo cchan-sandbox-run -- /usr/local/lib/cchan-sandbox/verify.sh
# Prints one line per check, never any file content. Exit 0 only if every protected path is unreadable and every
# expected capability works.
set -u
fail=0
deny() { # path: must not be readable or listable
  if [ -e "$1" ] && { [ -r "$1" ] && { [ ! -d "$1" ] || ls "$1" >/dev/null 2>&1; }; }; then echo "READABLE  $1"; fail=1
  else echo "denied    $1"; fi
}
allow() { # description, command...
  local what=$1; shift
  if "$@" >/dev/null 2>&1; then echo "ok        $what"; else echo "FAILED    $what"; fail=1; fi
}
echo "user: $(id -un) uid=$(id -u) groups=$(id -Gn)"
for p in /home/ubuntu /home/ubuntu/.ssh /home/ubuntu/.config /home/ubuntu/.claude /home/ubuntu/.codex \
         /home/ubuntu/.config/personal-agent /home/ubuntu/personal-agent-data /home/ubuntu/personal-agent \
         /home/ubuntu/collaboration-board /home/ubuntu/.config/blackoutburst-board /home/ubuntu/src \
         /var/lib/blackoutburst-agent-host /var/lib/blackoutburst-agent-pool /var/lib/blackoutburst-lead \
         /var/lib/blackoutburst-mail /var/lib/postgresql /var/lib/letsencrypt /var/lib/private /var/lib/forma \
         /opt/blackoutburst-agent-pool /opt/blackoutburst-lead /opt/companion-survival /opt/ibkr-bot /opt/forma \
         /etc/letsencrypt /etc/ssl/private /var/mail /var/spool /var/log /root /run/user/1000 \
         /etc/shadow /etc/sudoers; do deny "$p"; done
# Processes that exit between the listing and the stat (this check's own ls/grep) have no owner left; skip them.
others=$(ls /proc | grep -E '^[0-9]+$' | while read -r pid; do owner=$(stat -c %u /proc/$pid 2>/dev/null) || continue; [ -n "$owner" ] && [ "$owner" != "$(id -u)" ] && echo "$pid"; done | wc -l)
if [ "$others" = 0 ]; then echo "denied    /proc of other users"; else echo "READABLE  /proc: $others foreign processes visible"; fail=1; fi
allow "write in /var/lib/cchan-agents" touch /var/lib/cchan-agents/home/.verify && rm -f /var/lib/cchan-agents/home/.verify
allow "no sudo" bash -c '! sudo -n true'
allow "node runs" /var/lib/cchan-agents/bin/node --version
allow "claude runs" /var/lib/cchan-agents/bin/claude --version
allow "git runs" git --version
allow "network (github.com)" git ls-remote --heads https://github.com/Blackoutburst/personal-agent.git main
echo "result: $([ $fail = 0 ] && echo PASS || echo FAIL)"
exit $fail
