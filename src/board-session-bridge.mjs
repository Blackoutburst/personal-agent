// Bind model Board calls to an app-owned conversation session. Credentials stay in connect.py.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { askApproval, gateBoardWrite, isBoardRead, toolValue } from './board-write-gate.mjs';

const SESSION = /^companion-model-[a-f0-9]{40}$/;
const BRIDGE = fileURLToPath(import.meta.url);
const MAX_LINE = 1024 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// conversationKey is supplied by Conversations/GroupChat, never by the model or MCP payload.
// Administrative one-shot turns without a conversation get their own session.
// gate (#94): for unattended turns (the companion's own and contact wakes). The bridge then lets a Board write through
// only when every project it targets has an active standing approval (src/board-write-gate.mjs). gate is
// { url, token } of the turn's unattended scheduler endpoint; true or a gate without them refuses every write.
export const GATE_URL_ENV = 'COMPANION_BOARD_GATE_URL', GATE_TOKEN_ENV = 'COMPANION_BOARD_GATE_TOKEN';
export function bindBoardSession(policy, ownerLabel, conversationKey = randomUUID(), { gate = null } = {}) {
  if (!policy.mcpServers?.some(server => server.name === 'board')) return policy;
  if (typeof ownerLabel !== 'string' || !ownerLabel || typeof conversationKey !== 'string'
      || !conversationKey || conversationKey.length > 160 || /[\x00-\x1f\x7f]/.test(conversationKey)) {
    throw new TypeError('Invalid Board conversation context');
  }
  const sessionId = 'companion-model-' + createHash('sha256').update(JSON.stringify([ownerLabel, conversationKey])).digest('hex').slice(0, 40);
  const gated = gate !== null && gate !== false && gate !== undefined;
  const gateEnv = gated && typeof gate?.url === 'string' && typeof gate?.token === 'string' ? { [GATE_URL_ENV]: gate.url, [GATE_TOKEN_ENV]: gate.token } : {};
  return Object.freeze({ ...policy, mcpServers: Object.freeze(policy.mcpServers.map(server => server.name !== 'board' ? server
    : Object.freeze({ ...server, command: process.execPath, ...(gated ? { env: Object.freeze({ ...server.env, ...gateEnv }) } : {}),
      args: Object.freeze([BRIDGE, '--session-id', sessionId, ...(gated ? ['--gate'] : []), '--', server.command, ...server.args]) }))) });
}

// Missing, blank and conflicting model values all resolve to the trusted session. Neither a foreign
// session nor the app's polling session can be selected by a model argument.
export function bindBoardRequest(message, sessionId) {
  if (!SESSION.test(sessionId) || !object(message)) throw new TypeError('Invalid Board bridge input');
  if (message.method !== 'tools/call') return message;
  if (!object(message.params) || (message.params.arguments !== undefined && !object(message.params.arguments))) {
    throw new TypeError('Invalid Board tool arguments');
  }
  return { ...message, params: { ...message.params,
    arguments: { ...message.params.arguments, session_id: sessionId } } };
}

// Model-facing schemas omit the app-owned field, so omission never fails validation before injection.
export function hideBoardSessionSchema(response) {
  if (!object(response?.result) || !Array.isArray(response.result.tools)) return response;
  return { ...response, result: { ...response.result, tools: response.result.tools.map(tool => {
    if (!object(tool?.inputSchema)) return tool;
    const schema = { ...tool.inputSchema };
    if (object(schema.properties)) { schema.properties = { ...schema.properties }; delete schema.properties.session_id; }
    if (Array.isArray(schema.required)) schema.required = schema.required.filter(key => key !== 'session_id');
    return { ...tool, inputSchema: schema };
  }) } };
}

function jsonLines(rewrite, { limit, reject }) {
  const decoder = new StringDecoder('utf8'); let buffer = '';
  function line(value) {
    if (!value.trim()) return '';
    let message;
    try { message = JSON.parse(value); const next = rewrite(message); return next === undefined ? '' : JSON.stringify(next) + '\n'; }
    catch (error) { if (reject) { reject(message); return ''; } throw error; }
  }
  return new Transform({
    transform(chunk, encoding, done) {
      try {
        buffer += decoder.write(chunk);
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const selected = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(selected) > limit) throw new Error('Board line exceeded limit');
          this.push(line(selected));
        }
        if (Buffer.byteLength(buffer) > limit) throw new Error('Board line exceeded limit');
        done();
      } catch (error) { done(error); }
    },
    flush(done) {
      try { buffer += decoder.end(); if (buffer.trim()) this.push(line(buffer)); done(); }
      catch (error) { done(error); }
    }
  });
}

export function startBoardSessionBridge(argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch } = {}) {
  const gated = argv[2] === '--gate', rest = gated ? [argv[0], argv[1], ...argv.slice(3)] : argv;
  if (rest.length < 5 || rest[0] !== '--session-id' || !SESSION.test(rest[1]) || rest[2] !== '--'
      || !isAbsolute(rest[3])) throw new TypeError('Invalid Board bridge launch');
  // The gate's token is for this bridge only: connect.py never sees it.
  const childEnv = { ...env }; delete childEnv[GATE_URL_ENV]; delete childEnv[GATE_TOKEN_ENV];
  const sessionId = rest[1], child = spawn(rest[3], rest.slice(4), { stdio: ['pipe', 'pipe', 'ignore'], env: childEnv });
  const listRequests = new Set(), requestKey = id => JSON.stringify([typeof id, id]);
  let failed = false, stopTimer = null;
  const stopChild = signal => {
    child.kill(signal);
    stopTimer ??= setTimeout(() => child.kill('SIGKILL'), 2500);
    stopTimer.unref();
  };
  // #94 gate: the bridge's own read calls to the Board (ids it owns), and the writes it holds while checking them.
  const gateId = 'bridge-gate-' + randomBytes(6).toString('hex') + '-', reads = new Map();
  let nextRead = 1;
  const read = (name, args) => new Promise((resolveRead, rejectRead) => {
    const id = gateId + nextRead++;
    const timer = setTimeout(() => { reads.delete(id); rejectRead(new Error('Board read timed out')); }, 15_000);
    timer.unref();
    reads.set(id, { resolve: resolveRead, reject: rejectRead, timer });
    if (child.stdin.writableEnded) { reads.delete(id); clearTimeout(timer); rejectRead(new Error('Board closed')); return; }
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { ...args, session_id: sessionId } } }) + '\n');
  }).then(result => { const value = toolValue(result); if (value === null) throw new Error('Board read refused'); return value; });
  const approved = projectId => askApproval({ url: env[GATE_URL_ENV], token: env[GATE_TOKEN_ENV], projectId, fetchImpl });
  const hold = (message, bound) => {
    gateBoardWrite({ tool: message.params?.name, args: message.params?.arguments ?? {}, read, approved }).then(verdict => {
      if (failed) return;
      if (verdict.ok) { if (!child.stdin.writableEnded) child.stdin.write(JSON.stringify(bound) + '\n'); }
      else if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        result: { content: [{ type: 'text', text: verdict.reason }], isError: true } }) + '\n');
    }, () => {});
  };
  const replyError = message => {
    const id = object(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id,
      error: { code: -32602, message: 'Invalid Board session bridge request' } }) + '\n');
  };
  const input = jsonLines(message => {
    const bound = bindBoardRequest(message, sessionId);
    if (typeof message.id === 'string' && message.id.startsWith('bridge-gate-')) throw new TypeError('Reserved Board request id');
    if (gated && message.method === 'tools/call' && !isBoardRead(message.params?.name)) { hold(message, bound); return undefined; }
    if (message.method === 'tools/list' && ['string', 'number'].includes(typeof message.id)) {
      if (listRequests.size >= 256) throw new TypeError('Too many Board schema requests');
      listRequests.add(requestKey(message.id));
    }
    return bound;
  }, { limit: MAX_LINE, reject: replyError });
  const output = jsonLines(message => {
    const waiting = typeof message?.id === 'string' ? reads.get(message.id) : null;
    if (waiting) {
      reads.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error('Board read refused')); else waiting.resolve(message.result);
      return undefined;
    }
    const key = requestKey(message?.id);
    if (!listRequests.delete(key)) return message;
    return hideBoardSessionSchema(message);
  }, { limit: 32 * MAX_LINE });
  const fail = () => { if (failed) return; failed = true; process.exitCode = 2; stopChild('SIGTERM'); process.stdin.destroy(); };
  input.on('error', fail); output.on('error', fail); child.on('error', fail); child.stdin.on('error', fail);
  process.stdout.on('error', fail);
  process.stdin.pipe(input).pipe(child.stdin); child.stdout.pipe(output).pipe(process.stdout);
  input.once('finish', () => {
    stopTimer ??= setTimeout(() => child.kill('SIGKILL'), 2500);
    stopTimer.unref();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stopChild(signal));
  child.once('close', code => { clearTimeout(stopTimer); if (!failed) process.exitCode = Number.isInteger(code) ? code : 2; process.stdin.destroy(); });
  return child;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { startBoardSessionBridge(); } catch { console.error('Board session bridge refused its launch.'); process.exitCode = 2; }
}
