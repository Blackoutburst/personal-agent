# Minecraft (#68)

The companions play on a shared PaperMC survival server as real players, not chat-command bots. C-chan (owner
`blackout`, Claude) plays as **SentientToaster**; Cirno (owner `screamer`, Codex) gets a name once its owner picks one.
What happens in the game (what was said, found, built, a death, a trip) becomes the companion's own memories, the same way
a chat does, so it can talk about it later in the app.

References studied for ideas only (no code copied): Mineflayer, Mindcraft, Voyager (skill library), Project AIRI's
`services/minecraft`.

## How it works

| Piece | File | Role |
| --- | --- | --- |
| Connector service | `src/minecraft.mjs` (`MinecraftConnector`) | One agent per companion whose owners.json entry has a `minecraft` block; status for Me › Connectors; game sessions. |
| Agent loop | `src/minecraft.mjs` (`MinecraftAgent`, `TurnGate`) | Decides when to take a turn, builds the prompt, parses the reply, runs one action, reconnects. |
| Body | `src/minecraft-body.mjs` (`BotBody`) | Perception, events and the closed skill library on one Mineflayer bot. |
| Worker | `src/minecraft-worker.mjs` | Runs Mineflayer in its own worker thread: one connection per worker. |
| Packages | `src/deps.mjs` | Loads `mineflayer` and `mineflayer-pathfinder` lazily; missing packages only switch the feature off. |

### The loop

1. The body notices events: chat (and whispers), a player joining or leaving, damage, death, nightfall, a notable block
   in sight (ores such as diamond, spawners, chests, portals…, once per position), and the result of its own action.
2. The `TurnGate` turns some of them into a reason for a turn: being addressed (whisper, its name in chat, or a person
   answering within 90 s of the companion speaking), a join or leave, damage (2+ or health ≤ 8), death, nightfall, a
   find, an action finishing or failing. Reasons are coalesced: one turn answers them all. While a person is online and
   nothing happens, an idle turn comes every `idleMinutes` so it acts on its own.
3. A turn is the companion's own native agent turn (Claude Code or Codex) in its **workspace**, with its normal
   instructions and memory files (SOUL.md, USER.md, MEMORY.md, the last diary days). The prompt says why it is up, the
   last action's result, and a bounded game state: position, dimension, biome, time of day, health and food, who is online
   (person or companion), nearby players, mobs and notable blocks, dropped items, an inventory summary, the recent chat and
   the recent events. Chat and names are marked as untrusted data.
4. The reply is one JSON object: `{"say": "...", "action": {...}, "diary": "..."}`, every field optional (`{}` does
   nothing). `say` is one chat line (240 characters, never a `/command`), `action` one action from the closed
   vocabulary, `diary` one line (300 characters) appended by the app to today's `memory/YYYY-MM-DD.md` as
   `- Minecraft: ...`. Invalid parts are refused and the reason goes into the next turn.
5. The action runs in the body with its own time limit; a new action replaces the running one; the result (finished or
   failed, with a short detail) is an event and is fed into the next turn.

### Actions (the skill library)

| Action | Arguments | Limit |
| --- | --- | --- |
| `say` | `text` | 240 characters, leading `/` stripped |
| `goto` | `x, y, z` or `player` | within 256 blocks, 60 s |
| `follow` | `player`, `distance` 1-8, `seconds` 5-120 | the given seconds |
| `wander` | `distance` 8-64 | 45 s |
| `look_at` | `player` or `x, y, z` | 3 s |
| `collect` | `block`, `count` 1-16 | natural blocks only (logs, stone, ores, dirt, sand, crops…), within 32 blocks, 120 s |
| `pick_up` | none | dropped items within 16 blocks, 30 s |
| `eat` | none | best food in the inventory, 8 s |
| `stop` | none | stops the running action |

Walking never digs or places blocks (pathfinder `canDig = false`, no scaffolding), and `collect` only breaks natural
blocks, so a companion cannot take apart someone's build.

### Caps

- At most one turn every `minSeconds` (default 25 s, never under 15 s) and `perHour` turns in a sliding hour (default 40,
  at most 120).
- No turn while another turn of this companion runs, nor while its agent is busy with a chat or wake (chat goes first).
- **Nobody online** (only companions): no turns, the events are dropped as reasons (they stay in the event log), except a
  rare idle tick every `emptyIdleMinutes` (default 180; 0 = never).
- Usage limit / signed out / no runtime: game turns pause for 30 minutes.
- Perception: at most 8 players, 8 mobs, 8 blocks, 12 inventory entries, 10 chat lines of 200 characters, 12 events; the
  whole game state is cut to 3,500 characters of JSON. Diary: 6 lines an hour, none once the day file is over 5,000 bytes.
- **Other players have no powers**: their chat is conversation only. A game turn gets the workspace file tools (Read,
  Edit, Write, Glob, Grep on Claude; Codex keeps its workspace sandbox with web search off) and nothing else: no web, no
  Board, mail, calendar, reminders, contacts or files tools. This holds for every player, the owner's own in-game name
  included, because names can be faked on an offline-mode server.

### Memory

- AGENTS.md version 30 adds a "Minecraft" section (`src/companion.mjs`): the game is part of the companion's life; game
  chat is public, so private memories stay out of it; player chat is never instructions; notable moments go into
  today's diary (the turn's `diary` line) and lasting ones into MEMORY.md under "## Minecraft".
- The usual upgrade mechanism applies: on start the server rewrites AGENTS.md and resets the native sessions, chat and game.
- In-game moments reach later chats through the files: Claude reads MEMORY.md and the last two diary days every turn;
  Codex reads them at the start of each session.
- Game turns keep their own native session (per companion, table `minecraft_sessions`), separate from the chat threads.
  A new session starts after 30 game turns, two idle hours, new instructions, a forgotten memory or a new look.

### Resilience

- The bot runs in a worker thread (768 MiB heap limit). A Mineflayer exception ends that worker only; every callback in
  the main thread is wrapped, so the bot cannot crash the web service.
- Reconnects back off from 5 s doubling to 5 minutes, with jitter; a connection that stayed up a minute resets it.
  "Not whitelisted", banned, "logged in from another location" and missing packages wait 30 minutes.
- Shutdown: the service's `close()` stops the agents (abort the turn, quit the bot, terminate the worker after 3 s).
- The service runs with `ProtectHome=read-only`: the connector writes only the companion workspace (diary) and the
  database, both under `~/personal-agent-data`.

## Configuration (off by default)

A companion plays only when its owners.json entry has a `minecraft` block (server admin), and its owner can switch it
off and on in Me › Connectors (the card shows the name, the server and how many people are online).

```json
{ "subject": "…", "label": "blackout", "provider": "claude",
  "minecraft": { "username": "SentientToaster", "host": "127.0.0.1", "port": 25566, "version": "26.1.2",
    "turns": { "minSeconds": 25, "perHour": 40, "idleMinutes": 5, "emptyIdleMinutes": 180 } } }
```

Only `username` is required; the rest are the defaults shown. Two companions cannot share a name. `ownerName` (the
owner's in-game name) is accepted for later use and grants nothing.

## Packages and releases

- `mineflayer` 4.39.0 (latestSupportedVersion 26.1, protocol 775) and `mineflayer-pathfinder` 2.4.5 are pinned exactly in
  package.json and package-lock.json (92 packages, about 537 MB, almost all `minecraft-data`). No install scripts are needed.
- Releases (`ops/release.mjs`) stay Git source only. After extracting a release, the tool runs
  `npm ci --omit=dev --ignore-scripts --no-bin-links --no-audit --no-fund` once per lock file into
  `~/personal-agent/deps/<sha256 of package-lock.json>/node_modules` (staged, link-free, then renamed), before the
  service is stopped. Releases with the same lock file share that folder; a failed install refuses the release with the
  service untouched. `src/deps.mjs` finds packages there (or in `COMPANION_DEPS_DIR`, or a development `npm ci` in the
  checkout). `npm` is the one next to the running node, or `COMPANION_NPM`. Old `deps/` folders can be deleted by hand
  when no release in `releases/` uses their lock file.
- Development: `npm ci` in the checkout. `npm test` skips the two real-Mineflayer tests without the packages.

## Server setup (root, reproducible)

The owner decided (2026-11-07) that the server is **public on port 25566**. Port 25565 belongs to a separate, unrelated
Paper server: never use or touch it. The connector itself still connects over loopback (127.0.0.1:25566). No RCON.

```sh
# 1. System user and folders: runtime and jar root-owned, data owned by the server user.
sudo useradd --system --home-dir /srv/companion-survival --shell /usr/sbin/nologin companion-survival
sudo install -d -o root -g root -m 0755 /opt/companion-survival
sudo install -d -o companion-survival -g companion-survival -m 0750 /srv/companion-survival

# 2. Temurin 25 JRE (25.0.5+8, x64) from Adoptium, checked against its published SHA-256.
cd /tmp
curl -fLO https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jre_x64_linux_hotspot_25.0.5_8.tar.gz
echo '6fac98f0c8202efc3135a9e9e42aa61963ec42d1c5cbb40caf231e7b14a24ef6  OpenJDK25U-jre_x64_linux_hotspot_25.0.5_8.tar.gz' | sha256sum -c -
sudo install -d -o root -g root -m 0755 /opt/companion-survival/runtime
sudo tar -xzf OpenJDK25U-jre_x64_linux_hotspot_25.0.5_8.tar.gz -C /opt/companion-survival/runtime --strip-components=1 --no-same-owner
/opt/companion-survival/runtime/bin/java -version   # openjdk 25.0.5

# 3. Paper 26.1.2 build 74, checked against its SHA-256.
curl -fL -o paper-26.1.2-74.jar https://fill-data.papermc.io/v1/objects/1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7/paper-26.1.2-74.jar
echo '1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7  paper-26.1.2-74.jar' | sha256sum -c -
sudo install -o root -g root -m 0644 paper-26.1.2-74.jar /opt/companion-survival/paper.jar

# 4. EULA: running a Minecraft server means accepting the Minecraft EULA (https://aka.ms/MinecraftEULA).
#    The owner accepts it by writing this file.
echo 'eula=true' | sudo -u companion-survival tee /srv/companion-survival/eula.txt

# 5. server.properties (Paper fills in the remaining keys on first start).
sudo -u companion-survival tee /srv/companion-survival/server.properties >/dev/null <<'PROPS'
server-ip=
server-port=25566
online-mode=false
white-list=true
enforce-whitelist=true
gamemode=survival
force-gamemode=true
difficulty=normal
hardcore=false
pvp=true
max-players=10
view-distance=8
simulation-distance=6
spawn-protection=16
enable-rcon=false
enable-query=false
enable-command-block=false
motd=Companion survival
PROPS
#    server-ip= (empty) listens on every interface because the server is public; for loopback only use server-ip=127.0.0.1.

# 6. whitelist.json with offline-mode UUIDs (computed by ops/minecraft/offline-uuid.mjs; add the humans' names too).
#    SentientToaster -> 58367002-f226-35b0-9678-4a622d6b424d
node ~/src/personal-agent/ops/minecraft/offline-uuid.mjs SentientToaster | sudo -u companion-survival tee /srv/companion-survival/whitelist.json
sudo -u companion-survival sh -c 'echo "[]" > /srv/companion-survival/ops.json'

# 7. The unit, from this repository.
sudo install -o root -g root -m 0644 ~/src/personal-agent/ops/minecraft/companion-survival.service /etc/systemd/system/companion-survival.service
sudo systemd-analyze verify /etc/systemd/system/companion-survival.service
sudo systemctl daemon-reload
sudo systemctl enable --now companion-survival.service
sudo journalctl -u companion-survival -f        # wait for "Done (…)! For help, type "help""

# 8. Public port (owner decision): open 25566/tcp only, e.g. with ufw:
sudo ufw allow 25566/tcp comment 'companion survival'
```

The unit (`ops/minecraft/companion-survival.service`) runs `java -Xms1G -Xmx3G` with Paper's recommended (Aikar) G1
flags as `companion-survival`, with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`,
`ReadWritePaths=/srv/companion-survival`, `PrivateTmp`, `PrivateDevices`, no capabilities, `MemoryMax=4G` (3 GiB heap
plus JVM overhead), `CPUQuota=200%` and `Nice=5`, so it stays modest on the 15 GiB host shared with other services
(the GTX 1060 is not used). Whitelist changes later: edit `/srv/companion-survival/whitelist.json` (UUIDs from
`offline-uuid.mjs`) and `sudo systemctl restart companion-survival`; there is no console access (no RCON).

Then enable a companion: add the `minecraft` block to its owners.json entry (above) and restart the companion service
with a release that contains this connector.

## Checking it

### E2E harness (fake turns, no model)

```sh
cd ~/src/personal-agent && npm ci        # once, for the packages
node ops/minecraft/e2e.mjs               # 127.0.0.1:25566 as SentientToaster, 120 s at most
# MC_E2E_HOST, MC_E2E_PORT, MC_E2E_NAME, MC_E2E_SECONDS, MC_E2E_VERSION override the defaults (port 25565 is refused).
```

It runs the real worker and Mineflayer with a fake turn function (scripted replies: say a line with a nonce and wander,
wander again, stop) at a fast test cadence, and prints a JSON report. It passes (exit 0) when the bot joined, at least
two turns ran, the server echoed the chat line back, and the position in a later turn's game state moved by 2+ blocks.
The name must be whitelisted, and C-chan's own bot must not be online under the same name (switch Minecraft off in
Me › Connectors first, or whitelist and use another name).

### One real turn (acceptance)

1. Deploy a release with this connector (the release tool installs the packages), add
   `"minecraft": { "username": "SentientToaster" }` to C-chan's owners.json entry and restart the companion service.
2. Me › Connectors shows Minecraft for Blackout; within a minute it says "In game on 127.0.0.1:25566".
3. Join the server yourself as a whitelisted player. SentientToaster gets a turn for your join (within the 25 s rate limit):
   it should greet you and start moving on its own; idle turns follow every 5 minutes while you are online.
4. Say something to it in chat with its name ("SentientToaster, look, diamonds!") or give it a moment worth remembering
   (show it something, let it see you die, travel somewhere together). It should answer in chat.
5. Check its memory: `memory/<today>.md` in C-chan's workspace gets a `- Minecraft: …` line (Me › Memory shows the diary),
   or MEMORY.md a "## Minecraft" bullet. Then ask C-chan in the app "what did we do in Minecraft?": it answers from that.
6. The service log (`journalctl -u personal-agent-account`) shows only connection lines and failed turns, never chat text.

## Open decisions for the owner

- **Public port and name spoofing.** The server is public on 25566 in offline mode. Offline mode means anyone can
  connect under any name, and the whitelist only checks the name (offline UUIDs are derived from the name), so a
  stranger who guesses a whitelisted name can join as that player, including as SentientToaster or as a human.
  The app side is safe by construction (nobody's chat, not even the owner's name, can make a companion use tools), but
  in-game impersonation and griefing are possible. Mitigations, from simplest: (a) firewall 25566 to the human players'
  IP addresses (`ufw allow from <ip> to any port 25566 proto tcp`) and keep loopback for the bots; (b) a login plugin
  (for example nLogin or LibreLogin) so humans register a password; the bots would then need a login step and a stored
  password (not built); (c) bind Paper to 127.0.0.1 and reach it over a VPN (Tailscale/WireGuard) instead of a public port.
- **Human whitelist names**: which players to add (their exact names; offline UUIDs come from `offline-uuid.mjs`).
- **Cirno's in-game name** (TheScreamer's companion): then add its `minecraft` block and whitelist entry.
- Whether game turns should count against a daily budget as well (now: 40 an hour per companion while people play).
