import { createGoalsClient } from './goals-client.mjs';

const el = id => document.getElementById(id), client = createGoalsClient(), encoder = new TextEncoder();
const goalFields = { title: 'goal-title', desiredOutcome: 'desired-outcome', notes: 'goal-notes', plan: 'goal-plan', nextStep: 'next-step' };
const cardFields = { title: 'card-title', maxTasks: 'max-tasks', maxTokens: 'max-tokens', maxCostMinor: 'max-cost', currency: 'card-currency', reviewEveryDays: 'review-days' };
const listFields = { projectIds: 'project-ids', actions: 'card-actions', taskTypes: 'task-types', resources: 'card-resources', requireDecision: 'require-decision' };
const messages = {
  INVALID_REQUEST: 'Check the highlighted fields and the saved version before trying again.', NOT_READY: 'Open a fresh workspace first.',
  BUSY: 'Resolve the pending action first.', ACCESS_DENIED: 'Access ended. Open again after checking your platform sign-in.',
  UNAVAILABLE: 'The service is unavailable. The last action may need reconciliation.', NETWORK_ERROR: 'The connection was interrupted.',
  INVALID_RESPONSE: 'The workspace response could not be verified.', CONFLICT: 'The saved version changed. Refresh, then discard or revise this draft.',
  NOT_FOUND: 'The saved goal or card is no longer available. Refresh the workspace.'
};
const reasons = {
  GOALS_PAUSED: 'The goal is paused.', GOALS_NOT_CONFIRMED: 'No local consent is recorded.', GOALS_REVOKED: 'Local consent was revoked.',
  GOALS_CONFIRMATION_REQUIRED: 'The current saved version needs a new confirmation.', GOALS_NOT_YET_VALID: 'The saved time window has not started.',
  GOALS_EXPIRED: 'The saved time window has ended.', GOALS_REVIEW_REQUIRED: 'The permission review is due.', GOALS_BUDGET_EXCEEDED: 'A lifetime reservation limit is exhausted.',
  GOALS_CONTROL_CAPACITY: 'This workspace has reached its control capacity. Local checks remain closed.'
};
const goalNodes = new Map(), requests = new Set();
let state = client.getState(), mode = null, opened = false, opening = false, epoch = 0, notice = '';
let selectedId = null, editingNew = false, goalDirty = false, cardDirty = false, staleGoal = false, staleCard = false;
let goalBase = null, cardBase = null, cardGoalBase = null, milestones = [], activeIntent = null;
let sessionTimer = null, sessionProbe = null;
const currentGoal = () => state.goals.find(item => item.id === selectedId) ?? null;
const currentCard = () => state.cards.find(item => item.goalId === selectedId) ?? null;
const utcInput = value => value ? value.slice(0, -1) : '';
const utcLabel = value => value ? value.replace('T', ' ').replace('Z', ' UTC') : 'Not set';
function report(text) { notice = text; renderStatus(); }

function resetForms() {
  el('goal-form').reset(); el('card-form').reset(); el('milestone-list').replaceChildren();
  milestones = []; goalBase = null; cardBase = null; cardGoalBase = null; goalDirty = false; cardDirty = false; staleGoal = false; staleCard = false;
  for (const id of [...Object.values(goalFields), ...Object.values(cardFields), ...Object.values(listFields), 'goal-review-at', 'not-before', 'expires-at', 'template-title', 'template-instructions', 'template-acceptance']) el(id).setCustomValidity('');
  el('confirm-review').checked = false;
}
function fillGoal(entry) {
  const value = entry?.goal;
  for (const [key, id] of Object.entries(goalFields)) el(id).value = value?.[key] ?? '';
  el('goal-review-at').value = utcInput(value?.reviewAt);
  milestones = (value?.milestones ?? []).map(item => ({ ...item, localKey: crypto.randomUUID() }));
  goalBase = entry ? { id: entry.id, version: entry.version } : null; staleGoal = false; renderMilestones();
}
function fillCard(entry) {
  const value = entry?.card;
  for (const [key, id] of Object.entries(cardFields)) el(id).value = value?.[key] ?? (key === 'reviewEveryDays' ? 7 : key.startsWith('max') ? 0 : '');
  for (const [key, id] of Object.entries(listFields)) el(id).value = value?.[key]?.join('\n') ?? '';
  el('not-before').value = utcInput(value?.notBefore); el('expires-at').value = utcInput(value?.expiresAt);
  for (const [key, id] of [['title', 'template-title'], ['instructions', 'template-instructions'], ['acceptanceCriteria', 'template-acceptance']]) el(id).value = value?.template[key] ?? '';
  cardBase = entry ? { id: entry.id, version: entry.version, digest: entry.previewDigest } : null; cardGoalBase = selectedId; staleCard = false;
}
function syncForms() {
  const saved = currentGoal(), permission = currentCard();
  if (goalBase?.id !== saved?.id || (!saved && !editingNew)) { fillGoal(saved); goalDirty = false; }
  else if (saved && goalBase?.version !== saved.version) {
    if (goalDirty) staleGoal = true; else fillGoal(saved);
  }
  if (cardGoalBase !== selectedId || cardBase?.id !== permission?.id) { fillCard(permission); cardDirty = false; }
  else if (permission && (cardBase?.version !== permission.version || cardBase?.digest !== permission.previewDigest)) {
    if (cardDirty) staleCard = true; else fillCard(permission);
  }
}
function markGoalDirty() { if (!opened || state.pending) return; goalDirty = true; client.invalidateReview(); }
function markCardDirty() { if (!opened || state.pending) return; cardDirty = true; client.invalidateReview(); }
function renderMilestones() {
  const container = el('milestone-list'); container.replaceChildren();
  for (const [index, item] of milestones.entries()) {
    const row = document.createElement('div'), done = document.createElement('input'), title = document.createElement('input'), remove = document.createElement('button');
    row.className = 'milestone-row'; done.type = 'checkbox'; done.checked = item.done; done.setAttribute('aria-label', `Milestone ${index + 1} complete`);
    title.type = 'text'; title.value = item.title; title.maxLength = 160; title.required = true; title.setAttribute('aria-label', `Milestone ${index + 1} title`);
    remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove milestone ${index + 1}`);
    done.addEventListener('change', () => { item.done = done.checked; markGoalDirty(); renderMilestoneProgress(); });
    title.addEventListener('input', () => { item.title = title.value; title.setCustomValidity(''); markGoalDirty(); });
    remove.addEventListener('click', () => { milestones = milestones.filter(other => other.localKey !== item.localKey); markGoalDirty(); renderMilestones(); el('add-milestone').focus(); });
    row.append(done, title, remove); container.append(row);
  }
  renderMilestoneProgress();
}
function renderMilestoneProgress() {
  el('milestone-progress').textContent = `${milestones.filter(item => item.done).length} of ${milestones.length} complete${goalDirty ? ' · unsaved' : ''}`;
  el('add-milestone').disabled = milestones.length >= 20 || !opened || state.connection !== 'ready' || Boolean(state.pending);
}
function renderGoals(goals, canNavigate) {
  const list = el('goal-list'), select = el('goal-select'), retained = new Set();
  if (goals.length && select.firstElementChild?.value === '') select.firstElementChild.remove();
  for (const [index, entry] of goals.entries()) {
    retained.add(entry.id); let node = goalNodes.get(entry.id);
    if (!node) {
      const item = document.createElement('li'), button = document.createElement('button'), title = document.createElement('span'), detail = document.createElement('small'), option = document.createElement('option');
      button.type = 'button'; button.append(title, detail); option.value = entry.id;
      button.addEventListener('click', () => selectGoal(entry.id)); item.append(button); node = { item, button, title, detail, option }; goalNodes.set(entry.id, node);
    }
    if (node.title.textContent !== entry.goal.title) node.title.textContent = entry.goal.title;
    const detail = `${entry.goal.status === 'paused' ? 'Paused' : 'Active'} · ${entry.progress.done}/${entry.progress.total} milestones`;
    if (node.detail.textContent !== detail) node.detail.textContent = detail;
    if (node.option.textContent !== entry.goal.title) node.option.textContent = entry.goal.title;
    node.button.disabled = !canNavigate;
    if (entry.id === selectedId) node.button.setAttribute('aria-current', 'true'); else node.button.removeAttribute('aria-current');
    if (list.children[index] !== node.item) list.insertBefore(node.item, list.children[index] ?? null);
    if (select.children[index] !== node.option) select.insertBefore(node.option, select.children[index] ?? null);
  }
  for (const [id, node] of goalNodes) if (!retained.has(id)) { node.item.remove(); node.option.remove(); goalNodes.delete(id); }
  if (!goals.length && !select.firstElementChild) { const option = document.createElement('option'); option.value = ''; select.append(option); }
  if (!goals.length) select.firstElementChild.textContent = opened ? 'No saved goals' : 'Open workspace first';
  if (document.activeElement !== select) select.value = selectedId ?? '';
  select.disabled = !canNavigate || !goals.length;
}
function renderPreview(entry, usable) {
  const visible = Boolean(entry) && !goalDirty && !cardDirty && !staleGoal && !staleCard;
  el('saved-preview').hidden = !visible; el('preview-limits').replaceChildren();
  for (const id of ['preview-version', 'preview-title', 'preview-instructions', 'preview-acceptance']) el(id).textContent = '';
  const reviewed = visible && state.reviewed?.cardId === entry.id && state.reviewed.version === entry.version && state.reviewed.previewDigest === entry.previewDigest;
  el('confirm-review').checked = Boolean(reviewed);
  el('confirm-review').disabled = !visible || !usable || entry?.state === 'revoked' || currentGoal()?.goal.status !== 'active';
  el('confirm-card').disabled = el('confirm-review').disabled || !reviewed;
  if (!visible) return;
  const value = entry.card;
  el('preview-version').textContent = `Saved version ${entry.version}. Only an explicit confirmation applies to this exact saved card.`;
  const rows = [['Card label', value.title], ['Projects', value.projectIds.join('\n')], ['Actions', value.actions.join('\n')],
    ['Task types', value.taskTypes.join('\n')], ['Resources', value.resources.join('\n')], ['Task cap', String(value.maxTasks)],
    ['Token cap', String(value.maxTokens)], ['Spending cap', `${value.maxCostMinor} minor units${value.currency ? ' · ' + value.currency : ' · zero cap'}`],
    ['Starts', utcLabel(value.notBefore)], ['Ends', utcLabel(value.expiresAt)], ['Review cadence', `Every ${value.reviewEveryDays} day(s)`],
    ['Fresh decision', value.requireDecision.join('\n') || 'None of the listed actions']];
  for (const [label, text] of rows) { const term = document.createElement('dt'), description = document.createElement('dd'); term.textContent = label; description.textContent = text; el('preview-limits').append(term, description); }
  el('preview-title').textContent = entry.preview.template.title;
  el('preview-instructions').textContent = entry.preview.template.instructions;
  el('preview-acceptance').textContent = entry.preview.template.acceptanceCriteria;
}
function renderStatus() {
  const text = notice || (state.pending?.status === 'uncertain' ? 'Result uncertain. Retry safely checks the same action.'
    : state.pending?.status === 'acknowledged' ? 'The change was saved. Refresh to reconcile the current workspace.'
    : state.pending ? 'Saving your private change…' : opening || state.connection === 'loading' ? 'Checking current access and saved state…'
    : state.error ? messages[state.error] ?? 'The workspace could not be loaded.'
    : staleGoal || staleCard ? 'A saved version changed. Discard this draft to load the current version before saving.'
    : goalDirty || cardDirty ? 'Unsaved edits. Confirmation stays disabled until the draft is saved and reviewed.'
    : opened && state.connection === 'ready' ? 'Workspace loaded. Connected execution remains unavailable.' : 'Open explicitly to load your workspace.');
  if (el('status').textContent !== text) el('status').textContent = text;
}
function render() {
  const visible = opened && state.mode !== null;
  if (!visible) { selectedId = null; editingNew = false; activeIntent = null; resetForms(); }
  else {
    if (!editingNew && !state.goals.some(item => item.id === selectedId)) selectedId = state.goals[0]?.id ?? null;
    if (!selectedId && state.connection === 'ready') editingNew = true;
    syncForms();
  }
  const saved = visible ? currentGoal() : null, permission = visible ? currentCard() : null;
  const ready = visible && state.connection === 'ready', usable = ready && !state.pending && !['CONFLICT', 'NOT_FOUND'].includes(state.error);
  el('demo-notice').hidden = mode !== 'demo';
  el('connection-label').textContent = mode === 'demo' ? 'Synthetic goals workspace' : mode === 'account' ? 'Private platform workspace' : 'Goals unavailable';
  el('connection-note').textContent = mode === 'demo' ? 'Use sample data only. No AI, project dispatch or runtime is connected.'
    : 'Every action checks your current platform session. While open, access is checked every 15 seconds. Hiding or closing clears private forms.';
  el('open-workspace').textContent = opened ? 'Reopen workspace' : mode === 'demo' ? 'Open synthetic goals' : 'Open private goals';
  el('open-workspace').hidden = ready && !state.error;
  el('open-workspace').disabled = opening || !['demo', 'account'].includes(mode);
  el('refresh-workspace').hidden = !opened;
  el('refresh-workspace').disabled = opening || state.connection === 'loading' || Boolean(state.pending && state.pending.status !== 'acknowledged');
  el('close-workspace').hidden = !opened;
  el('retry-action').hidden = !opened || state.pending?.status !== 'uncertain';
  const canNavigate = usable && !goalDirty && !cardDirty;
  renderGoals(visible ? state.goals : [], canNavigate);
  el('goal-count').textContent = visible ? String(state.goals.length) : '0';
  el('goals-empty').hidden = visible && state.goals.length > 0;
  for (const id of ['new-goal', 'mobile-new-goal']) el(id).disabled = !canNavigate || state.goals.length >= 20;
  el('selected-title').textContent = saved?.goal.title ?? (editingNew ? 'A new private goal' : 'A place for your next step.');
  el('goal-summary').textContent = saved ? `Saved version ${saved.version} · ${saved.progress.done} of ${saved.progress.total} milestones complete`
    : editingNew ? 'Write a proposal, then save it before drafting permissions.' : 'No goal loaded.';
  el('goal-state').textContent = saved ? saved.goal.status === 'paused' ? 'Paused' : 'Active' : editingNew ? 'Unsaved proposal' : 'Not loaded';
  el('goal-fields').disabled = !usable;
  el('save-goal').disabled = !usable || staleGoal;
  el('card-fields').disabled = !usable || !saved;
  el('save-card').disabled = !usable || !saved || staleCard;
  el('pause-goal').disabled = !ready || Boolean(state.pending) || !saved;
  el('pause-goal').textContent = saved?.goal.status === 'paused' ? 'Resume goal' : 'Pause goal';
  el('review-goal').disabled = !ready || Boolean(state.pending) || !saved;
  el('goal-review-status').textContent = `Last private review: ${utcLabel(saved?.reviewedAt)}. This does not refresh permission consent. Resuming does not restore an old confirmation.`;
  el('discard-edits').hidden = !goalDirty && !cardDirty;
  el('card-lock-note').textContent = !saved ? 'Save the private goal before drafting its card.' : cardDirty || goalDirty
    ? 'Unsaved edits cannot be confirmed. Save the draft, then review the exact saved card.' : 'Edit the draft or review the exact saved card below.';
  const consentCurrent = permission?.state === 'confirmed' && permission.confirmedAuthorizationGeneration === permission.authorizationGeneration
    && saved?.goal.status === 'active' && !permission.blockedReason;
  el('consent-state').textContent = goalDirty || cardDirty ? 'Unsaved draft · review disabled' : !permission ? 'No local consent'
    : permission.state === 'revoked' ? 'Revoked' : consentCurrent ? 'Local consent recorded' : permission.state === 'confirmed' ? 'Review required' : 'Draft · no consent';
  el('consent-note').textContent = `${permission?.blockedReason ? reasons[permission.blockedReason] ?? 'Local checks do not currently allow this card.' : 'Local consent is separate from connected execution.'}${permission ? ` Last card confirmation: ${utcLabel(permission.confirmedAt)}. Permission review due: ${utcLabel(permission.reviewDueAt)}.` : ''} Saving edits requires a new confirmation. Board and runtime dispatch remain unavailable.`;
  el('revoke-card').disabled = !ready || Boolean(state.pending) || !permission || permission.state === 'revoked';
  el('card-currency').readOnly = Boolean(permission && permission.usage.costMinor > 0);
  for (const [id, key] of [['max-tasks', 'tasks'], ['max-tokens', 'tokens'], ['max-cost', 'costMinor']]) el(id).min = permission?.usage[key] ?? 0;
  el('reservation-summary').hidden = !permission;
  el('reservation-summary').textContent = permission ? `Lifetime reservations (not actual usage or billed spending)\nTasks: ${permission.usage.tasks}\nTokens: ${permission.usage.tokens}\nReserved cost: ${permission.usage.costMinor} minor units${permission.usage.currency ? ' · ' + permission.usage.currency : ''}\nEdits, reviews and reconfirmation never reset these totals.` : '';
  renderPreview(permission, usable); renderMilestoneProgress(); renderStatus(); scheduleSessionCheck();
}

function closeWorkspace(message = '') {
  if (sessionTimer !== null) clearTimeout(sessionTimer); sessionTimer = null; sessionProbe = null;
  epoch++; for (const request of requests) request.abort(); requests.clear(); opening = false; opened = false;
  notice = message; client.disconnect();
}
function sessionCheckNeeded() {
  return opened && mode === 'account' && state.mode === 'account' && state.companionId !== null && document.visibilityState !== 'hidden';
}
function scheduleSessionCheck() {
  if (sessionTimer === null && sessionProbe === null && sessionCheckNeeded()) sessionTimer = setTimeout(checkSession, 15000);
}
async function checkSession() {
  sessionTimer = null; if (!sessionCheckNeeded()) return;
  const version = epoch, companionId = state.companionId, controller = new AbortController(); sessionProbe = controller; requests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('api/session', { method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal });
    const body = response.ok ? await response.json() : null;
    if (version !== epoch || !sessionCheckNeeded()) return;
    if (!response.ok || response.redirected || body?.companionId !== companionId) closeWorkspace('Access changed or could not be checked. This tab is clear; open again to check current access.');
  } catch {
    if (version === epoch) closeWorkspace('Access could not be checked. This tab is clear; open again to check current access.');
  } finally {
    clearTimeout(timeout); requests.delete(controller); if (sessionProbe === controller) sessionProbe = null;
    if (version === epoch) scheduleSessionCheck();
  }
}
async function loadMode() {
  const version = epoch, controller = new AbortController(); requests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('api/status', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } });
    const body = await response.json(); if (version !== epoch || document.visibilityState === 'hidden') return false;
    if (!response.ok || !['demo', 'account', 'unavailable'].includes(body.service?.mode)) throw new Error();
    mode = body.service.mode; render(); return true;
  } catch { if (version === epoch) { mode = 'unavailable'; closeWorkspace('Service status could not be checked. Reload to try again.'); } return false; }
  finally { clearTimeout(timeout); requests.delete(controller); }
}
function selectGoal(id) {
  if (goalDirty || cardDirty) return report('Save or discard your edits before switching goals.');
  if (!state.goals.some(item => item.id === id)) return;
  selectedId = id; editingNew = false; resetForms(); fillGoal(currentGoal()); fillCard(currentCard()); client.invalidateReview(); el('goal-title').focus();
}
function newGoal() {
  if (goalDirty || cardDirty) return report('Save or discard your edits before starting another goal.');
  selectedId = null; editingNew = true; resetForms(); fillGoal(null); fillCard(null); client.invalidateReview(); el('goal-title').focus();
}
function invalid(field, text = 'Check this field or shorten its text.') { field.setCustomValidity(text); field.reportValidity(); throw new Error('FORM_INVALID'); }
function readText(id, maximum, required = false) {
  const field = el(id), value = field.value;
  if ((required && !value.trim()) || encoder.encode(value).length > maximum || (value.isWellFormed && !value.isWellFormed())) invalid(field);
  return value;
}
function readDate(id, required = false) {
  const field = el(id); if (!field.value && !required) return null;
  const value = new Date(field.value + 'Z'); if (!Number.isFinite(value.getTime())) invalid(field, 'Enter an absolute UTC date and time.');
  return value.toISOString();
}
function readNumber(id, minimum, maximum) {
  const field = el(id), value = Number(field.value);
  if (!field.value || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(field, 'Enter a whole number within the displayed limits.');
  return value;
}
function readList(id, resources = false, optional = false) {
  const field = el(id), values = field.value.split(/\r?\n/).filter(value => value !== '');
  if ((!optional && !values.length) || values.length > 20 || new Set(values).size !== values.length) invalid(field, 'Use up to 20 distinct exact values, one per line.');
  for (const value of values) if (resources ? encoder.encode(value).length > 512 || value !== value.trim() || /[*\u0000-\u001f\u007f]/.test(value)
    : !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid(field, 'Use an exact literal reference without wildcards or extra spaces.');
  return values;
}
function goalValue() {
  const value = Object.fromEntries(Object.entries(goalFields).map(([key, id]) => [key, readText(id,
    key === 'title' ? 160 : key === 'desiredOutcome' ? 2000 : key === 'nextStep' ? 1000 : 4096, ['title', 'desiredOutcome'].includes(key))]));
  for (const item of milestones) if (!item.title.trim() || encoder.encode(item.title).length > 160) throw new Error('FORM_INVALID');
  return { ...value, reviewAt: readDate('goal-review-at'), milestones: milestones.map(({ id, title, done }) => ({ id, title, done })), status: currentGoal()?.goal.status ?? 'active' };
}
function cardValue() {
  const lists = Object.fromEntries(Object.entries(listFields).map(([key, id]) => [key, readList(id, key === 'resources', key === 'requireDecision')]));
  if (!lists.requireDecision.every(action => lists.actions.includes(action))) invalid(el('require-decision'), 'Use only actions included in the allowed-action list.');
  const cost = readNumber('max-cost', Number(el('max-cost').min), 1e9), currency = cost ? el('card-currency').value : null;
  if (cost && !/^[A-Z]{3}$/.test(currency)) invalid(el('card-currency'), 'Use three capital currency letters.');
  const starts = readDate('not-before', true), ends = readDate('expires-at', true);
  if (starts >= ends) invalid(el('expires-at'), 'End the window after its start.');
  return { title: readText('card-title', 160, true), ...lists, maxTasks: readNumber('max-tasks', Number(el('max-tasks').min), 1e9),
    maxTokens: readNumber('max-tokens', Number(el('max-tokens').min), 1e9), maxCostMinor: cost, currency,
    notBefore: starts, expiresAt: ends, reviewEveryDays: readNumber('review-days', 1, 365),
    template: { title: readText('template-title', 160, true), instructions: readText('template-instructions', 4000, true), acceptanceCriteria: readText('template-acceptance', 2000, true) } };
}
function settleIntent() {
  if (!activeIntent || state.connection !== 'ready' || state.pending || state.error) return;
  const kind = activeIntent; activeIntent = null;
  if (kind === 'saveGoal') { goalDirty = false; const saved = state.goals.find(item => item.id === state.lastReceipt?.goalId) ?? currentGoal(); selectedId = saved?.id ?? null; editingNew = false; fillGoal(saved); }
  if (kind === 'saveCard') { cardDirty = false; fillCard(currentCard()); }
  if (['pause', 'reviewGoal'].includes(kind) && currentGoal()) { goalBase = { id: selectedId, version: currentGoal().version }; staleGoal = false; }
  if (kind === 'revoke' && currentCard()) { cardBase = { id: currentCard().id, version: currentCard().version, digest: currentCard().previewDigest }; staleCard = false; }
  notice = kind === 'confirm' ? 'Local consent recorded for the exact saved card. Connected execution remains unavailable.'
    : kind === 'revoke' ? 'Local consent revoked. No connected dispatch was enabled.'
    : kind === 'pause' ? currentGoal()?.goal.status === 'paused' ? 'Goal paused. Local authorization checks stop immediately.' : 'Goal resumed. Old permission consent is not restored.'
    : kind === 'reviewGoal' ? 'Private goal review recorded. Permission consent was not refreshed.' : kind === 'saveCard' ? 'Card draft saved. Review every saved constraint and the project-only proposal before confirming.' : 'Private goal saved.';
  render();
  if (kind === 'saveCard') { el('preview-heading').focus(); el('saved-preview').scrollIntoView?.({ block: 'start' }); }
}
async function runAction(kind, action) {
  const version = epoch; activeIntent = kind; notice = '';
  try { await action(); } catch (error) { if (version === epoch) { activeIntent = null; report(messages[error?.code] ?? 'Check the form and try again.'); } return; }
  if (version === epoch && state.error && !state.pending) activeIntent = null;
  if (version === epoch) { settleIntent(); render(); }
}
client.subscribe(next => {
  if (opened && ['denied', 'unavailable'].includes(next.connection) && !next.pending) { closeWorkspace(messages[next.error] ?? 'Open a fresh workspace to continue.'); return; }
  state = next; render();
});
el('open-workspace').addEventListener('click', async () => {
  if (opening || document.visibilityState === 'hidden') return;
  closeWorkspace(); const version = epoch; opening = true; render();
  try { if (!await loadMode() || version !== epoch || !['demo', 'account'].includes(mode)) return; opened = true; await client.open(mode); }
  finally { if (version === epoch) { opening = false; render(); } }
});
el('close-workspace').addEventListener('click', () => closeWorkspace('This tab is clear. Open explicitly to load saved goals again.'));
el('refresh-workspace').addEventListener('click', async () => {
  if ((goalDirty || cardDirty) && !activeIntent && !['CONFLICT', 'NOT_FOUND'].includes(state.error)) return report('Save or discard edits before refreshing.');
  const version = epoch; notice = ''; try { await client.refresh(); } catch (error) { if (version === epoch) report(messages[error.code] ?? 'The workspace could not refresh.'); }
  if (version === epoch) { settleIntent(); render(); }
});
el('retry-action').addEventListener('click', () => runAction(activeIntent, () => client.retry()));
for (const id of ['new-goal', 'mobile-new-goal']) el(id).addEventListener('click', newGoal);
el('goal-select').addEventListener('change', event => selectGoal(event.target.value));
el('discard-edits').addEventListener('click', () => { goalDirty = false; cardDirty = false; fillGoal(currentGoal()); fillCard(currentCard()); notice = ''; client.invalidateReview(); });
for (const id of [...Object.values(goalFields), 'goal-review-at']) el(id).addEventListener('input', () => { el(id).setCustomValidity(''); markGoalDirty(); });
for (const id of [...Object.values(cardFields), ...Object.values(listFields), 'not-before', 'expires-at', 'template-title', 'template-instructions', 'template-acceptance']) el(id).addEventListener('input', () => { el(id).setCustomValidity(''); markCardDirty(); });
el('add-milestone').addEventListener('click', () => { if (milestones.length >= 20) return; milestones.push({ id: null, title: '', done: false, localKey: crypto.randomUUID() }); markGoalDirty(); renderMilestones(); el('milestone-list').lastElementChild?.children[1].focus(); });
el('goal-form').addEventListener('submit', event => {
  event.preventDefault(); if (el('save-goal').disabled || !el('goal-form').reportValidity()) return;
  try { const saved = currentGoal(), goal = goalValue(); runAction('saveGoal', () => client.write('saveGoal', { goalId: saved?.id ?? null, expectedVersion: saved?.version ?? 0, goal })); }
  catch { report('Check the private goal fields and milestone titles.'); }
});
el('card-form').addEventListener('submit', event => {
  event.preventDefault(); if (el('save-card').disabled || !el('card-form').reportValidity()) return;
  try { const saved = currentCard(), card = cardValue(); runAction('saveCard', () => client.write('saveCard', { goalId: selectedId, cardId: saved?.id ?? null, expectedVersion: saved?.version ?? 0, card })); }
  catch { report('Check the exact card scope, limits, time window and project-only proposal.'); }
});
el('pause-goal').addEventListener('click', () => { const saved = currentGoal(); if (!saved || el('pause-goal').disabled) return;
  runAction('pause', () => client.write('saveGoal', { goalId: saved.id, expectedVersion: saved.version, goal: { ...saved.goal, status: saved.goal.status === 'paused' ? 'active' : 'paused' } })); });
el('review-goal').addEventListener('click', () => { const saved = currentGoal(); if (saved && !el('review-goal').disabled) runAction('reviewGoal', () => client.write('reviewGoal', { goalId: saved.id, expectedVersion: saved.version })); });
el('confirm-review').addEventListener('change', () => {
  if (!el('confirm-review').checked) return client.invalidateReview();
  if (goalDirty || cardDirty || el('confirm-review').disabled) { el('confirm-review').checked = false; return; }
  try { client.markPreviewReviewed(currentCard().id); } catch { report('Review the current saved card before confirming.'); }
});
el('confirm-card').addEventListener('click', () => { if (!el('confirm-card').disabled) runAction('confirm', () => client.confirm(currentCard().id)); });
el('revoke-card').addEventListener('click', () => { const saved = currentCard(); if (saved && !el('revoke-card').disabled) runAction('revoke', () => client.write('revokeCard', { cardId: saved.id, expectedVersion: saved.version })); });
function clearPage() { mode = null; closeWorkspace('This tab is clear. Open again to check current access.'); }
document.addEventListener('visibilitychange', () => { clearPage(); if (document.visibilityState !== 'hidden') loadMode(); });
window.addEventListener('pagehide', clearPage);
window.addEventListener('pageshow', event => { if (event.persisted) { clearPage(); loadMode(); } });
loadMode();
