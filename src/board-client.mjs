// The companion app's own Board connection (docs/BOARD-COMPANION.md). It speaks MCP over the owner's paired
// stdio bridge (the same connect.py the provider uses), with its own Board session, for three app jobs:
// watching the owner's "need you" requests, keeping the companion's Board profile in step with the app,
// and uploading chat files to a Board thread. The credential stays inside the bridge; this never reads it.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const CALL_TIMEOUT_MS = 30_000;

export class BoardClientError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}

export class BoardClient {
  #board; #spawn; #child = null; #pending = new Map(); #nextId = 1; #buffer = ''; #ready = null;
  #sessionId;
  // board: the owner's normalized Board policy { configDir, pythonPath, connectPath }.
  // sessionId: pass a stable id so the Board keeps this session's inbox position across restarts.
  constructor({ board, label = 'companion app', sessionId = null, spawnImpl = spawn }) {
    this.#board = board; this.#spawn = spawnImpl;
    this.#sessionId = typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(sessionId) ? sessionId
      : 'companion-app-' + randomBytes(6).toString('hex');
    this.label = label;
  }

  #start() {
    if (this.#ready) return this.#ready;
    const child = this.#spawn(this.#board.pythonPath, [this.#board.connectPath, '--stdio', '--client', 'other', '--config-dir', this.#board.configDir],
      { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '' } });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#receive(chunk));
    const fail = () => this.#reset(new BoardClientError('BOARD_UNAVAILABLE', 'The Board connection closed.'));
    child.on('exit', fail); child.on('error', fail);
    child.stdin.on('error', () => {});
    this.#ready = this.#request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'companion-app', version: '1' } })
      .then(async () => {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        await this.#tool('register_agent', { session_id: this.#sessionId, label: this.label, skills: [] });
      });
    this.#ready.catch(() => {});
    return this.#ready;
  }

  #receive(chunk) {
    this.#buffer += chunk;
    let end;
    while ((end = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const waiting = this.#pending.get(message?.id);
      if (!waiting) continue;
      this.#pending.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new BoardClientError('BOARD_REFUSED', String(message.error.message ?? 'The Board refused the request.').slice(0, 300)));
      else waiting.resolve(message.result);
    }
  }

  #reset(error) {
    for (const waiting of this.#pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.#pending.clear(); this.#ready = null; this.#buffer = '';
    const child = this.#child; this.#child = null;
    try { child?.kill(); } catch { /* already gone */ }
  }

  #request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new BoardClientError('BOARD_TIMEOUT', 'The Board did not answer in time.')); }, CALL_TIMEOUT_MS);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async #tool(name, args) {
    const result = await this.#request('tools/call', { name, arguments: { session_id: this.#sessionId, ...args } });
    if (result?.isError) {
      const text = result.content?.find(item => item.type === 'text')?.text ?? 'The Board refused the request.';
      throw new BoardClientError('BOARD_REFUSED', String(text).slice(0, 300));
    }
    const structured = result?.structuredContent;
    if (structured && typeof structured === 'object') {
      // FastMCP wraps non-object results (lists) as {"result": ...}.
      const keys = Object.keys(structured);
      return keys.length === 1 && keys[0] === 'result' ? structured.result : structured;
    }
    const text = result?.content?.find(item => item.type === 'text')?.text;
    try { return text ? JSON.parse(text) : null; } catch { return text ?? null; }
  }

  async call(name, args = {}) {
    await this.#start();
    try { return await this.#tool(name, args); } catch (error) {
      // An owner edit to the Board profile bumps its version; the Board then refuses every call with
      // "Agent profile changed; explicitly register again". Re-register once and retry instead of staying refused.
      if (name === 'register_agent' || !(error instanceof BoardClientError) || !/register again/i.test(error.message)) throw error;
      await this.#tool('register_agent', { label: this.label, skills: [] });
      return this.#tool(name, args);
    }
  }

  close() { this.#reset(new BoardClientError('BOARD_CLOSED', 'The Board connection was closed.')); }
}
