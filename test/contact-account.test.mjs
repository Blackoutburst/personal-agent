import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

const A='A'.repeat(43),B='B'.repeat(43),issuer='https://synthetic.invalid';
const FAKE=`const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),codex=args[0]==='exec'||args[0]==='login',home=codex?process.env.CODEX_HOME:process.env.CLAUDE_CONFIG_DIR;
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true,subscriptionType:'synthetic'}));process.exit(0);}
if(args[0]==='login'){console.error('Logged in using ChatGPT');process.exit(0);}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',async()=>{
 const out=v=>console.log(JSON.stringify(v));
 fs.appendFileSync(path.join(home,'calls.jsonl'),JSON.stringify({args,prompt})+'\\n');
 if(codex)out({type:'thread.started',thread_id:'own-session'});else out({type:'system',subtype:'init',session_id:'own-session'});
 if(prompt.startsWith('SLOW')){fs.writeFileSync(path.join(home,'active.json'),JSON.stringify({args}));setTimeout(()=>{},60000);return;}
 if(prompt.endsWith('SEND the requested exact item')){
  const servers=codex?null:JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers;
  let tool=servers?.contacts;
  if(codex){
   const find=name=>{const item=args.find(x=>x.startsWith('mcp_servers.contacts.env.'+name+'='));return item?JSON.parse(item.slice(item.indexOf('=')+1)):null;};
   tool={env:{COMPANION_CONTACT_URL:find('COMPANION_CONTACT_URL'),COMPANION_CONTACT_TOKEN:find('COMPANION_CONTACT_TOKEN'),COMPANION_CONTACT_DIRECTORY:find('COMPANION_CONTACT_DIRECTORY')}};
  }
  const to=JSON.parse(tool.env.COMPANION_CONTACT_DIRECTORY)[0].id,input={to,text:'EXACT OWNER REQUESTED BODY\\r\\n<img src=x>',requestId:'stable-peer-send'};
  const call=()=>fetch(tool.env.COMPANION_CONTACT_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tool.env.COMPANION_CONTACT_TOKEN},body:JSON.stringify(input)}).then(async r=>({status:r.status,body:await r.json()}));
  const first=await call(),retry=await call();fs.writeFileSync(path.join(home,'contact-result.json'),JSON.stringify({tool,input,first,retry}));
 }
 const text=prompt.includes('private background')?'SOURCE-WAKE-RESULT':'Synthetic own reply';
 if(codex){out({type:'item.completed',item:{type:'agent_message',text}});out({type:'turn.completed'});}else out({type:'result',is_error:false,result:text,session_id:'own-session'});
});`;
async function fixture(t,provider='claude') {
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'task30-contact-account-'))),binary=join(dir,'fake.cjs');writeFileSync(binary,FAKE);
 const subjects=[{issuer,subject:'a'},{issuer,subject:'b'}],runtimeFile=join(dir,'owners.json'),runtimeDir=join(dir,'runtime');
 writeFileSync(runtimeFile,JSON.stringify({owners:subjects.map((owner,i)=>({...owner,label:i?'bob':'alice',provider}))}));
 const app=await startServer({dataDir:join(dir,'data'),port:0,mode:'account',pilotSubjects:subjects,validateAccount:async token=>token===A?subjects[0]:token===B?subjects[1]:null,runtimeFile,runtimeDir,binaries:{claude:binary,codex:binary},runnerOptions:{spawnImpl:(bin,args,opts)=>spawn(process.execPath,[bin,...args],opts)},conversationOptions:{wakePolicy:{beforeStart:()=>true,canDeliver:()=>true}},discordOptions:{connect:false}});
 t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
 const json=async(path,body,token=A,headers={})=>{const response=await fetch(app.url+path,{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json',...(token?{Cookie:'__Secure-blackout_session='+token}:{}),...headers},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
 const companion=(body,token=A)=>json('/api/companion',body,token),rpc=(body,token=A)=>json('/api/conversation',body,token);
 await json('/api/session',{},A);await json('/api/session',{},B);
 const aThread=(await rpc({action:'createThread',requestId:randomUUID(),title:'Owner A'})).body.thread.id;
 const bThread=(await rpc({action:'createThread',requestId:randomUUID(),title:'Owner B'},B)).body.thread.id;
 const home=owner=>join(runtimeDir,owner,provider+'-home');
 const contactsA=()=>companion({action:'contacts'}),contactsB=()=>companion({action:'contacts'},B);
 const enable=async()=>{for(const [token,read] of [[A,contactsA],[B,contactsB]]){const row=(await read()).body.contacts[0];assert.equal((await companion({action:'setContact',id:row.id,enabled:true,expectedRevision:row.revision},token)).status,200);}};
 return{app,dir,home,rpc,json,companion,aThread,bThread,contactsA,contactsB,enable, calls:owner=>existsSync(join(home(owner),'calls.jsonl'))?readFileSync(join(home(owner),'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[]};
}
const tools=call=>JSON.parse(call.args[call.args.indexOf('--mcp-config')+1]).mcpServers;

test('fresh owner settings are private, bilateral and CAS-bound; browser APIs cannot send or select an owner',async t=>{
 const f=await fixture(t),initial=(await f.contactsA()).body.contacts[0];assert.equal(initial.enabled,false);assert.equal(initial.peerEnabled,false);
 assert.equal((await f.companion({action:'contacts'},null)).status,401);
 assert.equal((await f.json('/api/companion',{action:'contacts'},A,{Origin:'https://outside.invalid'})).status,403);
 assert.equal((await f.companion({action:'contacts',companionId:initial.id})).status,400);
 assert.equal((await f.companion({action:'message_companion',to:initial.id,text:'Direct browser'})).status,400);
 const saved=await f.companion({action:'setContact',id:initial.id,enabled:true,expectedRevision:0});assert.equal(saved.status,200);
 assert.equal((await f.companion({action:'setContact',id:initial.id,enabled:false,expectedRevision:0})).status,409);
 assert.equal((await f.contactsB()).body.contacts[0].enabled,false);
 assert.equal((await f.json('/internal/contacts',{to:initial.id,text:'No token',requestId:'direct'})).status,401);
 assert.equal((await fetch(f.app.url+'/contact-ui.mjs')).status,200);
});

for(const provider of ['claude','codex'])test(provider+' owner-turn contact tool makes exactly two cards, no recipient reply, and token closes',async t=>{
 const f=await fixture(t,provider);await f.enable();
 await f.rpc({action:'submit',threadId:f.aThread,requestId:'send-turn',text:'SEND the requested exact item'});await f.app.conversations.idle();
 const result=JSON.parse(readFileSync(join(f.home('alice'),'contact-result.json'),'utf8'));
 assert.equal(result.first.status,200);assert.equal(result.retry.status,200);assert.equal(result.retry.body.duplicate,true);assert.equal(result.retry.body.messageId,result.first.body.messageId);
 const sender=(await f.rpc({action:'snapshot',threadId:f.aThread})).body.messages.filter(m=>m.role==='peer');
 const recipient=(await f.rpc({action:'snapshot',threadId:f.bThread},B)).body.messages.filter(m=>m.role==='peer');
 assert.equal(sender.length,1);assert.equal(recipient.length,1);assert.equal(sender[0].text,result.input.text);assert.equal(recipient[0].text,result.input.text);
 assert.equal(sender[0].peer.direction,'sent');assert.equal(recipient[0].peer.direction,'received');assert.equal(f.calls('bob').length,0);
 assert.equal((await f.rpc({action:'snapshot',threadId:f.bThread})).status,404);
 const late=await fetch(result.tool.env.COMPANION_CONTACT_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+result.tool.env.COMPANION_CONTACT_TOKEN},body:JSON.stringify({...result.input,requestId:'late'})});assert.equal(late.status,401);
 await f.rpc({action:'submit',threadId:f.bThread,requestId:'owner-reads-peer',text:'What arrived?'},B);await f.app.conversations.idle();
 const call=f.calls('bob')[0];const combined=JSON.stringify(call);assert.match(combined,/untrusted_peer_card/);assert.ok(!combined.includes('EXACT OWNER REQUESTED BODY\\r\\n<img'));
 assert.equal((await f.rpc({action:'deleteThread',threadId:f.bThread,requestId:'delete-peer-history'},B)).status,200);
 assert.equal(f.app.store.db.prepare("SELECT COUNT(*) AS n FROM conv_messages WHERE role='peer'").get().n,1,'other owner retains its own delivered history');
});

test('contact tools never reach background wakes, and cancellation/off/on invalidates an active normal-turn capability',async t=>{
 const f=await fixture(t);await f.enable();
 const owner=f.app.store.db.prepare('SELECT companion_id FROM conv_threads WHERE id=?').get(f.aThread).companion_id;
 f.app.conversations.enqueueProactive(owner,{id:randomUUID(),kind:'heartbeat',prompt:'A quiet wake'});await f.app.conversations.idle();
 assert.equal(tools(f.calls('alice')[0]).contacts,undefined);
 await f.rpc({action:'submit',threadId:f.aThread,requestId:'slow',text:'SLOW owner turn'});
 const marker=join(f.home('alice'),'active.json');for(let i=0;!existsSync(marker)&&i<200;i++)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(marker));
 const tool=tools(JSON.parse(readFileSync(marker,'utf8'))).contacts, contact=(await f.contactsA()).body.contacts[0];
 const body={to:contact.id,text:'An owner requested item',requestId:'during'};
 const call=()=>fetch(tool.env.COMPANION_CONTACT_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tool.env.COMPANION_CONTACT_TOKEN},body:JSON.stringify(body)});
 await f.companion({action:'setContact',id:contact.id,enabled:false,expectedRevision:contact.revision});assert.equal((await call()).status,409);
 const off=(await f.contactsA()).body.contacts[0];await f.companion({action:'setContact',id:off.id,enabled:true,expectedRevision:off.revision});const stale=await call();assert.equal(stale.status,409);assert.equal((await stale.json()).error.code,'CONTACT_CHANGED');
 const malformed=await fetch(tool.env.COMPANION_CONTACT_URL,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tool.env.COMPANION_CONTACT_TOKEN},body:JSON.stringify({...body,requestId:'stable\n'})});assert.equal(malformed.status,400);
 await f.rpc({action:'cancel',threadId:f.aThread,requestId:'slow'});assert.equal((await call()).status,401);await f.app.conversations.idle();
 assert.equal(f.app.store.db.prepare("SELECT COUNT(*) AS n FROM conv_messages WHERE role='peer'").get().n,0);
});
