import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { BootstrapStore } from './src/store.mjs';
import { adapterStatus, syntheticPreview } from './src/adapters.mjs';
import { createAccountValidator } from './src/account-validator.mjs';
import { createAccountAccess, createAccountHttp, readJsonBody } from './src/account-http.mjs';
import { loadPilotSubjects } from './src/pilot-config.mjs';
import { PrivateStateStore } from './src/private-state.mjs';
import { createPrivateHttp } from './src/private-http.mjs';
import { createConversationHttp } from './src/conversation-http.mjs';
import { loadRuntimeConfig, companionIdFor } from './src/runtime-config.mjs';
import { CompanionRunner } from './src/runner.mjs';
import { Conversations } from './src/conversations.mjs';
import { Profiles, ensureWorkspace, instructions } from './src/companion.mjs';
import { createCompanionHttp } from './src/companion-http.mjs';
import { SchedulerStore, SchedulerService } from './src/scheduler.mjs';
import { createSchedulerHttp, schedulerOperation } from './src/scheduler-http.mjs';
import { DiscordLinks, DiscordBridge } from './src/discord.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
// Claude-chan art (docs/COMPANION.md): outfits are whole pictures, faces are patches drawn over them.
const PORTRAIT_FACES = ['blink', 'talk', 'listening', 'thinking', 'happy', 'sleepy', 'laugh', 'wink', 'surprised', 'sad', 'worried',
  'teary-smile', 'embarrassed', 'pout', 'proud', 'excited', 'confused', 'determined', 'tender', 'love', 'focused'];
const PORTRAIT_OUTFITS = ['base', 'cozy-home', 'pajamas', 'rain', 'sunny', 'snow', 'windy', 'spring', 'summer', 'autumn', 'winter',
  'halloween', 'christmas', 'party', 'new-year', 'lunar-new-year', 'valentine', 'easter', 'summer-festival', 'birthday'];
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/companion.css', ['companion.css', 'text/css; charset=utf-8']],
  ['/companion-app.mjs', ['companion-app.mjs', 'text/javascript; charset=utf-8']],
  ['/reminders-ui.mjs', ['reminders-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/companion-character.mjs', ['companion-character.mjs', 'text/javascript; charset=utf-8']],
  ['/companion-theme.js', ['companion-theme.js', 'text/javascript; charset=utf-8']],
  ['/conversation-client.mjs', ['conversation-client.mjs', 'text/javascript; charset=utf-8']],
  // Old address of the chat page: it now redirects to the companion.
  ['/conversation.html', ['conversation.html', 'text/html; charset=utf-8']],
  // Illustrated characters.
  ...PORTRAIT_FACES.map(face => `faces/${face}`).concat(PORTRAIT_OUTFITS.map(outfit => `outfits/${outfit}`))
    .map(name => [`/characters/claude/${name}.webp`, [`characters/claude/${name}.webp`, 'image/webp']])
]);

// runtimeFile / runtimeDir: the per-owner agent runtime (docs/RUNTIME.md). Without them, account
// mode still serves conversations but every reply reports that no agent is configured.
export async function startServer({ dataDir, mode = 'unavailable', port = 4318, pilotFile, publicOrigin,
  pilotSubjects, validateAccount, runtimeFile, runtimeDir, binaries, runnerOptions = {}, conversationOptions = {}, schedulerOptions = {}, discordOptions = {} } = {}) {
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
  let schedulerHttp, schedulerService, schedulerStore, discord = null;
  const schedulerTokens = new Map(), schedulerOwnerTokens = new Map();
  const tokenFor = companionId => {
    if (!schedulerOwnerTokens.has(companionId)) {
      const token = randomBytes(32).toString('hex'); schedulerOwnerTokens.set(companionId, token); schedulerTokens.set(token, companionId);
    }
    return schedulerOwnerTokens.get(companionId);
  };
  let conversations = null;
  let refreshWorkspaceInstructions = () => {};
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
      if (path === '/internal/scheduler' && mode === 'account') {
        // The provider's stdio adapter receives an ephemeral token for exactly one owner.
        // This path never accepts cookies, companion selectors or settings changes.
        if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'POST is required.');
        const authorization = req.headers.authorization;
        const token = typeof authorization === 'string' && /^Bearer [a-f0-9]{64}$/.test(authorization) ? authorization.slice(7) : null;
        const companionId = token && schedulerTokens.get(token);
        if (!companionId) return fail(401, 'SCHEDULER_UNAUTHORIZED', 'Reminder tool authorization required.');
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
          return fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
        }
        const parsed = await readJsonBody(req, 16384);
        const result = parsed.failure ?? await schedulerOperation(schedulerService, companionId, parsed.value);
        if (result.closeConnection) res.setHeader('connection', 'close');
        return send(result.status, result.body);
      }
      if (path === '/api/schedules' && mode === 'account') {
        const result = await schedulerHttp(req);
        if (result.closeConnection) res.setHeader('connection', 'close');
        return send(result.status, result.body);
      }
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
      const profiles = new Profiles({ store });
      schedulerStore = new SchedulerStore({ store, timezoneFor: companionId => profiles.get(companionId)?.timezone ?? 'UTC',
        ...(schedulerOptions.now ? { now: schedulerOptions.now } : {}) });
      const owners = loadRuntimeConfig(runtimeFile);
      if (owners.length) {
        if (!runtimeDir) throw new Error('COMPANION_RUNTIME_DIR is required with COMPANION_RUNTIME_FILE');
        const appServersFor = runnerOptions.mcpServersFor ?? (() => []);
        runner = new CompanionRunner({ store, owners, runtimeDir, binaries, ...runnerOptions,
          mcpServersFor: owner => {
            const additional = appServersFor(owner), companionId = companionIdFor(store, owner);
            if (additional && typeof additional.then === 'function') {
              Promise.resolve(additional).catch(() => {}); throw new TypeError('App tools must be synchronous');
            }
            if (!Array.isArray(additional) || !companionId || !server.address()) throw new TypeError('Invalid app tools');
            return [...additional, { name: 'scheduler', command: process.execPath, args: [join(ROOT, 'src', 'scheduler-mcp.mjs')],
              env: { COMPANION_SCHEDULER_URL: `http://127.0.0.1:${server.address().port}/internal/scheduler`,
                COMPANION_SCHEDULER_TOKEN: tokenFor(companionId) }, allowedTools: ['create_schedule', 'list_schedules', 'cancel_schedule'] }];
          } });
        agentsConfigured = true;
      }
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
          files: workspace.owner.provider === 'claude' || fresh, recent }) +
          '\n\nUse your scheduler tools for reminders the owner asks for. Check list_schedules for the current time and owner timezone, then resolve an explicit ISO timestamp. Never claim a reminder was saved without a successful tool result. Do not create unsolicited reminders or enable periodic checks for the owner.';
      };
      conversations = new Conversations({ store, runner, systemPrompt, wakePolicy: {
        beforeStart: (companionId, id) => Boolean(runner?.ownerFor(companionId)) && schedulerStore.startInTransaction(companionId, id),
        canDeliver: (companionId, id) => schedulerStore.canDeliver(companionId, id) },
        onSettled: event => discord?.settled(event),
        ...conversationOptions });
      // A native resumed session keeps its old instructions. Refresh only after binding the socket,
      // before recovery can start a queued turn; a competing process must not reset live sessions.
      refreshWorkspaceInstructions = () => {
        for (const owner of owners) {
          const companionId = companionIdFor(store, owner);
          if (!companionId) continue;
          const workspace = workspaceFor(companionId);
          if (workspace) ensureWorkspace(workspace.dir, workspace.owner, {
            beforeInstructionsChange: () => conversations.resetSessions(companionId)
          });
        }
      };
      schedulerService = new SchedulerService({ scheduler: schedulerStore, conversations,
        companions: () => owners.map(owner => companionIdFor(store, owner)).filter(id => id && profiles.get(id)),
        ready: companionId => Boolean(runner?.ownerFor(companionId)), ...(schedulerOptions.pollMs ? { pollMs: schedulerOptions.pollMs } : {}) });
      schedulerHttp = createSchedulerHttp({ access, scheduler: schedulerService });
      // Discord (docs/DISCORD.md): each owner's own bot, DMs with the paired owner only.
      discord = new DiscordBridge({ links: new DiscordLinks({ store }), conversations, ...discordOptions,
        log: message => console.error(message) });
      companionHttp = createCompanionHttp({ access, profiles, workspaceFor,
        runtimeStatus: async companionId => runner ? runner.status(companionId) : { state: 'unconfigured' },
        discord,
        onForget: companionId => conversations.resetSessions(companionId),
        // Claude reads the look every turn; Codex keeps its first instructions, so it starts afresh.
        onLook: companionId => conversations.resetSessions(companionId) });
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
    // A competing process must bind its socket before it can recover another process's turns.
    refreshWorkspaceInstructions();
    conversations?.recover();
    schedulerService?.start();
    if (discordOptions.connect !== false) discord?.start();
  } catch (error) {
    discord?.stop();
    await schedulerService?.stop();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await conversations?.shutdown();
    store.close(); throw error;
  }
  return {
    server, store, url: `http://127.0.0.1:${server.address().port}`,
    conversations, scheduler: schedulerService, discord,
    async close() {
      discord?.stop();
      await schedulerService?.stop();
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
