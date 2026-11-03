import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { BootstrapStore } from './src/store.mjs';
import { adapterStatus, syntheticPreview } from './src/adapters.mjs';
import { createAccountValidator } from './src/account-validator.mjs';
import { createAccountAccess, createAccountHttp, readJsonBody, sameOriginFetch } from './src/account-http.mjs';
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
import { FileStore, FileError, FILE_LIMITS } from './src/files.mjs';
import { createFileHttp, fileFailure } from './src/file-http.mjs';
import { PersonalityStore } from './src/personality.mjs';
import { Contacts, ContactError } from './src/contacts.mjs';
import { Weather } from './src/weather.mjs';
import { BoardCompanion } from './src/board-companion.mjs';
import { PushDevices, FcmSender, PushNotifier } from './src/push.mjs';

const BOARD_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const CONTENT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', log: 'text/plain', mp4: 'video/mp4' };
const contentTypeFor = name => CONTENT_TYPES[/\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase()] ?? 'application/octet-stream';

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
  ['/memory-ui.mjs', ['memory-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/personality-ui.mjs', ['personality-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/contact-ui.mjs', ['contact-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/weather-ui.mjs', ['weather-ui.mjs', 'text/javascript; charset=utf-8']],
  ['/companion-character.mjs', ['companion-character.mjs', 'text/javascript; charset=utf-8']],
  ['/companion-theme.js', ['companion-theme.js', 'text/javascript; charset=utf-8']],
  ['/conversation-client.mjs', ['conversation-client.mjs', 'text/javascript; charset=utf-8']],
  // Old address of the chat page: it now redirects to the companion.
  ['/conversation.html', ['conversation.html', 'text/html; charset=utf-8']],
  // Illustrated characters.
  ...PORTRAIT_FACES.map(face => `faces/${face}`).concat(PORTRAIT_OUTFITS.map(outfit => `outfits/${outfit}`),
    PORTRAIT_OUTFITS.filter(outfit => outfit !== 'base').map(outfit => `fronts/${outfit}`))
    .map(name => [`/characters/claude/${name}.webp`, [`characters/claude/${name}.webp`, 'image/webp']])
]);

// runtimeFile / runtimeDir: the per-owner agent runtime (docs/RUNTIME.md). Without them, account
// mode still serves conversations but every reply reports that no agent is configured.
// The published Android release, or null. android.json: {"version":"0.3.1","file":"companion-0.3.1.apk"}.
function androidRelease(dataDir) {
  try {
    const dir = join(dataDir, 'downloads'), info = JSON.parse(readFileSync(join(dir, 'android.json'), 'utf8'));
    if (typeof info?.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(info.version)
        || typeof info.file !== 'string' || !/^[A-Za-z0-9._-]{1,80}\.apk$/.test(info.file)) return null;
    const path = join(dir, info.file), { size } = statSync(path);
    return size > 0 ? { version: info.version, path, size } : null;
  } catch { return null; }
}

export async function startServer({ dataDir, mode = 'unavailable', port = 4318, pilotFile, publicOrigin,
  pilotSubjects, validateAccount, runtimeFile, runtimeDir, binaries, runnerOptions = {}, conversationOptions = {}, schedulerOptions = {}, discordOptions = {}, fileOptions = {}, weatherOptions = {}, boardOptions = {}, pushOptions = {} } = {}) {
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
  let files = null, fileHttp, contacts = null, weather = null, boardCompanion = null, pushDevices = null, pushNotifier = null;
  const fileTurns = new Map();
  const contactTurns = new Map();
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
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 120000, headersTimeout: 5000 }, async (req, res) => {
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
      if (req.headers.origin && !allowedOrigins().has(req.headers.origin) && !(req.headers.origin === 'null' && sameOriginFetch(req))) {
        return fail(403, 'ORIGIN_REJECTED', 'Same-origin access required.');
      }
      // Exact raw paths only: queries cannot enable demo and traversal is rejected.
      const path = req.url;
      if (path === '/internal/contacts' && mode === 'account') {
        if(req.method!=='POST') return fail(405,'METHOD_NOT_ALLOWED','POST is required.');
        const token=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization??'')?.[1], turn=token&&contactTurns.get(token);
        if(!turn?.current()) return fail(401,'CONTACT_TURN_ENDED','This owner reply is no longer active.');
        if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')) return fail(415,'UNSUPPORTED_MEDIA_TYPE','Use application/json.');
        const parsed=await readJsonBody(req,32768); if(parsed.failure) return send(parsed.failure.status,parsed.failure.body);
        try { return send(200,contacts.send(turn.companionId,parsed.value,turn)); }
        catch(error) { const known=error instanceof ContactError?error:new ContactError(); return fail(known.status,known.code,known.message); }
      }
      if (path === '/internal/files' && mode === 'account') {
        if (req.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'POST is required.');
        const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
        const turn = token && fileTurns.get(token);
        if (!turn?.current()) return fail(401, 'FILE_TURN_ENDED', 'This file tool reply is no longer active.');
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
        const parsed = await readJsonBody(req, 16384);
        if (parsed.failure) return send(parsed.failure.status, parsed.failure.body);
        const input = parsed.value;
        if (input && typeof input === 'object' && !Array.isArray(input) && input.action === 'board') {
          // attach_to_board: one workspace file to a Board thread through the owner's own Board bridge.
          if (Object.keys(input).some(key => !['action', 'path', 'threadId'].includes(key)) || typeof input.threadId !== 'string'
              || !/^[A-Za-z0-9_-]{1,64}$/.test(input.threadId) || !boardCompanion?.configuredFor(turn.companionId)) return fail(400, 'BOARD_UNCONFIGURED', 'No Board connection.');
          try {
            const file = files.readWorkspaceFile(turn.companionId, input.path, BOARD_ATTACHMENT_BYTES);
            const attachment = await boardCompanion.attach(turn.companionId, { threadId: input.threadId, filename: file.name,
              contentType: contentTypeFor(file.name), bytes: file.bytes });
            return send(200, { attachment: { id: attachment?.id, filename: attachment?.filename ?? file.name, size: attachment?.size ?? file.bytes.length } });
          } catch (error) {
            if (error instanceof FileError) { const result = fileFailure(error); return send(result.status, result.body); }
            const code = ['BOARD_REFUSED', 'BOARD_UNCONFIGURED'].includes(error?.code) ? error.code : 'BOARD_UNAVAILABLE';
            return fail(code === 'BOARD_UNAVAILABLE' ? 503 : 400, code, 'The Board upload failed.');
          }
        }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['requestId', 'path', 'caption'].includes(key))
            || typeof input.requestId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(input.requestId)) return fail(400, 'INVALID_FILE', 'Invalid file tool arguments.');
        let file;
        try {
          if (!turn.current()) throw new FileError('FILE_TURN_ENDED', 409);
          const requestId = createHash('sha256').update(JSON.stringify([turn.threadId, turn.requestId, input.requestId])).digest('hex');
          file = await files.outgoing(turn.companionId, { ...input, requestId, threadId: turn.threadId }, turn.current);
          turn.attach(file);
          return send(200, { file });
        } catch (error) {
          try { if (file) files.discardUnbound(turn.companionId, file.id); } catch (cleanup) { error = cleanup; }
          const result = fileFailure(error); return send(result.status, result.body);
        }
      }
      if ((path === '/api/files' || path.startsWith('/api/files/')) && mode === 'account') return fileHttp(req, res, headers);
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
      // The Android app download (docs/COMPANION.md): <dataDir>/downloads/android.json names the current APK.
      if ((path === '/android.json' || path === '/companion.apk') && ['GET', 'HEAD'].includes(req.method)) {
        const release = androidRelease(dataDir);
        if (!release) return fail(404, 'NOT_FOUND', 'The Android app is not available yet.');
        if (path === '/android.json') return send(200, { version: release.version, size: release.size });
        res.setHeader('content-disposition', `attachment; filename="companion-${release.version}.apk"`);
        return send(200, readFileSync(release.path), 'application/vnd.android.package-archive');
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
                COMPANION_SCHEDULER_TOKEN: tokenFor(companionId) }, allowedTools: ['create_schedule', 'list_schedules', 'cancel_schedule', 'create_release_watch', 'create_topic_watch', 'update_release_watch'] }];
          } });
        agentsConfigured = true;
      }
      const workspaceFor = companionId => {
        const owner = runner?.ownerFor(companionId);
        return owner ? { owner, dir: runner.paths(owner).workspace } : null;
      };
      const personality = new PersonalityStore({ store, workspaceFor });
      weather = new Weather({ store, ...(weatherOptions.fetchImpl ? { fetchImpl: weatherOptions.fetchImpl } : {}) });
      const displayLabel = (value, fallback) => {
        let text='';
        for(const char of String(value??fallback).replace(/[\x00-\x1f\x7f]/g,' ').trim()) {
          if(text.length+char.length>80) break; text+=char;
        }
        return text.trim()||fallback;
      };
      contacts = new Contacts({ store,
        directory: () => owners.flatMap(owner => {
          const id=companionIdFor(store,owner), profile=id&&profiles.get(id);
          return id?[{id,name:displayLabel(profile?.name,'Companion'),ownerLabel:displayLabel(owner.name??owner.label,'Owner')}]:[];
        }),
        deliver:(companionId,threadId,text,peer)=>conversations.peerInTransaction(companionId,threadId,text,peer)
      });
      files = new FileStore({ store, dataDir, workspaceFor, ...fileOptions });
      fileHttp = createFileHttp({ access, files });
      const fileToolsForTurn = (companionId, context) => {
        let available=[];
        try { if(context.ownerText?.trim()) available=contacts.forTurn(companionId); }
        catch { console.error('Contact tools unavailable for this turn.'); }
        const token = randomBytes(32).toString('hex');
        fileTurns.set(token, { companionId, ...context });
        const servers=[{ name: 'files', command: process.execPath, args: [join(ROOT, 'src', 'file-mcp.mjs')],
          env: { COMPANION_FILE_URL: `http://127.0.0.1:${server.address().port}/internal/files`, COMPANION_FILE_TOKEN: token,
            ...(boardCompanion?.configuredFor(companionId) ? { COMPANION_FILE_BOARD: '1' } : {}) },
          allowedTools: boardCompanion?.configuredFor(companionId) ? ['send_file', 'attach_to_board'] : ['send_file'] }];
        let contactToken;
        if(available.length) {
          contactToken=randomBytes(32).toString('hex'); contactTurns.set(contactToken,{companionId,...context,contacts:available});
          servers.push({name:'contacts',command:process.execPath,args:[join(ROOT,'src','contact-mcp.mjs')],env:{
            COMPANION_CONTACT_URL:`http://127.0.0.1:${server.address().port}/internal/contacts`,COMPANION_CONTACT_TOKEN:contactToken,
            COMPANION_CONTACT_DIRECTORY:JSON.stringify(available.map(({id,name,ownerLabel})=>({id,name,ownerLabel})))
          },allowedTools:['message_companion']});
        }
        return {servers,dispose:()=>{fileTurns.delete(token);if(contactToken)contactTurns.delete(contactToken);}};
      };
      // Claude gets the companion's files in every turn's system prompt (not kept in its history);
      // Codex only when a new session starts, since its instructions become part of the conversation.
      const systemPrompt = (companionId, { fresh = true, recent = [] } = {}) => {
        const workspace = workspaceFor(companionId);
        if (!workspace) return null;
        ensureWorkspace(workspace.dir, workspace.owner);
        const current = weather.current(companionId), place = current ? weather.snapshot(companionId).place : null;
        return instructions({ owner: workspace.owner, profile: profiles.get(companionId), dir: workspace.dir,
          files: workspace.owner.provider === 'claude' || fresh, recent, weather: current ? { place, current } : null }) +
          '\n\nUse your scheduler tools for reminders the owner asks for. Check list_schedules for the current time and owner timezone, then resolve an explicit ISO timestamp. Never claim a reminder was saved without a successful tool result. Do not create unsolicited reminders or enable periodic checks for the owner.';
      };
      conversations = new Conversations({ store, runner, systemPrompt, files, fileToolsForTurn, wakePolicy: {
        beforeStart: (companionId, id) => (schedulerStore.isReleaseOccurrence(companionId, id) || Boolean(runner?.ownerFor(companionId))) && schedulerStore.startInTransaction(companionId, id),
        canDeliver: (companionId, id) => schedulerStore.canDeliver(companionId, id),
        recordReleaseCheck: (companionId, id, check, text) => schedulerStore.recordReleaseCheck(companionId, id, check, text),
        releaseDelivered: (companionId, id) => schedulerStore.releaseDelivered(companionId, id) },
        onSettled: event => { discord?.settled(event); pushNotifier?.settled(event); },
        onNativeSettled: companionId => {
          try { if (workspaceFor(companionId)) personality.observe(companionId); }
          catch { console.error('Personality history observation unavailable.'); }
        },
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
        companions: () => [...new Set([...owners.map(owner => companionIdFor(store, owner)).filter(id => id && profiles.get(id)),
          ...schedulerStore.releaseCompanions()])],
        ready: companionId => Boolean(runner?.ownerFor(companionId)), ...(schedulerOptions.pollMs ? { pollMs: schedulerOptions.pollMs } : {}) });
      schedulerHttp = createSchedulerHttp({ access, scheduler: schedulerService });
      // Board companion duties (docs/BOARD-COMPANION.md): Needs-you wakes, profile sync and attachments.
      boardCompanion = new BoardCompanion({ store, owners, profiles, scheduler: schedulerService,
        companionIdFor: owner => companionIdFor(store, owner), log: message => console.error(message), ...boardOptions });
      // Android push (docs/PUSH.md): on when the FCM service-account key exists. Devices register through /api/companion.
      pushDevices = new PushDevices({ store });
      const pushKey = pushOptions.keyFile ?? process.env.COMPANION_PUSH_KEY
        ?? join(process.env.HOME ?? '', '.config/personal-agent/fcm-service-account.json');
      if (pushOptions.sender || existsSync(pushKey)) pushNotifier = new PushNotifier({ devices: pushDevices,
        sender: pushOptions.sender ?? new FcmSender({ keyFile: pushKey }), nameFor: companionId => profiles.get(companionId)?.name,
        log: message => console.error(message) });
      // Discord (docs/DISCORD.md): each owner's own bot, DMs with the paired owner only.
      discord = new DiscordBridge({ links: new DiscordLinks({ store }), conversations, files, ...discordOptions,
        log: message => console.error(message) });
      companionHttp = createCompanionHttp({ access, profiles, workspaceFor, personality, contacts, weather,
        runtimeStatus: async companionId => runner ? runner.status(companionId) : { state: 'unconfigured' },
        discord, push: pushDevices,
        assertMemoryIdle: companionId => conversations.assertMemoryIdle(companionId),
        onForget: companionId => conversations.resetSessions(companionId),
        // Claude reads the look every turn; Codex keeps its first instructions, so it starts afresh.
        onLook: companionId => {
          conversations.resetSessions(companionId);
          boardCompanion?.syncProfile(companionId).catch(() => console.error('Board profile sync failed; retried on the next check.'));
        } });
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
    files?.recover();
    conversations?.recover();
    schedulerService?.start();
    if (weatherOptions.poll !== false) weather?.start();
    if (boardOptions.poll !== false) boardCompanion?.start();
    if (discordOptions.connect !== false) discord?.start();
  } catch (error) {
    weather?.stop(); boardCompanion?.stop();
    discord?.stop();
    await schedulerService?.stop();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await conversations?.shutdown();
    store.close(); throw error;
  }
  return {
    server, store, url: `http://127.0.0.1:${server.address().port}`,
    conversations, files, scheduler: schedulerService, discord,
    async close() {
      weather?.stop(); boardCompanion?.stop();
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
      fileOptions: { limits: { normal: Number(process.env.COMPANION_FILE_MAX_BYTES ?? FILE_LIMITS.normal),
        video: Number(process.env.COMPANION_VIDEO_MAX_BYTES ?? FILE_LIMITS.video), quota: Number(process.env.COMPANION_FILE_QUOTA_BYTES ?? FILE_LIMITS.quota) } },
      binaries: { claude: process.env.COMPANION_CLAUDE_BIN || undefined, codex: process.env.COMPANION_CODEX_BIN || undefined } });
    console.log(`Personal Agent local bootstrap: ${app.url} (${process.env.COMPANION_MODE || 'unavailable'})`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(`Bootstrap refused: ${error.message}`); process.exitCode = 1; }
}
