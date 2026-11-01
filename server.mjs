import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BootstrapStore } from './src/store.mjs';
import { adapterStatus, syntheticPreview } from './src/adapters.mjs';
import { createAccountValidator } from './src/account-validator.mjs';
import { createAccountHttp } from './src/account-http.mjs';
import { loadPilotSubjects } from './src/pilot-config.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

export async function startServer({ dataDir, mode = 'unavailable', port = 4318, pilotFile, publicOrigin,
  pilotSubjects, validateAccount } = {}) {
  if (!['unavailable', 'demo', 'account'].includes(mode)) throw new Error('COMPANION_MODE must be unavailable, demo or account');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid COMPANION_PORT');
  // Only trusted startup configuration can select a public proxy origin.
  if (publicOrigin !== undefined) {
    let origin;
    try { origin = new URL(publicOrigin); } catch { throw new Error('Invalid COMPANION_PUBLIC_ORIGIN'); }
    if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) {
      throw new Error('Invalid COMPANION_PUBLIC_ORIGIN');
    }
  }
  // Internal constructor injection is for synthetic tests. The CLI accepts only a private pilot file.
  const admitted = mode === 'account' ? (pilotSubjects ?? loadPilotSubjects(pilotFile, ROOT)) : [];
  const store = new BootstrapStore(dataDir, ROOT);
  if (mode === 'demo') store.put('development', 'contract-preview', syntheticPreview());
  const headers = {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  };
  let accountHttp;
  const allowedOrigins = () => new Set(publicOrigin ? [publicOrigin] :
    [`http://127.0.0.1:${server.address().port}`, `http://localhost:${server.address().port}`]);
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { ...headers, 'content-type': type });
      res.end(req.method === 'HEAD' ? undefined : (type.startsWith('application/json') ? JSON.stringify(body) : body));
    };
    const fail = (status, code, message) => send(status, { error: { code, message } });
    try {
      const address = server.address();
      const allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
      if (!allowedHosts.has(req.headers.host)) return fail(403, 'HOST_REJECTED', 'Local development host required.');
      if (req.headers.origin && !allowedOrigins().has(req.headers.origin)) {
        return fail(403, 'ORIGIN_REJECTED', 'Same-origin access required.');
      }
      // Exact raw paths only: queries cannot enable demo and traversal is rejected.
      const path = req.url;
      if (path === '/api/session' && req.method === 'POST' && mode === 'account') {
        const result = await accountHttp(req);
        if (result.closeConnection) res.setHeader('connection', 'close');
        return send(result.status, result.body);
      }
      if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'METHOD_NOT_ALLOWED', 'Method not available.');
      if (path === '/api/status') return send(200, {
        service: { name: 'Personal Agent', mode, version: '0.1.0' },
        adapters: adapterStatus(mode), storage: { state: 'ready', mode: 'local-bootstrap' }
      });
      if (path === '/api/contract-preview') {
        if (mode !== 'demo') return fail(503, 'FOUNDATIONS_UNAVAILABLE', 'Explicit demo mode is required for the synthetic preview.');
        return send(200, store.get('development', 'contract-preview'));
      }
      if (STATIC.has(path)) {
        const [file, type] = STATIC.get(path);
        return send(200, readFileSync(join(ROOT, 'public', file)), type);
      }
      return fail(404, 'NOT_FOUND', 'Route not found.');
    } catch {
      return fail(500, 'INTERNAL_ERROR', 'The local bootstrap could not complete this request.');
    }
  });
  try {
    if (mode === 'account') accountHttp = createAccountHttp({ store,
      validateAccount: validateAccount ?? createAccountValidator(), pilotSubjects: admitted, allowedOrigins });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) { store.close(); throw error; }
  return {
    server, store, url: `http://127.0.0.1:${server.address().port}`,
    async close() { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); }
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const app = await startServer({ dataDir: process.env.COMPANION_DATA_DIR, mode: process.env.COMPANION_MODE || 'unavailable',
      port: Number(process.env.COMPANION_PORT || 4318), pilotFile: process.env.COMPANION_PILOT_FILE,
      publicOrigin: process.env.COMPANION_PUBLIC_ORIGIN });
    console.log(`Personal Agent local bootstrap: ${app.url} (${process.env.COMPANION_MODE || 'unavailable'})`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(`Bootstrap refused: ${error.message}`); process.exitCode = 1; }
}
