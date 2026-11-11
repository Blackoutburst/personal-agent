// Read-only data for the Studio "Ops" app (#75, docs/OPS.md): what C-chan's agents are doing. The runner service
// answers GET /ops with buildOps(): live agents, the ticket pipeline, C-chan's decision log and the usage of the runs.
// Everything here is derived from the runner's own run list and event log plus a read-only Board view; nothing is
// written, and Board text (titles, messages) is passed on as plain text for the app to show, never followed.
const STATUSES = ['todo', 'in_progress', 'review', 'blocked', 'done'];
const ACTIVE = new Set(['queued', 'preparing', 'running', 'stopping']);
const RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };
const DAY = 86_400_000;
const clip = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, max) : '';

export function normalizeStatus(status) {
  const value = String(status ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if (value === 'inprogress' || value === 'claimed' || value === 'working') return 'in_progress';
  return STATUSES.includes(value) ? value : 'todo';
}

export function agentRow(run, now) {
  const live = ACTIVE.has(run.state);
  const startedAt = run.startedAt ?? null;
  // The roster (#73) records each run's role; older runs fall back to the name's prefix (coder-1 -> coder).
  return { runId: run.id, name: run.agent, role: run.role ?? String(run.agent).split('-')[0], model: run.modelAlias, provider: run.provider,
    ticketNumber: run.ticketNumber ?? null, ticketTitle: clip(run.ticketTitle ?? '', 200), state: run.state, live,
    turns: run.turns ?? 0, maxTurns: run.maxTurns ?? null, branch: run.branch ?? null, startedAt, endedAt: run.endedAt ?? null,
    heartbeatAt: run.heartbeatAt ?? null, heartbeatAgeSeconds: live && run.heartbeatAt ? Math.max(0, Math.round((now - run.heartbeatAt) / 1000)) : null,
    cleanup: run.cleanup ?? null, error: clip(run.error ?? '', 300) || null };
}

// The decision log: what C-chan did, read back from launches and results. A relaunch on a stronger model is an
// escalation; a relaunch after an agent's block, failure or delivery is a return. Board changes are shown as observed.
export function decisionLog(runs, events, limit = 60) {
  const byId = new Map(runs.map(run => [run.id, run]));
  const out = [];
  const lastModel = new Map();
  for (const event of events) {
    const run = byId.get(event.runId);
    const n = event.ticketNumber ? `#${event.ticketNumber}` : 'a ticket';
    const base = { seq: event.seq, at: event.at, ticketNumber: event.ticketNumber ?? null, agent: event.agent ?? null };
    if (event.type === 'run.queued' && run) {
      const before = lastModel.get(event.ticketId);
      lastModel.set(event.ticketId, run.modelAlias);
      let kind = 'launch', text = `launched ${run.agent} on ${n} with ${run.modelAlias}`;
      if (before && (RANK[run.modelAlias] ?? 0) > (RANK[before] ?? 0)) { kind = 'escalate'; text = `escalated ${n} to ${run.modelAlias} (${run.agent}), after ${before}`; }
      else if (before) { kind = 'return'; text = `returned ${n} to ${run.agent} (${run.modelAlias}) for another run`; }
      out.push({ ...base, kind, text });
    } else if (event.type === 'run.ended') {
      const what = { succeeded: 'delivered', blocked: 'is blocked: needs the owner', failed: 'failed', timeout: 'hit its deadline', stopped: 'was stopped', cancelled: 'was cancelled', interrupted: 'was interrupted' }[event.state] ?? event.state;
      out.push({ ...base, kind: 'result', text: `${event.agent} on ${n} ${what}${event.cleanupConfirmed === false ? ' (cleanup NOT confirmed)' : ''}` });
    } else if (event.type === 'board.review') out.push({ ...base, kind: 'review', text: `${n} entered review` });
    else if (event.type === 'board.done') out.push({ ...base, kind: 'accept', text: `accepted ${n}: it is done` });
    else if (event.type === 'board.blocked') out.push({ ...base, kind: 'blocked', text: `${n} is blocked` });
    else if (event.type === 'board.ready') out.push({ ...base, kind: 'ready', text: `${n} became ready` });
    else if (event.type === 'board.needs_you') out.push({ ...base, kind: 'needs_you', text: `${n} is waiting on the owner` });
  }
  return out.slice(-limit).reverse();
}

// Usage of the runs. The Max plan reports no token counts to the runner, so this is what it can measure: runs, turns
// and run time per model over the last 24 hours and 7 days, plus how often the plan's limit stopped a run.
export function usageSummary(runs, now) {
  const windows = { last24h: DAY, last7d: 7 * DAY };
  const out = { windows: {}, limitHits: runs.filter(run => run.errorCode === 'USAGE_LIMIT' && now - (run.endedAt ?? 0) < 7 * DAY).length,
    note: 'Max plan: turns and run time per model; token counts are not reported to the runner.' };
  for (const [name, span] of Object.entries(windows)) {
    const models = {};
    let total = { runs: 0, turns: 0, seconds: 0 };
    for (const run of runs) {
      if (!run.startedAt || now - (run.endedAt ?? now) > span) continue;
      const seconds = Math.max(0, Math.round(((run.endedAt ?? now) - run.startedAt) / 1000));
      const row = models[run.modelAlias] ??= { runs: 0, turns: 0, seconds: 0 };
      row.runs += 1; row.turns += run.turns ?? 0; row.seconds += seconds;
      total = { runs: total.runs + 1, turns: total.turns + (run.turns ?? 0), seconds: total.seconds + seconds };
    }
    out.windows[name] = { total, models };
  }
  return out;
}

export function pipelineOf(tickets) {
  const out = Object.fromEntries(STATUSES.map(status => [status, []]));
  for (const ticket of tickets) out[normalizeStatus(ticket.status)].push({ id: ticket.id, number: ticket.number ?? null,
    title: clip(ticket.title, 200), projectId: ticket.projectId ?? null, ready: ticket.ready === true, waitingOnHuman: ticket.waitingOnHuman === true });
  for (const list of Object.values(out)) list.sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
  return out;
}

export function buildOps({ runs, events, tickets = null, now = Date.now() }) {
  const sorted = [...runs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return { at: now, agents: sorted.slice(0, 40).map(run => agentRow(run, now)),
    pipeline: tickets === null ? null : pipelineOf(tickets), decisions: decisionLog(runs, events), usage: usageSummary(runs, now) };
}

// Read-only Board view for the pipeline and a ticket's message history, cached so the app's refreshes stay cheap.
export class OpsBoard {
  #client; #projects; #ttl; #now; #cache = null;
  constructor({ client, projects, ttlMs = 15_000, now = Date.now }) { this.#client = client; this.#projects = projects; this.#ttl = ttlMs; this.#now = now; }

  async tickets() {
    if (this.#cache && this.#now() - this.#cache.at < this.#ttl) return this.#cache.items;
    const items = [];
    for (const projectId of this.#projects) {
      let cursor = null;
      for (let page = 0; page < 10; page++) {
        const listed = await this.#client.call('list_tickets', { project_id: projectId, limit: 100, ...(cursor ? { cursor } : {}) });
        for (const ticket of listed?.items ?? []) items.push({ id: ticket.id, number: ticket.number, title: ticket.title, status: ticket.status,
          projectId, ready: ticket.ready === true, waitingOnHuman: ticket.waiting_on_human === true });
        cursor = listed?.next_cursor ?? null;
        if (!cursor) break;
      }
    }
    this.#cache = { at: this.#now(), items };
    return items;
  }

  // The Board thread of one ticket, newest last, with plain-text bodies. Only tickets of the allowed projects.
  async messages(ticketId, limit = 50) {
    const known = (await this.tickets()).find(ticket => ticket.id === ticketId);
    if (!known) return null;
    const ticket = (await this.#client.call('get_ticket', { ticket_id: ticketId, view: 'full' }))?.ticket;
    const threadId = ticket?.thread_id;
    if (typeof threadId !== 'string') return { ticketNumber: known.number, title: clip(known.title, 200), messages: [] };
    // get_thread answers { thread, messages }: the messages are next to the thread, not inside it.
    const read = (await this.#client.call('get_thread', { thread_id: threadId, limit, view: 'full' })) ?? {};
    const raw = read.messages ?? read.thread?.messages ?? [];
    const messages = (Array.isArray(raw) ? raw : []).slice(-limit).map(message => ({ id: String(message.id ?? ''),
      // Board times are Unix seconds; the app shows milliseconds like every other Ops time.
      at: typeof message.created_at === 'number' ? Math.round(message.created_at * 1000) : null,
      author: clip(message.author?.agent_name ?? message.author?.display_name ?? (typeof message.author === 'string' ? message.author : ''), 80),
      text: clip(typeof message.body === 'string' ? message.body : message.text ?? '', 1500) }));
    return { ticketNumber: known.number, title: clip(known.title, 200), messages };
  }
}
