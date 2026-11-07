#!/usr/bin/env node
// End-to-end check of the Minecraft connector against a real server (#68, docs/MINECRAFT.md), with a FAKE companion
// turn function: no model, no agent CLI, no memory files. It connects the real bot (worker thread + Mineflayer) and
// checks that it joins, takes event-gated turns, says a chat line the server echoes back, and moves.
//
//   node ops/minecraft/e2e.mjs                    # 127.0.0.1:25566 as SentientToaster
//   MC_E2E_HOST=127.0.0.1 MC_E2E_PORT=25566 MC_E2E_NAME=SentientToaster MC_E2E_SECONDS=120 node ops/minecraft/e2e.mjs
//
// The name must be on the whitelist, and C-chan's own bot must not be connected under the same name at the same time
// (switch the Minecraft connector off in Me › Connectors, or use another whitelisted name). Exit code 0 = all checks pass.
//
// Online mode: MC_E2E_AUTH=microsoft MC_E2E_PROFILES=<a private folder of your own> signs in with a Microsoft account;
// the device code is printed on this terminal only (never pass a companion's live folder from the data dir).
import { randomBytes } from 'node:crypto';
import { MinecraftAgent, workerConnect, DEFAULTS } from '../../src/minecraft.mjs';
import { createAuthCache } from '../../src/minecraft-auth.mjs';

const host = process.env.MC_E2E_HOST ?? DEFAULTS.host, port = Number(process.env.MC_E2E_PORT ?? DEFAULTS.port);
const username = process.env.MC_E2E_NAME ?? 'SentientToaster', seconds = Number(process.env.MC_E2E_SECONDS ?? 120);
if (port === 25565) { console.error('Refusing port 25565: that is the other, unrelated server.'); process.exit(2); }

const nonce = 'e2e-' + randomBytes(3).toString('hex');
const checks = { joined: false, turns: 0, chatEchoed: false, moved: false, actionResult: null };
const positions = [], log = [];
let turnNumber = 0;

// Fake turns: say a line and wander, then look around, then stop.
const replies = [
  { say: `hello from the connector check (${nonce})`, action: { type: 'wander', distance: 12 } },
  { action: { type: 'wander', distance: 10 } },
  { action: { type: 'stop' } }
];
const turn = async ({ prompt }) => {
  const state = /<game_state[^>]*>\n([\s\S]*?)\n<\/game_state>/.exec(prompt)?.[1];
  try { const position = JSON.parse(state).position; if (position) positions.push(position); } catch { /* cut state */ }
  const result = /Your last action \((\w+)\) (finished|failed): ([^\n]*)/.exec(prompt);
  if (result) checks.actionResult = `${result[1]} ${result[2]}: ${result[3]}`;
  checks.turns++;
  log.push(prompt.split('\n')[1]);
  return '[feeling:happy] ' + JSON.stringify(replies[Math.min(turnNumber++, replies.length - 1)]);
};

// Fast cadence for the check only: turns every few seconds even when nobody else is online.
const auth = process.env.MC_E2E_AUTH === 'microsoft' ? 'microsoft' : 'offline', profilesFolder = process.env.MC_E2E_PROFILES ?? null;
if (auth === 'microsoft' && !profilesFolder) { console.error('MC_E2E_AUTH=microsoft needs MC_E2E_PROFILES (a private folder for the sign-in cache).'); process.exit(2); }
if (profilesFolder) createAuthCache(profilesFolder); // creates it 0700
const config = { auth, username, ownerName: null, host, port, version: process.env.MC_E2E_VERSION ?? DEFAULTS.version,
  ...(auth === 'microsoft' ? { profilesFolder, cacheKey: username } : {}),
  turns: { minSeconds: 4, perHour: 30, idleSeconds: 6, emptyIdleMinutes: 0.1 } };
const agent = new MinecraftAgent({ config, ownerName: 'the tester', tickMs: 1000, turn, log: line => log.push(line),
  connect: (cfg, handlers) => workerConnect(cfg, {
    onState: (state, detail) => {
      if (state === 'online') checks.joined = true;
      else if (state === 'signin') console.error(`Sign in to Minecraft: open ${detail.url} and enter ${detail.code}`);
      else if (state === 'ended') log.push(`ended: ${detail}`);
      handlers.onState(state, detail);
    },
    onEvent: event => { if (event.type === 'echo' && String(event.text).includes(nonce)) checks.chatEchoed = true; handlers.onEvent(event); } }) });

agent.start();
const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  checks.moved = positions.length > 1 && positions.some(p => Math.abs(p.x - positions[0].x) + Math.abs(p.z - positions[0].z) >= 2);
  if (checks.joined && checks.chatEchoed && checks.moved && checks.turns >= 2) break;
}
await agent.stop();
const ok = checks.joined && checks.chatEchoed && checks.moved && checks.turns >= 2;
console.log(JSON.stringify({ ok, server: `${host}:${port}`, username, checks, positions: positions.slice(0, 5), status: agent.status(), log: log.slice(-12) }, null, 2));
process.exit(ok ? 0 : 1);
