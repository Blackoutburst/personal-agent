// GitHub connector (#45). Each owner pastes their own fine-grained personal access token in Me › Connectors; there is
// no shared or configured token. The token is stored per owner, encrypted (AES-256-GCM, bound to that owner's id) with a
// server key kept outside the database, so database backups never hold a usable token. It is never returned to a client,
// never given to the model, and never written to chat or the Board.
//
// The companion gets a few tools: list repos, read one repo, list and read pull requests (with check status), and create
// a repo, private unless the owner explicitly asked for public. This client has no way to delete, archive, transfer,
// change visibility or push: only the GET and POST requests listed in #request are possible, whatever the token allows.
import { createHash } from 'node:crypto';
import { SecretBox } from './secrets.mjs';

const API = 'https://api.github.com';
const TOKEN = /^github_pat_[A-Za-z0-9_]{20,255}$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const REQUEST = /^[A-Za-z0-9._-]{1,80}$/;
const TEMPLATE = /^[A-Za-z0-9._+-]{1,60}$/;
const WARN_DAYS = 7, DAY = 86400000;

export class GitHubError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'GitHubError'; this.code = code; this.status = status; }
}

// "2026-12-03 14:00:00 UTC" or "2026-12-03 14:00:00 +0100" (GitHub's token expiration header) as epoch ms, or null.
export function parseExpiry(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/);
  if (!match) return null;
  const zone = match[3] === 'UTC' ? 'Z' : `${match[3].slice(0, 3)}:${match[3].slice(3)}`;
  const time = Date.parse(`${match[1]}T${match[2]}${zone}`);
  return Number.isFinite(time) ? time : null;
}

export class GitHub {
  #db; #box; #fetch; #now;
  constructor({ store, keyFile, fetchImpl = fetch, now = Date.now }) {
    this.#db = store.db; this.#box = new SecretBox({ keyFile }); this.#fetch = fetchImpl; this.#now = now;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS connector_github(companion_id TEXT PRIMARY KEY, token_enc TEXT NOT NULL,
      login TEXT NOT NULL, name TEXT, expires_at INTEGER, repos INTEGER NOT NULL, problem TEXT, linked_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_github_requests(companion_id TEXT NOT NULL, request_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(companion_id, request_id))`);
  }

  #seal(companionId, token) {
    try { return this.#box.seal('github:' + companionId, token); } catch { throw new GitHubError('GITHUB_UNCONFIGURED', 503); }
  }
  #open(companionId, sealed) {
    try { return this.#box.open('github:' + companionId, sealed); }
    catch (error) { throw new GitHubError(error.message === 'SECRETS_UNCONFIGURED' ? 'GITHUB_UNCONFIGURED' : 'GITHUB_UNAVAILABLE', 503); }
  }

  // Only these requests exist. Anything else (DELETE, PATCH, PUT, other paths) is impossible from here.
  async #request(token, method, path, body) {
    const allowed = method === 'GET' ? /^\/(user|user\/repos|repos\/[^?]+)(\?.*)?$/.test(path) : method === 'POST' && path === '/user/repos';
    if (!allowed) throw new GitHubError('GITHUB_FORBIDDEN_OPERATION', 400);
    let response;
    try {
      response = await this.#fetch(API + path, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'blackoutburst-companion', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new GitHubError('GITHUB_UNREACHABLE', 502); }
    const data = await response.json().catch(() => null);
    if (response.ok) return { data, headers: response.headers };
    if (response.status === 401) throw new GitHubError('GITHUB_TOKEN_REJECTED', 401);
    if (response.status === 404) throw new GitHubError('GITHUB_NOT_FOUND', 404);
    if (response.status === 403) throw new GitHubError('GITHUB_FORBIDDEN', 403);
    if (response.status === 422) throw new GitHubError('GITHUB_REJECTED', 422);
    throw new GitHubError('GITHUB_UNAVAILABLE', 502);
  }

  #row(companionId) { return this.#db.prepare('SELECT * FROM connector_github WHERE companion_id=?').get(companionId) ?? null; }
  linked(companionId) { return Boolean(this.#row(companionId)); }

  // What the owner's Connectors page shows. Never includes the token.
  status(companionId) {
    const row = this.#row(companionId);
    if (!row) return { linked: false };
    const now = this.#now(), expired = row.expires_at !== null && row.expires_at <= now;
    return { linked: true, login: row.login, name: row.name, repos: row.repos,
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      expiring: !expired && row.expires_at !== null && row.expires_at - now <= WARN_DAYS * DAY,
      problem: expired ? 'EXPIRED' : row.problem };
  }

  // Checks the token with GitHub, then stores it for this owner only. Replaces the owner's previous token.
  async link(companionId, token) {
    if (typeof token !== 'string' || !TOKEN.test(token.trim())) throw new GitHubError('INVALID_TOKEN');
    token = token.trim();
    let user;
    try { user = await this.#request(token, 'GET', '/user'); }
    catch (error) { throw error.code === 'GITHUB_TOKEN_REJECTED' ? new GitHubError('INVALID_TOKEN') : error; }
    if (typeof user.data?.login !== 'string') throw new GitHubError('INVALID_TOKEN');
    const repos = await this.#request(token, 'GET', '/user/repos?per_page=100&sort=updated').catch(() => ({ data: [] }));
    const now = this.#now();
    this.#db.prepare(`INSERT INTO connector_github(companion_id,token_enc,login,name,expires_at,repos,problem,linked_at,updated_at)
      VALUES(?,?,?,?,?,?,NULL,?,?) ON CONFLICT(companion_id) DO UPDATE SET token_enc=excluded.token_enc, login=excluded.login,
      name=excluded.name, expires_at=excluded.expires_at, repos=excluded.repos, problem=NULL, updated_at=excluded.updated_at`)
      .run(companionId, this.#seal(companionId, token), user.data.login.slice(0, 64), typeof user.data.name === 'string' ? user.data.name.slice(0, 100) : null,
        parseExpiry(user.headers.get('github-authentication-token-expiration')), Array.isArray(repos.data) ? repos.data.length : 0, now, now);
    return this.status(companionId);
  }

  unlink(companionId) {
    this.#db.prepare('DELETE FROM connector_github WHERE companion_id=?').run(companionId);
    this.#db.prepare('DELETE FROM connector_github_requests WHERE companion_id=?').run(companionId);
    return { linked: false };
  }

  async #call(companionId, method, path, body) {
    const row = this.#row(companionId);
    if (!row) throw new GitHubError('GITHUB_NOT_CONNECTED', 409);
    if (row.expires_at !== null && row.expires_at <= this.#now()) throw new GitHubError('GITHUB_TOKEN_EXPIRED', 409);
    try { return (await this.#request(this.#open(companionId, row.token_enc), method, path, body)).data; }
    catch (error) {
      if (error.code === 'GITHUB_TOKEN_REJECTED') this.#db.prepare("UPDATE connector_github SET problem='REJECTED', updated_at=? WHERE companion_id=?").run(this.#now(), companionId);
      throw error;
    }
  }

  // ---- Companion tools ----
  async listRepos(companionId) {
    const data = await this.#call(companionId, 'GET', '/user/repos?per_page=100&sort=updated');
    return { repos: (Array.isArray(data) ? data : []).map(repo => ({ fullName: repo.full_name, private: repo.private, description: repo.description ?? null,
      url: repo.html_url, defaultBranch: repo.default_branch, updatedAt: repo.updated_at, archived: Boolean(repo.archived) })) };
  }
  async repo(companionId, input) {
    const repo = repoName(input?.repo);
    const data = await this.#call(companionId, 'GET', `/repos/${repo}`);
    const commits = await this.#call(companionId, 'GET', `/repos/${repo}/commits?per_page=5`).catch(() => []);
    return { fullName: data.full_name, private: data.private, description: data.description ?? null, url: data.html_url,
      defaultBranch: data.default_branch, openIssuesAndPulls: data.open_issues_count, pushedAt: data.pushed_at,
      recentCommits: (Array.isArray(commits) ? commits : []).map(commit => ({ sha: String(commit.sha).slice(0, 12),
        message: String(commit.commit?.message ?? '').split('\n')[0].slice(0, 200), author: commit.commit?.author?.name ?? null,
        date: commit.commit?.author?.date ?? null })) };
  }
  async pulls(companionId, input) {
    const repo = repoName(input?.repo), state = input?.state ?? 'all';
    if (!['open', 'closed', 'all'].includes(state)) throw new GitHubError('INVALID_REQUEST');
    const query = typeof input?.query === 'string' ? input.query.trim().toLowerCase().slice(0, 100) : '';
    const data = await this.#call(companionId, 'GET', `/repos/${repo}/pulls?state=${state}&per_page=50&sort=updated&direction=desc`);
    return { pulls: (Array.isArray(data) ? data : []).filter(pull => !query || `${pull.title} ${pull.head?.ref} #${pull.number}`.toLowerCase().includes(query))
      .slice(0, 30).map(pull => ({ number: pull.number, title: pull.title, state: pull.state, merged: Boolean(pull.merged_at), draft: Boolean(pull.draft),
        branch: pull.head?.ref ?? null, url: pull.html_url, updatedAt: pull.updated_at })) };
  }
  async pull(companionId, input) {
    const repo = repoName(input?.repo), number = input?.number;
    if (!Number.isSafeInteger(number) || number < 1) throw new GitHubError('INVALID_REQUEST');
    const pull = await this.#call(companionId, 'GET', `/repos/${repo}/pulls/${number}`);
    let checks = null;
    try {
      const runs = await this.#call(companionId, 'GET', `/repos/${repo}/commits/${pull.head.sha}/check-runs?per_page=100`);
      const counts = {};
      for (const run of runs.check_runs ?? []) { const key = run.status === 'completed' ? run.conclusion ?? 'unknown' : run.status; counts[key] = (counts[key] ?? 0) + 1; }
      checks = counts;
    } catch { /* The token may not include Checks; report checks as unknown. */ }
    return { number: pull.number, title: pull.title, state: pull.state, merged: Boolean(pull.merged), mergedAt: pull.merged_at ?? null,
      draft: Boolean(pull.draft), mergeableState: pull.mergeable_state ?? null, branch: pull.head?.ref ?? null, base: pull.base?.ref ?? null,
      commits: pull.commits, changedFiles: pull.changed_files, url: pull.html_url, checks };
  }
  // Creates a repo under the owner's account. Private unless private is explicitly false. Exact retries replay the result.
  async createRepo(companionId, input) {
    const keys = input && typeof input === 'object' ? Object.keys(input) : [];
    if (keys.some(key => !['requestId', 'name', 'description', 'private', 'autoInit', 'gitignoreTemplate', 'licenseTemplate'].includes(key))) throw new GitHubError('INVALID_REQUEST');
    const { requestId, name, description = null, autoInit = false, gitignoreTemplate = null, licenseTemplate = null } = input;
    const visibility = input.private;
    if (typeof requestId !== 'string' || !REQUEST.test(requestId) || typeof name !== 'string' || !NAME.test(name) || name.startsWith('.')
      || typeof visibility !== 'boolean' || typeof autoInit !== 'boolean'
      || (description !== null && (typeof description !== 'string' || description.length > 350 || /[\u0000-\u001f\u007f]/.test(description)))
      || (gitignoreTemplate !== null && (typeof gitignoreTemplate !== 'string' || !TEMPLATE.test(gitignoreTemplate)))
      || (licenseTemplate !== null && (typeof licenseTemplate !== 'string' || !TEMPLATE.test(licenseTemplate)))) throw new GitHubError('INVALID_REQUEST');
    const body = { name, private: visibility, auto_init: autoInit || Boolean(gitignoreTemplate || licenseTemplate),
      ...(description ? { description } : {}), ...(gitignoreTemplate ? { gitignore_template: gitignoreTemplate } : {}),
      ...(licenseTemplate ? { license_template: licenseTemplate } : {}) };
    const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const prior = this.#db.prepare('SELECT * FROM connector_github_requests WHERE companion_id=? AND request_id=?').get(companionId, requestId);
    if (prior) { if (prior.fingerprint !== fingerprint) throw new GitHubError('CONFLICT', 409); return { ...JSON.parse(prior.result_json), replayed: true }; }
    const data = await this.#call(companionId, 'POST', '/user/repos', body);
    const result = { fullName: data.full_name, private: data.private, url: data.html_url, defaultBranch: data.default_branch ?? null };
    this.#db.prepare('INSERT INTO connector_github_requests VALUES(?,?,?,?,?)').run(companionId, requestId, fingerprint, JSON.stringify(result), this.#now());
    return result;
  }

  // A one-time heads-up before the token expires (queued by the scheduler tick as a "connector" wake).
  expiryNotice(companionId) {
    const row = this.#row(companionId), now = this.#now();
    if (!row || row.expires_at === null || row.expires_at <= now || row.expires_at - now > WARN_DAYS * DAY) return null;
    const days = Math.max(1, Math.ceil((row.expires_at - now) / DAY));
    return { requestId: 'gh-expiry-' + createHash('sha256').update(`${companionId}:${row.linked_at}:${row.expires_at}`).digest('hex').slice(0, 24),
      prompt: `App notice, not from the owner: the GitHub token your owner connected (account ${row.login}) expires in about ${days} day${days === 1 ? '' : 's'}. `
        + 'Let them know briefly that they can create a new fine-grained token on GitHub and paste it in Me › Connectors to keep GitHub working. Never ask them to send the token in chat.' };
  }
}

function repoName(value) {
  if (typeof value !== 'string' || !REPO.test(value) || value.includes('..')) throw new GitHubError('INVALID_REQUEST');
  return value;
}

const OPERATIONS = { listRepos: 'listRepos', repo: 'repo', pulls: 'pulls', pull: 'pull', createRepo: 'createRepo' };
// The companion's GitHub tools arrive on the scheduler tool endpoint as { action: 'github', input: { op, ... } }.
export async function githubOperation(github, companionId, input) {
  const fail = (status, code, message) => ({ status, body: { error: { code, message } } });
  if (!github) return fail(503, 'GITHUB_UNAVAILABLE', 'GitHub is unavailable right now.');
  try {
    const { op, ...rest } = input && typeof input === 'object' ? input : {};
    if (!Object.hasOwn(OPERATIONS, op)) throw new GitHubError('INVALID_REQUEST');
    return { status: 200, body: await github[OPERATIONS[op]](companionId, rest) };
  } catch (error) {
    const code = error instanceof GitHubError ? error.code : 'GITHUB_UNAVAILABLE';
    const message = { GITHUB_NOT_CONNECTED: 'GitHub is not connected. The owner can connect it in Me › Connectors.',
      GITHUB_TOKEN_EXPIRED: 'The owner\'s GitHub token has expired. They can paste a new one in Me › Connectors.',
      GITHUB_TOKEN_REJECTED: 'GitHub no longer accepts the owner\'s token. They can paste a new one in Me › Connectors.',
      GITHUB_NOT_FOUND: 'Not found, or the token does not give access to it.',
      GITHUB_FORBIDDEN: 'The token does not allow this. The owner can add that permission to the token on GitHub.',
      GITHUB_REJECTED: 'GitHub rejected this (for example, a repository with that name already exists).',
      CONFLICT: 'This request key was already used for different details.',
      INVALID_REQUEST: 'Invalid GitHub request.' }[code] ?? 'GitHub is unavailable right now. Try again later.';
    return fail(error instanceof GitHubError ? error.status : 503, code, message);
  }
}
