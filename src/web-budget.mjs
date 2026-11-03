// On-demand web search in chat (#42): a per-owner daily budget of native web tool uses (WebSearch/WebFetch,
// or Codex web search). When it is spent, owner turns run without web tools until the next UTC day.
export const DAILY_WEB_USES = 60;

export class WebBudget {
  #db; #now; #daily;
  constructor({ store, now = Date.now, daily = DAILY_WEB_USES }) {
    this.#db = store.db; this.#now = now; this.#daily = daily;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS web_usage(companion_id TEXT NOT NULL, day TEXT NOT NULL, uses INTEGER NOT NULL,
      PRIMARY KEY(companion_id, day))`);
  }
  #day() { return new Date(this.#now()).toISOString().slice(0, 10); }
  used(companionId) {
    return this.#db.prepare('SELECT uses FROM web_usage WHERE companion_id=? AND day=?').get(companionId, this.#day())?.uses ?? 0;
  }
  available(companionId) { return this.used(companionId) < this.#daily; }
  record(companionId) {
    const day = this.#day();
    this.#db.prepare(`INSERT INTO web_usage(companion_id, day, uses) VALUES(?,?,1)
      ON CONFLICT(companion_id, day) DO UPDATE SET uses=uses+1`).run(companionId, day);
    this.#db.prepare('DELETE FROM web_usage WHERE day < ?').run(new Date(this.#now() - 30 * 86_400_000).toISOString().slice(0, 10));
  }
}
