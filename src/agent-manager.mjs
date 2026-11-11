// Manager mode for C-chan (#76, docs/MANAGER.md). C-chan manages Blackout's Board projects like a human manager: she
// turns his ideas into tickets, dispatches them to her roster agents (#73), unblocks, escalates stuck tickets to a
// bigger model, and accepts or returns work on an independent reviewer's report. She never does ticket work herself.
// This module is the runner's model-free part of that job. It lives in the runner, next to the runs it checks:
//   - standing approvals: the projects/directions Blackout approved in chat. Inside one, C-chan needs no further yes for
//     Board actions (hard limits #74 excepted). Recorded only from an owner chat turn (the tool is refused in every wake).
//   - the budget: the subscription's weekly usage, read from the provider's rate-limit events. Above 80% (configurable)
//     no Opus or Fable launch is accepted (BUDGET), so escalation stops at Sonnet until the week resets.
//   - the decision log: C-chan's explicit decisions with their reasons, for the Ops app (#75). An accept or a return
//     must name an independent reviewer's report (a review run by another agent, on the current work, with the matching
//     verdict), or it is refused.
//   - attention: a sweep over the Board tickets of approved projects and the runs, so C-chan acts on her own when a ticket
//     is ready and idle, waits for a review, has a verdict, keeps failing, waits for a quota reset or stays blocked.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const LADDER = Object.freeze(['haiku', 'sonnet', 'opus', 'fable']);
export const PREMIUM = Object.freeze(new Set(['opus', 'fable']));
export const DEFAULT_PREMIUM_MAX_WEEKLY = 0.8;
export const DECISION_KINDS = Object.freeze(['plan', 'dispatch', 'unblock', 'reassign', 'split', 'escalate_model', 'accept',
  'return', 'escalate_owner', 'answer', 'pause']);
const ACTIVE = new Set(['queued', 'preparing', 'running', 'stopping']);
const LIMITED = new Set(['USAGE_LIMIT', 'RATE_LIMITED']);
// Failures that say something about the work (not the provider, not a stop C-chan or a restart caused).
const WORK_FAILURE = run => (run.state === 'failed' && !LIMITED.has(run.errorCode)) || run.state === 'timeout';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const MINUTE = 60_000, DAY = 86_400_000;
const MAX_DECISIONS = 500;

export class ManagerError extends Error {
  constructor(code, message) { super(message); this.name = 'ManagerError'; this.code = code; }
}
const invalid = message => { throw new ManagerError('INVALID', message); };
const clean = (value, max) => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim().slice(0, max);

// The next model up for a stuck ticket: haiku -> sonnet -> opus -> fable. null at the top.
export function nextModel(alias) {
  const index = LADDER.indexOf(alias);
  return index >= 0 && index < LADDER.length - 1 ? LADDER[index + 1] : null;
}

// Claude's rate-limit event carries unifiedWindows { five_hour, seven_day, ... } with utilization as a fraction.
function windowOf(value) {
  if (!value || typeof value !== 'object') return null;
  let utilization = Number(value.utilization);
  if (!Number.isFinite(utilization) || utilization < 0) return null;
  if (utilization > 1.5) utilization /= 100; // defensive: a percentage instead of a fraction
  const resets = Number(value.resetsAt);
  const resetsAt = Number.isFinite(resets) && resets > 0 ? (resets < 1e12 ? resets * 1000 : resets) : null;
  return { utilization: Math.min(utilization, 1), resetsAt, status: typeof value.status === 'string' ? value.status : null };
}

const latestWork = (runs, ticketId) => runs.filter(run => run.ticketId === ticketId && run.mode !== 'review' && run.state === 'succeeded' && run.head)
  .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).at(-1) ?? null;

// Is this review run an independent, current report on the ticket's work? -> { review, work } or throws.
export function checkReview(runs, { ticketId, reviewRunId, verdict = null }) {
  const review = runs.find(run => run.id === reviewRunId);
  if (!review || review.mode !== 'review' || review.ticketId !== ticketId) {
    throw new ManagerError('NO_REVIEW', 'reviewRunId must be a review run (agents_launch mode review) on this ticket.');
  }
  if (review.state !== 'succeeded' || review.result?.kind !== 'review') {
    throw new ManagerError('NO_REVIEW', `Review run ${review.id} ended ${review.state} without a verdict; launch another review.`);
  }
  const authors = new Set(runs.filter(run => run.mode !== 'review' && run.ticketId === ticketId && run.branch === review.reviewBranch).map(run => run.agent));
  if (authors.has(review.agent) || review.role !== 'reviewer') {
    throw new ManagerError('NOT_INDEPENDENT', `${review.agent} is not an independent reviewer of ${review.reviewBranch}: the reviewer must be a reviewer agent and never the author.`);
  }
  const work = latestWork(runs, ticketId);
  // A review that recorded no head cannot prove it saw the current work, so it counts as stale.
  if (work && work.head !== review.reviewHead) {
    throw new ManagerError('STALE_REVIEW', `Review ${review.id} checked ${String(review.reviewHead).slice(0, 10)}, but the latest work is ${String(work.head).slice(0, 10)} (${work.agent}). Review the current work first.`);
  }
  if (verdict && review.result.verdict !== verdict) {
    throw new ManagerError('VERDICT_MISMATCH', `The reviewer's verdict is ${review.result.verdict}; ${verdict === 'approve' ? 'accept' : 'return'} needs ${verdict}.`);
  }
  return { review, work };
}

export class Manager {
  #file; #projects; #now; #log; #threshold; #state;

  // projects: the Board projects the runner manages (Blackout's; config.projects). Approvals outside them are refused.
  constructor({ file = null, projects = [], premiumMaxWeekly = DEFAULT_PREMIUM_MAX_WEEKLY, now = Date.now, log = () => {} } = {}) {
    if (!(typeof premiumMaxWeekly === 'number' && premiumMaxWeekly > 0 && premiumMaxWeekly <= 1)) invalid('premiumMaxWeekly: a fraction, e.g. 0.8');
    this.#file = file; this.#projects = new Set(projects); this.#now = now; this.#log = log; this.#threshold = premiumMaxWeekly;
    this.#state = this.#load();
  }

  #load() {
    const empty = { approvals: [], decisions: [], usage: null, nudged: {}, seq: 0 };
    if (!this.#file || !existsSync(this.#file)) return empty;
    const value = JSON.parse(readFileSync(this.#file, 'utf8'));
    return { approvals: Array.isArray(value.approvals) ? value.approvals : [], decisions: Array.isArray(value.decisions) ? value.decisions : [],
      usage: value.usage ?? null, nudged: value.nudged && typeof value.nudged === 'object' ? value.nudged : {}, seq: Number.isSafeInteger(value.seq) ? value.seq : 0 };
  }

  #save() {
    if (!this.#file) return;
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    if (this.#state.decisions.length > MAX_DECISIONS) this.#state.decisions.splice(0, this.#state.decisions.length - MAX_DECISIONS);
    writeFileSync(this.#file + '.tmp', JSON.stringify(this.#state), { mode: 0o600 });
    renameSync(this.#file + '.tmp', this.#file);
  }

  // ---------- Standing approvals ----------

  approvals({ includeRevoked = false } = {}) { return this.#state.approvals.filter(item => includeRevoked || item.status === 'active').map(item => ({ ...item })); }
  approved(projectId) { const found = this.#state.approvals.find(item => item.projectId === projectId && item.status === 'active'); return found ? { ...found } : null; }

  // From an owner chat only (the companion refuses the tool in every wake). One active approval per project; approving
  // again replaces the direction (a scope change Blackout agreed to). requestId makes a retry return the same record.
  approve({ projectId, direction, requestId = null } = {}) {
    if (typeof projectId !== 'string' || !ID.test(projectId)) invalid('projectId: the Board project id');
    if (!this.#projects.has(projectId)) throw new ManagerError('FORBIDDEN', 'Manager mode covers only the Board projects of the runner (Blackout\'s projects).');
    const text = clean(direction, 2000);
    if (!text) invalid('direction: what Blackout approved, in one or two sentences');
    if (requestId !== null && (typeof requestId !== 'string' || !ID.test(requestId))) invalid('requestId');
    const same = requestId && this.#state.approvals.find(item => item.requestId === requestId);
    if (same) return { ...same };
    const current = this.#state.approvals.find(item => item.projectId === projectId && item.status === 'active');
    const at = this.#now();
    if (current) Object.assign(current, { status: 'replaced', endedAt: at });
    const approval = { projectId, direction: text, status: 'active', approvedAt: at, version: (current?.version ?? 0) + 1, requestId,
      source: 'owner_chat' };
    this.#state.approvals.push(approval);
    this.#record({ kind: 'approval', projectId, reason: `Blackout approved: ${text}`.slice(0, 1000) });
    this.#save();
    return { ...approval };
  }

  revoke({ projectId } = {}) {
    const current = this.#state.approvals.find(item => item.projectId === projectId && item.status === 'active');
    if (!current) throw new ManagerError('NOT_FOUND', 'No active approval for that project.');
    Object.assign(current, { status: 'revoked', endedAt: this.#now() });
    this.#record({ kind: 'approval_revoked', projectId, reason: 'Blackout withdrew the standing approval.' });
    this.#save();
    return { ...current };
  }

  // ---------- Budget ----------

  // A rate event from a run ({ status, resetsAt, windows }). Keeps the latest weekly and 5-hour readings.
  noteRate(event) {
    const weekly = windowOf(event?.windows?.seven_day), session = windowOf(event?.windows?.five_hour);
    if (!weekly && !session) return;
    const at = this.#now();
    this.#state.usage = { ...(this.#state.usage ?? {}), ...(weekly ? { weekly: { ...weekly, at } } : {}), ...(session ? { session: { ...session, at } } : {}) };
    this.#save();
  }

  usage() {
    const now = this.#now();
    const fresh = reading => reading && (reading.resetsAt ? reading.resetsAt > now : now - reading.at < 7 * DAY) ? { ...reading } : null;
    const weekly = fresh(this.#state.usage?.weekly), session = fresh(this.#state.usage?.session);
    const throttled = Boolean(weekly && weekly.utilization >= this.#threshold);
    return { weekly, session, premiumMaxWeekly: this.#threshold, premiumAllowed: !throttled,
      note: throttled ? `Weekly usage ${Math.round(weekly.utilization * 100)}% is at or above ${Math.round(this.#threshold * 100)}%: no Opus or Fable until it resets${weekly.resetsAt ? ` (${new Date(weekly.resetsAt).toISOString()})` : ''}.` : null };
  }

  // Called by the runner before a launch is queued.
  checkLaunch({ model }) {
    if (!PREMIUM.has(model)) return;
    const usage = this.usage();
    if (!usage.premiumAllowed) {
      throw new ManagerError('BUDGET', `${usage.note} Use sonnet, split the ticket, or wait for the reset.`);
    }
  }

  // ---------- Decisions ----------

  #record(fields) {
    const decision = { id: `d${++this.#state.seq}`, at: this.#now(), ...fields };
    this.#state.decisions.push(decision);
    return decision;
  }

  decisions({ ticketId = null, limit = 100 } = {}) {
    return this.#state.decisions.filter(item => !ticketId || item.ticketId === ticketId).slice(-limit).map(item => ({ ...item }));
  }

  // C-chan's decision, with her reason. runs: the runner's run list. accept/return must cite an independent review.
  decide(input = {}, runs = []) {
    const { kind, ticketId = null, projectId = null, ticketNumber = null, requestId = null, reviewRunId = null, model = null, agent = null } = input;
    if (!DECISION_KINDS.includes(kind)) invalid(`kind: one of ${DECISION_KINDS.join(', ')}`);
    if (requestId !== null && (typeof requestId !== 'string' || !ID.test(requestId))) invalid('requestId');
    const same = requestId && this.#state.decisions.find(item => item.requestId === requestId);
    if (same) return { ...same };
    if (ticketId !== null && (typeof ticketId !== 'string' || !ID.test(ticketId))) invalid('ticketId');
    if (projectId !== null && (typeof projectId !== 'string' || !ID.test(projectId))) invalid('projectId');
    if (kind !== 'plan' && !ticketId) invalid('ticketId: the ticket this decision is about');
    if (kind === 'plan' && !ticketId && !projectId) invalid('projectId or ticketId');
    if (ticketNumber !== null && !Number.isSafeInteger(ticketNumber)) invalid('ticketNumber');
    const reason = clean(input.reason, 1000);
    if (!reason) invalid('reason: why, in one sentence');
    if (model !== null && !LADDER.includes(model)) invalid(`model: one of ${LADDER.join(', ')}`);
    if (agent !== null && (typeof agent !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(agent))) invalid('agent');
    const fields = { kind, ticketId, projectId, ticketNumber, reason, requestId, model, agent };
    if (kind === 'accept' || kind === 'return') {
      if (typeof reviewRunId !== 'string') throw new ManagerError('NO_REVIEW', `${kind} needs reviewRunId: the independent reviewer's run whose report you follow.`);
      const { review, work } = checkReview(runs, { ticketId, reviewRunId, verdict: kind === 'accept' ? 'approve' : 'changes_requested' });
      Object.assign(fields, { reviewRunId, verdict: review.result.verdict, reviewer: review.agent, reviewedHead: review.reviewHead ?? null,
        author: work?.agent ?? null, ticketNumber: ticketNumber ?? review.ticketNumber ?? null });
    } else if (kind === 'escalate_model') {
      if (!model) invalid('model: the model you escalate to');
      this.checkLaunch({ model });
    }
    const decision = this.#record(fields);
    this.#save();
    return { ...decision };
  }

  // The latest accept decision on a ticket (for the done audit), or null.
  accepted(ticketId) { return this.#state.decisions.filter(item => item.ticketId === ticketId && item.kind === 'accept').at(-1) ?? null; }

  // ---------- Attention ----------

  // Findings over the approved projects; see attention() below.
  attention({ tickets, runs, now = this.#now(), ...options }) {
    const approved = new Set(this.approvals().map(item => item.projectId));
    return attention({ tickets: tickets.filter(ticket => approved.has(ticket.projectId)), runs, decisions: this.#state.decisions,
      usage: this.usage(), now, ...options });
  }

  // The findings worth a wake now: new ones, and ones still open after renudgeMinutes. Remembers what it sent.
  due(findings, { renudgeMinutes = 120 } = {}) {
    const now = this.#now(), open = new Set(findings.map(item => item.key)), out = [];
    for (const key of Object.keys(this.#state.nudged)) if (!open.has(key)) delete this.#state.nudged[key];
    for (const finding of findings) {
      const last = this.#state.nudged[finding.key];
      if (last && now - last < renudgeMinutes * MINUTE) continue;
      this.#state.nudged[finding.key] = now; out.push(finding);
    }
    this.#save();
    return out;
  }

  view({ tickets = null, runs = [] } = {}) {
    return { approvals: this.approvals(), usage: this.usage(), decisions: this.decisions({ limit: 50 }),
      attention: tickets ? this.attention({ tickets, runs }) : null };
  }
}

// The sweep. tickets: [{ id, number, status, ready, waiting, projectId, since }] (since: when the watch first saw this
// status). Returns [{ key, kind, ticketId, ticketNumber, projectId, suggestion, model?, agent?, reviewRunId?, verdict? }].
// Suggestions are fixed text with ids, numbers, agent names and models only: Board text never reaches a wake.
export function attention({ tickets, runs, decisions = [], usage = { premiumAllowed: true }, now = Date.now(), stuckMinutes = 30 }) {
  const out = [];
  const decided = new Set(decisions.filter(item => item.reviewRunId).map(item => item.reviewRunId));
  for (const ticket of tickets) {
    const mine = runs.filter(run => run.ticketId === ticket.id).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    if (mine.some(run => ACTIVE.has(run.state))) continue;
    const n = ticket.number ? `#${ticket.number}` : `ticket ${ticket.id}`;
    const base = { ticketId: ticket.id, ticketNumber: ticket.number ?? null, projectId: ticket.projectId ?? null };
    const work = mine.filter(run => run.mode !== 'review'), reviews = mine.filter(run => run.mode === 'review');
    const lastWork = work.at(-1) ?? null;
    if (ticket.status === 'review') {
      const delivered = latestWork(runs, ticket.id);
      if (!delivered) continue; // not our agents' work: nothing to review here
      const onHead = reviews.filter(run => run.reviewHead === delivered.head && run.reviewBranch === delivered.branch);
      const verdict = onHead.filter(run => run.state === 'succeeded' && run.result?.kind === 'review').at(-1);
      if (verdict) {
        if (decided.has(verdict.id)) continue;
        out.push({ ...base, key: `review_ready:${ticket.id}:${verdict.id}`, kind: 'review_ready', reviewRunId: verdict.id, verdict: verdict.result.verdict,
          agent: delivered.agent, suggestion: `${n}: reviewer ${verdict.agent} (run ${verdict.id}) says ${verdict.result.verdict}. `
            + (verdict.result.verdict === 'approve' ? 'Log the accept with agents_decide (kind accept, reviewRunId), then accept it on the Board.'
              : `Log the return with agents_decide (kind return, reviewRunId), return it on the Board with the findings, and relaunch ${delivered.agent}.`) });
        continue;
      }
      const failed = onHead.filter(run => !ACTIVE.has(run.state)).length;
      out.push({ ...base, key: `needs_review:${ticket.id}:${delivered.head}:${failed}`, kind: 'needs_review', agent: delivered.agent,
        suggestion: `${n} is in review with ${delivered.agent}'s work @ ${String(delivered.head).slice(0, 10)} and no verdict yet`
          + `${failed ? ` (${failed} review run(s) ended without one)` : ''}. Launch a reviewer agent that is not ${delivered.agent} (agents_launch mode review).` });
      continue;
    }
    if (ticket.status === 'todo' && ticket.ready && !ticket.waiting) {
      if (lastWork && LIMITED.has(lastWork.errorCode)) {
        const retry = lastWork.retryAt ? Date.parse(lastWork.retryAt) : (lastWork.endedAt ?? 0) + 15 * MINUTE;
        if (retry > now) continue; // waiting for the quota; the reset itself raises the next finding
        out.push({ ...base, key: `quota_reset:${ticket.id}:${lastWork.id}`, kind: 'quota_reset', agent: lastWork.agent, model: lastWork.modelAlias,
          suggestion: `${n}: ${lastWork.agent}'s run stopped on the plan's limit (${lastWork.errorCode}); that has reset, relaunch it.` });
        continue;
      }
      let failures = 0;
      for (const run of [...work].reverse()) { if (WORK_FAILURE(run)) failures++; else break; }
      if (failures >= 2) {
        const up = nextModel(lastWork.modelAlias);
        const capped = up && PREMIUM.has(up) && !usage.premiumAllowed;
        out.push({ ...base, key: `failing:${ticket.id}:${lastWork.id}`, kind: 'failing', agent: lastWork.agent, model: capped ? null : up,
          suggestion: `${n} failed ${failures} runs in a row (last: ${lastWork.agent} on ${lastWork.modelAlias}, ${lastWork.errorCode ?? lastWork.state}). `
            + (!up ? 'It is already on the biggest model: split it into smaller tickets or escalate to the owner if it needs a decision.'
              : capped ? `Escalating to ${up} is not allowed now (weekly usage is above the budget): split it, or retry on ${lastWork.modelAlias} with sharper instructions.`
                : `Escalate it to ${up} (update the agent's model, log agents_decide kind escalate_model) or split it.`) });
        continue;
      }
      const returned = lastWork && lastWork.state === 'succeeded';
      out.push({ ...base, key: `ready_idle:${ticket.id}:${lastWork?.id ?? 'new'}`, kind: 'ready_idle', agent: lastWork?.agent ?? null,
        suggestion: lastWork ? `${n} is ready again with no agent on it (last: ${lastWork.agent}, ${lastWork.state}${returned ? ', returned after review' : ''}). Relaunch or reassign it.`
          : `${n} is ready and nobody is on it. Dispatch it to a coder (agents_launch).` });
      continue;
    }
    if ((ticket.status === 'blocked' || ticket.waiting) && ticket.since && now - ticket.since >= stuckMinutes * MINUTE) {
      const minutes = Math.round((now - ticket.since) / MINUTE);
      out.push({ ...base, key: `stuck:${ticket.id}:${ticket.since}`, kind: 'stuck', agent: lastWork?.agent ?? null,
        suggestion: `${n} has been ${ticket.status === 'blocked' ? 'blocked' : 'waiting on a human'} for ${minutes} min. Read why, then unblock, reassign, split`
          + `${lastWork && nextModel(lastWork.modelAlias) ? `, escalate the model (now ${lastWork.modelAlias})` : ''}, or escalate to the owner only if it is a hard limit or a scope change.` });
    }
  }
  return out;
}

// One manager pass of the runner's Board poll. boardEvents: what the watch just reported. Adds manager.* events to the
// runner's log, so C-chan's event stream wakes her: attention findings that are due, and a done ticket of an approved
// project with no accept decision on record (accepted by a person, or by C-chan without a reviewer report).
export function managerSweep({ manager, runner, tickets, boardEvents = [] }) {
  const added = [];
  for (const event of boardEvents) {
    if (event.type !== 'board.done' || !event.ticketId || !manager.approved(event.projectId) || manager.accepted(event.ticketId)) continue;
    added.push(runner.note({ type: 'manager.unbacked', ticketId: event.ticketId, ticketNumber: event.ticketNumber, projectId: event.projectId,
      kind: 'unbacked_accept', suggestion: `#${event.ticketNumber ?? '?'} was marked done with no accept decision backed by a reviewer report on record.` }));
  }
  if (Array.isArray(tickets)) {
    for (const finding of manager.due(manager.attention({ tickets, runs: runner.list() }))) {
      added.push(runner.note({ type: 'manager.attention', ...finding }));
    }
  }
  return added;
}
