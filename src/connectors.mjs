// Connectors (#43): what the companion is linked to, listed in Me › Connectors. Each connector reports its state for one
// owner and may be paused or removed by that owner. New connectors (calendar, GitHub…) add an entry to CONNECTORS.
//
// Discord keeps its own link/unlink flow (src/discord.mjs). The Agent Board link itself is set up by the server admin
// (owners.json board profile); the owner can switch it off and on here, which removes the Board tools from every turn
// and stops Board wakes, without touching the admin setup.

export class ConnectorError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'ConnectorError'; this.code = code; this.status = status; }
}

export class Connectors {
  #db; #now; #discord; #boardConfigured;
  // discord: () => the DiscordBridge or null (created after the conversations it serves).
  constructor({ store, now = Date.now, discord = () => null, boardConfigured = () => false }) {
    this.#db = store.db; this.#now = now; this.#discord = discord; this.#boardConfigured = boardConfigured;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS connector_settings(companion_id TEXT NOT NULL, connector TEXT NOT NULL,
      enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(companion_id, connector))`);
  }

  enabled(companionId, connector) {
    return (this.#db.prepare('SELECT enabled FROM connector_settings WHERE companion_id=? AND connector=?').get(companionId, connector)?.enabled ?? 1) === 1;
  }

  boardOn(companionId) { return this.#boardConfigured(companionId) && this.enabled(companionId, 'board'); }

  list(companionId) {
    const items = [];
    const bridge = this.#discord();
    if (bridge) {
      const status = bridge.status(companionId);
      items.push({ id: 'discord', name: 'Discord', purpose: 'Chat with me in a Discord DM; reminders arrive there too.',
        state: !status.linked ? 'not_connected' : status.problem ? 'error' : status.user ? 'connected' : 'pending',
        detail: !status.linked ? null : status.user ? `DM with ${status.user.name} through ${status.bot.name}`
          : status.problem ? `${status.bot.name} needs a new token` : `${status.bot.name} is waiting for your pairing message`,
        actions: status.linked ? ['disconnect'] : ['connect'] });
    }
    const configured = this.#boardConfigured(companionId), on = configured && this.enabled(companionId, 'board');
    items.push({ id: 'board', name: 'Agent Board', purpose: 'Create tickets, follow project work and answer requests on the Board.',
      state: !configured ? 'unavailable' : on ? 'connected' : 'paused',
      detail: !configured ? 'Not set up for you on this server yet. The server admin links it.' : on ? 'board.blackoutburst.com' : 'Switched off: the Board is untouched, I just stop using it.',
      actions: !configured ? [] : on ? ['disconnect'] : ['connect'] });
    return { connectors: items };
  }

  // Only connectors whose link is an on/off switch here; Discord uses its own link and unlink actions.
  set(companionId, connector, enabled) {
    if (connector !== 'board' || typeof enabled !== 'boolean') throw new ConnectorError('INVALID_REQUEST');
    if (!this.#boardConfigured(companionId)) throw new ConnectorError('CONNECTOR_UNAVAILABLE', 409);
    this.#db.prepare(`INSERT INTO connector_settings(companion_id, connector, enabled, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(companion_id, connector) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at`)
      .run(companionId, connector, enabled ? 1 : 0, this.#now());
    return this.list(companionId);
  }

  // A turn's tool filter: drops the tools of switched-off connectors.
  toolFilter(companionId) {
    if (this.boardOn(companionId)) return null;
    return name => !name.startsWith('mcp__board__') && name !== 'mcp__files__attach_to_board';
  }
}
