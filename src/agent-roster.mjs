// C-chan's agent roster (#73, docs/AGENT-RUNNER.md). Instead of one static agent doing everything, C-chan defines
// the agents she needs: per-task agents (one ticket, archived when it is done) and standing agents grouped in teams
// (for example three Haiku coders and an Opus reviewer). The runner stores the roster and enforces it on every launch:
// the agent must exist and be active, it runs with its own model, only in its repos, within its own turn and time
// limits, and only the actions it is allowed:
//   work    claim a ticket and move it to review with outcome and evidence
//   commit  edit files and commit on its branch (without it the agent gets no edit tools, and a commit fails the run)
//   review  review another agent's branch and post a verdict on the ticket's thread (no status change)
//   merge   (#85) land an accepted, reviewed branch on main: merge, full test suite, push. Runs without a model.
// Each agent is mirrored on the Board as a managed agent profile when the runner's Board profile has the owner's
// management grant (see BoardRosterMirror); the roster here stays the source of truth.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PROVIDERS } from './agent-providers.mjs';
import { hardLimit } from './escalation.mjs';

export const ROLES = Object.freeze({
  coder: Object.freeze(['work', 'commit']),
  reviewer: Object.freeze(['review']),
  merger: Object.freeze(['merge'])
});
export const ACTIONS = Object.freeze(['work', 'commit', 'review', 'merge']);
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
// What the Board copy reflects: a team change alone also needs a new mirror.
const mirrorKey = view => `${view.version}|${view.team ?? ''}|${view.status}`;
const MAX_AGENTS = 60, MAX_TEAMS = 20, MAX_MEMBERS = 12, MAX_SKILLS = 8;

export class RosterError extends Error {
  constructor(code, message) { super(message); this.name = 'RosterError'; this.code = code; }
}
const invalid = message => { throw new RosterError('INVALID', message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const plain = (value, max, label) => {
  if (typeof value !== 'string' || value.length > max) invalid(`${label}: text of at most ${max} characters`);
  return value.trim();
};

function checkName(value, label = 'name') {
  if (typeof value !== 'string' || !NAME.test(value)) invalid(`${label}: lowercase letters, digits and dashes, at most 40`);
  return value;
}

// One agent's fields from a create or update request. `base` is the stored agent for an update.
function agentFields(input, base = null) {
  const allowed = ['name', 'role', 'kind', 'model', 'provider', 'ticketId', 'actions', 'repos', 'skills', 'instructions',
    'maxTurns', 'maxMinutes', 'status', 'description'];
  const extra = Object.keys(input).filter(key => !allowed.includes(key));
  if (extra.length) invalid(`unknown field(s): ${extra.join(', ')}`);
  const out = { ...(base ?? {}) };
  if (!base) out.name = checkName(input.name);
  else if (input.name !== undefined && input.name !== base.name) invalid('name cannot change; archive and create a new agent');

  const role = input.role ?? base?.role ?? 'coder';
  if (!Object.hasOwn(ROLES, role)) invalid(`role: one of ${Object.keys(ROLES).join(', ')}`);
  if (base && input.role !== undefined && input.role !== base.role && input.actions === undefined) out.actions = [...ROLES[role]];
  out.role = role;

  const kind = input.kind ?? base?.kind ?? 'standing';
  if (!['standing', 'task'].includes(kind)) invalid('kind: standing (kept) or task (one ticket, archived when it is done)');
  out.kind = kind;
  if (input.ticketId !== undefined) {
    if (input.ticketId !== null && (typeof input.ticketId !== 'string' || !ID.test(input.ticketId))) invalid('ticketId: the Board ticket id');
    out.ticketId = input.ticketId;
  }
  out.ticketId ??= null;
  if (kind === 'task' && !out.ticketId) invalid('a task agent needs its ticketId');

  const providerName = input.provider ?? base?.provider ?? 'claude';
  const provider = PROVIDERS[providerName];
  if (!provider) invalid('provider: claude');
  if (!provider.available) throw new RosterError('PROVIDER_UNAVAILABLE', `The ${providerName} backend is not enabled yet.`);
  out.provider = providerName;
  const model = input.model ?? base?.model;
  if (!Object.hasOwn(provider.models, model ?? '')) invalid(`model: one of ${Object.keys(provider.models).join(', ')}`);
  out.model = model;

  if (input.actions !== undefined) {
    if (!Array.isArray(input.actions) || !input.actions.length || input.actions.some(action => !ACTIONS.includes(action))) {
      invalid(`actions: a non-empty list of ${ACTIONS.join(', ')}`);
    }
    out.actions = [...new Set(input.actions)];
  }
  out.actions ??= [...ROLES[role]];
  if (out.actions.includes('commit') && !out.actions.includes('work')) invalid('commit needs work');

  if (input.repos !== undefined) {
    if (!Array.isArray(input.repos) || input.repos.length > 10) invalid('repos: a list of at most 10 sandbox repos ([] = any)');
    out.repos = [...new Set(input.repos.map(repo => checkName(repo, 'repo')))];
  }
  out.repos ??= [];
  if (input.skills !== undefined) {
    if (!Array.isArray(input.skills) || input.skills.length > MAX_SKILLS) invalid(`skills: at most ${MAX_SKILLS} short texts`);
    out.skills = input.skills.map(skill => plain(skill, 2000, 'skill')).filter(Boolean);
  }
  out.skills ??= [];
  if (input.instructions !== undefined) out.instructions = plain(input.instructions, 4000, 'instructions');
  out.instructions ??= '';
  if (input.description !== undefined) out.description = plain(input.description, 500, 'description');
  out.description ??= '';
  for (const [key, max] of [['maxTurns', 400], ['maxMinutes', 240]]) {
    if (input[key] === undefined) continue;
    if (input[key] !== null && !(Number.isSafeInteger(input[key]) && input[key] >= 1 && input[key] <= max)) invalid(`${key}: 1 to ${max}`);
    out[key] = input[key];
  }
  out.maxTurns ??= null; out.maxMinutes ??= null;
  if (input.status !== undefined) {
    if (!['active', 'paused'].includes(input.status)) invalid('status: active or paused (archive has its own call)');
    out.status = input.status;
  }
  out.status ??= 'active';
  // Hard limits (#74) cannot be written into an agent's standing instructions or skills either.
  const limit = hardLimit([out.instructions, ...out.skills].join('\n'));
  if (limit) throw new RosterError('HARD_LIMIT', `Refused: ${limit.label} is a hard limit and only the owner can approve it.`);
  return out;
}

export class Roster {
  #file; #now; #mirror; #log; #state; #chains = new Map();

  // file: JSON state file. mirror: optional Board mirror (sync(agent) -> board fields). now: clock for tests.
  constructor({ file = null, mirror = null, log = () => {}, now = Date.now } = {}) {
    this.#file = file; this.#mirror = mirror; this.#log = log; this.#now = now;
    this.#state = this.#load();
  }

  #load() {
    if (this.#file && existsSync(this.#file)) {
      const value = JSON.parse(readFileSync(this.#file, 'utf8'));
      return { agents: Array.isArray(value.agents) ? value.agents : [], teams: Array.isArray(value.teams) ? value.teams : [] };
    }
    return { agents: [], teams: [] };
  }

  #save() {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    writeFileSync(this.#file + '.tmp', JSON.stringify(this.#state), { mode: 0o600 });
    renameSync(this.#file + '.tmp', this.#file);
  }

  #agent(name) { return this.#state.agents.find(agent => agent.name === name) ?? null; }
  #team(name) { return this.#state.teams.find(team => team.name === name) ?? null; }
  #teamOf(name) { return this.#state.teams.find(team => team.status !== 'archived' && team.members.includes(name))?.name ?? null; }
  #view(agent) { return { ...agent, team: this.#teamOf(agent.name), board: { ...(agent.board ?? {}) } }; }

  list({ includeArchived = false } = {}) {
    const keep = item => includeArchived || item.status !== 'archived';
    return { agents: this.#state.agents.filter(keep).map(agent => this.#view(agent)),
      teams: this.#state.teams.filter(keep).map(team => ({ ...team, members: [...team.members] })) };
  }

  // At-a-glance counts for the runner's /status. Archiving is mirrored to the Board too (and retried by resync()), so
  // archived agents count in mirrored/pending/error like the others. error: the latest Board mirror error, or null.
  summary() {
    const agents = { active: { total: 0 }, paused: { total: 0 }, archived: { total: 0 } };
    for (const role of Object.keys(ROLES)) for (const group of Object.values(agents)) group[role] = 0;
    let mirrored = 0, pending = 0, latest = null;
    for (const agent of this.#state.agents) {
      const group = Object.hasOwn(agents, agent.status) ? agents[agent.status] : null;
      if (!group) continue;
      group.total++;
      if (Object.hasOwn(group, agent.role)) group[agent.role]++;
      const board = agent.board ?? {};
      if (board.syncedKey === mirrorKey(this.#view(agent)) && !board.error) mirrored++; else pending++;
      if (board.error && (!latest || (board.triedAt ?? 0) >= (latest.triedAt ?? 0))) latest = board;
    }
    return { agents, teams: this.#state.teams.filter(team => team.status !== 'archived').length,
      board: { mirrored, pending, error: latest?.error ?? null } };
  }

  get(name) { const agent = this.#agent(name); return agent ? this.#view(agent) : null; }

  #checkVersion(item, expectedVersion) {
    if (expectedVersion === undefined) invalid('expectedVersion: the version you last read (agents_roster)');
    if (item.version !== expectedVersion) throw new RosterError('CONFLICT', `${item.name} changed (version ${item.version}); read the roster again.`);
  }

  create(input = {}) {
    if (!object(input)) invalid('agent: an object');
    const { createdBy = 'c-chan', ...fields } = input;
    const existing = this.#agent(fields.name);
    if (existing && existing.status !== 'archived') throw new RosterError('EXISTS', `Agent ${fields.name} already exists; update it instead.`);
    if (this.#state.agents.filter(agent => agent.status !== 'archived').length >= MAX_AGENTS) throw new RosterError('LIMIT', `At most ${MAX_AGENTS} active agents.`);
    const values = agentFields(fields);
    const agent = { ...values, version: 1, createdAt: this.#now(), updatedAt: this.#now(), archivedAt: null, createdBy,
      board: existing?.board?.profileId ? { profileId: existing.board.profileId, version: existing.board.version, revive: true } : {} };
    if (existing) this.#state.agents.splice(this.#state.agents.indexOf(existing), 1);
    this.#state.agents.push(agent);
    this.#save();
    this.#sync(agent);
    return this.#view(agent);
  }

  update(name, { expectedVersion, ...changes } = {}) {
    const agent = this.#agent(checkName(name));
    if (!agent || agent.status === 'archived') throw new RosterError('NOT_FOUND', `No active agent ${name}.`);
    this.#checkVersion(agent, expectedVersion);
    if (!Object.keys(changes).length) invalid('no changes');
    const values = agentFields(changes, agent);
    Object.assign(agent, values, { version: agent.version + 1, updatedAt: this.#now() });
    this.#save();
    this.#sync(agent);
    return this.#view(agent);
  }

  archive(name, { expectedVersion } = {}) {
    const agent = this.#agent(checkName(name));
    if (!agent || agent.status === 'archived') throw new RosterError('NOT_FOUND', `No active agent ${name}.`);
    this.#checkVersion(agent, expectedVersion);
    this.#archive(agent);
    this.#save();
    return this.#view(agent);
  }

  #archive(agent) {
    Object.assign(agent, { status: 'archived', archivedAt: this.#now(), version: agent.version + 1, updatedAt: this.#now() });
    for (const team of this.#state.teams) {
      if (team.members.includes(agent.name)) Object.assign(team, { members: team.members.filter(member => member !== agent.name), version: team.version + 1, updatedAt: this.#now() });
    }
    this.#sync(agent);
  }

  // A ticket is done: its per-task agents are archived (the branch stays in the sandbox clone).
  archiveTaskAgents(ticketId) {
    const done = this.#state.agents.filter(agent => agent.kind === 'task' && agent.ticketId === ticketId && agent.status !== 'archived');
    for (const agent of done) this.#archive(agent);
    if (done.length) { this.#save(); this.#log(`roster: archived task agent(s) ${done.map(agent => agent.name).join(', ')} (ticket done)`); }
    return done.map(agent => agent.name);
  }

  saveTeam(input = {}) {
    if (!object(input)) invalid('team: an object');
    const extra = Object.keys(input).filter(key => !['name', 'purpose', 'members', 'expectedVersion'].includes(key));
    if (extra.length) invalid(`unknown field(s): ${extra.join(', ')}`);
    const name = checkName(input.name, 'team name');
    let team = this.#team(name);
    if (team && team.status !== 'archived') this.#checkVersion(team, input.expectedVersion);
    const members = input.members ?? team?.members ?? [];
    if (!Array.isArray(members) || members.length > MAX_MEMBERS) invalid(`members: at most ${MAX_MEMBERS} agent names`);
    for (const member of members) {
      const agent = this.#agent(checkName(member, 'member'));
      if (!agent || agent.status === 'archived') throw new RosterError('NOT_FOUND', `No active agent ${member}; create it first.`);
      const other = this.#teamOf(member);
      if (other && other !== name) invalid(`${member} is already in team ${other}`);
    }
    const purpose = input.purpose !== undefined ? plain(input.purpose, 500, 'purpose') : team?.purpose ?? '';
    if (!team || team.status === 'archived') {
      if (this.#state.teams.filter(item => item.status !== 'archived').length >= MAX_TEAMS) throw new RosterError('LIMIT', `At most ${MAX_TEAMS} teams.`);
      if (team) this.#state.teams.splice(this.#state.teams.indexOf(team), 1);
      team = { name, purpose, members: [...new Set(members)], status: 'active', version: 1, createdAt: this.#now(), updatedAt: this.#now(), archivedAt: null };
      this.#state.teams.push(team);
    } else {
      Object.assign(team, { purpose, members: [...new Set(members)], version: team.version + 1, updatedAt: this.#now() });
    }
    this.#save();
    for (const member of team.members) this.#sync(this.#agent(member));
    return { ...team, members: [...team.members] };
  }

  // Archive a team; with archiveMembers its agents are archived too (otherwise they stay as standing agents).
  archiveTeam(name, { expectedVersion, archiveMembers = false } = {}) {
    const team = this.#team(checkName(name, 'team name'));
    if (!team || team.status === 'archived') throw new RosterError('NOT_FOUND', `No active team ${name}.`);
    this.#checkVersion(team, expectedVersion);
    const members = [...team.members];
    Object.assign(team, { status: 'archived', archivedAt: this.#now(), version: team.version + 1, updatedAt: this.#now() });
    for (const member of members) {
      const agent = this.#agent(member);
      if (archiveMembers && agent && agent.status !== 'archived') this.#archive(agent);
      else if (agent) this.#sync(agent);
    }
    this.#save();
    return { ...team, members };
  }

  // The policy for one launch. Throws if the agent may not do it. mode: work | review.
  authorize({ agent: name, mode = 'work', repo, ticketId, model }) {
    const agent = this.#agent(name);
    if (!agent || agent.status === 'archived') throw new RosterError('NOT_FOUND', `No active agent ${name}. Create it with agents_save_agent first.`);
    if (agent.status === 'paused') throw new RosterError('PAUSED', `Agent ${name} is paused.`);
    if (!['work', 'review', 'merge'].includes(mode)) invalid('mode: work, review or merge');
    if (!agent.actions.includes(mode)) throw new RosterError('FORBIDDEN', `Agent ${name} (${agent.role}) may not ${mode === 'work' ? 'work tickets' : mode === 'merge' ? 'merge' : 'review'}; its actions: ${agent.actions.join(', ')}.`);
    if (agent.repos.length && !agent.repos.includes(repo)) throw new RosterError('FORBIDDEN', `Agent ${name} may only work in ${agent.repos.join(', ')}.`);
    if (agent.kind === 'task' && agent.ticketId !== ticketId) throw new RosterError('FORBIDDEN', `Agent ${name} is a task agent for another ticket.`);
    if (model !== undefined && model !== null && model !== agent.model) {
      throw new RosterError('INVALID', `Agent ${name} runs on ${agent.model}. To use ${model}, update the agent's model (or launch another agent).`);
    }
    return { name: agent.name, role: agent.role, provider: agent.provider, model: agent.model, actions: [...agent.actions],
      canCommit: mode === 'work' && agent.actions.includes('commit'), skills: [...agent.skills], instructions: agent.instructions,
      maxTurns: agent.maxTurns, maxSeconds: agent.maxMinutes ? agent.maxMinutes * 60 : null, team: this.#teamOf(agent.name), version: agent.version };
  }

  // Re-mirror agents whose Board copy is behind (after a failed or refused sync). Called from the runner's poll.
  async resync({ minIntervalMs = 10 * 60_000 } = {}) {
    if (!this.#mirror) return 0;
    let count = 0;
    for (const agent of this.#state.agents) {
      const board = agent.board ?? {};
      if (board.syncedKey === mirrorKey(this.#view(agent)) && !board.error) continue;
      if (board.triedAt && this.#now() - board.triedAt < minIntervalMs) continue;
      await this.#sync(agent, { wait: true }); count++;
    }
    return count;
  }

  #sync(agent, { wait = false } = {}) {
    if (!this.#mirror || !agent) return Promise.resolve();
    // One Board call chain per agent, so a create and a quick update never race; each step mirrors the latest state.
    const previous = this.#chains.get(agent.name) ?? Promise.resolve();
    const done = previous.then(() => {
      const snapshot = this.#view(agent);
      if (agent.board?.syncedKey === mirrorKey(snapshot) && !agent.board?.error) return null;
      return Promise.resolve().then(() => this.#mirror.sync(snapshot)).then(board => ({ board, key: mirrorKey(snapshot) }));
    }).then(synced => {
      if (!synced) return;
      const { board } = synced;
      agent.board = { ...board, syncedKey: synced.key, triedAt: this.#now(), error: null };
    }, error => {
      const why = [error?.code, error?.message].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join(': ');
      agent.board = { ...(agent.board ?? {}), triedAt: this.#now(), error: (why || 'ERROR').slice(0, 300) };
      this.#log(`roster: Board mirror of ${agent.name} failed: ${agent.board.error}`);
    }).then(() => this.#save());
    this.#chains.set(agent.name, done.catch(() => {}));
    return wait ? done : Promise.resolve();
  }
}
