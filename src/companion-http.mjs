// POST /api/companion: the signed-in owner's companion profile (name and look) and its memory
// (complete view, correction, forgetting and private export). Fresh account validation on every request.
import { CompanionError, ensureWorkspace } from './companion.mjs';
import { MemoryError, memorySnapshot, editMemory, forgetMemory, forgetAllMemory, exportMemory } from './memory.mjs';
import { ConversationError } from './conversations.mjs';
import { outfitFor } from './wardrobe.mjs';
import { DiscordError } from './discord.mjs';
import { ConnectorError } from './connectors.mjs';
import { GitHubError } from './github.mjs';
import { XError } from './x-posts.mjs';
import { createHash } from 'node:crypto';
import { PersonalityError, PERSONALITY_LIMITS } from './personality.mjs';
import { ContactError } from './contacts.mjs';
import { WeatherError } from './weather.mjs';
import { PushError } from './push.mjs';

const fail = (status, code, message) => ({ status, body: { error: { code, message } } });
const EMPTY_MEMORY_REVISION = createHash('sha256').update('[]').digest('hex');

// profiles: Profiles. workspaceFor(companionId) -> {dir, owner} or null when no agent is configured.
// onForget(companionId): durable session reset BEFORE any memory bytes are replaced.
// onLook(companionId): called when the name or look changed, so the agent's next session knows.
// discord: the DiscordBridge (docs/DISCORD.md), or null when connections are unavailable.
export function createCompanionHttp({ access, profiles, workspaceFor, runtimeStatus, assertMemoryIdle = () => {}, onForget = () => {}, onLook = () => {}, now = () => new Date(), discord = null, personality = null, contacts = null, weather = null, push = null, webPush = null, activeClients = null, connectors = null, github = null, x = null }) {
  const weatherNow = companionId => weather?.current(companionId) ?? null;
  return async function companion(request) {
    const parsed = await access.read(request, PERSONALITY_LIMITS.requestBytes);
    if (parsed.failure) return parsed.failure;
    const admitted = await access.authorize(request);
    if (admitted.failure) return admitted.failure;
    const companionId = admitted.companionId, payload = parsed.value;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail(400, 'INVALID_REQUEST', 'Invalid request.');
    const only = keys => Object.keys(payload).every(key => keys.includes(key));
    try {
      switch (payload.action) {
        case 'weather': {
          if (!only(['action']) || !weather) break;
          return { status: 200, body: weather.snapshot(companionId) };
        }
        case 'setWeatherPlace': {
          if (!only(['action', 'place']) || !weather) break;
          const snapshot = await weather.setPlace(companionId, payload.place);
          return { status: 200, body: { ...snapshot, wearing: outfitFor(profiles.get(companionId), now(), weatherNow(companionId)) } };
        }
        case 'contacts': {
          if(!only(['action'])||!contacts) break;
          return {status:200,body:contacts.snapshot(companionId)};
        }
        case 'setContact': {
          if(!only(['action','id','enabled','expectedRevision'])||!contacts) break;
          const {action,...change}=payload;
          return {status:200,body:contacts.set(companionId,change)};
        }
        case 'personality': {
          if (!only(['action']) || !personality) break;
          try { return { status: 200, body: personality.snapshot(companionId) }; }
          catch (error) {
            const workspace = workspaceFor(companionId);
            if (!(error instanceof PersonalityError) || error.code !== 'PERSONALITY_NOT_FOUND' || !workspace) throw error;
            // The fixed-file reader already checked the owning root and refused
            // unsafe existing SOUL bytes. First use follows normal native setup.
            ensureWorkspace(workspace.dir, workspace.owner);
            return { status: 200, body: personality.snapshot(companionId) };
          }
        }
        case 'personalityVersion': {
          if (!only(['action', 'revision']) || !personality) break;
          return { status: 200, body: { version: personality.version(companionId, payload.revision) } };
        }
        case 'editPersonality':
        case 'restorePersonality': {
          const restoring = payload.action === 'restorePersonality';
          if (!personality || !only(restoring ? ['action', 'revision', 'expectedRevision', 'confirm'] : ['action', 'content', 'expectedRevision'])) break;
          const { action, ...change } = payload;
          const beforeChange = () => { assertMemoryIdle(companionId); return onForget(companionId); };
          try { assertMemoryIdle(companionId); }
          catch (error) { if (error?.code === 'MEMORY_BUSY') throw new PersonalityError('PERSONALITY_BUSY'); throw error; }
          return { status: 200, body: restoring ? personality.restore(companionId, change, beforeChange) : personality.edit(companionId, change, beforeChange) };
        }
        case 'get': {
          if (!only(['action'])) break;
          const runtime = await runtimeStatus(companionId);
          const profile = profiles.get(companionId);
          return { status: 200, body: { profile, wearing: outfitFor(profile, now(), weatherNow(companionId)),
            runtime: { state: runtime.state, ...(runtime.provider ? { provider: runtime.provider } : {}) } } };
        }
        case 'setProfile': {
          if (!only(['action', 'profile'])) break;
          const before = profiles.get(companionId), profile = profiles.set(companionId, payload.profile);
          if (!before || ['name', 'character', 'color', 'outfit'].some(key => before[key] !== profile[key])) onLook(companionId);
          return { status: 200, body: { profile, wearing: outfitFor(profile, now(), weatherNow(companionId)) } };
        }
        case 'memory': {
          if (!only(['action'])) break;
          const workspace = workspaceFor(companionId);
          if (!workspace) return { status: 200, body: { files: [], revision: EMPTY_MEMORY_REVISION } };
          memorySnapshot(workspace.dir); // Refuse unsafe roots/files before optional first-use initialization.
          ensureWorkspace(workspace.dir, workspace.owner);
          return { status: 200, body: memorySnapshot(workspace.dir) };
        }
        case 'editMemory':
        case 'forget': {
          if (!only(payload.action === 'forget' ? ['action', 'file', 'id', 'expectedRevision'] : ['action', 'file', 'id', 'text', 'expectedRevision'])) break;
          if (typeof payload.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(payload.expectedRevision)) return fail(409, 'MEMORY_CONFLICT', 'Reload your saved notes before changing them.');
          const workspace = workspaceFor(companionId);
          if (!workspace) return fail(404, 'NOT_FOUND', 'Nothing to forget.');
          assertMemoryIdle(companionId);
          const { action, ...change } = payload;
          const beforeChange = () => { assertMemoryIdle(companionId); onForget(companionId); };
          return { status: 200, body: action === 'forget' ? forgetMemory(workspace.dir, change, beforeChange) : editMemory(workspace.dir, change, beforeChange) };
        }
        case 'forgetAll': {
          if (!only(['action', 'expectedRevision', 'confirm']) || payload.confirm !== true) break;
          const workspace = workspaceFor(companionId);
          if (!workspace) return fail(404, 'NOT_FOUND', 'No saved notes are available.');
          assertMemoryIdle(companionId);
          return { status: 200, body: forgetAllMemory(workspace.dir, { expectedRevision: payload.expectedRevision, confirm: true }, () => {
            assertMemoryIdle(companionId); onForget(companionId);
          }) };
        }
        case 'exportMemory': {
          if (!only(['action'])) break;
          const workspace = workspaceFor(companionId);
          if (!workspace) return fail(404, 'NOT_FOUND', 'No saved notes are available.');
          return { status: 200, body: { export: exportMemory(workspace.dir, { now: () => now().getTime() }) } };
        }
        case 'discord': {
          if (!only(['action']) || !discord) break;
          return { status: 200, body: { discord: discord.status(companionId) } };
        }
        case 'discordLink': {
          if (!only(['action', 'token']) || !discord) break;
          return { status: 200, body: { discord: await discord.link(companionId, payload.token) } };
        }
        // Android push (docs/PUSH.md): the app registers or removes its own FCM token for this owner.
        case 'pushRegister': {
          if (!only(['action', 'token']) || !push) break;
          return { status: 200, body: push.register(companionId, payload.token) };
        }
        case 'pushUnregister': {
          if (!only(['action', 'token']) || !push) break;
          return { status: 200, body: push.unregister(companionId, payload.token) };
        }
        // Web Push (docs/PUSH.md): the installed web app's own subscription for this owner.
        case 'webPushKey': {
          if (!only(['action']) || !webPush) break;
          return { status: 200, body: { publicKey: webPush.publicKey() } };
        }
        case 'webPushStatus': {
          if (!only(['action', 'endpoint']) || !webPush) break;
          return { status: 200, body: webPush.subscriptions.status(companionId, payload.endpoint) };
        }
        case 'webPushSubscribe': {
          if (!only(['action', 'endpoint', 'p256dh', 'auth', 'preview']) || !webPush) break;
          return { status: 200, body: webPush.subscriptions.subscribe(companionId, payload) };
        }
        case 'webPushPresence': {
          if (!only(['action', 'endpoint', 'present']) || !webPush) break;
          return { status: 200, body: webPush.subscriptions.presence(companionId, payload.endpoint, payload.present) };
        }
        // #59: a client in active use (visible, focused, recent input) holds pushes to the owner's other devices.
        case 'clientActive': {
          if (!only(['action', 'client', 'active', 'threadId']) || !activeClients) break;
          return { status: 200, body: activeClients.report(companionId, { client: payload.client, active: payload.active, threadId: payload.threadId ?? null }) };
        }
        case 'webPushUnsubscribe': {
          if (!only(['action', 'endpoint']) || !webPush) break;
          return { status: 200, body: webPush.subscriptions.unsubscribe(companionId, payload.endpoint) };
        }
        case 'connectors': {
          if (!only(['action']) || !connectors) break;
          return { status: 200, body: connectors.list(companionId) };
        }
        case 'setConnector': {
          if (!only(['action', 'id', 'enabled']) || !connectors) break;
          return { status: 200, body: connectors.set(companionId, payload.id, payload.enabled) };
        }
        // GitHub (#45): this owner's own token. The reply is the Connectors list; the token never comes back.
        case 'githubLink': {
          if (!only(['action', 'token']) || !github || !connectors) break;
          await github.link(companionId, payload.token);
          return { status: 200, body: connectors.list(companionId) };
        }
        case 'githubUnlink': {
          if (!only(['action']) || !github || !connectors) break;
          github.unlink(companionId);
          return { status: 200, body: connectors.list(companionId) };
        }
        // X / Twitter (#46): this owner's optional official API key; it never comes back.
        case 'xKeyLink': {
          if (!only(['action', 'token']) || !x || !connectors) break;
          await x.linkKey(companionId, payload.token);
          return { status: 200, body: connectors.list(companionId) };
        }
        case 'xKeyUnlink': {
          if (!only(['action']) || !x || !connectors) break;
          x.unlinkKey(companionId);
          return { status: 200, body: connectors.list(companionId) };
        }
        case 'discordUnlink': {
          if (!only(['action']) || !discord) break;
          return { status: 200, body: { discord: discord.unlink(companionId) } };
        }
        default: break;
      }
      return fail(400, 'INVALID_REQUEST', 'Invalid request.');
    } catch (error) {
      if (error instanceof WeatherError) return fail(error.status, error.code, error.code === 'PLACE_NOT_FOUND' ? 'That place was not found. Try a nearby city.' : error.code === 'INVALID_REQUEST' ? 'Invalid request.' : 'The weather service is unavailable right now. Try again later.');
      if (error instanceof ContactError) return fail(error.status,error.code,error.message);
      if (error instanceof PushError) return fail(error.status, error.code, 'Invalid request.');
      if (error instanceof PersonalityError) return fail(error.status, error.code, error.message);
      if (error instanceof CompanionError) return fail(error.status, error.code, 'Invalid request.');
      if (error instanceof MemoryError || error instanceof ConversationError) {
        const message = error.code === 'MEMORY_BUSY' ? 'Finish or stop the current reply, wait for it to stop, then try again.'
          : error.code === 'MEMORY_CONFLICT' ? 'Your saved notes changed. Reload them before trying again.'
          : 'Your saved notes could not be read or changed. Reload and try again.';
        return fail(error.status, error.code, message);
      }
      if (error instanceof ConnectorError) return fail(error.status, error.code, error.code === 'CONNECTOR_UNAVAILABLE' ? 'This connector is not set up for you.' : 'Invalid request.');
      if (error instanceof GitHubError) return fail(error.code === 'INVALID_TOKEN' ? 400 : error.status, error.code,
        error.code === 'INVALID_TOKEN' ? 'GitHub did not accept that token.' : 'GitHub could not be reached. Try again later.');
      if (error instanceof XError) return fail(error.status, error.code, ['X_INVALID_KEY', 'X_KEY_REJECTED'].includes(error.code)
        ? 'X did not accept that key.' : 'X could not be reached. Try again later.');
      if (error instanceof DiscordError) return fail(error.status, error.code, 'Discord could not be linked.');
      return fail(503, 'UNAVAILABLE', 'Your companion is unavailable right now.');
    }
  };
}
