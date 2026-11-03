import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PersonalityStore, PersonalityError, PERSONALITY_LIMITS } from '../src/personality.mjs';
import { memorySnapshot, exportMemory, forgetAllMemory } from '../src/memory.mjs';
import { Conversations } from '../src/conversations.mjs';

const WORK = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sha = text => createHash('sha256').update(text).digest('hex');
const failure = code => error => error instanceof PersonalityError && error.code === code && !error.message.includes(WORK);
function fixture(t) {
  const dir = fs.mkdtempSync(join(WORK, 'task17-personality-synthetic-')), db = new DatabaseSync(':memory:');
  const a = randomUUID(), b = randomUUID(), dirs = new Map([[a, join(dir, 'a')], [b, join(dir, 'b')]]);
  for (const [id, path] of dirs) { fs.mkdirSync(path, { mode: 0o700 }); fs.writeFileSync(join(path, 'SOUL.md'), `# Private ${id}\n`, { mode: 0o600 }); }
  let time = Date.parse('2026-11-03T00:00:00Z');
  const history = new PersonalityStore({ store: { db }, workspaceFor: id => dirs.has(id) ? { dir: dirs.get(id) } : null, now: () => ++time });
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, a, b, history, path: id => join(dirs.get(id), 'SOUL.md'), root: id => dirs.get(id), write: (id, text) => fs.writeFileSync(join(dirs.get(id), 'SOUL.md'), text) };
}

test('full byte view is read-only, truthful and isolated; history needs an actual observation', t => {
  const f = fixture(t), content = '\uFEFF# Voice\r\nRaw prose.\n\tTab and emoji 🌙\r\n'; f.write(f.a, content);
  const current = f.history.snapshot(f.a);
  assert.equal(current.content, content); assert.equal(current.revision, sha(content)); assert.equal(current.file, 'SOUL.md');
  assert.equal(current.modifiedAtISO, fs.statSync(f.path(f.a)).mtime.toISOString()); assert.deepEqual(current.history, []);
  f.history.observe(f.a); assert.equal(f.history.snapshot(f.a).history[0].source, 'settled_turn');
  assert.throws(() => f.history.version(f.b, current.revision), failure('PERSONALITY_NOT_FOUND'));
  assert.throws(() => f.history.snapshot(randomUUID()), failure('PERSONALITY_NOT_FOUND'));
  assert.ok(!JSON.stringify(f.history.snapshot(f.b)).includes(content));
});

test('history keeps last20 unique byte versions per companion across reopen and restores an exact observed version', t => {
  const f = fixture(t); f.history.observe(f.b);
  for (let i=0; i<25; i++) { f.write(f.a, `Version ${i}\r\n`); f.history.observe(f.a); }
  const s = f.history.snapshot(f.a); assert.equal(s.history.length, 20); assert.equal(s.history[0].revision, sha('Version 24\r\n'));
  assert.throws(() => f.history.version(f.a, sha('Version 4\r\n')), failure('PERSONALITY_NOT_FOUND'));
  f.history.observe(f.a); assert.equal(f.history.snapshot(f.a).history[0].observedAtISO, s.history[0].observedAtISO);
  const reopened = new PersonalityStore({ store: { db: f.db }, workspaceFor: id => ({ dir: f.root(id) }) });
  assert.equal(reopened.version(f.a, sha('Version 5\r\n')).content, 'Version 5\r\n');
  let resets=0;
  const result = reopened.restore(f.a, { revision: sha('Version 5\r\n'), expectedRevision: s.revision, confirm: true }, () => { resets++; assert.equal(fs.readFileSync(f.path(f.a),'utf8'), 'Version 24\r\n'); });
  assert.equal(resets,1); assert.equal(result.content,'Version 5\r\n'); assert.equal(result.history.length,20);
  assert.equal(result.history[0].revision,result.revision); assert.equal(result.history[0].source,'owner_restore');
  assert.equal(f.history.snapshot(f.b).history.length,1);
});

test('owner edits enforce full-byte CAS, preserve baseline before reset, and never touch memories or SOUL forgetting boundaries', t => {
  const f=fixture(t); f.write(f.a,'Original prose\r\n'); const initial=f.history.snapshot(f.a); let resets=0;
  fs.writeFileSync(join(f.root(f.a),'USER.md'),'- Remember tea\n');
  const next=f.history.edit(f.a,{content:'Owner voice\r\n',expectedRevision:initial.revision},()=>{
    resets++; assert.equal(fs.readFileSync(f.path(f.a),'utf8'),'Original prose\r\n');
    assert.equal(f.history.version(f.a,initial.revision).content,initial.content);
  });
  assert.equal(resets,1); assert.equal(next.changed,true); assert.equal(next.history.length,2);
  assert.throws(()=>f.history.edit(f.a,{content:'lost ack retry',expectedRevision:initial.revision},()=>resets++),failure('PERSONALITY_CONFLICT'));
  assert.equal(f.history.edit(f.a,{content:next.content,expectedRevision:next.revision},()=>resets++).changed,false); assert.equal(resets,1);
  assert.ok(!exportMemory(f.root(f.a)).files.some(file=>file.file==='SOUL.md'));
  forgetAllMemory(f.root(f.a),{expectedRevision:memorySnapshot(f.root(f.a)).revision,confirm:true},()=>{});
  assert.equal(f.history.snapshot(f.a).content,next.content); assert.equal(f.history.snapshot(f.a).history.length,2);
});

test('stale native prose and failed reset cannot publish; replacement-window native writes win and temporary files are removed', t => {
  const f=fixture(t), old=f.history.snapshot(f.a); f.write(f.a,old.content+'Native prose\n'); let reset=0;
  assert.throws(()=>f.history.edit(f.a,{content:'stale',expectedRevision:old.revision},()=>reset++),failure('PERSONALITY_CONFLICT')); assert.equal(reset,0);
  const current=f.history.snapshot(f.a);
  assert.throws(()=>f.history.edit(f.a,{content:'new',expectedRevision:current.revision},()=>{throw Error('PRIVATE PATH '+WORK);}),failure('PERSONALITY_UNAVAILABLE'));
  assert.equal(f.history.snapshot(f.a).content,current.content);
  assert.throws(()=>f.history.edit(f.a,{content:'async must not publish',expectedRevision:current.revision},async()=>{}),failure('INVALID_REQUEST'));
  assert.equal(f.history.snapshot(f.a).content,current.content);
  assert.throws(()=>f.history.edit(f.a,{content:'new',expectedRevision:current.revision},()=>f.write(f.a,'Concurrent native\n')),failure('PERSONALITY_CONFLICT'));
  assert.equal(f.history.snapshot(f.a).content,'Concurrent native\n');
  assert.deepEqual(fs.readdirSync(f.root(f.a)).filter(x=>x.startsWith('.soul-')),[]);
});

test('malformed, oversized or unobserved restore requests have no reset or file effects', t => {
  const f=fixture(t), current=f.history.snapshot(f.a); let resets=0;
  for(const content of ['\u0000','\ud800',{},'a'.repeat(PERSONALITY_LIMITS.fileBytes+1)]) {
    assert.throws(()=>f.history.edit(f.a,{content,expectedRevision:current.revision},()=>resets++));
  }
  for(const input of [{revision:current.revision,expectedRevision:current.revision,confirm:true},{revision:current.revision+'\n',expectedRevision:current.revision,confirm:true},{revision:current.revision,expectedRevision:current.revision,confirm:false}]) {
    assert.throws(()=>f.history.restore(f.a,input,()=>resets++));
  }
  assert.equal(resets,0); assert.equal(f.history.snapshot(f.a).content,current.content);
  f.write(f.a,Buffer.from([0xc3,0x28])); assert.throws(()=>f.history.snapshot(f.a),failure('PERSONALITY_UNAVAILABLE'));
});

test('additive migration preserves existing records and failed history persistence never claims a successful save', t => {
  const f=fixture(t); f.db.exec("CREATE TABLE retained_canary(value TEXT); INSERT INTO retained_canary VALUES('retained'); PRAGMA user_version=1");
  new PersonalityStore({store:{db:f.db},workspaceFor:id=>({dir:f.root(id)})});
  assert.equal(f.db.prepare('SELECT * FROM retained_canary').get().value,'retained'); assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,1);
  const current=f.history.snapshot(f.a);
  f.db.exec("CREATE TRIGGER reject_after BEFORE INSERT ON personality_versions WHEN new.content='After publication' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  assert.throws(()=>f.history.edit(f.a,{content:'After publication',expectedRevision:current.revision},()=>{}),failure('PERSONALITY_UNAVAILABLE'));
  assert.equal(f.history.snapshot(f.a).content,'After publication','uncertain failure requires reload; no optimistic success');
  assert.equal(f.history.version(f.a,current.revision).content,current.content);
});

test('unsafe SOUL links/FIFO never expose or mutate foreign bytes', {skip:process.platform==='win32'?'Canonical Linux gate covers link/FIFO safety.':false}, async t => {
  const f=fixture(t), current=f.history.snapshot(f.a); fs.unlinkSync(f.path(f.a)); fs.symlinkSync(f.path(f.b),f.path(f.a));
  assert.throws(()=>f.history.snapshot(f.a),failure('PERSONALITY_UNSAFE'));
  assert.throws(()=>f.history.edit(f.a,{content:'no',expectedRevision:current.revision},()=>{}),failure('PERSONALITY_UNSAFE'));
  fs.unlinkSync(f.path(f.a)); fs.linkSync(f.path(f.b),f.path(f.a)); assert.throws(()=>f.history.observe(f.a),failure('PERSONALITY_UNSAFE'));
  fs.unlinkSync(f.path(f.a)); const {spawnSync}=await import('node:child_process'); assert.equal(spawnSync('mkfifo',[f.path(f.a)]).status,0);
  assert.throws(()=>f.history.observe(f.a),failure('PERSONALITY_UNSAFE'));
});

test('settled native observation runs after actual normal/cancelled/silent-wake closure, not notification timing', async t => {
  const f=fixture(t); let release, start, mode='normal', result;
  const started=()=>new Promise(resolve=>{start=resolve;}); let beginning=started();
  const conv=new Conversations({store:{db:f.db}, runner:{turn(){start(); return new Promise(resolve=>{release=()=>{f.write(f.a,mode+' closed\n'); resolve({text:mode==='silent'?'{"action":"silent"}':'Reply',sessionId:'session'});};});}},
    onNativeSettled:id=>{f.history.observe(id);}, onSettled:()=>{result=f.history.snapshot(f.a).history.length;} });
  t.after(()=>conv.shutdown());
  const threadId=(await conv.handle(f.a,{action:'createThread',requestId:'personality-thread',title:'Private'})).thread.id;
  await conv.handle(f.a,{action:'submit',threadId,requestId:'normal',text:'Hello'}); await beginning;
  assert.equal(f.history.snapshot(f.a).history.length,0); release(); await conv.idle();
  assert.equal(result,0); assert.equal(f.history.snapshot(f.a).content,'normal closed\n'); assert.equal(f.history.snapshot(f.a).history.length,1);
  mode='cancelled'; beginning=started(); await conv.handle(f.a,{action:'submit',threadId,requestId:'cancelled',text:'Wait'}); await beginning;
  await conv.handle(f.a,{action:'cancel',threadId,requestId:'cancelled'}); assert.equal(f.history.snapshot(f.a).history.length,1);
  release(); await conv.idle(); assert.equal(f.history.snapshot(f.a).history.length,2);
  mode='silent'; beginning=started(); conv.enqueueProactive(f.a,{id:randomUUID(),kind:'heartbeat',prompt:'A quiet turn'}); await beginning;
  release(); await conv.idle(); assert.equal(f.history.snapshot(f.a).history[0].revision,sha('silent closed\n'));
});

test('quiet queued wakes without a native attempt do not invent settled observations', async t => {
  const f=fixture(t); let calls=0;
  const conv=new Conversations({store:{db:f.db},runner:{turn(){calls++; throw Error('must not start');}},wakePolicy:{beforeStart:()=>false},onNativeSettled:id=>f.history.observe(id)});
  t.after(()=>conv.shutdown()); conv.enqueueProactive(f.a,{id:randomUUID(),kind:'heartbeat',prompt:'Wait for quiet time'}); await conv.idle();
  assert.equal(calls,0); assert.deepEqual(f.history.snapshot(f.a).history,[]);
});

test('failed instruction preparation cannot be attributed as a settled native turn', async t => {
  const f=fixture(t); let calls=0, observations=0;
  const conv=new Conversations({store:{db:f.db},runner:{turn(){calls++; return {text:'unused'};}},systemPrompt(){throw Error('instruction preparation failed');},onNativeSettled(){observations++;}});
  t.after(()=>conv.shutdown());
  const threadId=(await conv.handle(f.a,{action:'createThread',requestId:'preparation',title:'Private'})).thread.id;
  await conv.handle(f.a,{action:'submit',threadId,requestId:'preparation-normal',text:'Hello'}); await conv.idle();
  conv.enqueueProactive(f.a,{id:randomUUID(),kind:'heartbeat',prompt:'Quiet check'}); await conv.idle();
  assert.equal(calls,0); assert.equal(observations,0);
});
