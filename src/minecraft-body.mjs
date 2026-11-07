// The companion's body in Minecraft (#68, docs/MINECRAFT.md): what it perceives, which events it notices and the
// closed set of skills it can run. It drives one Mineflayer bot object and never decides anything itself: the
// companion's turns (src/minecraft.mjs) choose the actions. Everything here works on an injected bot, so tests use
// a fake one and the worker (src/minecraft-worker.mjs) a real Mineflayer bot.

export const ACTION_TYPES = Object.freeze(['say', 'goto', 'follow', 'wander', 'look_at', 'collect', 'pick_up', 'eat', 'stop']);
// Per-action time limits (ms). follow uses its own seconds, bounded by FOLLOW_MAX_S.
export const ACTION_TIMEOUTS = Object.freeze({ say: 2000, goto: 60_000, wander: 45_000, look_at: 3000, collect: 120_000, pick_up: 30_000, eat: 8000, stop: 1000 });
export const LIMITS = Object.freeze({ gotoDistance: 256, wanderMin: 8, wanderMax: 64, followMax: 8, followMaxSeconds: 120,
  collectMax: 16, collectRange: 32, pickupRange: 16, sayChars: 240, players: 8, mobs: 8, blocks: 8, inventory: 12, scanRange: 16, mobRange: 24 });
// Blocks worth noticing (a "found" event once per position) and the only blocks collect may break: natural ones, so a
// companion never takes apart someone's build on a shared server.
const NOTABLE = /^(?:deepslate_)?(?:diamond|emerald|gold|lapis|redstone)_ore$|^(?:ancient_debris|spawner|chest|trial_spawner|vault|nether_portal|end_portal_frame|budding_amethyst|bee_nest|suspicious_sand|suspicious_gravel)$/;
const COLLECTABLE = /^(?:[a-z_]+_log|[a-z_]+_stem|(?:deepslate_|nether_)?[a-z_]+_ore|stone|deepslate|cobbled_deepslate|dirt|coarse_dirt|grass_block|podzol|mud|sand|red_sand|gravel|clay|snow_block|ice|andesite|diorite|granite|tuff|calcite|netherrack|basalt|blackstone|soul_sand|soul_soil|end_stone|sugar_cane|pumpkin|melon|kelp|bamboo|cactus|short_grass|tall_grass|fern|dandelion|poppy|[a-z_]+_mushroom|sweet_berry_bush|wheat|carrots|potatoes|beetroots|[a-z_]+_leaves|amethyst_cluster|glowstone|obsidian)$/;
const HOSTILE = new Set(['hostile']);

const round = value => Math.round(value * 10) / 10;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const clean = (value, max) => String(value ?? '').replace(/[\x00-\x1f\x7f§]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Shape check of one action, before the world is consulted. Returns { action } or { error }.
export function validateAction(input) {
  if (!object(input) || typeof input.type !== 'string' || !ACTION_TYPES.includes(input.type)) return { error: 'unknown action type' };
  const keys = Object.keys(input), allow = (...names) => keys.every(key => key === 'type' || names.includes(key));
  const name = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(value);
  const coordinate = value => finite(value) && Math.abs(value) <= 30_000_000;
  switch (input.type) {
    case 'say': {
      const text = typeof input.text === 'string' ? clean(input.text, LIMITS.sayChars) : '';
      return allow('text') && text ? { action: { type: 'say', text } } : { error: 'say needs text' };
    }
    case 'goto':
      if (allow('player') && name(input.player)) return { action: { type: 'goto', player: input.player } };
      if (allow('x', 'y', 'z') && coordinate(input.x) && coordinate(input.y) && coordinate(input.z)) return { action: { type: 'goto', x: input.x, y: input.y, z: input.z } };
      return { error: 'goto needs a player or x, y, z' };
    case 'follow': {
      const distance = input.distance ?? 3, seconds = input.seconds ?? 60;
      return allow('player', 'distance', 'seconds') && name(input.player) && Number.isInteger(distance) && distance >= 1 && distance <= LIMITS.followMax
        && Number.isInteger(seconds) && seconds >= 5 && seconds <= LIMITS.followMaxSeconds
        ? { action: { type: 'follow', player: input.player, distance, seconds } } : { error: `follow needs a player, distance 1-${LIMITS.followMax}, seconds 5-${LIMITS.followMaxSeconds}` };
    }
    case 'wander': {
      const value = input.distance ?? 24;
      return allow('distance') && Number.isInteger(value) && value >= LIMITS.wanderMin && value <= LIMITS.wanderMax
        ? { action: { type: 'wander', distance: value } } : { error: `wander distance must be ${LIMITS.wanderMin}-${LIMITS.wanderMax}` };
    }
    case 'look_at':
      if (allow('player') && name(input.player)) return { action: { type: 'look_at', player: input.player } };
      if (allow('x', 'y', 'z') && coordinate(input.x) && coordinate(input.y) && coordinate(input.z)) return { action: { type: 'look_at', x: input.x, y: input.y, z: input.z } };
      return { error: 'look_at needs a player or x, y, z' };
    case 'collect': {
      const count = input.count ?? 1;
      if (!allow('block', 'count') || typeof input.block !== 'string' || !/^[a-z_]{1,40}$/.test(input.block)) return { error: 'collect needs a block name' };
      if (!COLLECTABLE.test(input.block)) return { error: `${input.block} is not a natural block you may collect` };
      return Number.isInteger(count) && count >= 1 && count <= LIMITS.collectMax ? { action: { type: 'collect', block: input.block, count } } : { error: `collect count must be 1-${LIMITS.collectMax}` };
    }
    case 'pick_up': case 'eat': case 'stop':
      return allow() ? { action: { type: input.type } } : { error: `${input.type} takes no arguments` };
  }
  return { error: 'unknown action type' };
}

export function timeOfDay(ticks) {
  const t = ((Number(ticks) % 24000) + 24000) % 24000;
  return t < 12000 ? 'day' : t < 13800 ? 'dusk' : t < 22200 ? 'night' : 'dawn';
}

export class BotBody {
  #bot; #pathfinder; #emit; #companions; #now; #scanMs; #scanTimer = null; #seen = new Set(); #current = null; #lastHealth = null;
  #night = null; #spawnedAt = 0; #players = '';

  // bot: a Mineflayer bot (or a fake). pathfinder: the mineflayer-pathfinder module ({ goals, Movements }) once loaded, or
  // null (movement skills then fail cleanly). onEvent(event): what the body noticed. companions: other companions' names.
  constructor({ bot, pathfinder = null, onEvent = () => {}, companions = [], now = Date.now, scanMs = 5000 }) {
    this.#bot = bot; this.#pathfinder = pathfinder; this.#emit = onEvent; this.#companions = new Set(companions.map(name => name.toLowerCase()));
    this.#now = now; this.#scanMs = scanMs;
  }

  get username() { return this.#bot.username; }

  // Never lets a handler error escape into Mineflayer's emitter.
  #on(name, handler) {
    this.#bot.on(name, (...args) => { try { handler(...args); } catch { /* one bad packet must not stop the body */ } });
  }
  #event(event) { try { this.#emit({ at: this.#now(), ...event }); } catch { /* the agent isolates itself */ } }

  attach() {
    const bot = this.#bot;
    if (this.#pathfinder && typeof bot.loadPlugin === 'function' && !bot.pathfinder) bot.loadPlugin(this.#pathfinder.pathfinder);
    this.#on('spawn', () => {
      if (this.#spawnedAt) return;
      this.#spawnedAt = this.#now();
      if (this.#pathfinder && bot.pathfinder) {
        // Walk only: no digging through blocks and no placing blocks on someone else's land.
        const movements = new this.#pathfinder.Movements(bot);
        movements.canDig = false; movements.scafoldingBlocks = []; movements.allow1by1towers = false;
        bot.pathfinder.setMovements(movements);
      }
      this.#event({ type: 'spawn' });
      this.#playersChanged();
      this.#scanTimer = setInterval(() => { try { this.#scan(); } catch { /* next scan */ } }, this.#scanMs);
      this.#scanTimer.unref?.();
    });
    this.#on('chat', (username, message) => {
      // The server's echo of our own line: proof it was said (the E2E harness checks it); the agent ignores it.
      if (username && username === bot.username) { this.#event({ type: 'echo', text: clean(message, 256) }); return; }
      if (!username) return;
      this.#event({ type: 'chat', from: clean(username, 16), text: clean(message, 256) });
    });
    this.#on('whisper', (username, message) => {
      if (!username || username === bot.username) return;
      this.#event({ type: 'chat', from: clean(username, 16), text: clean(message, 256), whisper: true });
    });
    // Mineflayer lists everyone already online right after login; only later changes are joins and leaves.
    this.#on('playerJoined', player => {
      if (!player?.username || player.username === bot.username) return;
      if (this.#spawnedAt && this.#now() - this.#spawnedAt > 3000) this.#event({ type: 'join', name: clean(player.username, 16) });
      this.#playersChanged();
    });
    this.#on('playerLeft', player => {
      if (!player?.username || player.username === bot.username) return;
      this.#event({ type: 'leave', name: clean(player.username, 16) });
      this.#playersChanged();
    });
    this.#on('health', () => {
      const health = bot.health;
      if (finite(health) && finite(this.#lastHealth) && health < this.#lastHealth) {
        this.#event({ type: 'hurt', amount: round(this.#lastHealth - health), health: round(health) });
      }
      this.#lastHealth = health;
    });
    this.#on('death', () => { this.#abort('died'); this.#lastHealth = null; this.#event({ type: 'death' }); });
    this.#on('time', () => {
      const night = ['night', 'dusk'].includes(timeOfDay(bot.time?.timeOfDay));
      if (this.#night === false && night) this.#event({ type: 'nightfall' });
      this.#night = night;
    });
  }

  detach() { clearInterval(this.#scanTimer); this.#scanTimer = null; this.#abort('disconnected'); }

  #playersChanged() {
    const names = Object.keys(this.#bot.players ?? {}).filter(name => name !== this.#bot.username).sort().slice(0, 64);
    const key = names.join(',');
    if (key === this.#players) return;
    this.#players = key;
    this.#event({ type: 'players', names });
  }

  #registry() { return this.#bot.registry ?? {}; }

  #scan() {
    const bot = this.#bot, registry = this.#registry();
    if (!bot.entity || typeof bot.findBlocks !== 'function' || !registry.blocksByName) return;
    const ids = Object.values(registry.blocksByName).filter(block => NOTABLE.test(block.name)).map(block => block.id);
    if (!ids.length) return;
    for (const position of (bot.findBlocks({ matching: ids, maxDistance: LIMITS.scanRange, count: 8 }) ?? []).slice(0, 8)) {
      const key = `${position.x},${position.y},${position.z}`;
      if (this.#seen.has(key)) continue;
      if (this.#seen.size > 2000) this.#seen.clear();
      this.#seen.add(key);
      const block = bot.blockAt(position);
      if (block?.name) this.#event({ type: 'found', block: block.name, x: position.x, y: position.y, z: position.z });
    }
  }

  // A compact, bounded snapshot of the world around the bot.
  perceive() {
    const bot = this.#bot, self = bot.entity, registry = this.#registry();
    if (!self?.position) return { spawned: false };
    const here = self.position, kind = name => this.#companions.has(name.toLowerCase()) ? 'companion' : 'human';
    const online = Object.keys(bot.players ?? {}).filter(name => name !== bot.username);
    const players = online.map(name => ({ name, entity: bot.players[name]?.entity }))
      .filter(player => player.entity?.position).map(player => ({ name: player.name, kind: kind(player.name), distance: round(distance(here, player.entity.position)) }))
      .sort((a, b) => a.distance - b.distance).slice(0, LIMITS.players);
    const entities = Object.values(bot.entities ?? {}).filter(entity => entity !== self && entity?.position && entity.type !== 'player');
    const mobs = entities.filter(entity => ['hostile', 'animal', 'passive', 'mob', 'water_creature', 'ambient'].includes(entity.type))
      .map(entity => ({ name: clean(entity.name ?? entity.displayName ?? 'mob', 32), hostile: HOSTILE.has(entity.type), distance: round(distance(here, entity.position)) }))
      .filter(mob => mob.distance <= LIMITS.mobRange).sort((a, b) => a.distance - b.distance).slice(0, LIMITS.mobs);
    const items = entities.filter(entity => entity.name === 'item' && distance(here, entity.position) <= LIMITS.pickupRange).length;
    let blocks = [];
    try {
      const ids = registry.blocksByName ? Object.values(registry.blocksByName).filter(block => NOTABLE.test(block.name)).map(block => block.id) : [];
      if (ids.length && typeof bot.findBlocks === 'function') blocks = (bot.findBlocks({ matching: ids, maxDistance: LIMITS.scanRange, count: LIMITS.blocks }) ?? []).slice(0, LIMITS.blocks)
        .map(position => ({ name: bot.blockAt(position)?.name ?? 'block', x: position.x, y: position.y, z: position.z, distance: round(distance(here, position)) }));
    } catch { blocks = []; }
    const counts = new Map();
    for (const item of bot.inventory?.items?.() ?? []) counts.set(item.name, (counts.get(item.name) ?? 0) + (item.count ?? 1));
    const inventory = [...counts].sort((a, b) => b[1] - a[1]).slice(0, LIMITS.inventory).map(([name, count]) => ({ name: clean(name, 40), count }));
    let biome = null;
    try { biome = bot.blockAt(here)?.biome?.name ?? null; } catch { biome = null; }
    return { spawned: true, username: bot.username,
      position: { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) },
      dimension: clean(String(bot.game?.dimension ?? 'overworld').replace(/^minecraft:/, ''), 32), biome: biome ? clean(biome, 40) : null,
      time: { phase: timeOfDay(bot.time?.timeOfDay ?? 0), ticks: Math.floor(bot.time?.timeOfDay ?? 0) },
      health: round(bot.health ?? 0), food: Math.round(bot.food ?? 0),
      online: online.slice(0, 16).map(name => ({ name, kind: kind(name) })), players, mobs, blocks, droppedItems: items,
      inventory, freeSlots: typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null,
      holding: bot.heldItem?.name ?? null, doing: this.#current?.action.type ?? null };
  }

  say(text) {
    // Plain chat only: a leading slash would run a server command.
    const line = clean(text, LIMITS.sayChars).replace(/^[/\\]+/, '').trim();
    if (!line) return false;
    this.#bot.chat(line);
    return true;
  }

  #abort(reason) {
    const current = this.#current;
    if (!current) return;
    current.controller.abort(reason);
    try { this.#bot.pathfinder?.stop(); } catch { /* not moving */ }
    try { this.#bot.pathfinder?.setGoal(null); } catch { /* not moving */ }
    try { if (this.#bot.targetDigBlock) this.#bot.stopDigging(); } catch { /* not digging */ }
  }

  // Runs one validated action with its time limit. A new movement or work action replaces the running one; say
  // (a chat line) and refused actions never touch it (#69: talking mid-task must not drop the task). Never throws: the
  // result ({ type, ok, detail }) is what the companion's next turn hears.
  async act(input, { timeoutMs } = {}) {
    const checked = validateAction(input);
    if (checked.error) return { type: String(input?.type ?? 'unknown').slice(0, 20), ok: false, detail: checked.error };
    const action = checked.action;
    if (action.type === 'say') return this.say(action.text) ? { type: 'say', ok: true, detail: 'said it' } : { type: 'say', ok: false, detail: 'nothing to say' };
    if (action.type === 'stop') {
      const was = this.#current?.action.type ?? null;
      this.#abort('stopped');
      return { type: 'stop', ok: true, detail: was ? `stopped ${was}` : 'nothing to stop' };
    }
    if (!this.#bot.entity?.position) return { type: action.type, ok: false, detail: 'not in the world yet' };
    this.#abort('replaced by a new action');
    const controller = new AbortController(), entry = { action, controller };
    this.#current = entry;
    const limit = timeoutMs ?? (action.type === 'follow' ? action.seconds * 1000 + 5000 : ACTION_TIMEOUTS[action.type]);
    let timer;
    try {
      const detail = await Promise.race([
        this.#skill(action, controller.signal),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), limit); }),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(String(controller.signal.reason ?? 'stopped'))), { once: true }))
      ]);
      return { type: action.type, ok: true, detail: clean(detail, 200) };
    } catch (error) {
      if (this.#current === entry && !controller.signal.aborted) this.#abort(error?.message === 'timed out' ? 'timed out' : 'failed');
      return { type: action.type, ok: false, detail: clean(error?.message ?? 'failed', 200) };
    } finally {
      clearTimeout(timer);
      if (this.#current === entry) this.#current = null;
    }
  }

  #player(name) {
    const entity = this.#bot.players?.[name]?.entity;
    if (!entity?.position) throw new Error(`${name} is not in sight`);
    return entity;
  }

  #goals() {
    if (!this.#pathfinder || !this.#bot.pathfinder) throw new Error('walking is unavailable');
    return this.#pathfinder.goals;
  }

  async #walk(goal, signal) {
    if (signal.aborted) throw new Error('stopped');
    await this.#bot.pathfinder.goto(goal);
  }

  async #skill(action, signal) {
    const bot = this.#bot, here = bot.entity.position;
    switch (action.type) {
      case 'goto': {
        const goals = this.#goals();
        if (action.player) {
          const target = this.#player(action.player).position;
          await this.#walk(new goals.GoalNear(target.x, target.y, target.z, 2), signal);
          return `reached ${action.player}`;
        }
        if (distance(here, action) > LIMITS.gotoDistance) throw new Error(`too far (more than ${LIMITS.gotoDistance} blocks)`);
        await this.#walk(new goals.GoalNear(action.x, action.y, action.z, 1), signal);
        return `arrived near ${Math.floor(action.x)} ${Math.floor(action.y)} ${Math.floor(action.z)}`;
      }
      case 'follow': {
        const goals = this.#goals(), entity = this.#player(action.player);
        bot.pathfinder.setGoal(new goals.GoalFollow(entity, action.distance), true);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, action.seconds * 1000);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error(String(signal.reason ?? 'stopped'))); }, { once: true });
        });
        bot.pathfinder.setGoal(null);
        return `followed ${action.player} for ${action.seconds}s`;
      }
      case 'wander': {
        const goals = this.#goals(), angle = Math.random() * Math.PI * 2;
        const x = Math.floor(here.x + Math.cos(angle) * action.distance), z = Math.floor(here.z + Math.sin(angle) * action.distance);
        await this.#walk(new goals.GoalNearXZ(x, z, 3), signal);
        const now = bot.entity.position;
        return `wandered to ${Math.floor(now.x)} ${Math.floor(now.y)} ${Math.floor(now.z)}`;
      }
      case 'look_at': {
        const target = action.player ? this.#player(action.player).position.offset(0, 1.6, 0) : here.offset(action.x - here.x, action.y - here.y, action.z - here.z);
        await bot.lookAt(target);
        return action.player ? `looking at ${action.player}` : 'looking there';
      }
      case 'collect': {
        const goals = this.#goals(), type = this.#registry().blocksByName?.[action.block];
        if (!type) throw new Error(`no block called ${action.block}`);
        let got = 0;
        for (let attempt = 0; got < action.count && attempt < action.count + 4; attempt++) {
          if (signal.aborted) break;
          const position = bot.findBlocks({ matching: [type.id], maxDistance: LIMITS.collectRange, count: 1 })?.[0];
          if (!position) break;
          await this.#walk(new goals.GoalLookAtBlock(position, bot.world), signal);
          const block = bot.blockAt(position);
          if (!block || block.name !== action.block) continue;
          if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block)) throw new Error(`cannot reach the ${action.block}`);
          const tool = bot.pathfinder?.bestHarvestTool?.(block);
          if (tool) await bot.equip(tool, 'hand');
          await bot.dig(block, true);
          got++;
        }
        if (!got) throw new Error(`no ${action.block} within ${LIMITS.collectRange} blocks`);
        await this.#pickUp(signal).catch(() => {});
        return `collected ${got} ${action.block}`;
      }
      case 'pick_up': {
        const count = await this.#pickUp(signal);
        if (!count) throw new Error('no dropped items nearby');
        return `picked up ${count} item stack${count === 1 ? '' : 's'}`;
      }
      case 'eat': {
        if ((bot.food ?? 20) >= 20) throw new Error('not hungry');
        const foods = this.#registry().foodsByName ?? {};
        const food = (bot.inventory?.items?.() ?? []).filter(item => foods[item.name]).sort((a, b) => (foods[b.name].foodPoints ?? 0) - (foods[a.name].foodPoints ?? 0))[0];
        if (!food) throw new Error('no food in the inventory');
        await bot.equip(food, 'hand');
        await bot.consume();
        return `ate ${food.name}`;
      }
    }
    throw new Error('unknown action');
  }

  async #pickUp(signal) {
    const goals = this.#goals(), bot = this.#bot;
    const items = Object.values(bot.entities ?? {}).filter(entity => entity?.name === 'item' && entity.position
      && distance(bot.entity.position, entity.position) <= LIMITS.pickupRange).slice(0, 8);
    let count = 0;
    for (const item of items) {
      if (signal.aborted) break;
      try { await this.#walk(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.5), signal); count++; } catch { /* next item */ }
    }
    return count;
  }

  quit(reason = 'bye') { this.detach(); try { this.#bot.quit(reason); } catch { /* already gone */ } }
}
