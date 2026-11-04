import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
import { byteRange } from '../src/file-http.mjs';

const A = 'A'.repeat(43), B = 'B'.repeat(43), issuer = 'https://synthetic.invalid';
const PNG = Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
const FAKE = `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),codex=!!process.env.CODEX_HOME,home=process.env.CODEX_HOME||process.env.CLAUDE_CONFIG_DIR;
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,subscriptionType:'synthetic'}));process.exit(0);}
if(args[0]==='login'){console.error('Logged in using ChatGPT');process.exit(0);}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',async()=>{
 fs.appendFileSync(path.join(home,'calls.jsonl'),JSON.stringify({args,prompt,cwd:process.cwd()})+'\\n');
 const out=v=>console.log(JSON.stringify(v));
 if(codex)out({type:'thread.started',thread_id:'synthetic-session'});else out({type:'system',subtype:'init',session_id:'synthetic-session'});
 if(prompt.startsWith('SLOW')){fs.writeFileSync(path.join(home,'active.json'),JSON.stringify({args}));setTimeout(()=>{},60000);return;}
 let text='Synthetic reply';
 if(prompt.startsWith('SEND')){
  const tool=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.files;
  const input={requestId:'stable-send',path:'result.gif',caption:'A synthetic GIF'};
  const call=()=>fetch(tool.env.COMPANION_FILE_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tool.env.COMPANION_FILE_TOKEN},body:JSON.stringify(input)}).then(async r=>({status:r.status,body:await r.json()}));
  if(prompt.includes('MANY')){const many=[];for(let i=0;i<9;i++){input.requestId='send-'+i;many.push(await call());}fs.writeFileSync(path.join(home,'file-results.json'),JSON.stringify({many,tool}));}
  else {const first=await call(),retry=await call();fs.writeFileSync(path.join(home,'file-results.json'),JSON.stringify({first,retry,tool}));}text='File sent';
 }
 if(codex){out({type:'item.completed',item:{type:'agent_message',text}});out({type:'turn.completed'});}
 else out({type:'result',is_error:false,result:text,session_id:'synthetic-session'});
});`;

async function setup(t, provider = 'claude', extra = {}, withBoard = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pa-file-account-'))), binary = join(dir, 'fake.cjs');
  writeFileSync(binary, FAKE);
  const runtimeFile = join(dir, 'owners.json'), runtimeDir = join(dir, 'runtime');
  const subjects = ['a', 'b'].map(subject => ({ issuer, subject }));
  writeFileSync(runtimeFile, JSON.stringify({ owners: subjects.map((p, i) => {
    const label = i ? 'bob' : 'alice';
    return { ...p, label, provider, ...(withBoard ? { board: { configDir: join(dir, 'board-' + label),
      pythonPath: process.execPath, connectPath: join(dir, 'unused-board.py'), allowedTools: [] } } : {}) };
  }) }));
  const app = await startServer({ dataDir: join(dir, 'data'), port: 0, mode: 'account', pilotSubjects: subjects,
    validateAccount: async token => token === A ? subjects[0] : token === B ? subjects[1] : null,
    runtimeFile, runtimeDir, binaries: { claude: binary, codex: binary },
    runnerOptions: { spawnImpl: (bin, args, options) => spawn(process.execPath, [bin, ...args], options) },
    discordOptions: { connect: false }, ...extra });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const json = async (path, body, token = A, overrides = {}) => {
    const r = await fetch(app.url + path, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json',
      ...(token ? { Cookie: '__Secure-blackout_session=' + token } : {}), ...overrides }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const rpc = (body, token = A) => json('/api/conversation', body, token);
  await json('/api/session', {}, A); await json('/api/session', {}, B);
  const thread = async token => (await rpc({ action: 'createThread', requestId: randomUUID(), title: 'Files' }, token)).body.thread.id;
  const threadId = await thread(A), otherThread = await thread(B);
  const upload = async (bytes, { token = A, id = randomUUID(), thread = threadId, name = 'image.png', origin = app.url, headers = {} } = {}) => {
    const response = await fetch(app.url + '/api/files', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Origin: origin,
      ...(token ? { Cookie: '__Secure-blackout_session=' + token } : {}), 'X-Thread-Id': thread, 'X-Request-Id': id,
      'X-File-Name': encodeURIComponent(name), ...headers }, body: bytes });
    return { status: response.status, body: await response.json() };
  };
  const home = join(runtimeDir, 'alice', provider + '-home'), workspace = join(runtimeDir, 'alice', 'workspace');
  return { app, dir, rpc, json, threadId, otherThread, upload, home, workspace,
    calls: () => existsSync(join(home, 'calls.jsonl')) ? readFileSync(join(home, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [],
    async settled() { await app.conversations.idle(); return (await rpc({ action: 'snapshot', threadId })).body; } };
}

test('private binary routes enforce fresh owner/auth/Origin, sniffing, exact retries, Range and nosniff', async t => {
  const f = await setup(t), id = randomUUID();
  for (const [options, status] of [[{ token: null },401],[{ origin: 'https://cross.invalid' },403],[{ token: B },404],[{ thread:f.otherThread },404]]) assert.equal((await f.upload(PNG,options)).status,status);
  const first = await f.upload(PNG,{id,name:'photo.html'}); assert.equal(first.status,200);
  const file = first.body.file; assert.equal(file.mime,'image/png'); assert.equal((await f.upload(PNG,{id,name:'photo.html'})).body.file.id,file.id);
  assert.equal((await f.upload(Buffer.from('different'),{id,name:'photo.html'})).status,409);
  for (const [token,status] of [[null,401],[B,404],[A,200]]) {
    const r=await fetch(f.app.url+file.url,{headers:token?{Cookie:'__Secure-blackout_session='+token}:{}}); assert.equal(r.status,status); await r.arrayBuffer();
  }
  const headers={Cookie:'__Secure-blackout_session='+A,Range:'bytes=2-5'};
  const part=await fetch(f.app.url+file.url,{headers});assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),'bytes 2-5/12');
  assert.equal(part.headers.get('x-content-type-options'),'nosniff');assert.equal(part.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await part.arrayBuffer()),PNG.subarray(2,6));
  const head=await fetch(f.app.url+file.url,{method:'HEAD',headers});assert.equal(head.status,206);assert.equal(head.headers.get('content-length'),'4');assert.equal((await head.arrayBuffer()).byteLength,0);
  const invalid=await fetch(f.app.url+file.url,{headers:{...headers,Range:'bytes=100-200'}});assert.equal(invalid.status,416);assert.equal(invalid.headers.get('content-range'),'bytes */12');
  for(const name of ['attack.svg','attack.html']){const r=await f.upload(Buffer.from('<svg onload="alert(1)">'),{name});const got=await fetch(f.app.url+r.body.file.url,{headers:{Cookie:'__Secure-blackout_session='+A}});assert.equal(got.headers.get('content-type'),'application/octet-stream');assert.match(got.headers.get('content-disposition'),/^attachment;/);await got.arrayBuffer();}
  assert.equal((await fetch(f.app.url+'/files/'+file.id)).status,404);
});

test('files-only submit is owner/thread-bound, stable across retry, visible in snapshots/events and removed with thread', async t => {
  const f=await setup(t), first=(await f.upload(PNG)).body.file;
  const payload={action:'submit',requestId:'file-turn',threadId:f.threadId,text:'',attachments:[first.id]};
  assert.equal((await f.rpc({...payload,threadId:f.otherThread},B)).status,404);
  assert.equal((await f.rpc({...payload,attachments:null,text:'not an array'})).status,400);
  assert.equal((await f.json('/api/files/remove',{id:[first.id]})).status,400);
  assert.equal((await f.rpc(payload)).status,200);const snap=await f.settled();
  assert.deepEqual(snap.messages[0].attachments,[first]);assert.equal(snap.messages[0].text,'');assert.equal((await f.rpc(payload)).status,200);
  assert.equal(f.calls().length,1);const call=f.calls()[0];assert.match(call.prompt,/Files sent by the owner/);assert.match(call.prompt,/native Read tool/);
  const rows=f.app.store.db.prepare('SELECT workspace_path FROM conv_files WHERE id=?').get(first.id);assert.ok(existsSync(rows.workspace_path));assert.deepEqual(readFileSync(rows.workspace_path),PNG);
  const events=(await f.rpc({action:'events',threadId:f.threadId,cursor:'0'})).body.events;assert.ok(events.some(e=>e.message?.attachments?.[0]?.id===first.id));
  const deletion={action:'deleteThread',threadId:f.threadId,requestId:'delete-once'};assert.equal((await f.rpc(deletion,B)).status,404);
  assert.equal((await f.rpc(deletion)).status,200);assert.equal((await f.rpc(deletion)).status,200);assert.equal(existsSync(rows.workspace_path),false);
  assert.equal((await fetch(f.app.url+first.url,{headers:{Cookie:'__Secure-blackout_session='+A}})).status,404);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM conv_files WHERE thread_id=?').get(f.threadId).n,0);
  assert.equal((await f.rpc(payload)).status,404);assert.equal((await f.rpc({action:'snapshot',threadId:f.threadId})).status,404);
});

test('active-turn outbound file has one durable attachment and its token expires before the next call', async t => {
  const f=await setup(t);writeFileSync(join(f.workspace,'result.gif'),Buffer.from('GIF89a-synthetic'));
  assert.equal((await f.rpc({action:'submit',threadId:f.threadId,requestId:'send-file',text:'SEND'})).status,200);
  const snap=await f.settled(), result=JSON.parse(readFileSync(join(f.home,'file-results.json'),'utf8'));
  assert.equal(result.first.status,200);assert.deepEqual(result.retry,result.first);
  const message=snap.messages.find(m=>m.role==='assistant');assert.equal(message.attachments.length,1);assert.equal(message.attachments[0].caption,'A synthetic GIF');
  assert.equal(snap.cursor,'5','exact send_file retry adds no second message event');
  const r=await fetch(result.tool.env.COMPANION_FILE_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+result.tool.env.COMPANION_FILE_TOKEN},body:JSON.stringify({requestId:'late',path:'result.gif'})});
  assert.equal(r.status,401);assert.ok(!JSON.stringify(message).includes(f.workspace));
});

test('cancel and deletion revoke an in-flight file capability and no late call can publish', async t=>{
  for(const action of ['cancel','deleteThread']){
    const f=await setup(t);writeFileSync(join(f.workspace,'result.gif'),Buffer.from('GIF89a-private-synthetic'));
    await f.rpc({action:'submit',threadId:f.threadId,requestId:'slow-turn',text:'SLOW'});
    const marker=join(f.home,'active.json');
    for(let i=0;!existsSync(marker)&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(existsSync(marker));const args=JSON.parse(readFileSync(marker,'utf8')).args;
    const tool=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.files;
    const stopped=await f.rpc({action,threadId:f.threadId,requestId:action==='cancel'?'slow-turn':'delete-slow'});assert.equal(stopped.status,200);
    const response=await fetch(tool.env.COMPANION_FILE_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tool.env.COMPANION_FILE_TOKEN},body:JSON.stringify({requestId:'late-file',path:'result.gif'})});
    assert.equal(response.status,401);await f.app.conversations.idle();assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM conv_files').get().n,0);
    if(action==='deleteThread')assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM conv_messages WHERE thread_id=?').get(f.threadId).n,0);
  }
});

test('simultaneous owner-turn Board attachments bind each token to its own workspace and bridge', async t => {
  const bridges = new Map(), uploads = { alice: [], bob: [] };
  const f = await setup(t, 'claude', { boardOptions: { poll: false, clientFor: configured => {
    assert.ok(bridges.has(configured.configDir), 'Only the two configured synthetic bridges may be used');
    return bridges.get(configured.configDir);
  } } }, true);
  const entries = [
    { label: 'alice', token: A, thread: f.threadId, home: f.home, workspace: f.workspace },
    { label: 'bob', token: B, thread: f.otherThread, home: join(f.dir, 'runtime', 'bob', 'claude-home'), workspace: join(f.dir, 'runtime', 'bob', 'workspace') }
  ];
  for (const entry of entries) {
    entry.bytes = Buffer.from('Explicit safe attachment bytes for ' + entry.label);
    writeFileSync(join(entry.workspace, 'same.txt'), entry.bytes);
    bridges.set(join(f.dir, 'board-' + entry.label), { close() {}, async call(name, args) {
      assert.equal(name, 'upload_attachment'); uploads[entry.label].push(args);
      return { id: 'attachment-' + entry.label };
    } });
  }
  const started = await Promise.all(entries.map(entry => f.rpc({ action: 'submit', threadId: entry.thread,
    requestId: 'board-' + entry.label, text: 'SLOW explicitly requested attachment' }, entry.token)));
  assert.ok(started.every(result => result.status === 200));
  for (const entry of entries) {
    const marker = join(entry.home, 'active.json');
    for (let i = 0; !existsSync(marker) && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(marker)); const args = JSON.parse(readFileSync(marker, 'utf8')).args;
    entry.tool = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.files;
    assert.equal(entry.tool.env.COMPANION_FILE_BOARD, '1');
    entry.id = f.app.store.db.prepare('SELECT companion_id FROM conv_threads WHERE id=?').get(entry.thread).companion_id;
  }
  assert.notEqual(entries[0].tool.env.COMPANION_FILE_TOKEN, entries[1].tool.env.COMPANION_FILE_TOKEN);
  const attach = async (entry, body) => {
    const response = await fetch(entry.tool.env.COMPANION_FILE_URL, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer ' + entry.tool.env.COMPANION_FILE_TOKEN }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  for (const [index, entry] of entries.entries()) {
    const foreign = entries[1 - index], input = { action: 'board', path: 'same.txt', threadId: 'thread-' + entry.label };
    for (const path of [join(foreign.workspace, 'same.txt'), join('..', '..', foreign.label, 'workspace', 'same.txt')]) {
      const denied = await attach(entry, { ...input, path }); assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'FILE_PATH_REJECTED');
    }
    assert.equal((await attach(entry, { ...input, companionId: foreign.id })).status, 400);
  }
  assert.deepEqual(uploads, { alice: [], bob: [] }, 'Rejected paths and owner selectors must not reach either bridge');
  for (const entry of entries) {
    const sent = await attach(entry, { action: 'board', path: 'same.txt', threadId: 'thread-' + entry.label });
    assert.equal(sent.status, 200); assert.equal(sent.body.attachment.id, 'attachment-' + entry.label);
    const [upload] = uploads[entry.label]; assert.equal(uploads[entry.label].length, 1);
    assert.equal(upload.thread_id, 'thread-' + entry.label); assert.equal(upload.filename, 'same.txt'); assert.equal(upload.content_type, 'text/plain');
    assert.deepEqual(Buffer.from(upload.content_base64, 'base64'), entry.bytes);
  }
  assert.equal((await f.rpc({ action: 'cancel', threadId: f.threadId, requestId: 'board-alice' })).status, 200);
  const late = await attach(entries[0], { action: 'board', path: 'same.txt', threadId: 'late-alice' });
  assert.equal(late.status, 401); assert.equal(late.body.error.code, 'FILE_TURN_ENDED'); assert.equal(uploads.alice.length, 1);
  const bob = await attach(entries[1], { action: 'board', path: 'same.txt', threadId: 'still-bob' }); assert.equal(bob.status, 200);
  assert.equal(uploads.bob.length, 2); assert.equal(uploads.bob[1].thread_id, 'still-bob');
  for (const upload of uploads.bob) assert.deepEqual(Buffer.from(upload.content_base64, 'base64'), entries[1].bytes);
  assert.equal((await f.rpc({ action: 'cancel', threadId: f.otherThread, requestId: 'board-bob' }, B)).status, 200);
  await f.app.conversations.idle();
});

test('Codex fresh and resumed turns receive trusted image paths as actual --image inputs', async t => {
  const f=await setup(t,'codex');
  for(const requestId of ['fresh','resumed']) { const file=(await f.upload(PNG,{name:'photo.png'})).body.file;
    assert.equal((await f.rpc({action:'submit',threadId:f.threadId,requestId,text:'describe',attachments:[file.id]})).status,200);await f.settled(); }
  const calls=f.calls();assert.equal(calls.length,2);
  for(const call of calls){const index=call.args.indexOf('--image');assert.ok(index>0);assert.ok(existsSync(call.args[index+1]));assert.deepEqual(readFileSync(call.args[index+1]),PNG);}
  assert.equal(calls[0].args.includes('resume'),false);assert.equal(calls[1].args.includes('resume'),true);
});

test('a rejected ninth outgoing file leaves no unbound bytes or quota charge',async t=>{
  const f=await setup(t);writeFileSync(join(f.workspace,'result.gif'),Buffer.from('GIF89a-synthetic'));
  await f.rpc({action:'submit',threadId:f.threadId,requestId:'many-files',text:'SEND MANY'});const snap=await f.settled();
  const result=JSON.parse(readFileSync(join(f.home,'file-results.json'),'utf8'));
  assert.ok(result.many.slice(0,8).every(item=>item.status===200));assert.equal(result.many[8].status,409);assert.equal(result.many[8].body.error.code,'FILE_TOO_MANY');
  assert.equal(snap.messages.find(m=>m.role==='assistant').attachments.length,8);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM conv_files').get().n,8);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM conv_files WHERE message_id IS NULL').get().n,0);
});

test('Range parser handles suffix/open ranges and rejects multiple, unsafe or empty ranges',()=>{
  assert.deepEqual(byteRange('bytes=-3',10),{start:7,end:9});assert.deepEqual(byteRange('bytes=2-',10),{start:2,end:9});assert.deepEqual(byteRange('bytes=0-99',10),{start:0,end:9});
  for(const value of ['bytes=0-1,4-5','bytes=-0','bytes=9-2','bytes=999999999999999999999-','nope'])assert.throws(()=>byteRange(value,10),e=>e.status===416);
  assert.throws(()=>byteRange('bytes=0-',0),e=>e.status===416);
});

test('voice uploads: X-File-Voice marks one, the transcript shows on the message and /voice serves AAC to its owner only', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'no ffmpeg' }, async t => {
  const tone = join(realpathSync(mkdtempSync(join(tmpdir(), 'pa-voice-'))), 'tone.webm');
  t.after(() => rmSync(join(tone, '..'), { recursive: true, force: true }));
  assert.equal(spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-f', 'webm', '-y', tone]).status, 0);
  const bytes = readFileSync(tone);
  const asr = { durationMs: async () => 1000, transcribe: async () => ({ text: 'quick test', language: 'en-US' }), stop() {} };
  const f = await setup(t, 'claude', { fileOptions: { asr } });
  assert.equal((await f.upload(bytes, { name: 'Voice message.webm', headers: { 'X-File-Voice': 'yes' } })).status, 400);
  const up = await f.upload(bytes, { name: 'Voice message.webm', headers: { 'X-File-Voice': '1' } });
  assert.equal(up.status, 200); assert.deepEqual(up.body.file.voice, { durationMs: 1000 });
  assert.equal((await f.rpc({ action: 'submit', requestId: randomUUID(), threadId: f.threadId, text: '', attachments: [up.body.file.id] })).status, 200);
  const snapshot = await f.settled();
  assert.equal(snapshot.messages.find(message => message.attachments?.length).attachments[0].voice.transcript, 'quick test');
  assert.match(f.calls().at(-1).prompt ?? JSON.stringify(f.calls().at(-1)), /\(voice message\) quick test/);
  const get = (token, range) => fetch(f.app.url + up.body.file.url + '/voice', { headers: { Cookie: '__Secure-blackout_session=' + token, ...(range ? { Range: range } : {}) } });
  const audio = await get(A);
  assert.equal(audio.status, 200); assert.equal(audio.headers.get('content-type'), 'audio/mp4');
  const body = Buffer.from(await audio.arrayBuffer()); assert.equal(body.subarray(4, 8).toString(), 'ftyp');
  assert.equal((await get(A, 'bytes=0-7')).status, 206);
  assert.equal((await get(B)).status, 404);
});
