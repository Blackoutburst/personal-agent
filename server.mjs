import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BootstrapStore } from './src/store.mjs';
import { adapterStatus, syntheticPreview } from './src/adapters.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

export async function startServer({ dataDir, mode = 'unavailable', port = 4318 } = {}) {
  if (!['unavailable', 'demo'].includes(mode)) throw new Error('COMPANION_MODE must be unavailable or demo');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid COMPANION_PORT');
  const store = new BootstrapStore(dataDir, ROOT);
  if (mode === 'demo') store.put('development', 'contract-preview', syntheticPreview());
  const headers = {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  };
  const server = createServer((req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { ...headers, 'content-type': type });
      res.end(req.method === 'HEAD' ? undefined : (type.startsWith('application/json') ? JSON.stringify(body) : body));
    };
    const fail = (status, code, message) => send(status, { error: { code, message } });
    try {
      const address = server.address();
      const allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
      if (!allowedHosts.has(req.headers.host)) return fail(403, 'HOST_REJECTED', 'Local development host required.');
      if (req.headers.origin && !new Set([`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`]).has(req.headers.origin)) {
        return fail(403, 'ORIGIN_REJECTED', 'Same-origin access required.');
      }
      if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'METHOD_NOT_ALLOWED', 'This bootstrap is read-only.');
      // Exact raw paths only: queries cannot enable demo and traversal is rejected.
      const path = req.url;
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
    const app = await startServer({ dataDir: process.env.COMPANION_DATA_DIR, mode: process.env.COMPANION_MODE || 'unavailable', port: Number(process.env.COMPANION_PORT || 4318) });
    console.log(`Personal Agent local bootstrap: ${app.url} (${process.env.COMPANION_MODE || 'unavailable'})`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(`Bootstrap refused: ${error.message}`); process.exitCode = 1; }
}
