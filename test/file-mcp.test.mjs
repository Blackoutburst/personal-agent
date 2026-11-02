import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runFileMcp } from '../src/file-mcp.mjs';

const token='a'.repeat(64),endpoint='http://127.0.0.1:12345/internal/files';
const request=(id,method,params)=>({jsonrpc:'2.0',id,method,...(params===undefined?{}:{params})});
const handshake=[request(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic',version:'1'}}),{jsonrpc:'2.0',method:'notifications/initialized'}];
const call=(id,args)=>request(id,'tools/call',{name:'send_file',arguments:args});
async function exchange(frames,{fetchImpl=async()=>new Response(JSON.stringify({file:{id:'synthetic-file'}})),...options}={}) {
  const input=new PassThrough(),output=new PassThrough();let raw='';output.setEncoding('utf8').on('data',chunk=>raw+=chunk);
  const done=runFileMcp({input,output,endpoint,token,fetchImpl,...options});input.end(frames.map(frame=>JSON.stringify(frame)).join('\n')+'\n');await done;
  return {raw,messages:raw.trim().split('\n').map(JSON.parse)};
}
test('file MCP advertises one closed finite tool and forwards exact stable input only through turn-bound endpoint',async()=>{
  const sent=[],args={requestId:'same-key',path:'inbox/a file.gif',caption:'A GIF'};
  const result=await exchange([...handshake,request(2,'tools/list'),call(3,args),call(4,args)],{fetchImpl:async(url,spec)=>{sent.push({url,spec});return new Response(JSON.stringify({file:{id:'same-file'}}));}});
  const tool=result.messages.find(v=>v.id===2).result.tools;assert.equal(tool.length,1);assert.equal(tool[0].name,'send_file');
  assert.deepEqual(tool[0].inputSchema.required,['requestId','path']);assert.equal(tool[0].inputSchema.additionalProperties,false);
  assert.equal(sent.length,2);for(const item of sent){assert.equal(item.url,endpoint);assert.deepEqual(JSON.parse(item.spec.body),args);assert.equal(item.spec.headers.Authorization,'Bearer '+token);assert.equal(item.spec.redirect,'error');}
  assert.deepEqual(result.messages.find(v=>v.id===3).result,result.messages.find(v=>v.id===4).result);
  assert.ok(!result.raw.includes(token));
});
test('file MCP refuses owner selectors, missing keys, control paths, oversize captions and malformed initialization without forwarding',async()=>{
  let calls=0;const bad=[{}, {path:'x'}, {requestId:'key',path:'x',owner:'foreign'}, {requestId:'key',path:'x\nsecret'}, {requestId:'key',path:'x',caption:'x'.repeat(1001)}];
  const result=await exchange([...handshake,...bad.map((args,i)=>call(10+i,args))],{fetchImpl:async()=>{calls++;throw Error('PRIVATE');}});
  for(const item of result.messages.filter(v=>v.id>=10))assert.equal(item.error.code,-32602);assert.equal(calls,0);
  const failed=await exchange([...handshake,call(3,{requestId:'key',path:'x'})],{fetchImpl:async()=>new Response('PRIVATE-PATH-DETAIL',{status:403})});
  assert.equal(failed.messages.at(-1).result.isError,true);assert.ok(!failed.raw.includes('PRIVATE-PATH-DETAIL'));
  for(const url of ['http://localhost:12345/internal/files','https://127.0.0.1:12345/internal/files',endpoint+'?token='+token,'http://127.0.0.1:12345/internal/scheduler'])await assert.rejects(exchange([],{endpoint:url}),/File tools are unavailable/);
});
test('real file stdio child uses ephemeral env transport and emits a durable broker receipt without leaking token',async t=>{
  const requests=[];const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({authorization:req.headers.authorization,body:JSON.parse(body)});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({file:{id:'receipt',name:'file.gif'}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/internal/files`;
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/file-mcp.mjs',import.meta.url))],{env:{...process.env,COMPANION_FILE_URL:url,COMPANION_FILE_TOKEN:token},stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stdout.setEncoding('utf8').on('data',chunk=>output+=chunk);child.stderr.setEncoding('utf8').on('data',chunk=>errors+=chunk);
  child.stdin.end([...handshake,call(3,{requestId:'one-send',path:'file.gif'})].map(JSON.stringify).join('\n')+'\n');
  const [code]=await once(child,'close');assert.equal(code,0);assert.equal(errors,'');assert.equal(requests[0].authorization,'Bearer '+token);
  assert.deepEqual(requests[0].body,{requestId:'one-send',path:'file.gif'});assert.ok(output.includes('receipt'));assert.ok(!output.includes(token));
});
