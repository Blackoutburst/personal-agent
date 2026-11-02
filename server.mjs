import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BootstrapStore } from './src/store.mjs';
import { adapterStatus, syntheticPreview } from './src/adapters.mjs';
import { createAccountValidator } from './src/account-validator.mjs';
import { createAccountAccess, createAccountHttp } from './src/account-http.mjs';
import { loadPilotSubjects } from './src/pilot-config.mjs';
import { PrivateStateStore } from './src/private-state.mjs';
import { createPrivateHttp } from './src/private-http.mjs';
import { createConversationHttp } from './src/conversation-http.mjs';
import { loadRuntimeConfig } from './src/runtime-config.mjs';
import { CompanionRunner } from './src/runner.mjs';
import { Conversations } from './src/conversations.mjs';
import { Profiles, ensureWorkspace, instructions } from './src/companion.mjs';
import { createCompanionHttp } from './src/companion-http.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/companion.css', ['companion.css', 'text/css; charset=utf-8']],
  ['/companion-app.mjs', ['companion-app.mjs', 'text/javascript; charset=utf-8']],
  ['/companion-character.mjs', ['companion-character.mjs', 'text/javascript; charset=utf-8']],
  ['/companion-theme.js', ['companion-theme.js', 'text/javascript; charset=utf-8']],
  ['/conversation-client.mjs', ['conversation-client.mjs', 'text/javascript; charset=utf-8']],
  // Old address of the chat page: it now redirects to the companion.
  ['/conversation.html', ['conversation.html', 'text/html; charset=utf-8']]
]);

// runtimeFile / runtimeDir: the per-owner agent runtime (docs/RUNTIME.md). Without them, account
// mode still serves conversations but every reply reports that no agent is configured.
export async function startServer({ dataDir, mode = 'unavailable', port = 4318, pilotFile, publicOrigin,
  pilotSubjects, validateAccount, runtimeFile, runtimeDir, binaries, runnerOptions = {}, conversationOptions = {} } = {}) {
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
  let privateHttp;
  let conversationHttp;
  let agentsConfigured = false;
  let companionHttp;
  let conversations = null;
  const allowedOrigins = () => new Set(publicOrigin ? [publicOrigin] :
    [`http://127.0.0.1:${server.address().port}`, `http://localhost:${server.address().port}`]);
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      if (res.destroyed || res.headersSent) return;
      const encoded = req.method === 'HEAD' ? undefined : (type.startsWith('application/json') ? JSON.stringify(body) : body);
      res.writeHead(status, { ...headers, 'content-type': type });
      res.end(encoded);
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
      if (path === '/api/companion' && mode === 'account') {
        if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Method not available.');
        const result = await companionHttp(req);
        if (result.closeConnection) res.setHeader('connection', 'close');
        return send(result.status, result.body);
      }
      if (path === '/api/conversation') {
        const result = await conversationHttp(req);
        if (result.closeConnection) res.setHeader('connection', 'close');
        return send(result.status, result.body);
      }
      if (path === '/api/session' && req.method === 'POST' && mode === 'account') {
        const result = await accountHttp(req);
        if (result.closeConnection) res.setHeader('connection', 'close');
        return send(result.status, result.body);
      }
      if (path === '/api/private/state' && mode === 'account') {
        const result = await privateHttp(req);
        if (result.closeConnection) res.setHeader('connection', 'close');
        return send(result.status, result.body);
      }
      if (!['GET', 'HEAD'].includes(req.method)) return fail(405, 'METHOD_NOT_ALLOWED', 'Method not available.');
      if (path === '/api/status') return send(200, {
        service: { name: 'Personal Agent', mode, version: '0.1.0' },
        adapters: adapterStatus(mode, { agents: agentsConfigured }), storage: { state: 'ready', mode: 'local-bootstrap' }
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
    const access = createAccountAccess({ store,
      validateAccount: mode === 'account' ? (validateAccount ?? createAccountValidator()) : null,
      pilotSubjects: admitted, allowedOrigins });
    let runner = null;
    if (mode === 'account') {
      const owners = loadRuntimeConfig(runtimeFile);
      if (owners.length) {
        if (!runtimeDir) throw new Error('COMPANION_RUNTIME_DIR is required with COMPANION_RUNTIME_FILE');
        runner = new CompanionRunner({ store, owners, runtimeDir, binaries, ...runnerOptions });
        agentsConfigured = true;
      }
      const profiles = new Profiles({ store });
      const workspaceFor = companionId => {
        const owner = runner?.ownerFor(companionId);
        return owner ? { owner, dir: runner.paths(owner).workspace } : null;
      };
      // Claude gets the companion's files in every turn's system prompt (not kept in its history);
      // Codex only when a new session starts, since its instructions become part of the conversation.
      const systemPrompt = (companionId, { fresh = true, recent = [] } = {}) => {
        const workspace = workspaceFor(companionId);
        if (!workspace) return null;
        ensureWorkspace(workspace.dir, workspace.owner);
        return instructions({ owner: workspace.owner, profile: profiles.get(companionId), dir: workspace.dir,
          files: workspace.owner.provider === 'claude' || fresh, recent });
      };
      conversations = new Conversations({ store, runner, systemPrompt, allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
        ...conversationOptions });
      conversations.recover();
      companionHttp = createCompanionHttp({ access, profiles, workspaceFor,
        runtimeStatus: async companionId => runner ? runner.status(companionId) : { state: 'unconfigured' },
        onForget: companionId => conversations.resetSessions(companionId) });
    }
    const runtimeStatus = async companionId => runner ? runner.status(companionId) : { state: 'unconfigured' };
    conversationHttp = createConversationHttp({ access, store, mode, conversations, runtimeStatus });
    if (mode === 'account') {
      accountHttp = createAccountHttp({ access, runtimeStatus });
      privateHttp = createPrivateHttp({ access, state: new PrivateStateStore(store) });
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) { store.close(); throw error; }
  return {
    server, store, url: `http://127.0.0.1:${server.address().port}`,
    conversations,
    async close() {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      // Running replies end as interrupted; nothing writes to a closed store.
      await conversations?.shutdown();
      store.close();
    }
  };
}

// Compare real paths: the service starts it through the ~/personal-agent/current link.
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href) {
  try {
    const app = await startServer({ dataDir: process.env.COMPANION_DATA_DIR, mode: process.env.COMPANION_MODE || 'unavailable',
      port: Number(process.env.COMPANION_PORT || 4318), pilotFile: process.env.COMPANION_PILOT_FILE,
      publicOrigin: process.env.COMPANION_PUBLIC_ORIGIN, runtimeFile: process.env.COMPANION_RUNTIME_FILE,
      runtimeDir: process.env.COMPANION_RUNTIME_DIR,
      binaries: { claude: process.env.COMPANION_CLAUDE_BIN || undefined, codex: process.env.COMPANION_CODEX_BIN || undefined } });
    console.log(`Personal Agent local bootstrap: ${app.url} (${process.env.COMPANION_MODE || 'unavailable'})`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(`Bootstrap refused: ${error.message}`); process.exitCode = 1; }
}
