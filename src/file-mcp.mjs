import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const MAX_BYTES = 65536, MAX_RESPONSE_BYTES = 512 * 1024, VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const REQUEST = /^[A-Za-z0-9._-]{1,80}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const empty = value => value === undefined || exact(value, []);
const string = (maximum, description) => ({ type: 'string', maxLength: maximum, description });
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const TOOLS = [{ name: 'send_file', description: 'Send one regular file from your own workspace to the owner in this active reply. Use a stable requestId for exact retries. Only a successful result means the file was sent.', inputSchema: {type:'object',properties:{requestId:string(80,'Stable logical send key'),path:string(4096,'File inside your own workspace'),caption:string(1000,'Optional caption')},required:['requestId','path'],additionalProperties:false} }];
function configuration(endpoint, token) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('File tools are unavailable.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.pathname !== '/internal/files' || url.search || url.hash || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('File tools are unavailable.');
  }
  return url.href;
}
function toolInput(name,args) {
  if (name !== 'send_file' || !object(args) || Object.keys(args).some(key=>!['requestId','path','caption'].includes(key))
      || typeof args.requestId !== 'string' || !REQUEST.test(args.requestId) || typeof args.path !== 'string'
      || !args.path || args.path.length > 4096 || /[\x00-\x1f]/.test(args.path)
      || (args.caption !== undefined && (typeof args.caption !== 'string' || !args.caption.isWellFormed() || args.caption.length > 1000 || Buffer.byteLength(args.caption)>4000))) return null;
  return args;
}
async function readJson(response) {
  if (!response.body) throw new Error();
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error();
    chunks.push(chunk);
  }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!object(value)) throw new Error();
  return value;
}

// The child process owns no identity selector, storage path or arbitrary HTTP capability.
// Its endpoint and ephemeral active-turn token come only from the application constructor.
export async function runFileMcp({ input = process.stdin, output = process.stdout,
  endpoint = process.env.COMPANION_FILE_URL, token = process.env.COMPANION_FILE_TOKEN, fetchImpl = fetch } = {}) {
  const url = configuration(endpoint, token);
  let initialized = false, ready = false;
  const write = async message => { if (!output.write(JSON.stringify(message) + '\n')) await once(output, 'drain'); };
  const error = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
  async function frame(line) {
    let request;
    try { request = JSON.parse(line); } catch { return error(null, -32700, 'Invalid JSON.'); }
    if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
      || Object.keys(request).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) return error(null, -32600, 'Invalid request.');
    if (!Object.hasOwn(request, 'id')) {
      if (request.method === 'notifications/initialized' && initialized && empty(request.params)) ready = true;
      return;
    }
    const { id, method } = request;
    // MCP lets clients attach _meta (progress token, client ids) to any request's params; it carries no input.
    let { params } = request;
    if (object(params) && Object.hasOwn(params, '_meta')) {
      if (!object(params._meta)) return error(id ?? null, -32602, 'Invalid request metadata.');
      const { _meta, ...rest } = params; params = rest;
    }
    if (!(typeof id === 'string' && id.length <= 100 || Number.isSafeInteger(id))) return error(null, -32600, 'Invalid request ID.');
    const result = value => write({ jsonrpc: '2.0', id, result: value });
    if (method === 'ping' && empty(params)) return result({});
    if (method === 'initialize') {
      if (initialized || !object(params) || typeof params.protocolVersion !== 'string' || !object(params.capabilities) || !object(params.clientInfo)) {
        return error(id, -32602, 'Invalid initialization.');
      }
      initialized = true;
      return result({ protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS.at(-1),
        capabilities: { tools: {} }, serverInfo: { name: 'companion-files', version: '1.0.0' } });
    }
    if (!ready) return error(id, -32002, 'Initialization required.');
    if (method === 'tools/list') {
      if (!empty(params)) return error(id, -32602, 'Invalid tool list request.');
      return result({ tools: TOOLS });
    }
    if (method !== 'tools/call') return error(id, -32601, 'Method not found.');
    if (!exact(params, ['name', 'arguments'])) return error(id, -32602, 'Invalid tool request.');
    const body = toolInput(params.name, params.arguments);
    if (!body) return error(id, -32602, 'Invalid files tool arguments.');
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      const data = await readJson(response);
      if (!response.ok) {
        const errors = { FILE_TOO_LARGE: 'The file exceeds this companion file size limit.', FILE_QUOTA: 'The companion file quota is full.',
          FILE_PATH_REJECTED: 'Choose a regular, unshared file inside your own workspace; links are not allowed.',
          FILE_TURN_ENDED: 'This reply ended; no more files can be sent from it.', FILE_TOO_MANY: 'At most eight files can be sent in one reply.',
          CONFLICT: 'The request key changed or a matching send is still running. Reuse the original file and key for an exact retry.' };
        if (!Object.hasOwn(errors, data.error?.code)) throw new Error();
        return result({ content: [{ type: 'text', text: errors[data.error.code] }], isError: true });
      }
      return result({ content: [{ type: 'text', text: JSON.stringify(data) }], isError: false });
    } catch {
      return result({ content: [{ type: 'text', text: 'The file service could not complete this request. Retry with the same request key.' }], isError: true });
    }
  }
  // Frame by LF bytes before decoding: stream chunk boundaries may split UTF-8
  // or contain several independent records, including one malformed record.
  let pending = Buffer.alloc(0), discarding = false;
  for await (const chunk of input) {
    let part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (discarding) { const end = part.indexOf(10); if (end < 0) continue; part = part.subarray(end + 1); discarding = false; }
    pending = Buffer.concat([pending, part]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      const bytes = pending.subarray(0, end); pending = pending.subarray(end + 1);
      if (bytes.length > MAX_BYTES) await error(null, -32600, 'Request too large.');
      else {
        let line;
        try { line = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { await error(null, -32700, 'Invalid UTF-8.'); continue; }
        if (line.trim()) await frame(line);
      }
    }
    if (pending.length > MAX_BYTES) { await error(null, -32600, 'Request too large.'); pending = Buffer.alloc(0); discarding = true; }
  }
  if (pending.length && pending.toString('utf8').trim()) await error(null, -32700, 'Incomplete request.');
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href) {
  runFileMcp().catch(() => { process.stderr.write('File tools are unavailable.\n'); process.exitCode = 1; });
}
