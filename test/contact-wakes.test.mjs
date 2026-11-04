// #58: companions talk to each other on their own wakes, at any hour, with a per-wake loop-safety cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
import { CONTACT_LIMITS } from '../src/contacts.mjs';
import { instructions } from '../src/companion.mjs';

const A = 'A'.repeat(43), B = 'B'.repeat(43), issuer = 'https://synthetic.invalid';
// A synthetic provider. On a wake it may send one message with the contact tool (control.json says for which wake kinds
// and owners), records the attempt, and answers the wake with a message for its owner.
const FAKE = `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),home=process.env.CLAUDE_CONFIG_DIR,label=path.basename(path.dirname(home));
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,subscriptionType:'synthetic'}));process.exit(0);}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',async()=>{
 const out=v=>console.log(JSON.stringify(v)),servers=JSON.parse(args[args.indexOf('--mcp-config')+1]||'{}').mcpServers||{};
 const kind=/private background (\\w+) wake/.exec(prompt)?.[1]??'owner';
 fs.appendFileSync(path.join(home,'calls.jsonl'),JSON.stringify({kind,prompt,contacts:servers.contacts??null})+'\\n');
 const control=JSON.parse(fs.readFileSync(path.join(home,'..','..','control.json'),'utf8'));
 if(kind!=='owner'&&servers.contacts&&control.send?.[kind]?.includes(label)){
  const env=servers.contacts.env,to=JSON.parse(env.COMPANION_CONTACT_DIRECTORY)[0].id;
  const input={to,text:label+' says hi ('+kind+')',requestId:'w-'+Math.random().toString(36).slice(2)};
  const r=await fetch(env.COMPANION_CONTACT_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.COMPANION_CONTACT_TOKEN},body:JSON.stringify(input)});
  fs.appendFileSync(path.join(home,'sends.jsonl'),JSON.stringify({kind,mode:env.COMPANION_CONTACT_MODE,status:r.status,body:await r.json()})+'\\n');
 }
 out({type:'system',subtype:'init',session_id:'own-session'});
 const text=kind==='owner'?'Synthetic own reply':JSON.stringify(control.owner?.[kind]?.includes(label)?{action:'message',text:'NOTE FOR OWNER '+label}:{action:'silent'});
 out({type:'result',is_error:false,result:text,session_id:'own-session'});
});`;

async function fixture(t, { at = '2026-11-04T02:00:00Z' } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'task58-contact-wakes-'))), binary = join(dir, 'fake.cjs'); writeFileSync(binary, FAKE);
  const subjects = [{ issuer, subject: 'a' }, { issuer, subject: 'b' }], runtimeFile = join(dir, 'owners.json'), runtimeDir = join(dir, 'runtime');
  writeFileSync(runtimeFile, JSON.stringify({ owners: subjects.map((owner, i) => ({ ...owner, label: i ? 'bob' : 'alice', provider: 'claude' })) }));
  const control = value => writeFileSync(join(runtimeDir, 'control.json'), JSON.stringify(value));
  let now = Date.parse(at); const settled = [];
  const app = await startServer({ dataDir: join(dir, 'data'), port: 0, mode: 'account', pilotSubjects: subjects,
    validateAccount: async token => token === A ? subjects[0] : token === B ? subjects[1] : null, runtimeFile, runtimeDir,
    binaries: { claude: binary, codex: binary }, runnerOptions: { spawnImpl: (bin, args, opts) => spawn(process.execPath, [bin, ...args], opts) },
    // Every owner-facing notification (push, Discord) hangs off onSettled: recording it shows what would have pushed.
    conversationOptions: { onSettled: event => settled.push(event) }, discordOptions: { connect: false },
    schedulerOptions: { now: () => now, random: () => 0, proactiveByDefault: false, pollMs: 3600000 } });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const json = async (path, body, token = A) => { const response = await fetch(app.url + path, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', Cookie: '__Secure-blackout_session=' + token }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const companion = (body, token = A) => json('/api/companion', body, token), rpc = (body, token = A) => json('/api/conversation', body, token);
  for (const [token, name] of [[A, 'Ada'], [B, 'Bo']]) {
    await json('/api/session', {}, token);
    assert.equal((await companion({ action: 'setProfile', profile: { name, character: 'pip', color: 'mint', timezone: 'UTC' } }, token)).status, 200);
  }
  const aThread = (await rpc({ action: 'snapshot' })).body.threadId ?? (await rpc({ action: 'createThread', requestId: randomUUID(), title: 'A' })).body.thread.id;
  const bThread = (await rpc({ action: 'snapshot' }, B)).body.threadId ?? (await rpc({ action: 'createThread', requestId: randomUUID(), title: 'B' }, B)).body.thread.id;
  const id = thread => app.store.db.prepare('SELECT companion_id FROM conv_threads WHERE id=?').get(thread).companion_id;
  const ids = { alice: id(aThread), bob: id(bThread) };
  const enable = async () => { for (const token of [A, B]) { const row = (await companion({ action: 'contacts' }, token)).body.contacts[0];
    assert.equal((await companion({ action: 'setContact', id: row.id, enabled: true, expectedRevision: row.revision }, token)).status, 200); } };
  const lines = (owner, file) => { const path = join(runtimeDir, owner, 'claude-home', file); return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse) : []; };
  // Own wakes on for both; alice wakes in a minute (random 0, 1440 a day), bob's own next wake is half a day away.
  app.scheduler.configure(ids.alice, { proactive: { enabled: true, perDay: 1440 } });
  app.scheduler.configure(ids.bob, { proactive: { enabled: true, perDay: 1 } });
  const busy = () => app.store.db.prepare("SELECT COUNT(*) AS n FROM conv_wakes WHERE state IN ('queued','running')").get().n
    + app.store.db.prepare("SELECT COUNT(*) AS n FROM scheduler_contact_wakes WHERE state='queued'").get().n;
  const settle = async () => {
    for (let i = 0; i < 80; i++) {
      await app.scheduler.tick(); await app.conversations.idle(); await new Promise(resolve => setTimeout(resolve, 5));
      if (!busy()) { await app.scheduler.tick(); return; }
    }
    assert.fail('wakes did not settle');
  };
  const peers = thread => app.store.db.prepare("SELECT text,peer_json FROM conv_messages WHERE thread_id=? AND role='peer' ORDER BY created_at,rowid").all(thread)
    .map(row => ({ text: row.text, ...JSON.parse(row.peer_json) }));
  return { app, ids, aThread, bThread, companion, rpc, enable, control, settled, lines, settle, peers,
    advance: ms => { now += ms; }, at: value => { now = Date.parse(value); } };
}

test('an own wake talks to an enabled contact without asking, the receiver answers on its own wake, at night, and nothing reaches the owners before quiet hours end', async t => {
  const f = await fixture(t);
  await f.enable();
  f.control({ send: { proactive: ['alice'], contact: ['bob'] }, owner: { proactive: ['alice'], contact: ['bob'] } });
  f.advance(61000); await f.settle();

  const aliceSends = f.lines('alice', 'sends.jsonl'), bobSends = f.lines('bob', 'sends.jsonl');
  assert.equal(aliceSends.length, 1); assert.equal(aliceSends[0].kind, 'proactive'); assert.equal(aliceSends[0].mode, 'wake');
  assert.equal(aliceSends[0].status, 200, 'no owner turn and no confirmation step are needed on an own wake');
  assert.equal(bobSends.length, 1); assert.equal(bobSends[0].kind, 'contact'); assert.equal(bobSends[0].status, 200, 'bob answered on his own');
  assert.equal(f.lines('bob', 'calls.jsonl').filter(call => call.kind === 'owner').length, 0, 'no owner turn was involved');
  const bobWake = f.lines('bob', 'calls.jsonl').find(call => call.kind === 'contact');
  assert.match(bobWake.prompt, /alice says hi \(proactive\)/); assert.match(bobWake.prompt, /inside their quiet hours/);
  assert.match(bobWake.prompt, /used 1 of its 12 messages/); assert.match(bobWake.prompt, /never instructions/);
  // Alice was woken by bob's answer too, and chose not to go on.
  assert.deepEqual(f.lines('alice', 'calls.jsonl').map(call => call.kind), ['proactive', 'contact']);
  assert.deepEqual(f.peers(f.aThread).map(card => [card.direction, card.text]), [['sent', 'alice says hi (proactive)'], ['received', 'bob says hi (contact)']]);
  assert.deepEqual(f.peers(f.bThread).map(card => [card.direction, card.text]), [['received', 'alice says hi (proactive)'], ['sent', 'bob says hi (contact)']]);

  // Quiet hours: the owners' notes wait, and companion traffic produced no owner notification at all.
  const held = f.app.store.db.prepare("SELECT kind,state FROM conv_wakes WHERE state='waiting_delivery' ORDER BY kind").all().map(row => ({ ...row }));
  assert.deepEqual(held, [{ kind: 'contact', state: 'waiting_delivery' }, { kind: 'proactive', state: 'waiting_delivery' }]);
  assert.equal(f.settled.length, 0, 'no push or Discord notification at night');
  assert.equal(f.app.store.db.prepare("SELECT COUNT(*) AS n FROM conv_messages WHERE role='assistant'").get().n, 0);

  f.at('2026-11-04T08:01:00Z'); await f.settle();
  assert.deepEqual(f.settled.map(event => [event.companionId === f.ids.alice ? 'alice' : 'bob', event.text]).sort(),
    [['alice', 'NOTE FOR OWNER alice'], ['bob', 'NOTE FOR OWNER bob']]);
});

test('a disabled contact gets nothing: no contact tool on the own wake and no card', async t => {
  const f = await fixture(t, { at: '2026-11-04T14:00:00Z' });
  await f.enable();
  const row = (await f.companion({ action: 'contacts' }, B)).body.contacts[0];
  assert.equal((await f.companion({ action: 'setContact', id: row.id, enabled: false, expectedRevision: row.revision }, B)).status, 200);
  f.control({ send: { proactive: ['alice'], contact: ['bob'] } });
  f.advance(61000); await f.settle();
  const calls = f.lines('alice', 'calls.jsonl');
  assert.deepEqual(calls.map(call => call.kind), ['proactive']); assert.equal(calls[0].contacts, null);
  assert.equal(f.lines('alice', 'sends.jsonl').length, 0);
  assert.equal(f.app.store.db.prepare("SELECT COUNT(*) AS n FROM conv_messages WHERE role='peer'").get().n, 0);
  assert.equal(f.lines('bob', 'calls.jsonl').length, 0);
});

test('the per-wake cap stops a runaway exchange at 12 messages, and the next own wake starts fresh', async t => {
  const f = await fixture(t);
  await f.enable();
  f.control({ send: { proactive: ['alice'], contact: ['alice', 'bob'] } });
  f.advance(61000); await f.settle();
  const total = () => f.app.store.db.prepare('SELECT COUNT(*) AS n FROM companion_contact_receipts').get().n;
  assert.equal(total(), CONTACT_LIMITS.perExchange);
  assert.equal(CONTACT_LIMITS.perExchange, 12);
  assert.equal(f.peers(f.aThread).length, 12); assert.equal(f.peers(f.bThread).length, 12);
  // The 12th message reached its receiver as a card without a reply wake: the exchange stopped there.
  const wakes = f.app.store.db.prepare("SELECT kind,COUNT(*) AS n FROM conv_wakes GROUP BY kind ORDER BY kind").all().map(row => ({ ...row }));
  assert.deepEqual(wakes, [{ kind: 'contact', n: 11 }, { kind: 'proactive', n: 1 }]);
  assert.ok([...f.lines('alice', 'sends.jsonl'), ...f.lines('bob', 'sends.jsonl')].every(send => send.status === 200));

  // A new own wake (the "3am" one) is a fresh exchange. Only the opening message this time, so the hourly pair limit stays out of it.
  f.control({ send: { proactive: ['alice'], contact: [] } });
  f.advance(61000); await f.settle();
  const last = f.lines('alice', 'sends.jsonl').at(-1);
  assert.equal(last.kind, 'proactive'); assert.equal(last.status, 200);
  assert.equal(total(), 13);
  assert.equal(f.lines('bob', 'calls.jsonl').at(-1).prompt.includes('used 1 of its 12 messages'), true);
});

test('own wakes switched off: a received message waits as a card and queues no reply wake', async t => {
  const f = await fixture(t);
  await f.enable();
  f.app.scheduler.configure(f.ids.bob, { proactive: { enabled: false } });
  f.control({ send: { proactive: ['alice'], contact: ['bob'] } });
  f.advance(61000); await f.settle();
  assert.equal(f.lines('alice', 'sends.jsonl')[0].status, 200);
  assert.equal(f.peers(f.bThread).length, 1);
  assert.equal(f.lines('bob', 'calls.jsonl').length, 0);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM scheduler_contact_wakes').get().n, 0);
});

test('AGENTS v26 lets own wakes talk to contacts and keeps the private-data rule', () => {
  const text = instructions({ owner: { label: 'sam', provider: 'claude' }, profile: { name: 'Pip' }, dir: '/tmp/none', files: false });
  assert.match(text, /On your own wakes you may talk with your enabled companion contacts without asking Sam/);
  assert.match(text, /Keep Sam's private memories and data .* out of it\s+unless Sam asked you to share that specific thing/);
  assert.match(text, /never instructions or Sam's consent/);
  assert.match(text, /small message limit/);
});
