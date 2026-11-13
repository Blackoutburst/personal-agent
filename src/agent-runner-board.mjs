import { createHash } from 'node:crypto';
import { escalationQuestion } from './escalation.mjs';
import { COMPANION_UNIT as COMPANION } from './server-deploy.mjs';
// The runner's Board side (#72, docs/AGENT-RUNNER.md). The runner has its own Board worker identity, paired once by
// the owner, with the credential kept inside its connect.py bridge (never read here). Sub-agents in the sandbox have
// no Board access, so this reporter does the Board work for them:
//   begin     read the ticket, check its project is allowed, claim it
//   started   reserve and start a Board Runtime execution (capacity, heartbeats, cleanup proof), post "started"
//   heartbeat execution heartbeat (the Board may ask to stop), lease renewal with a progress line
//   finish    finish the execution with cleanup_confirmed, then: review with outcome/evidence, a Needs-you question,
//             or release the ticket with the failure explained
// The Runtime execution part is best effort: if the Board refuses it (no Runtime grant), the run continues with lease
// renewals and thread posts, and the run record says so.
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const RENEW_EVERY = 5;

const pick = (value, ...paths) => {
  for (const path of paths) {
    let item = value;
    for (const key of path.split('.')) item = item?.[key];
    if (item !== undefined && item !== null) return item;
  }
  return null;
};
const minutes = run => run.startedAt && run.endedAt ? Math.max(1, Math.round((run.endedAt - run.startedAt) / 60000)) : null;
const FINISH_REASON = { succeeded: 'completed', blocked: 'completed', stopped: 'stop_requested', cancelled: 'cancelled',
  timeout: 'timeout', interrupted: 'runner_error' };

// The bare clone belongs to cchan-agents, so a reviewer's fetch needs safe.directory on the upload-pack side too.
export function reviewFetch(repo, branch) {
  const dir = `/var/lib/cchan-agents/repos/${repo}.git`;
  return `Review: git fetch --upload-pack="git -c safe.directory=${dir} upload-pack" ${dir} ${branch}:review/${branch.split('/').slice(1).join('-')}`;
}

export function runSummary(run) {
  const parts = [`run ${run.id}`, `${run.provider}/${run.modelAlias}`, `${run.turns} turn(s)`];
  const took = minutes(run); if (took) parts.push(`${took} min`);
  if (run.branch) parts.push(`branch ${run.branch}${run.head ? ` @ ${run.head.slice(0, 10)}` : ''}${run.commits !== null && run.commits !== undefined ? ` (${run.commits} commit(s))` : ''}`);
  const { unitGone, worktreeRemoved } = run.cleanup ?? {};
  parts.push(unitGone && worktreeRemoved ? 'cleanup confirmed (unit gone, worktree removed)'
    : `cleanup NOT confirmed (unit gone: ${unitGone}, worktree removed: ${worktreeRemoved})`);
  return parts.join(', ');
}

export class BoardReporter {
  #client; #projects; #ownerId; #log; #beats = new Map();

  // client: a BoardClient (call(tool, args)). projects: Board project ids C-chan's agents may work in.
  // ownerId: who Needs-you questions go to.
  constructor({ client, projects, ownerId, log = () => {} }) {
    this.#client = client; this.#projects = new Set(projects); this.#ownerId = ownerId; this.#log = log;
  }

  async #post(run, body, key) {
    if (!run.board?.threadId) return;
    try { await this.#client.call('post_message', { thread_id: run.board.threadId, body, idempotency_key: `${run.id}-${key}` }); }
    catch (error) { this.#log(`post for ${run.id} failed: ${error.code ?? error.message}`); }
  }

  #version(run, ticket) { if (Number.isSafeInteger(ticket?.version)) run.board.version = ticket.version; }

  // A launch refused for a hard limit (#74): raise a Needs-you for the owner on the ticket, once per request.
  async hardLimit({ ticketId, agent, limit, instructions, requestId }) {
    const key = 'hardlimit-' + createHash('sha256').update(`${ticketId}|${agent}|${requestId ?? instructions}`).digest('hex').slice(0, 40);
    const question = escalationQuestion(limit, `${agent} was asked to: ${instructions}`);
    // The Board only takes a Needs-you from the session holding the ticket's claim, so claim it first (the request then
    // releases the claim and blocks the ticket on the owner). A retry finds the ticket already blocked on this request:
    // the claim is refused and the request with the same key returns the existing one.
    const read = await this.#client.call('get_ticket', { ticket_id: ticketId, view: 'full' });
    const ticket = read?.ticket ?? read;
    if (!ticket?.id) throw Object.assign(new Error('Ticket not found on the Board.'), { code: 'NOT_FOUND' });
    if (!this.#projects.has(ticket.project_id)) throw Object.assign(new Error('This ticket is outside the projects C-chan\'s agents may work in.'), { code: 'FORBIDDEN' });
    let version = ticket.version;
    try { version = (await this.#client.call('claim_ticket', { ticket_id: ticket.id, expected_version: ticket.version }))?.version ?? version; }
    catch { /* already blocked on this request (a retry), or claimed by someone else: the request below says which */ }
    await this.#client.call('request_human_input', { ticket_id: ticket.id, owner_id: this.#ownerId, kind: 'question',
      question, summary: question.slice(0, 240), idempotency_key: key, ...(Number.isSafeInteger(version) ? { expected_version: version } : {}) });
  }

  // An owner approval for a hard-limit launch: a Needs-you raised for the same limit on the ticket (the runner's own
  // escalationQuestion text), answered "yes", and resolved by the owner in person: the Board's activity must show a
  // human resolver with the owner's id (answers C-chan gives as companion do not count). used: request ids already spent.
  // Returns { requestId } or null.
  async ownerApproval({ ticketId, limit, used = [] }) {
    const read = await this.#client.call('get_ticket', { ticket_id: ticketId, view: 'full' });
    const ticket = read?.ticket ?? read;
    if (!ticket?.id || !this.#projects.has(ticket.project_id) || !limit?.label) return null;
    const prefix = `Needs your decision (${limit.label} is a hard limit;`;
    const candidates = (Array.isArray(ticket.human_requests) ? ticket.human_requests : []).filter(request => request?.status === 'resolved'
      && typeof request.id === 'string' && !used.includes(request.id) && typeof request.question === 'string'
      && request.question.startsWith(prefix) && /^\s*yes\b/i.test(String(request.answer ?? '')));
    if (!candidates.length) return null;
    const listed = await this.#client.call('list_activity', { ticket_id: ticket.id, limit: 200, view: 'full' });
    const events = Array.isArray(listed) ? listed : Array.isArray(listed?.result) ? listed.result : Array.isArray(listed?.items) ? listed.items : [];
    const byOwner = new Set(events.filter(event => event?.event === 'human_input_resolved' && event.actor?.kind === 'human'
      && event.actor?.owner_id === this.#ownerId && event.ticket_id === ticket.id).map(event => event.detail?.request_id));
    const found = candidates.find(request => byOwner.has(request.id));
    return found ? { requestId: found.id } : null;
  }

  async begin(run) {
    run.board = { claimed: false, execution: null, revision: null, executionError: null };
    const read = await this.#client.call('get_ticket', { ticket_id: run.ticketId, view: 'full' });
    const ticket = read?.ticket ?? read;
    if (!ticket?.id) throw Object.assign(new Error('Ticket not found on the Board.'), { code: 'NOT_FOUND' });
    if (!this.#projects.has(ticket.project_id)) throw Object.assign(new Error('This ticket is outside the projects C-chan\'s agents may work in.'), { code: 'FORBIDDEN' });
    if (ticket.status === 'done') throw Object.assign(new Error('This ticket is already done.'), { code: 'INVALID' });
    // #103: the Board refuses an execution on a ticket in review, so a coder launched on it would work with no Board record.
    if (ticket.status === 'review') {
      throw Object.assign(new Error('This ticket is in review. Return it to todo on the Board first (a coder cannot work on a ticket in review).'), { code: 'TICKET_IN_REVIEW' });
    }
    run.board.projectId = ticket.project_id; run.board.threadId = ticket.thread_id ?? null; this.#version(run, ticket);
    const claimed = await this.#client.call('claim_ticket', { ticket_id: ticket.id, expected_version: ticket.version });
    this.#version(run, claimed);
    run.board.claimed = true;
    return { number: ticket.number, title: ticket.title ?? '', description: ticket.description ?? '',
      acceptanceCriteria: ticket.acceptance_criteria ?? '' };
  }

  // A review run (#73): read the ticket and check its project, but do not claim it. The ticket stays where it is (usually
  // in review); the reviewer's report goes on its thread and C-chan decides.
  async beginReview(run) {
    run.board = { claimed: false, review: true, execution: null, revision: null, executionError: null };
    const read = await this.#client.call('get_ticket', { ticket_id: run.ticketId, view: 'full' });
    const ticket = read?.ticket ?? read;
    if (!ticket?.id) throw Object.assign(new Error('Ticket not found on the Board.'), { code: 'NOT_FOUND' });
    if (!this.#projects.has(ticket.project_id)) throw Object.assign(new Error('This ticket is outside the projects C-chan\'s agents may work in.'), { code: 'FORBIDDEN' });
    run.board.projectId = ticket.project_id; run.board.threadId = ticket.thread_id ?? null; this.#version(run, ticket);
    return { number: ticket.number, title: ticket.title ?? '', description: ticket.description ?? '',
      acceptanceCriteria: ticket.acceptance_criteria ?? '' };
  }

  // A merge run (#85): read the ticket and check its project and that it waits for the merge (in review). It is claimed
  // only at the end, to record the result (done, or back to todo).
  async beginMerge(run) {
    run.board = { claimed: false, merge: true, execution: null, revision: null, executionError: null };
    const read = await this.#client.call('get_ticket', { ticket_id: run.ticketId, view: 'full' });
    const ticket = read?.ticket ?? read;
    if (!ticket?.id) throw Object.assign(new Error('Ticket not found on the Board.'), { code: 'NOT_FOUND' });
    if (!this.#projects.has(ticket.project_id)) throw Object.assign(new Error('This ticket is outside the projects C-chan\'s agents may work in.'), { code: 'FORBIDDEN' });
    if (ticket.status === 'done') throw Object.assign(new Error('This ticket is already done.'), { code: 'INVALID' });
    run.board.projectId = ticket.project_id; run.board.threadId = ticket.thread_id ?? null; this.#version(run, ticket);
    await this.#post(run, `${run.agent} started the merge of ${run.mergeBranch} @ ${run.mergeHead.slice(0, 10)} into ${run.base}: update onto ${run.base}, full test suite, push. Run ${run.id}.`, 'merge-started');
    return { number: ticket.number, title: ticket.title ?? '' };
  }

  async started(run) {
    try {
      const reserved = await this.#client.call('reserve_execution', { idempotency_key: `${run.id}-reserve`,
        project_id: run.board.projectId, ticket_id: run.ticketId, work_id: run.id, turn_id: `${run.id}-1`,
        provider: run.provider, model: run.model });
      const execution = pick(reserved, 'execution.id', 'execution_id', 'id');
      const revision = pick(reserved, 'execution.revision', 'revision');
      if (!ID.test(String(execution ?? ''))) throw new Error('no execution id');
      const active = await this.#client.call('start_execution', { execution_id: execution, expected_revision: revision });
      run.board.execution = execution; run.board.revision = pick(active, 'execution.revision', 'revision') ?? revision;
    } catch (error) {
      run.board.executionError = String(error.code ? `${error.code}: ${error.message}` : error.message).slice(0, 300);
      this.#log(`Runtime execution not recorded for ${run.id}: ${run.board.executionError}`);
    }
    const who = `${run.agent}${run.role ? ` (${run.role}${run.team ? `, team ${run.team}` : ''})` : ''}`;
    await this.#post(run, run.mode === 'review'
      ? `${who} started reviewing ${run.reviewBranch}${run.reviewHead ? ` @ ${run.reviewHead.slice(0, 10)}` : ''} (${run.provider}/${run.modelAlias}, `
        + `at most ${run.maxTurns} turns, ${Math.round(run.maxSeconds / 60)} min). Run ${run.id}.`
      : `${who} started on this ticket (${run.provider}/${run.modelAlias}, at most ${run.maxTurns} turns, `
        + `${Math.round(run.maxSeconds / 60)} min). Branch ${run.branch}${run.resumed ? ' (resumed)' : ''}. Run ${run.id}.`, 'started');
  }

  async heartbeat(run) {
    let stop = null;
    if (run.board.execution) {
      try {
        const beat = await this.#client.call('heartbeat_execution', { execution_id: run.board.execution, expected_revision: run.board.revision });
        run.board.revision = pick(beat, 'execution.revision', 'revision') ?? run.board.revision;
        if (pick(beat, 'should_stop', 'execution.should_stop', 'control.should_stop') === true) stop = { stop: true, reason: 'stop_requested' };
      } catch (error) { this.#log(`execution heartbeat for ${run.id} failed: ${error.code ?? error.message}`); }
    }
    const count = (this.#beats.get(run.id) ?? 0) + 1; this.#beats.set(run.id, count);
    if (count % RENEW_EVERY === 0 && run.board.claimed) {
      try {
        const renewed = await this.#client.call('renew_ticket', { ticket_id: run.ticketId, expected_version: run.board.version,
          progress: `${run.agent} working: ${run.turns} turn(s) so far (run ${run.id}).` });
        this.#version(run, renewed);
      } catch (error) {
        this.#log(`lease renewal for ${run.id} failed: ${error.code ?? error.message}`);
        if (/expired|replaced|not.*claim/i.test(String(error.message))) stop = { stop: true, reason: 'claim_lost' };
      }
    }
    return stop;
  }

  async finish(run) {
    this.#beats.delete(run.id);
    if (run.board?.merge) return this.#finishMerge(run);
    if (!run.board?.claimed && !run.board?.review) return;
    const confirmed = Boolean(run.cleanup?.unitGone && run.cleanup?.worktreeRemoved);
    if (run.board.execution) {
      const status = run.state === 'succeeded' ? 'completed' : run.state === 'blocked' ? 'blocked'
        : ['stopped', 'cancelled'].includes(run.state) ? 'cancelled' : 'blocked';
      const reason = !confirmed ? 'cleanup_unconfirmed' : ['USAGE_LIMIT', 'RATE_LIMITED'].includes(run.errorCode) ? 'quota_or_rate_limit'
        : run.errorCode === 'NOT_SIGNED_IN' ? 'authentication_failed' : FINISH_REASON[run.state] ?? 'execution_failed';
      try {
        await this.#client.call('finish_execution', { execution_id: run.board.execution, expected_revision: run.board.revision,
          status, cleanup_confirmed: confirmed, reason });
      } catch (error) { this.#log(`finish_execution for ${run.id} failed: ${error.code ?? error.message}`); }
    }
    const summary = runSummary(run);
    if (run.board.review) return this.#finishReview(run, summary);
    if (run.state === 'succeeded') {
      const result = run.result ?? {};
      const outcome = result.kind === 'done' ? result.outcome
        : `${run.agent} finished without the OUTCOME block. Its last words: ${result.outcome ?? ''}`.slice(0, 4000);
      const evidence = [result.evidence, `Runner: ${summary}.`, run.branch ? reviewFetch(run.repo, run.branch) : '']
        .filter(Boolean).join('\n\n');
      await this.#ticket(run, { status: 'review', outcome, evidence, release_claim: true });
      await this.#post(run, `${run.agent} finished; the ticket is in review. ${summary}.`, 'finished');
    } else if (run.state === 'blocked') {
      try {
        await this.#client.call('request_human_input', { ticket_id: run.ticketId, owner_id: this.#ownerId, kind: 'question',
          question: run.result.question, summary: run.result.question.slice(0, 240), idempotency_key: `${run.id}-blocked`,
          expected_version: run.board.version });
      } catch (error) {
        this.#log(`Needs-you for ${run.id} failed: ${error.code ?? error.message}`);
        await this.#ticket(run, { release_claim: true, progress: `${run.agent} is blocked: ${run.result.question}`.slice(0, 2000) });
      }
      await this.#post(run, `${run.agent} stopped with a question for the owner (Needs-you). ${summary}.`, 'blocked');
    } else {
      const why = run.error ? String(run.error).slice(0, 400) : run.state;
      await this.#ticket(run, { status: 'todo', release_claim: true, progress: `Last run ${run.state}: ${why}`.slice(0, 2000) });
      await this.#post(run, `${run.agent}'s run ended: ${run.state} (${why}). The ticket is released. ${summary}.`, 'ended');
    }
  }

  // The merge outcome (#85). Merged: done, with the merge commit as evidence. Conflict or failing tests: nothing was merged,
  // the ticket goes back to todo for a coder with the output. Anything else (moved branch, push refused, interrupted): the
  // ticket stays in review and the thread says why. Returns { done } so the runner knows whether the Board shows it done.
  async #finishMerge(run) {
    const result = run.mergeResult ?? {};
    const short = value => String(value ?? '').slice(0, 10);
    const claim = async () => {
      try { this.#version(run, await this.#client.call('claim_ticket', { ticket_id: run.ticketId, expected_version: run.board.version })); }
      catch (error) { this.#log(`claim for ${run.id} failed (continuing without): ${error.code ?? error.message}`); }
    };
    if (run.state === 'succeeded') {
      const evidence = `Merge commit ${result.mergeCommit} on ${run.base} (${run.mergeBranch} @ ${short(run.mergeHead)}), `
        + `${result.status === 'already_merged' ? 'which was already part of main' : 'full test suite passed on the merge result, pushed to origin'}.\nRun ${run.id}.`;
      await claim();
      const done = await this.#ticket(run, { status: 'done', outcome: `Merged ${run.mergeBranch} into ${run.base}: ${result.mergeCommit}`, evidence, release_claim: true });
      await this.#post(run, `${evidence}${done ? '' : '\nThe ticket could not be set to done automatically.'}`, 'merged');
      return { done };
    }
    const why = `${run.errorCode ?? run.state}: ${String(result.output || run.error || '').slice(0, 12000)}`;
    if (['MERGE_CONFLICT', 'TESTS_FAILED'].includes(run.errorCode)) {
      await claim();
      const progress = `${run.errorCode === 'MERGE_CONFLICT' ? 'Merge conflict with' : 'The full test suite fails after merging into'} ${run.base}. Nothing was merged. Fix it on ${run.mergeBranch} and deliver again.`;
      await this.#ticket(run, { status: 'todo', release_claim: true, progress });
      await this.#post(run, `${progress}\n\nOutput:\n${why}`.slice(0, 19000), 'merge-refused');
    } else {
      await this.#post(run, `The merge of ${run.mergeBranch} did not happen (${why}). Nothing was merged; the ticket stays in review.`.slice(0, 19000), 'merge-failed');
    }
    return { done: false };
  }

  // The desktop release after a merge (#90): version and installer sha256, or the error, on the ticket's thread. A merge
  // that does not change the desktop version posts nothing.
  async release(run) {
    const r = run.release ?? {};
    if (!run.board?.merge || ['no_bump', 'no_desktop'].includes(r.reason)) return;
    const at = `from ${run.base} @ ${String(r.commit).slice(0, 10)}`;
    const body = r.status === 'published'
      ? `Desktop ${r.version} published ${at} (was ${r.served ?? 'none'}). Installer ${r.file} sha256 ${r.sha256}. Installed apps update through the in-app updater. Run ${run.id}.`
      : r.status === 'skipped'
        ? `Desktop release skipped ${at}: ${String(r.output).slice(0, 500)} Nothing was published. Run ${run.id}.`
        : `Desktop release ${r.version ?? ''} ${at} failed (${r.status}). ${r.status === 'build_failed' ? 'Nothing was published' : `The server still serves ${r.served ?? 'the previous version'}`}; main is unchanged. Run ${run.id}.\n\nOutput:\n${String(r.output).slice(-12000)}`;
    await this.#post(run, body.slice(0, 19000), `release-${r.status}`);
  }

  // The server deploy after a merge (#100): commit, units restarted and the health result, or the failure with its output,
  // on the ticket's thread. A merge that changes nothing on the server posts nothing.
  async deploy(run) {
    const r = run.deploy ?? {};
    if (!run.board?.merge || r.status === 'skipped') return;
    const c = String(r.commit).slice(0, 10), units = (r.units ?? []).join(', ');
    const waited = r.idle && r.idle.waitedMs >= 1000 ? ` Waited ${Math.round(r.idle.waitedMs / 1000)}s for an idle companion${r.idle.ok ? '' : ' (bound reached)'}.` : '';
    const reinstall = r.plan?.reinstall ? ' ops/deploy/ changed: re-run `sudo sh ops/deploy/install.sh` from this commit.' : '';
    const output = r.output ? `\n\nOutput:\n${String(r.output).slice(-12000)}` : '';
    let body, key = `deploy-${r.status}`;
    if (r.status === 'runner_restarting') {
      body = `Deployed ${c} to the server: ${COMPANION} restarted, health check passed.${waited} Restarting the runner now (the guard checks it stays up, or rolls back). Run ${run.id}.`;
    } else if (r.status === 'deployed') {
      key = `deploy-deployed-${r.runner ?? 'companion'}`;
      body = r.runner && r.runner !== 'healthy'
        ? `Deployed ${c}: ${COMPANION} is healthy, but the runner ${r.runner === 'restart_failed' ? 'could not be restarted (it still runs the previous code)' : 'restart was not confirmed'}.${waited} Run ${run.id}.${output}`
        : `Deployed ${c} to the server. Restarted: ${units}. Health check passed${r.runner === 'healthy' ? ' (companion /api/status; runner up and stable)' : ' (companion /api/status)'}.${waited}${reinstall} Run ${run.id}.`;
    } else if (r.status === 'rolled_back') {
      body = `Deploy of ${c} failed its health check and was rolled back to ${String(r.previous ?? 'the previous release').slice(0, 10)}; main is unchanged.${reinstall} Run ${run.id}.${output}`;
    } else if (r.status === 'recovery_failed') {
      body = `Deploy of ${c} failed and the automatic rollback failed too: check the server now. Run ${run.id}.${output}`;
    } else {
      body = `Deploy of ${c} did not run (${r.errorCode ?? r.status}); the previous release is still live. Run ${run.id}.${output}`;
    }
    await this.#post(run, body.slice(0, 19000), key);
  }

  // The reviewer's report goes on the ticket's thread; the ticket itself is not changed (C-chan accepts or returns it).
  async #finishReview(run, summary) {
    const result = run.result ?? {};
    if (run.state === 'succeeded' && result.kind === 'review') {
      const body = [`Review by ${run.agent} of ${run.reviewBranch}${run.reviewHead ? ` @ ${run.reviewHead.slice(0, 10)}` : ''}: `
        + `VERDICT ${result.verdict === 'approve' ? 'approve' : 'changes requested'}.`,
        result.findings ? `Findings:\n${result.findings}` : '', result.evidence ? `Evidence:\n${result.evidence}` : '',
        `Runner: ${summary}. The ticket was not changed: C-chan accepts or returns it.`].filter(Boolean).join('\n\n');
      await this.#post(run, body.slice(0, 19000), 'review');
    } else if (run.state === 'blocked') {
      try {
        await this.#client.call('request_human_input', { ticket_id: run.ticketId, owner_id: this.#ownerId, kind: 'question',
          question: run.result.question, summary: run.result.question.slice(0, 240), idempotency_key: `${run.id}-blocked` });
      } catch (error) { this.#log(`Needs-you for ${run.id} failed: ${error.code ?? error.message}`); }
      await this.#post(run, `${run.agent} stopped its review with a question for the owner (Needs-you). ${summary}.`, 'blocked');
    } else {
      const why = run.error ? String(run.error).slice(0, 400) : run.state;
      await this.#post(run, `${run.agent}'s review ended without a verdict: ${run.state} (${why}). ${summary}.`, 'ended');
    }
  }

  async #ticket(run, changes) {
    try {
      const updated = await this.#client.call('update_ticket', { ticket_id: run.ticketId, expected_version: run.board.version, changes });
      this.#version(run, updated);
      return true;
    } catch (error) { this.#log(`ticket update for ${run.id} failed: ${error.code ?? error.message}`); return false; }
  }
}

// Board events that should wake C-chan right away, from a cheap model-free watch of the allowed projects: a ticket
// becoming ready (its dependencies delivered), entering review, getting done or getting blocked.
// It also keeps the latest snapshot (tickets()) for manager mode's sweep (#76): since is when the watch first saw the
// ticket's current status and waiting state.
export class BoardWatch {
  #client; #projects; #now; #seen = new Map(); #primed = false; #snapshot = null;
  constructor({ client, projects, now = Date.now }) { this.#client = client; this.#projects = projects; this.#now = now; }

  tickets() { return this.#snapshot ? this.#snapshot.map(ticket => ({ ...ticket })) : null; }

  async poll() {
    const events = [], snapshot = [], at = this.#now();
    for (const projectId of this.#projects) {
      let cursor = null;
      for (let page = 0; page < 10; page++) {
        const listed = await this.#client.call('list_tickets', { project_id: projectId, limit: 100, ...(cursor ? { cursor } : {}) });
        for (const ticket of listed?.items ?? []) {
          const now = { status: ticket.status, ready: ticket.ready === true, waiting: ticket.waiting_on_human === true };
          const before = this.#seen.get(ticket.id);
          now.since = before && before.status === now.status && before.waiting === now.waiting ? before.since : at;
          this.#seen.set(ticket.id, now);
          snapshot.push({ id: ticket.id, number: ticket.number ?? null, status: now.status, ready: now.ready, waiting: now.waiting, projectId, since: now.since });
          if (!this.#primed || !before) continue;
          const base = { ticketId: ticket.id, ticketNumber: ticket.number, title: String(ticket.title ?? '').slice(0, 200), projectId };
          if (now.ready && !before.ready && now.status === 'todo') events.push({ type: 'board.ready', ...base });
          if (now.status !== before.status && ['review', 'done', 'blocked'].includes(now.status)) events.push({ type: `board.${now.status}`, ...base });
          if (now.waiting && !before.waiting) events.push({ type: 'board.needs_you', ...base });
        }
        cursor = listed?.next_cursor ?? null;
        if (!cursor) break;
      }
    }
    this.#primed = true;
    this.#snapshot = snapshot;
    return events;
  }
}

// The roster's copy on the Board (#73): each roster agent is a managed agent profile, so the owner sees C-chan's
// agents and teams in the Board's agent list. It needs the owner's "manage agent profiles" grant on the runner's own
// Board profile; until then every sync fails with the Board's refusal, which the roster records and retries.
// The profiles are unbound (no device, no session, no credential) and hold no permissions: the runner does the Board
// work for every run with its own identity, and the roster in the runner is what is enforced.
export class BoardRosterMirror {
  #client; #projects;
  constructor({ client, projects }) { this.#client = client; this.#projects = [...projects]; }

  #fields(agent) {
    const where = agent.kind === 'task' ? `task agent for one ticket (archived when it is done)` : 'standing agent';
    const description = [`C-chan's ${agent.role} agent: ${where}${agent.team ? `, team ${agent.team}` : ''}. Model ${agent.provider}/${agent.model}; `
      + `actions ${agent.actions.join(', ')}${agent.repos.length ? `; repos ${agent.repos.join(', ')}` : ''}. Run by C-chan's agent runner `
      + 'in the sandbox; not paired, it works through the runner\'s Board identity.', agent.description].filter(Boolean).join(' ');
    const instructions = [agent.instructions, ...agent.skills.map(skill => `Skill: ${skill}`)].filter(Boolean).join('\n\n');
    return { name: `C-chan · ${agent.name}`.slice(0, 200), description: description.slice(0, 4000), role: agent.role,
      ...(instructions ? { instructions: instructions.slice(0, 12000) } : {}), preferred_provider: agent.provider,
      preferred_model: agent.model, project_ids: this.#projects };
  }

  async #current(profileId) {
    const value = await this.#client.call('get_managed_agent_profile', { profile_id: profileId, view: 'full' });
    const profile = value?.profile ?? value;
    return { version: profile?.version, status: profile?.status };
  }

  // Returns { profileId, version } for the roster to keep.
  async sync(agent) {
    const key = `cchan-roster-${agent.name}-${agent.createdAt}`;
    let profileId = agent.board?.profileId ?? null, version = agent.board?.version ?? null;
    const read = value => { const profile = value?.profile ?? value; if (profile?.id) profileId = profile.id; if (Number.isSafeInteger(profile?.version)) version = profile.version; };
    if (!profileId) {
      if (agent.status === 'archived') return { profileId: null, version: null };
      read(await this.#client.call('create_managed_agent_profile', { profile: { ...this.#fields(agent), status: agent.status,
        policy: { allow_read: false, allow_messages: false, allow_requests: false, actions: [], resources: [], autonomy: 'responses' },
        idempotency_key: key } }));
      return { profileId, version };
    }
    const now = await this.#current(profileId);
    version = now.version;
    if (agent.status === 'archived') {
      if (now.status !== 'archived') read(await this.#client.call('archive_managed_agent_profile', { profile_id: profileId,
        expected_version: version, idempotency_key: `${key}-archive-v${agent.version}` }));
      return { profileId, version };
    }
    read(await this.#client.call('update_managed_agent_profile', { profile_id: profileId, expected_version: version,
      idempotency_key: `${key}-v${agent.version}-${agent.team ?? 'none'}-${agent.status}`, changes: { ...this.#fields(agent), status: agent.status } }));
    return { profileId, version };
  }
}
