// #70: the full survival skill set, on a fake Mineflayer bot (no server, no network, no model).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BotBody, validateAction, actionTimeout, ACTION_TYPES, LIMITS, patchWindowState } from '../src/minecraft-body.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseReply, buildPrompt, boundedState, MinecraftAgent, parseMinecraftConfig, PROMPT_LIMITS } from '../src/minecraft.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

// ---------- A fake world ----------

class Vec {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  offset(dx, dy, dz) { return new Vec(this.x + dx, this.y + dy, this.z + dz); }
  plus(v) { return new Vec(this.x + v.x, this.y + v.y, this.z + v.z); }
  floored() { return new Vec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
  scaled(k) { return new Vec(this.x * k, this.y * k, this.z * k); }
}
const BLOCKS = ['air', 'stone', 'oak_log', 'diamond_ore', 'iron_ore', 'crafting_table', 'furnace', 'chest', 'barrel', 'red_bed', 'oak_door', 'lever', 'dirt',
  'grass_block', 'farmland', 'wheat', 'bedrock', 'cobblestone', 'oak_planks', 'carrots', 'short_grass', 'tall_grass', 'poppy', 'snow', 'water'];
const ITEMS = ['oak_log', 'oak_planks', 'stick', 'crafting_table', 'furnace', 'raw_iron', 'iron_ingot', 'coal', 'dirt', 'cobblestone', 'netherrack', 'wooden_pickaxe',
  'stone_pickaxe', 'iron_axe', 'iron_sword', 'diamond_sword', 'shield', 'iron_helmet', 'bread', 'wheat_seeds', 'wheat', 'iron_hoe', 'fishing_rod', 'emerald', 'cod',
  'bow', 'stone', 'diamond', 'carrot', 'red_bed', 'oak_door'];
const REGISTRY = {
  blocksByName: Object.fromEntries(BLOCKS.map((name, id) => [name, { id, name }])),
  itemsByName: Object.fromEntries(ITEMS.map((name, i) => [name, { id: 100 + i, name }])),
  items: Object.fromEntries(ITEMS.map((name, i) => [100 + i, { id: 100 + i, name }])),
  foodsByName: { bread: { foodPoints: 5 }, cod: { foodPoints: 2 }, carrot: { foodPoints: 3 } }
};
const itemId = name => REGISTRY.itemsByName[name].id;
const RECIPES = {
  oak_planks: { per: 4, needs: { oak_log: 1 } }, stick: { per: 4, needs: { oak_planks: 2 } }, crafting_table: { per: 1, needs: { oak_planks: 4 } },
  wooden_pickaxe: { per: 1, needs: { oak_planks: 3, stick: 2 }, table: true }, furnace: { per: 1, needs: { cobblestone: 8 }, table: true }
};
const SMELTS = { raw_iron: 'iron_ingot', oak_log: 'charcoal' };
const DROPS = { stone: 'cobblestone', diamond_ore: 'diamond', iron_ore: 'raw_iron', oak_log: 'oak_log', wheat: 'wheat', carrots: 'carrot', dirt: 'dirt' };

function fakeBot() {
  const bot = new EventEmitter(), log = [];
  const world = new Map(), key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  let nextEntity = 1;
  const item = (name, count) => ({ name, count, type: itemId(name) });
  const inv = [];
  const add = (name, count) => { const stack = inv.find(entry => entry.name === name); if (stack) stack.count += count; else inv.push(item(name, count)); };
  const remove = (name, count) => {
    for (const stack of inv.filter(entry => entry.name === name)) { const n = Math.min(stack.count, count); stack.count -= n; count -= n; }
    for (let i = inv.length - 1; i >= 0; i--) if (inv[i].count <= 0) inv.splice(i, 1);
    if (bot.heldItem && !inv.includes(bot.heldItem)) bot.heldItem = null;
  };
  const count = name => inv.filter(entry => entry.name === name).reduce((sum, entry) => sum + entry.count, 0);
  const set = (x, y, z, name, extra = {}) => world.set(`${x},${y},${z}`, { name, ...extra });
  const blockAt = position => {
    const p = new Vec(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z)), entry = world.get(key(p)) ?? { name: 'air' };
    const props = entry.props ?? {};
    return { name: entry.name, type: REGISTRY.blocksByName[entry.name]?.id ?? 0, position: p, boundingBox: ['air', 'wheat', 'carrots', 'lever', 'short_grass', 'tall_grass', 'poppy', 'snow', 'water'].includes(entry.name) ? 'empty' : 'block',
      hardness: entry.name === 'bedrock' ? null : 1, getProperties: () => ({ ...props }), metadata: props.age ?? 0, biome: { name: 'plains' } };
  };
  const drop = (name, position, n = 1) => { const id = nextEntity++; bot.entities[id] = { id, name: 'item', type: 'other', position: new Vec(position.x + 0.5, position.y, position.z + 0.5), getDroppedItem: () => ({ name, count: n }), drop: name, n }; };
  Object.assign(bot, { username: 'Yakusuna', entity: { position: new Vec(0.5, 64, 0.5), yaw: 0, type: 'player', id: 0 }, health: 20, food: 15, oxygenLevel: 20,
    experience: { level: 3 }, game: { dimension: 'minecraft:overworld' }, time: { timeOfDay: 1000 }, players: {}, entities: {}, said: [], log, world, heldItem: null,
    isSleeping: false, vehicle: null, usingHeldItem: false, controls: {}, registry: REGISTRY, chests: new Map(),
    inventory: { items: () => inv.filter(entry => entry.count > 0), emptySlotCount: () => 30, count: (id) => inv.filter(entry => entry.type === id).reduce((s, e) => s + e.count, 0), slots: new Array(46).fill(null) },
    set, add, count, drop,
    chat(text) { bot.said.push(text); }, quit() {},
    blockAt,
    findBlocks({ matching, maxDistance }) {
      const here = bot.entity.position;
      return [...world.entries()].filter(([, entry]) => matching.includes(REGISTRY.blocksByName[entry.name]?.id))
        .map(([k]) => new Vec(...k.split(',').map(Number))).filter(p => Math.hypot(p.x - here.x, p.y - here.y, p.z - here.z) <= maxDistance);
    },
    canDigBlock: () => true,
    async dig(block) { log.push(['dig', block.name, bot.heldItem?.name ?? null]); world.delete(key(block.position)); if (DROPS[block.name]) drop(DROPS[block.name], block.position); },
    async equip(entry, destination) {
      log.push(['equip', entry.name, destination]);
      const slots = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };
      if (destination === 'hand') bot.heldItem = entry; else bot.inventory.slots[slots[destination]] = entry;
    },
    async unequip(destination) { log.push(['unequip', destination]); if (destination === 'hand') bot.heldItem = null; },
    async toss(type, metadata, n) {
      const name = REGISTRY.items[type].name; log.push(['toss', name, n]); remove(name, n);
      // A player standing by picks it up a moment later.
      setTimeout(() => { for (const player of Object.values(bot.players)) if (player.picksUp) bot.emit('playerCollect', player.entity, {}); }, 5);
    },
    async placeBlock(reference, face) {
      const target = reference.position.plus(face), held = bot.heldItem?.name;
      if (!held) throw new Error('nothing held');
      const name = { wheat_seeds: 'wheat', carrot: 'carrots' }[held] ?? held;
      log.push(['place', held, target.x, target.y, target.z]); set(target.x, target.y, target.z, name); remove(held, 1);
    },
    async lookAt(target) { bot.looked = target; },
    recipesFor(id, metadata, min, table) {
      const name = REGISTRY.items[id]?.name, recipe = RECIPES[name];
      if (!recipe || (recipe.table && !table)) return [];
      const times = Math.ceil((min ?? 1) / recipe.per);
      if (Object.entries(recipe.needs).some(([need, n]) => count(need) < n * times)) return [];
      return [{ result: { count: recipe.per }, requiresTable: Boolean(recipe.table), name, needs: recipe.needs }];
    },
    recipesAll(id) {
      const name = REGISTRY.items[id]?.name, recipe = RECIPES[name];
      return recipe ? [{ result: { count: recipe.per }, delta: Object.entries(recipe.needs).map(([need, n]) => ({ id: itemId(need), count: -n })) }] : [];
    },
    async craft(recipe, times, table) {
      log.push(['craft', recipe.name, times, table ? table.name : null]);
      if (recipe.requiresTable && !table) throw new Error('Recipe requires craftingTable');
      for (const [need, n] of Object.entries(recipe.needs)) remove(need, n * times);
      add(recipe.name, recipe.result.count * times);
    },
    // A furnace that cooks one item every 2 ms while it burns; a coal burns 8 items.
    async openFurnace(block) {
      const slots = bot.furnaceSlots ??= [null, null, null];
      log.push(['openFurnace', block.name]);
      const furnace = { fuel: 0, burnLeft: 0, progress: 0, inputItem: () => slots[0], fuelItem: () => slots[1], outputItem: () => slots[2],
        async putFuel(type, m, n) { const name = REGISTRY.items[type].name; log.push(['fuel', name, n]); remove(name, n); slots[1] = item(name, n); },
        async putInput(type, m, n) { const name = REGISTRY.items[type].name; log.push(['input', name, n]); remove(name, n); slots[0] = item(name, n); },
        async takeOutput() { add(slots[2].name, slots[2].count); slots[2] = null; }, async takeInput() { add(slots[0].name, slots[0].count); slots[0] = null; },
        close() { clearInterval(timer); log.push(['closeFurnace']); } };
      const timer = setInterval(() => {
        if (slots[0] && !(furnace.burnLeft > 0) && slots[1]) { furnace.burnLeft = 8; if (--slots[1].count <= 0) slots[1] = null; }
        furnace.fuel = furnace.burnLeft > 0 ? 1 : 0;
        if (!slots[0] || !(furnace.burnLeft > 0)) return;
        furnace.burnLeft--;
        if (slots[2]) slots[2].count++; else slots[2] = item(SMELTS[slots[0].name], 1);
        if (--slots[0].count <= 0) slots[0] = null;
      }, 2);
      return furnace;
    },
    async openContainer(block) {
      const k = key(block.position);
      if (!bot.chests.has(k)) bot.chests.set(k, []);
      const contents = bot.chests.get(k);
      log.push(['open', block.name]);
      return { containerItems: () => contents.filter(entry => entry.count > 0),
        async deposit(type, m, n) { const name = REGISTRY.items[type].name; remove(name, n); const s = contents.find(e => e.name === name); if (s) s.count += n; else contents.push(item(name, n)); },
        async withdraw(type, m, n) { const name = REGISTRY.items[type].name; const s = contents.find(e => e.name === name); s.count -= n; add(name, n); },
        close() { log.push(['close', block.name]); } };
    },
    async activateBlock(block) {
      log.push(['activate', block.name, bot.heldItem?.name ?? null]);
      const entry = world.get(key(block.position));
      if (bot.heldItem && /_hoe$/.test(bot.heldItem.name) && ['dirt', 'grass_block'].includes(block.name)) entry.name = 'farmland';
      else if (entry?.props && 'open' in entry.props) entry.props.open = !entry.props.open;
      else if (entry?.props && 'powered' in entry.props) entry.props.powered = !entry.props.powered;
    },
    async activateEntity(entity) { log.push(['feed', entity.name, bot.heldItem?.name]); remove(bot.heldItem.name, 1); },
    async sleep(bed) { if (bot.time.timeOfDay < 12541) throw new Error("it's not night and it's not a thunderstorm"); log.push(['sleep', bed.name]); bot.isSleeping = true; },
    async wake() { bot.isSleeping = false; log.push(['wake']); },
    attack(entity) { log.push(['attack', entity.name, bot.heldItem?.name ?? null]); entity.health -= 4; if (entity.health <= 0) { entity.isValid = false; delete bot.entities[entity.id]; } },
    setControlState(control, state) { bot.controls[control] = state; log.push(['control', control, state]); if (control === 'jump' && state) bot.entity.position = bot.entity.position.offset(0, 1.2, 0); },
    activateItem(offhand = false) { bot.usingHeldItem = true; log.push(['use', offhand]); },
    deactivateItem() { bot.usingHeldItem = false; log.push(['release']); },
    async consume() { log.push(['consume', bot.heldItem?.name]); bot.food = 20; remove(bot.heldItem.name, 1); },
    mount(entity) { bot.vehicle = entity; log.push(['mount', entity.name]); }, dismount() { bot.vehicle = null; log.push(['dismount']); },
    async fish() { log.push(['fish']); add('cod', 1); },
    async openVillager(entity) {
      log.push(['openVillager', entity.name]);
      return { trades: [{ inputItem1: { name: 'emerald', count: 1 }, inputs: [{ name: 'emerald', count: 1 }], realPrice: 1, outputItem: { name: 'bread', count: 6 }, hasItem2: false, tradeDisabled: false },
        { inputItem1: { name: 'wheat', count: 20 }, realPrice: 20, outputItem: { name: 'emerald', count: 1 }, hasItem2: false, tradeDisabled: true }], close() { log.push(['closeVillager']); } };
    },
    async trade(window, index, n) { log.push(['trade', index, n]); }
  });
  // The pathfinder walks instantly: next to the goal, and over dropped items there (picking them up).
  bot.pathfinder = { goals: [], setGoal(goal) { bot.goal = goal; }, stop() {}, setMovements(m) { bot.movements = m; },
    bestHarvestTool(block) { return inv.find(entry => (/_pickaxe$/.test(entry.name) && /stone|ore|cobble/.test(block.name)) || (/_axe$/.test(entry.name) && /log|planks/.test(block.name))) ?? null; },
    goto: async goal => {
      bot.pathfinder.goals.push(goal);
      const target = goal.kind === 'lookat' ? goal.args[0] : goal.kind === 'near' ? new Vec(goal.args[0], goal.args[1], goal.args[2]) : null;
      if (goal.kind === 'invert') { bot.entity.position = bot.entity.position.offset(3, 0, 0); return; }
      if (!target) return;
      for (const [id, entity] of Object.entries(bot.entities)) {
        if (entity.name === 'item' && Math.hypot(entity.position.x - target.x, entity.position.z - target.z) < 1.5 && Math.abs(entity.position.y - target.y) < 2) { add(entity.drop, entity.n); delete bot.entities[id]; }
      }
      const r = goal.kind === 'near' ? Math.min(goal.args[3] ?? 1, 2) : 2;
      if (goal.kind === 'near' && (goal.args[3] ?? 1) < 1) bot.entity.position = new Vec(target.x, target.y, target.z);
      else bot.entity.position = new Vec(Math.floor(target.x) + 0.5 + r, Math.floor(target.y), Math.floor(target.z) + 0.5);
    } };
  // The ground: a stone floor under y=64 around the origin.
  for (let x = -6; x <= 12; x++) for (let z = -6; z <= 6; z++) set(x, 63, z, 'stone');
  return bot;
}
const goal = name => class { constructor(...args) { this.kind = name; this.args = args; } };
const pathfinderModule = { pathfinder: () => {}, Movements: class { constructor() { this.canDig = false; this.scafoldingBlocks = []; this.allow1by1towers = false; } },
  goals: { GoalNear: goal('near'), GoalNearXZ: goal('nearxz'), GoalFollow: goal('follow'), GoalLookAtBlock: goal('lookat'), GoalInvert: goal('invert') } };
const spawned = (options = {}) => {
  const bot = fakeBot(), events = [];
  const body = new BotBody({ bot, pathfinder: pathfinderModule, onEvent: event => events.push(event), scanMs: 60_000, pace: { hit: 1, poll: 1, settle: 1, inventory: 30, sync: 10, collect: 30, look: 1 }, ...options });
  body.attach(); bot.emit('spawn');
  return { bot, body, events };
};

// ---------- Validation ----------

test('#70: every new action validates its shape, with defaults, and refuses bad input', () => {
  const ok = [
    [{ type: 'goto', block: 'crafting_table' }, { type: 'goto', block: 'crafting_table' }],
    [{ type: 'jump' }], [{ type: 'sprint' }, { type: 'sprint', on: true }], [{ type: 'sneak', on: false }],
    [{ type: 'swim' }, { type: 'swim', seconds: 5, forward: false }],
    [{ type: 'dig', x: 1.7, y: 63, z: -2.2 }, { type: 'dig', x: 1, y: 63, z: -3 }], [{ type: 'dig', block: 'minecraft:stone' }, { type: 'dig', block: 'stone' }],
    [{ type: 'collect', block: 'chest', count: 64 }],
    [{ type: 'place', item: 'dirt' }, { type: 'place', item: 'dirt', at: 'front' }], [{ type: 'place', item: 'dirt', at: 'below' }], [{ type: 'place', item: 'dirt', x: 1, y: 64, z: 1 }],
    [{ type: 'build', blocks: [[0, 0, 1, 'oak_planks'], { x: 1, y: 0, z: 1, item: 'cobblestone' }] }, { type: 'build', blocks: [[0, 0, 1, 'oak_planks'], [1, 0, 1, 'cobblestone']] }],
    [{ type: 'craft', item: 'oak_planks' }, { type: 'craft', item: 'oak_planks', count: 1 }],
    [{ type: 'smelt', item: 'raw_iron', count: 3, fuel: 'coal' }],
    [{ type: 'equip', item: 'shield', slot: 'offhand' }, { type: 'equip', item: 'shield', slot: 'off-hand' }], [{ type: 'equip', item: 'iron_helmet' }],
    [{ type: 'unequip' }, { type: 'unequip', slot: 'hand' }],
    [{ type: 'toss', item: 'dirt', count: 10 }], [{ type: 'drop', item: 'dirt' }, { type: 'toss', item: 'dirt', count: 1 }],
    [{ type: 'give', player: 'Blackout', item: 'bread', count: 2 }],
    [{ type: 'use_item' }, { type: 'use_item', offhand: false, seconds: 0 }], [{ type: 'use_item', seconds: 1.5 }, { type: 'use_item', offhand: false, seconds: 1.5 }],
    [{ type: 'eat', item: 'bread' }],
    [{ type: 'attack' }], [{ type: 'attack', mob: 'zombie' }], [{ type: 'attack', player: 'Cirno' }],
    [{ type: 'shield' }, { type: 'shield', seconds: 5 }], [{ type: 'defend', seconds: 30 }],
    [{ type: 'open' }], [{ type: 'open', block: 'barrel' }], [{ type: 'open', x: 3, y: 64, z: 0 }],
    [{ type: 'deposit', item: 'cobblestone' }], [{ type: 'withdraw', item: 'iron_ingot', count: 5, x: 3, y: 64, z: 0 }],
    [{ type: 'activate', block: 'lever' }], [{ type: 'activate', x: 2, y: 64, z: 2 }],
    [{ type: 'sleep' }], [{ type: 'wake' }], [{ type: 'mount' }], [{ type: 'mount', entity: 'oak_boat' }], [{ type: 'dismount' }],
    [{ type: 'fish' }, { type: 'fish', seconds: 60 }],
    [{ type: 'till' }, { type: 'till', count: 1 }], [{ type: 'plant', item: 'wheat_seeds', count: 4 }],
    [{ type: 'harvest' }, { type: 'harvest', count: 8, replant: true }], [{ type: 'harvest', block: 'wheat', replant: false, count: 3 }],
    [{ type: 'breed', mob: 'cow' }], [{ type: 'trade' }, { type: 'trade', count: 1 }], [{ type: 'trade', index: 0, count: 2 }]
  ];
  for (const [input, expected] of ok) {
    const checked = validateAction(input);
    assert.ok(checked.action, `${JSON.stringify(input)}: ${checked.error}`);
    if (expected) assert.deepEqual(checked.action, expected);
  }
  const bad = [
    { type: 'eval', code: '1' }, { type: 'run' }, { type: 'goto', block: 'stone', player: 'A' }, { type: 'jump', high: true }, { type: 'sprint', on: 'yes' },
    { type: 'swim', seconds: 99 }, { type: 'dig' }, { type: 'dig', x: 1, y: 2 }, { type: 'dig', block: 'Stone!' }, { type: 'collect', block: 'stone', count: 0 },
    { type: 'place' }, { type: 'place', item: 'dirt', at: 'left' }, { type: 'place', item: 'dirt', x: 1, y: 2, z: 3, at: 'front' },
    { type: 'build' }, { type: 'build', blocks: [] }, { type: 'build', blocks: Array.from({ length: 65 }, () => [0, 0, 0, 'dirt']) }, { type: 'build', blocks: [[0, 0, 17, 'dirt']] },
    { type: 'build', blocks: [[0, 0, 0]] }, { type: 'craft' }, { type: 'craft', item: 'stick', count: 65 }, { type: 'smelt', item: 'raw_iron', fuel: 'Coal!' },
    { type: 'equip' }, { type: 'equip', item: 'shield', slot: 'pocket' }, { type: 'unequip', slot: 'pocket' }, { type: 'toss' }, { type: 'toss', item: 'dirt', count: 9999 },
    { type: 'give', item: 'bread' }, { type: 'give', player: 'a b', item: 'bread' }, { type: 'use_item', seconds: 9 }, { type: 'eat', item: 'Bread' },
    { type: 'attack', mob: 'zombie', player: 'A' }, { type: 'attack', entity: 'x' }, { type: 'shield', seconds: 0 }, { type: 'defend', seconds: 1 },
    { type: 'open', block: 'chest', x: 1, y: 2, z: 3 }, { type: 'sleep', block: 'red_bed' }, { type: 'deposit' }, { type: 'withdraw', item: 'dirt', count: 0 },
    { type: 'activate' }, { type: 'wake', now: 1 }, { type: 'mount', entity: 'Boat!' }, { type: 'fish', seconds: 1 }, { type: 'till', count: 999 },
    { type: 'plant' }, { type: 'harvest', block: 'stone' }, { type: 'harvest', replant: 'yes' }, { type: 'breed' }, { type: 'breed', mob: 'zombie' },
    { type: 'trade', index: -1 }, { type: 'trade', index: 64 }
  ];
  for (const input of bad) assert.ok(validateAction(input).error, JSON.stringify(input));
  assert.match(validateAction({ type: 'eval', code: 'process.exit()' }).error, /unknown action type/, 'no code or eval action, ever');
  assert.ok(!ACTION_TYPES.some(type => /eval|exec|code|script|shell|file/.test(type)));
  // Time limits are sized for the action.
  assert.ok(actionTimeout(validateAction({ type: 'smelt', item: 'raw_iron', count: 32 }).action) > actionTimeout(validateAction({ type: 'smelt', item: 'raw_iron' }).action));
  assert.equal(actionTimeout(validateAction({ type: 'build', blocks: Array.from({ length: 10 }, () => [0, 0, 0, 'dirt']) }).action), 20_000 + 10 * 6000);
  assert.ok(actionTimeout({ type: 'craft', count: 1 }) >= 60_000); assert.equal(actionTimeout({ type: 'jump' }), 3000);
});

// ---------- Movement ----------

test('#70: pathfinding may dig and place scaffolding from the inventory; jump, sprint, sneak, swim and goto a block', async () => {
  const { bot, body } = spawned();
  assert.equal(bot.movements.canDig, false, 't70: the first pass walks (through doors) without digging'); assert.equal(bot.movements.allow1by1towers, true);
  for (const name of ['dirt', 'cobblestone', 'netherrack', 'oak_planks', 'stone']) assert.ok(bot.movements.scafoldingBlocks.includes(itemId(name)), name);
  assert.ok(!bot.movements.scafoldingBlocks.includes(itemId('diamond_sword')));
  assert.deepEqual(await body.act({ type: 'jump' }), { type: 'jump', ok: true, detail: 'jumped (1.2 blocks up)' });
  assert.equal(bot.controls.jump, false);
  assert.deepEqual(await body.act({ type: 'sprint', on: true }), { type: 'sprint', ok: true, detail: 'sprint on' }); assert.equal(bot.controls.sprint, true);
  assert.equal((await body.act({ type: 'sneak', on: false })).detail, 'sneak off');
  const swim = body.act({ type: 'swim', seconds: 1, forward: true });
  await tick(); assert.equal(bot.controls.jump, true); assert.equal(bot.controls.forward, true);
  assert.equal(await body.act({ type: 'stop' }).then(result => result.detail), 'stopped swim');
  assert.equal((await swim).ok, false); assert.equal(bot.controls.jump, false); assert.equal(bot.controls.forward, false);
  bot.set(8, 64, 2, 'crafting_table');
  assert.deepEqual(await body.act({ type: 'goto', block: 'crafting_table' }), { type: 'goto', ok: true, detail: 'reached the crafting_table at 8 64 2; now at 10 64 2' });
  assert.equal((await body.act({ type: 'goto', block: 'furnace' })).detail, "you haven't seen any furnace nearby; explore or mine to find some");
});

// ---------- Blocks ----------

test('#70: dig picks the best tool, any block, and refuses unbreakable ones', async () => {
  const { bot, body } = spawned();
  bot.add('wooden_pickaxe', 1); bot.add('iron_axe', 1);
  bot.set(2, 64, 0, 'stone'); bot.set(3, 64, 1, 'oak_log'); bot.set(1, 64, 1, 'oak_planks'); bot.set(0, 62, 0, 'bedrock');
  assert.deepEqual(await body.act({ type: 'dig', x: 2, y: 64, z: 0 }), { type: 'dig', ok: true, detail: 'dug stone at 2 64 0 with wooden_pickaxe' });
  assert.deepEqual(bot.log.find(entry => entry[0] === 'dig'), ['dig', 'stone', 'wooden_pickaxe']);
  assert.equal((await body.act({ type: 'dig', block: 'oak_log' })).detail, 'dug oak_log at 3 64 1 with iron_axe');
  assert.equal((await body.act({ type: 'dig', block: 'oak_planks' })).ok, true, 'not only natural blocks');
  assert.equal((await body.act({ type: 'dig', x: 0, y: 62, z: 0 })).detail, 'bedrock cannot be broken');
  assert.equal((await body.act({ type: 'dig', x: 5, y: 70, z: 0 })).detail, 'nothing to dig at 5 70 0');
  assert.equal((await body.act({ type: 'dig', x: 500, y: 64, z: 0 })).detail, '500 64 0 is too far (more than 64 blocks)');
});

test('t70: dig breaks blocks without a collision box (grass, a tall plant\'s upper half, a flower, a snow layer); air and water are nothing to dig', async () => {
  const { bot, body } = spawned();
  bot.set(1, 64, 0, 'short_grass'); bot.set(0, 64, 1, 'tall_grass', { props: { half: 'lower' } }); bot.set(0, 65, 1, 'tall_grass', { props: { half: 'upper' } });
  bot.set(-1, 64, 0, 'poppy'); bot.set(0, 64, -1, 'snow'); bot.set(2, 64, 2, 'water');
  assert.deepEqual(await body.act({ type: 'dig', x: 1, y: 64, z: 0 }), { type: 'dig', ok: true, detail: 'dug short_grass at 1 64 0' });
  assert.equal((await body.act({ type: 'dig', x: 0, y: 65, z: 1 })).detail, 'dug tall_grass at 0 65 1', 'either half');
  assert.equal((await body.act({ type: 'dig', block: 'poppy' })).detail, 'dug poppy at -1 64 0');
  assert.equal((await body.act({ type: 'dig', x: 0, y: 64, z: -1 })).ok, true, 'a snow layer');
  assert.deepEqual(bot.log.filter(entry => entry[0] === 'dig').map(entry => entry[1]), ['short_grass', 'tall_grass', 'poppy', 'snow']);
  assert.equal((await body.act({ type: 'dig', x: 2, y: 64, z: 2 })).detail, 'nothing to dig at 2 64 2');
  assert.equal(bot.pathfinder.goals.filter(goal => goal.kind === 'lookat').length, 0, 'no line-of-sight goal for a block without a box');
});

test('#70: collect mines N blocks, then picks up the drops; partial results say so', async () => {
  const { bot, body } = spawned();
  bot.add('stone_pickaxe', 1);
  bot.set(2, 64, 0, 'stone'); bot.set(4, 64, 0, 'stone');
  const result = await body.act({ type: 'collect', block: 'stone', count: 2 });
  assert.deepEqual(result, { type: 'collect', ok: true, detail: 'mined 2 stone; picked up 2 cobblestone' });
  assert.equal(bot.count('cobblestone'), 2); assert.ok(bot.log.filter(entry => entry[0] === 'dig').every(entry => entry[2] === 'stone_pickaxe'));
  bot.set(3, 64, 2, 'iron_ore'); bot.set(-3, 64, 1, 'iron_ore');
  const rest = await body.act({ type: 'collect', block: 'iron_ore', count: 5 });
  assert.deepEqual(rest, { type: 'collect', ok: true, detail: 'mined 2 iron_ore (only 2 of 5 found); picked up 2 raw_iron' });
  assert.equal((await body.act({ type: 'collect', block: 'diamond_ore' })).detail, "you haven't seen any diamond_ore nearby; explore or mine to find some");
  assert.equal((await body.act({ type: 'collect', block: 'unobtainium' })).detail, 'no block called unobtainium');
});

test('#70: place at coordinates, in front, below (bridge or pillar) and above; build reports each placement', async () => {
  const { bot, body } = spawned();
  bot.add('dirt', 20); bot.add('cobblestone', 2);
  assert.deepEqual(await body.act({ type: 'place', item: 'dirt', x: 3, y: 64, z: 0 }), { type: 'place', ok: true, detail: 'placed dirt at 3 64 0' });
  assert.equal(bot.blockAt(new Vec(3, 64, 0)).name, 'dirt');
  assert.equal((await body.act({ type: 'place', item: 'dirt', x: 3, y: 64, z: 0 })).detail, 'already dirt at 3 64 0');
  assert.equal((await body.act({ type: 'place', item: 'cobblestone', x: 3, y: 64, z: 0 })).detail, 'there is already dirt at 3 64 0');
  assert.equal((await body.act({ type: 'place', item: 'emerald', x: 4, y: 64, z: 0 })).detail, 'no emerald in the inventory');
  assert.equal((await body.act({ type: 'place', item: 'dirt', x: 4, y: 80, z: 0 })).detail, 'nothing to place the dirt against at 4 80 0');
  bot.entity.position = new Vec(0.5, 64, 0.5); bot.entity.yaw = 0; // facing north (-z)
  assert.equal((await body.act({ type: 'place', item: 'dirt' })).detail, 'placed dirt in front of you at 0 64 -1');
  assert.equal((await body.act({ type: 'place', item: 'dirt', at: 'above' })).ok, false, 'nothing to place against two blocks up');
  // Below on solid ground: jump and place under her (a pillar step).
  const pillar = await body.act({ type: 'place', item: 'dirt', at: 'below' });
  assert.equal(pillar.detail, 'jumped and placed dirt under you at 0 64 0'); assert.equal(bot.blockAt(new Vec(0, 64, 0)).name, 'dirt'); assert.equal(bot.controls.jump, false);
  // Below over a gap: bridge.
  bot.entity.position = new Vec(20.5, 64, 0.5); bot.set(21, 63, 0, 'stone');
  assert.equal((await body.act({ type: 'place', item: 'dirt', at: 'below' })).detail, 'placed dirt below you at 20 63 0');

  bot.entity.position = new Vec(0.5, 64, 3.5);
  const before = bot.count('dirt');
  const build = await body.act({ type: 'build', x: 5, y: 64, z: 3, blocks: [[0, 0, 0, 'dirt'], [1, 0, 0, 'dirt'], [1, 1, 0, 'dirt'], [2, 0, 0, 'emerald'], [0, 0, 0, 'dirt']] });
  assert.equal(build.ok, true);
  assert.equal(build.detail, 'placed 3 of 5 blocks (1 were already there); 1 failed: #4 emerald at 7 64 3: no emerald in the inventory');
  assert.equal(bot.count('dirt'), before - 3); assert.equal(bot.blockAt(new Vec(6, 65, 3)).name, 'dirt');
  const none = await body.act({ type: 'build', blocks: [[0, 0, 2, 'emerald']] });
  assert.equal(none.ok, false); assert.match(none.detail, /^placed 0 of 1 blocks; #1 emerald/);
  // Standing in the target spot: she steps out of the way first.
  bot.entity.position = new Vec(9.5, 64, 0.5);
  assert.equal((await body.act({ type: 'place', item: 'dirt', x: 9, y: 64, z: 0 })).ok, true);
  assert.ok(bot.pathfinder.goals.some(g => g.kind === 'invert'));
});

// ---------- Crafting ----------

test('#70: craft in the 2x2 grid, at a nearby table, or by placing a table from the inventory; missing ingredients are named', async () => {
  const { bot, body } = spawned();
  bot.add('oak_log', 3);
  assert.deepEqual(await body.act({ type: 'craft', item: 'oak_planks', count: 8 }), { type: 'craft', ok: true, detail: 'crafted 8 oak_planks; it took 2 oak_log' });
  assert.deepEqual(bot.log.find(entry => entry[0] === 'craft'), ['craft', 'oak_planks', 2, null]);
  assert.equal(bot.count('oak_planks'), 8);
  assert.equal((await body.act({ type: 'craft', item: 'oak_planks', count: 64 })).detail, 'crafted 4 oak_planks (only enough ingredients for 4 of 64); it took 1 oak_log');
  assert.equal((await body.act({ type: 'craft', item: 'stick', count: 4 })).detail, 'crafted 4 stick; it took 2 oak_planks');
  // A table recipe without a table anywhere: refused with the reason.
  assert.match((await body.act({ type: 'craft', item: 'wooden_pickaxe' })).detail, /needs a crafting table: none within 32 blocks and none in the inventory/);
  // With a crafting table in the inventory: she places it, then crafts there.
  await body.act({ type: 'craft', item: 'crafting_table' });
  assert.equal(bot.count('crafting_table'), 1);
  const placed = await body.act({ type: 'craft', item: 'wooden_pickaxe' });
  assert.equal(placed.ok, true, placed.detail); assert.equal(placed.detail, 'crafted 1 wooden_pickaxe; placed a crafting table; it took 3 oak_planks, 2 stick');
  assert.deepEqual(bot.log.filter(entry => entry[0] === 'craft').at(-1), ['craft', 'wooden_pickaxe', 1, 'crafting_table']);
  assert.equal(bot.count('crafting_table'), 0);
  // A nearby table: she walks there and uses it.
  const table = bot.findBlocks({ matching: [REGISTRY.blocksByName.crafting_table.id], maxDistance: 64 })[0];
  bot.entity.position = new Vec(-5.5, 64, -5.5); bot.add('oak_planks', 3); bot.add('stick', 2);
  const nearby = await body.act({ type: 'craft', item: 'wooden_pickaxe' });
  assert.equal(nearby.detail, `crafted 1 wooden_pickaxe; used the crafting table at ${table.x} ${table.y} ${table.z}; it took 3 oak_planks, 2 stick`);
  assert.equal((await body.act({ type: 'craft', item: 'furnace' })).detail, 'missing ingredients for furnace: one craft needs 8 cobblestone');
  assert.equal((await body.act({ type: 'craft', item: 'diamond' })).detail, 'diamond cannot be crafted');
});

test('#70: smelt uses the nearest furnace (or places one), adds fuel, waits and takes the output', async () => {
  const { bot, body } = spawned();
  bot.add('raw_iron', 3); bot.add('coal', 2);
  assert.match((await body.act({ type: 'smelt', item: 'raw_iron' })).detail, /no furnace within 32 blocks and none in the inventory/);
  bot.add('furnace', 1);
  const result = await body.act({ type: 'smelt', item: 'raw_iron', count: 3 });
  assert.deepEqual(result, { type: 'smelt', ok: true, detail: 'smelted 3 raw_iron: got 3 iron_ingot; placed a furnace' });
  assert.deepEqual(bot.log.filter(entry => ['fuel', 'input', 'closeFurnace'].includes(entry[0])), [['fuel', 'coal', 1], ['input', 'raw_iron', 3], ['closeFurnace']]);
  assert.equal(bot.count('iron_ingot'), 3);
  assert.equal((await body.act({ type: 'smelt', item: 'raw_iron' })).detail, 'no raw_iron in the inventory');
  bot.add('raw_iron', 1); bot.add('coal', -1); bot.inventory.items().forEach(i => { if (i.name === 'coal') i.count = 0; });
  assert.match((await body.act({ type: 'smelt', item: 'raw_iron' })).detail, /no fuel in the inventory/);
});

// ---------- Items ----------

test('#70: equip (armor goes to its slot), unequip, toss, give, use_item and eat', async () => {
  const { bot, body } = spawned();
  bot.add('iron_helmet', 1); bot.add('shield', 1); bot.add('bread', 2); bot.add('dirt', 10); bot.add('bow', 1);
  assert.equal((await body.act({ type: 'equip', item: 'iron_helmet' })).detail, 'equipped iron_helmet (head)');
  assert.equal((await body.act({ type: 'equip', item: 'shield', slot: 'offhand' })).detail, 'equipped shield (off-hand)');
  assert.equal((await body.act({ type: 'equip', item: 'diamond_sword' })).detail, 'no diamond_sword in the inventory');
  assert.equal((await body.act({ type: 'unequip', slot: 'head' })).detail, 'unequipped head');
  assert.equal((await body.act({ type: 'toss', item: 'dirt', count: 4 })).detail, 'tossed 4 dirt'); assert.equal(bot.count('dirt'), 6);
  assert.equal((await body.act({ type: 'drop', item: 'dirt', count: 100 })).detail, 'tossed 6 dirt (all you had)');
  assert.equal((await body.act({ type: 'give', player: 'Blackout', item: 'bread' })).detail, 'Blackout is not in sight');
  bot.players.Blackout = { username: 'Blackout', entity: { position: new Vec(8, 64, 0) }, picksUp: true };
  assert.equal((await body.act({ type: 'give', player: 'Blackout', item: 'bread', count: 1 })).detail, 'gave Blackout 1 bread; they picked it up');
  assert.ok(bot.pathfinder.goals.at(-1).kind === 'near'); assert.equal(bot.looked.y, 64.5, "t70: aimed low");
  await body.act({ type: 'equip', item: 'bow' });
  assert.equal((await body.act({ type: 'use_item', seconds: 0.01 })).detail, 'used bow for 0.01s, then released');
  assert.deepEqual(bot.log.slice(-2), [['use', false], ['release']]);
  assert.equal((await body.act({ type: 'eat' })).detail, 'ate bread (food 15 -> 20)'); assert.equal(bot.food, 20);
  assert.equal((await body.act({ type: 'eat' })).detail, 'not hungry');
  bot.food = 10;
  assert.equal((await body.act({ type: 'eat' })).detail, 'no food in the inventory');
});

// ---------- Combat ----------

test('#70: attack hits until the target is dead with the best weapon; a target out of range got away; shield and defend', async () => {
  let t = 0;
  const { bot, body } = spawned({ now: () => (t += 250) });
  bot.add('iron_sword', 1); bot.add('diamond_sword', 1); bot.add('iron_axe', 1);
  bot.entities[50] = { id: 50, name: 'zombie', type: 'hostile', position: new Vec(2, 64, 0), health: 10, height: 1.95 };
  bot.entities[51] = { id: 51, name: 'cow', type: 'animal', position: new Vec(1, 64, 1), health: 10 };
  const result = await body.act({ type: 'attack' });
  assert.deepEqual(result, { type: 'attack', ok: true, detail: 'killed zombie after 3 hits with diamond_sword' }, 'no target given: the nearest hostile, not the cow');
  assert.deepEqual(bot.log.filter(entry => entry[0] === 'attack').map(entry => entry[2]), ['diamond_sword', 'diamond_sword', 'diamond_sword']);
  assert.equal(bot.entities[50], undefined);
  assert.equal((await body.act({ type: 'attack', mob: 'cow' })).detail, 'killed cow after 3 hits with diamond_sword');
  assert.equal((await body.act({ type: 'attack', mob: 'creeper' })).detail, 'no creeper within 32 blocks');
  bot.players.Cirno = { username: 'Cirno', entity: { id: 60, position: new Vec(40, 64, 0), health: 20 } };
  bot.entities[60] = bot.players.Cirno.entity;
  assert.equal((await body.act({ type: 'attack', player: 'Cirno' })).detail, 'Cirno got away after 0 hits');
  // A target farther than reach: she follows it.
  bot.entities[52] = { id: 52, name: 'skeleton', type: 'hostile', position: new Vec(8, 64, 0), health: 4 };
  const follow = body.act({ type: 'attack', mob: 'skeleton' });
  await tick(); await tick();
  assert.equal(bot.goal?.kind, 'follow');
  bot.entities[52].position = new Vec(2, 64, 0);
  assert.equal((await follow).detail, 'killed skeleton after 1 hit with diamond_sword');

  bot.add('shield', 1);
  const shield = body.act({ type: 'shield', seconds: 1 });
  await tick(); await tick();
  assert.deepEqual(bot.log.filter(entry => entry[0] === 'equip').at(-1), ['equip', 'shield', 'off-hand']); assert.equal(bot.usingHeldItem, true);
  await body.act({ type: 'stop' }); await shield; assert.equal(bot.usingHeldItem, false, 'the shield is lowered when stopped');

  bot.entities[53] = { id: 53, name: 'spider', type: 'hostile', position: new Vec(3, 64, 0), health: 8 };
  const defend = await body.act({ type: 'defend', seconds: 5 });
  assert.deepEqual(defend, { type: 'defend', ok: true, detail: 'defended for 5s: killed 1 spider' });
  assert.equal((await body.act({ type: 'defend', seconds: 5 })).detail, 'defended for 5s: no hostile mob came close');
});

// ---------- Containers ----------

test('#70: open a chest or barrel and see inside; deposit and withdraw by name and count', async () => {
  const { bot, body } = spawned();
  bot.set(3, 64, 0, 'chest'); bot.set(-4, 64, 0, 'barrel');
  bot.add('cobblestone', 20); bot.add('iron_ingot', 2);
  assert.equal((await body.act({ type: 'open' })).detail, 'chest at 3 64 0 holds: nothing');
  assert.equal((await body.act({ type: 'deposit', item: 'cobblestone', count: 15 })).detail, 'put 15 cobblestone in; chest at 3 64 0 holds: 15 cobblestone');
  assert.equal((await body.act({ type: 'deposit', item: 'iron_ingot' })).detail, 'put 2 iron_ingot in; chest at 3 64 0 holds: 15 cobblestone, 2 iron_ingot');
  assert.equal(bot.count('cobblestone'), 5); assert.equal(bot.count('iron_ingot'), 0);
  assert.equal((await body.act({ type: 'withdraw', item: 'iron_ingot', count: 1, x: 3, y: 64, z: 0 })).detail, 'took 1 iron_ingot; chest at 3 64 0 holds: 15 cobblestone, 1 iron_ingot');
  assert.equal((await body.act({ type: 'withdraw', item: 'cobblestone', count: 100 })).detail, 'took 15 cobblestone; chest at 3 64 0 holds: 1 iron_ingot');
  assert.equal((await body.act({ type: 'withdraw', item: 'diamond' })).detail, 'no diamond in it; chest at 3 64 0 holds: 1 iron_ingot');
  assert.equal((await body.act({ type: 'deposit', item: 'diamond' })).detail, 'no diamond in the inventory');
  assert.equal((await body.act({ type: 'open', block: 'barrel' })).detail, 'barrel at -4 64 0 holds: nothing');
  assert.equal(bot.log.filter(entry => entry[0] === 'open').length, bot.log.filter(entry => entry[0] === 'close').length, 'every container is closed again');
  assert.equal((await body.act({ type: 'open', x: 3, y: 64, z: 0 })).ok, true, 'by coordinates');
  assert.equal((await body.act({ type: 'open', x: 1, y: 63, z: 1 })).detail, 'stone at 1 63 1 is not something to open (chest, barrel, shulker box, hopper…)');
});

// ---------- World interaction ----------

test('#70: activate doors and levers, sleep in a bed and wake, mount and dismount, fish', async () => {
  const { bot, body } = spawned();
  bot.set(2, 64, 2, 'oak_door', { props: { open: false } }); bot.set(-2, 64, 0, 'lever', { props: { powered: false } });
  assert.equal((await body.act({ type: 'activate', block: 'oak_door' })).detail, 'activated oak_door at 2 64 2 (now open)');
  assert.equal((await body.act({ type: 'activate', x: -2, y: 64, z: 0 })).detail, 'activated lever at -2 64 0 (now on)');
  assert.equal((await body.act({ type: 'sleep' })).detail, "you haven't seen any bed nearby; explore or mine to find some");
  bot.set(4, 64, -2, 'red_bed');
  assert.equal((await body.act({ type: 'sleep' })).detail, "it's not night and it's not a thunderstorm");
  bot.time.timeOfDay = 18000;
  assert.equal((await body.act({ type: 'sleep' })).detail, 'sleeping in the red_bed at 4 64 -2');
  assert.equal(body.perceive().sleeping, true);
  assert.equal((await body.act({ type: 'wake' })).detail, 'woke up'); assert.equal((await body.act({ type: 'wake' })).detail, 'not sleeping');
  assert.equal((await body.act({ type: 'sleep', x: 2, y: 64, z: 2 })).detail, 'oak_door at 2 64 2 is not a bed');
  assert.equal((await body.act({ type: 'mount' })).detail, 'no boat, minecart or rideable animal within 16 blocks');
  bot.entities[70] = { id: 70, name: 'oak_boat', type: 'other', position: new Vec(3, 64, 0) };
  assert.equal((await body.act({ type: 'mount' })).detail, 'got on the oak_boat'); assert.equal(body.perceive().riding, 'oak_boat');
  assert.equal((await body.act({ type: 'dismount' })).detail, 'got off'); assert.equal((await body.act({ type: 'dismount' })).detail, 'not riding anything');
  assert.equal((await body.act({ type: 'fish' })).detail, 'no fishing_rod in the inventory');
  bot.add('fishing_rod', 1);
  assert.equal((await body.act({ type: 'fish' })).detail, 'caught 1 cod');
});

test('#70: farming: till dirt, plant seeds on farmland, harvest only ripe crops and replant', async () => {
  const { bot, body } = spawned();
  bot.set(2, 63, 0, 'dirt'); bot.set(3, 63, 0, 'grass_block'); bot.set(4, 63, 0, 'dirt'); bot.set(4, 64, 0, 'stone');
  assert.equal((await body.act({ type: 'till', count: 2 })).detail, 'no hoe in the inventory');
  bot.add('iron_hoe', 1);
  assert.equal((await body.act({ type: 'till', count: 4 })).detail, 'tilled 2 blocks into farmland', 'the covered dirt is skipped');
  assert.equal(bot.blockAt(new Vec(2, 63, 0)).name, 'farmland'); assert.equal(bot.blockAt(new Vec(4, 63, 0)).name, 'dirt');
  assert.equal((await body.act({ type: 'till', x: 5, y: 63, z: 0 })).detail, 'stone cannot be tilled');
  bot.add('wheat_seeds', 1);
  assert.equal((await body.act({ type: 'plant', item: 'wheat_seeds', count: 2 })).detail, 'planted 1 wheat_seeds (1 of 2)');
  assert.equal((await body.act({ type: 'plant', item: 'carrot' })).detail, 'no carrot in the inventory');
  // One ripe and one young wheat: only the ripe one is cut, and replanted.
  bot.set(2, 64, 0, 'wheat', { props: { age: 7 } }); bot.set(3, 64, 0, 'wheat', { props: { age: 3 } }); bot.add('wheat_seeds', 2);
  const harvest = await body.act({ type: 'harvest' });
  assert.deepEqual(harvest, { type: 'harvest', ok: true, detail: 'harvested 1, replanted 1; got 1 wheat' });
  assert.equal(bot.blockAt(new Vec(3, 64, 0)).name, 'wheat'); assert.equal(bot.blockAt(new Vec(2, 64, 0)).name, 'wheat', 'replanted');
  assert.equal((await body.act({ type: 'harvest', block: 'carrots' })).detail, 'no ripe carrots within 16 blocks');
});

test('#70: breed two animals with the right food; trade lists the offers, then trades by index', async () => {
  const { bot, body } = spawned();
  bot.entities[80] = { id: 80, name: 'cow', type: 'animal', position: new Vec(3, 64, 0) };
  bot.entities[81] = { id: 81, name: 'cow', type: 'animal', position: new Vec(4, 64, 1) };
  assert.equal((await body.act({ type: 'breed', mob: 'cow' })).detail, 'breeding cow needs 2 of: wheat');
  bot.add('wheat', 3);
  assert.match((await body.act({ type: 'breed', mob: 'cow' })).detail, /^fed two cows wheat/);
  assert.deepEqual(bot.log.filter(entry => entry[0] === 'feed'), [['feed', 'cow', 'wheat'], ['feed', 'cow', 'wheat']]);
  bot.add('carrot', 2);
  assert.equal((await body.act({ type: 'breed', mob: 'pig' })).detail, 'need two pigs within 16 blocks, found 0');
  assert.equal((await body.act({ type: 'trade' })).detail, 'no villager within 16 blocks');
  bot.entities[90] = { id: 90, name: 'villager', type: 'passive', position: new Vec(5, 64, 0) };
  const offers = await body.act({ type: 'trade' });
  assert.equal(offers.detail, 'the villager offers: #0: 1 emerald -> 6 bread; #1: 20 wheat -> 1 emerald (sold out)');
  assert.match((await body.act({ type: 'trade', index: 0, count: 2 })).detail, /^traded offer #0 x2; offers: /);
  assert.deepEqual(bot.log.filter(entry => entry[0] === 'trade'), [['trade', 0, 2]]);
  assert.match((await body.act({ type: 'trade', index: 1 })).detail, /^offer #1 is sold out/);
  assert.match((await body.act({ type: 'trade', index: 5 })).detail, /^no offer #5/);
  assert.equal(bot.log.filter(entry => entry[0] === 'openVillager').length, bot.log.filter(entry => entry[0] === 'closeVillager').length);
});

test('#70: a failing timed-out action reports what it got done before', async () => {
  const { bot, body } = spawned();
  bot.add('dirt', 3);
  bot.placeBlock = async () => new Promise(() => {}); // the server never answers
  const result = await body.act({ type: 'build', blocks: [[1, 0, 1, 'dirt']] }, { timeoutMs: 30 });
  assert.equal(result.ok, false); assert.match(result.detail, /^timed out/);
});

// ---------- Commands ----------

test('#70: chat lines may be /commands (non-op permissions); the server answer comes back as an event', async () => {
  let t = 1000;
  const { bot, body, events } = spawned({ now: () => t });
  assert.deepEqual(await body.act({ type: 'say', text: '/msg Blackout\u0007 on my way' }), { type: 'say', ok: true, detail: 'sent the command' });
  assert.deepEqual(bot.said, ['/msg Blackout on my way'], 'control characters still cleaned');
  bot.emit('messagestr', 'You whisper to Blackout: on my way', 'system');
  bot.emit('messagestr', 'Blackout: hi', 'chat');
  for (let i = 0; i < 6; i++) bot.emit('messagestr', 'line ' + i, 'system');
  t += 5000; bot.emit('messagestr', 'later system line', 'system');
  const server = events.filter(event => event.type === 'server').map(event => event.text);
  assert.deepEqual(server, ['You whisper to Blackout: on my way', 'line 0', 'line 1', 'line 2'], 'at most 4 lines, only right after her own command');
  bot.emit('messagestr', 'Server restarting', 'system');
  assert.equal(events.filter(event => event.type === 'server').length, 4, 'no command, no capture');
  assert.equal(body.say('x'.repeat(500)), true); assert.equal(bot.said.at(-1).length, 240);
  // In replies the slash stays too.
  assert.equal(parseReply('{"say":"/spawn"}').say, '/spawn');
  assert.equal(parseReply('{"action":{"type":"say","text":"/home"}}').say, '/home');
  assert.match(buildPrompt({ username: 'Yakusuna', perception: {} }), /A line starting with \/ is a server command, run as a normal player without op/);
});

test('#70: the agent passes a /command through to the body and hears the server answer next turn', async () => {
  const acts = [], prompts = [];
  let handlers = null, t = 1_000_000;
  const conn = { perceive: async () => ({ spawned: true }), act: async action => { acts.push(action); return { type: action.type, ok: true, detail: 'sent the command' }; }, quit: async () => {} };
  const agent = new MinecraftAgent({ config: parseMinecraftConfig({ username: 'Yakusuna' }), now: () => t, tickMs: 60_000,
    connect: (cfg, h) => { handlers = h; return conn; }, turn: async ({ prompt }) => { prompts.push(prompt); return prompts.length === 1 ? '{"say":"/list"}' : '{}'; } });
  agent.start();
  handlers.onState('online', 'Yakusuna'); handlers.onEvent({ type: 'spawn' }); handlers.onEvent({ type: 'players', names: ['Blackout'] });
  t += 9000; await agent.tick(); await tick();
  assert.deepEqual(acts, [{ type: 'say', text: '/list' }]);
  handlers.onEvent({ type: 'server', text: 'There are 2 of a max of 10 players online: Blackout, Yakusuna' });
  t += 9000; await agent.tick(); await tick();
  assert.match(prompts[1], /the server answered your command/); assert.match(prompts[1], /the server said: There are 2 of a max/);
  await agent.stop();
});

// ---------- Perception ----------

test('#70: perception shows inventory, armor, held item, vitals, time, entities with distance and notable blocks, all bounded', () => {
  const { bot, body } = spawned({ companions: ['Cirno'] });
  bot.add('oak_log', 12); bot.add('iron_sword', 1); bot.heldItem = bot.inventory.items().find(i => i.name === 'iron_sword');
  bot.inventory.slots[5] = { name: 'iron_helmet' }; bot.inventory.slots[45] = { name: 'shield' };
  bot.oxygenLevel = 12; bot.food = 9;
  bot.set(3, 64, 0, 'chest'); bot.set(4, 64, 0, 'crafting_table'); bot.set(-3, 64, 0, 'furnace'); bot.set(5, 64, 5, 'red_bed'); bot.set(2, 64, -3, 'iron_ore'); bot.set(6, 64, -2, 'oak_log');
  bot.entities[201] = { id: 201, name: 'zombie', type: 'hostile', position: new Vec(4, 64, 0) };
  bot.entities[202] = { id: 202, name: 'cow', type: 'animal', position: new Vec(2, 64, 0) };
  bot.drop('diamond', new Vec(1, 64, 0), 2);
  const view = body.perceive();
  assert.equal(view.holding, 'iron_sword 1'); assert.equal(view.offhand, 'shield'); assert.deepEqual(view.armor, ['iron_helmet']);
  assert.ok(view.inventory.includes('oak_log 12')); assert.equal(view.oxygen, 12); assert.equal(view.food, 9); assert.equal(view.health, 20); assert.equal(view.level, 3);
  assert.equal(view.time.phase, 'day');
  assert.deepEqual(view.mobs.map(mob => [mob.name, Boolean(mob.hostile)]), [['cow', false], ['zombie', true]]);
  assert.deepEqual(view.items, [{ name: 'diamond', count: 2, distance: 1 }]);
  const names = view.blocks.map(block => block.name);
  for (const name of ['chest', 'crafting_table', 'furnace', 'red_bed', 'iron_ore', 'oak_log']) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('stone'), 'plain blocks are not listed');
  // Bounds: dozens of everything stay within the limits and the prompt state cap.
  for (let i = 0; i < 60; i++) {
    bot.players['P' + i] = { username: 'P' + i, entity: { position: new Vec(i, 64, 0) } };
    bot.entities[100 + i] = { id: 100 + i, type: 'hostile', name: 'zombie', position: new Vec(i % 20, 64, 1) };
    bot.drop('item_' + i, new Vec(i % 10, 64, 2));
    bot.add(ITEMS[i % ITEMS.length], 1);
  }
  for (const [i, name] of BLOCKS.entries()) bot.set(i - 8, 62, 3, name);
  const big = body.perceive();
  assert.ok(big.players.length <= LIMITS.players && big.mobs.length <= LIMITS.mobs && big.items.length <= LIMITS.items && big.blocks.length <= LIMITS.blocks);
  assert.ok(big.inventory.length <= LIMITS.inventory);
  const state = boundedState(big, Array.from({ length: 40 }, () => ({ what: 'e'.repeat(200) })), Array.from({ length: 40 }, () => ({ from: 'A', text: 't'.repeat(200) })));
  assert.ok(state.length <= PROMPT_LIMITS.state && PROMPT_LIMITS.state <= 6000, `state ${state.length}`);
  assert.ok(JSON.parse(state).position, 'the essentials survive the trimming');
  assert.ok(JSON.stringify(big).length < 6000, 'a busy scene fits the cap before events and chat');
});

test('#70: the prompt lists every action family, plans hold 8 steps, and a reply plan of new actions validates', () => {
  const prompt = buildPrompt({ username: 'Yakusuna', perception: { spawned: true } });
  for (const name of ACTION_TYPES.filter(type => !['drop', 'say', 'stop'].includes(type))) assert.match(prompt, new RegExp(`\\b${name} [{·(]|\\b${name}$|\\b${name} ·|\\b${name}\\b`), name);
  assert.match(prompt, /plan: up to 8 actions/);
  assert.ok(prompt.length < 12_000, `prompt ${prompt.length}`);
  const reply = parseReply(JSON.stringify({ plan: [{ type: 'collect', block: 'oak_log', count: 3 }, { type: 'craft', item: 'oak_planks', count: 12 }, { type: 'craft', item: 'crafting_table' },
    { type: 'place', item: 'crafting_table' }, { type: 'craft', item: 'wooden_pickaxe' }, { type: 'equip', item: 'wooden_pickaxe' }, { type: 'dig', block: 'stone' },
    { type: 'say', text: 'got a pickaxe!' }] }));
  assert.equal(reply.plan.length, 8); assert.deepEqual(reply.problems, []);
});

// ---------- t70: windows and inventory checks ----------
// Live on 26.1 (Yakusuna): a table craft "succeeded" with nothing made and nothing used, a smelt that worked was
// reported as a failure, and pickups showed up late. Every inventory action now measures what really changed.

// Mineflayer 4.39.0's single state id, as its inventory plugin keeps it.
function mineflayerClient() {
  const client = new EventEmitter(), bot = new EventEmitter();
  let stateId = -1;
  const listener = packet => { stateId = packet.stateId };
  client.on('window_items', listener); client.on('set_slot', listener);
  Object.assign(bot, { _client: client, currentWindow: null });
  return { bot, client, stateId: () => stateId };
}

test('t70 root cause: each window click carries its own window\'s state id, not the inventory\'s', () => {
  const { bot, client, stateId } = mineflayerClient();
  // Unpatched, the off-hand sync of window 0 the 26.1 server sends after each click overwrites the table's id.
  bot.currentWindow = { id: 1 };
  client.emit('window_items', { windowId: 1, stateId: 1 }); client.emit('set_slot', { windowId: 0, stateId: 11, slot: 45 });
  assert.equal(stateId(), 11, 'the bug: window 0\'s id would go out with the next click on window 1');
  assert.equal(patchWindowState(bot), true);
  assert.equal(patchWindowState(bot), true, 'idempotent');
  assert.equal(client.listenerCount('set_slot'), 1); assert.equal(client.listenerCount('window_items'), 1);
  client.emit('set_slot', { windowId: 1, stateId: 2, slot: 0 }); client.emit('set_slot', { windowId: 0, stateId: 12, slot: 45 });
  assert.equal(stateId(), 2, 'window 0 traffic no longer changes the open window\'s id');
  // Closed: back to window 0's latest id.
  bot.currentWindow = null; bot.emit('windowClose', { id: 1 });
  assert.equal(stateId(), 12);
  // A window whose contents came before its open_window (villagers) starts from those contents' id.
  client.emit('window_items', { windowId: 2, stateId: 7 });
  assert.equal(stateId(), 12);
  bot.currentWindow = { id: 2 }; client.emit('open_window', { windowId: 2 });
  assert.equal(stateId(), 7);
  assert.equal(patchWindowState(new EventEmitter()), false, 'no client yet');
  const early = new EventEmitter(); early._client = new EventEmitter();
  assert.equal(patchWindowState(early), false, 'Mineflayer\'s inventory plugin not injected yet');
});

test('t70: the patch recognises the state-id listener of the pinned Mineflayer', () => {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve('mineflayer/lib/plugins/inventory.js'), 'utf8');
  const line = /const listener = (packet => \{ stateId = packet\.stateId \})/.exec(source);
  assert.ok(line, 'mineflayer still keeps one state id from window_items and set_slot');
  assert.match(line[1].replace(/\s/g, ''), /^\(?packet\)?=>\{stateId=packet\.stateId;?\}$/, 'the pattern patchWindowState looks for');
});

test('t70: a craft the server did not make is a failure that says the inventory is unchanged', async () => {
  const { bot, body } = spawned();
  bot.set(2, 64, 0, 'crafting_table'); bot.add('oak_planks', 3); bot.add('stick', 2);
  const calls = [];
  bot.craft = async (recipe, times, table) => { calls.push([recipe.name, times, table?.name]); };
  const result = await body.act({ type: 'craft', item: 'wooden_pickaxe' });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'crafting wooden_pickaxe did not work: the server made none; your inventory is unchanged; used the crafting table at 2 64 0');
  assert.deepEqual(calls, [['wooden_pickaxe', 1, 'crafting_table'], ['wooden_pickaxe', 1, 'crafting_table']], 'tried once more');
  // An error from the craft is part of the answer.
  bot.craft = async () => { throw new Error('missing ingredient'); };
  assert.match((await body.act({ type: 'craft', item: 'wooden_pickaxe' })).detail, /^crafting wooden_pickaxe did not work: the server made none \(missing ingredient\)/);
});

test('t70: craft waits for the server\'s slot updates and counts what really arrived, one table craft per round', async () => {
  const { bot, body } = spawned();
  bot.set(2, 64, 0, 'crafting_table'); bot.add('oak_planks', 6); bot.add('stick', 4);
  // The server's updates arrive 10 ms after the craft call returns; the second round makes nothing.
  const real = bot.craft.bind(bot), log = [];
  bot.craft = async (recipe, times, table) => {
    log.push(times);
    if (log.length > 1) return;
    setTimeout(() => { real(recipe, times, table).catch(() => {}); }, 10);
  };
  const result = await body.act({ type: 'craft', item: 'wooden_pickaxe', count: 2 });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.detail, 'crafted 1 wooden_pickaxe (only 1 of 2: the server made no more); used the crafting table at 2 64 0; it took 3 oak_planks, 2 stick');
  assert.equal(bot.count('wooden_pickaxe'), 1);
  assert.deepEqual(log, [1, 1, 1], 'one craft per round at a table; the empty round is tried once more');
  // Both rounds made: the full count.
  bot.craft = real; bot.add('oak_planks', 3); bot.add('stick', 2);
  assert.equal((await body.act({ type: 'craft', item: 'wooden_pickaxe', count: 2 })).detail, 'crafted 2 wooden_pickaxe; used the crafting table at 2 64 0; it took 6 oak_planks, 4 stick');
});

test('t70: when the updates never come, the body asks the server for the real inventory', async () => {
  const { bot, body } = spawned();
  bot.add('oak_log', 1);
  // Mineflayer's model lost the result; only a resync shows it.
  let pending = null, syncs = 0;
  bot.craft = async () => { bot.add('oak_log', -1); bot.inventory.items().forEach(i => { if (i.name === 'oak_log') i.count = 0; }); pending = () => bot.add('oak_planks', 4); };
  bot._syncWindow = async () => { syncs++; pending?.(); pending = null; };
  const result = await body.act({ type: 'craft', item: 'oak_planks', count: 4 });
  assert.equal(result.detail, 'crafted 4 oak_planks; it took 1 oak_log');
  assert.ok(syncs >= 2, 'before the craft, and when nothing arrived');
});

test('t70: smelt reports what really came out, waits for the last item, and hands back what the fuel did not cover', async () => {
  const { bot, body } = spawned();
  bot.set(0, 64, 2, 'furnace'); bot.add('raw_iron', 10); bot.add('coal', 1);
  const result = await body.act({ type: 'smelt', item: 'raw_iron', count: 10, fuel: 'coal' });
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.detail, 'smelted 8 raw_iron: got 8 iron_ingot; 2 raw_iron not smelted (out of fuel) taken back');
  assert.equal(bot.count('iron_ingot'), 8); assert.equal(bot.count('raw_iron'), 2);
  // The output reaches the inventory only after the window is closed: still counted.
  bot.add('coal', 1);
  const opened = bot.openFurnace.bind(bot);
  bot.openFurnace = async block => { const furnace = await opened(block), take = furnace.takeOutput;
    furnace.takeOutput = async () => { const out = furnace.outputItem(), copy = { ...out }; furnace.outputItem = () => null; bot.furnaceSlots[2] = null; setTimeout(() => bot.add(copy.name, copy.count), 15); void take; };
    return furnace; };
  assert.equal((await body.act({ type: 'smelt', item: 'raw_iron', count: 2 })).detail, 'smelted 2 raw_iron: got 2 iron_ingot');
  assert.equal(bot.count('iron_ingot'), 10);
  // Taking the output failed: nothing came out, and she is told where it is.
  bot.add('raw_iron', 1); bot.add('coal', 1);
  bot.openFurnace = async block => { const furnace = await opened(block); furnace.takeOutput = async () => { throw new Error('inventory full'); }; return furnace; };
  const stuck = await body.act({ type: 'smelt', item: 'raw_iron', count: 1 });
  assert.equal(stuck.ok, false);
  assert.match(stuck.detail, /^nothing came out of the furnace; 1 iron_ingot still in the furnace's output at 0 64 2 \(inventory full\)/);
});

test('t70: deposit and withdraw report what really moved', async () => {
  const { bot, body } = spawned();
  bot.set(3, 64, 0, 'chest'); bot.add('cobblestone', 15);
  // A chest with room for 10 only.
  const open = bot.openContainer.bind(bot);
  bot.openContainer = async block => { const window = await open(block), deposit = window.deposit;
    window.deposit = async (type, m, n) => { await deposit(type, m, Math.min(n, 10)); if (n > 10) throw new Error('destination full'); };
    return window; };
  const result = await body.act({ type: 'deposit', item: 'cobblestone' });
  assert.equal(result.ok, true);
  assert.equal(result.detail, 'put 10 cobblestone in (only 10 of 15 (destination full)); chest at 3 64 0 holds: 10 cobblestone');
  assert.equal(bot.count('cobblestone'), 5);
  // A withdraw that moved nothing is a failure.
  bot.openContainer = async block => { const window = await open(block); window.withdraw = async () => {}; return window; };
  const none = await body.act({ type: 'withdraw', item: 'cobblestone' });
  assert.equal(none.ok, false); assert.equal(none.detail, 'taking cobblestone out did not work; chest at 3 64 0 holds: 10 cobblestone');
});

test('t70: toss and give count what left the inventory; give says whether they picked it up', async () => {
  const { bot, body } = spawned();
  bot.add('bread', 5);
  bot.players.Blackout = { username: 'Blackout', entity: { position: new Vec(3, 64, 0) } };
  assert.equal((await body.act({ type: 'give', player: 'Blackout', item: 'bread', count: 2 })).detail, 'dropped 2 bread for Blackout; they have not picked it up yet (it is on the ground near them)');
  const toss = bot.toss.bind(bot);
  bot.toss = async () => {};
  const result = await body.act({ type: 'toss', item: 'bread', count: 1 });
  assert.equal(result.ok, false); assert.equal(result.detail, 'tossing bread did not work: you still have 3');
  bot.toss = toss;
  assert.equal((await body.act({ type: 'toss', item: 'bread', count: 1 })).detail, 'tossed 1 bread');
});

test('t70: pick_up waits for the items to reach the inventory; nothing arriving is a failure', async () => {
  const { bot, body } = spawned();
  // The server adds picked-up items a moment after she walks over them.
  const goto = bot.pathfinder.goto;
  bot.pathfinder.goto = async goal => { const before = new Map(bot.inventory.items().map(i => [i.name, i.count])); await goto(goal);
    for (const entry of bot.inventory.items()) { const extra = entry.count - (before.get(entry.name) ?? 0); if (extra > 0) { entry.count -= extra; setTimeout(() => bot.add(entry.name, extra), 15); } } };
  bot.drop('raw_iron', { x: 2, y: 64, z: 0 }, 3);
  assert.equal((await body.act({ type: 'pick_up' })).detail, 'picked up 3 raw_iron (1 item stack nearby)');
  assert.equal(bot.count('raw_iron'), 3);
  // Items she cannot pick up (a full inventory): walking over them is not picking them up.
  bot.pathfinder.goto = async () => {};
  bot.drop('dirt', { x: 2, y: 64, z: 1 }, 2);
  const none = await body.act({ type: 'pick_up' });
  assert.equal(none.ok, false); assert.equal(none.detail, 'walked over 1 item stack but nothing reached your inventory (full, or not pickable yet)');
});

test('t70: eat checks the food was really eaten; perception counts from an open window', async () => {
  const { bot, body } = spawned();
  bot.add('bread', 2);
  bot.consume = async () => {};
  const result = await body.act({ type: 'eat' });
  assert.equal(result.ok, false); assert.equal(result.detail, 'eating bread did not work: it is still in your inventory');
  // While a window is open the server updates that window's copy of the inventory.
  bot.currentWindow = { id: 3, items: () => [{ name: 'iron_ingot', count: 3 }, { name: 'bread', count: 2 }] };
  assert.deepEqual(body.perceive().inventory, ['iron_ingot 3', 'bread 2']);
  bot.currentWindow = null;
  assert.deepEqual(body.perceive().inventory, ['bread 2']);
});

test('t70: a furnace still burning from the last smelt needs no fuel from her', async () => {
  const { bot, body } = spawned({ pace: { hit: 1, poll: 1, settle: 20, inventory: 30, sync: 10, collect: 30 } });
  bot.set(0, 64, 2, 'furnace'); bot.add('raw_iron', 2);
  const opened = bot.openFurnace.bind(bot);
  // Its burn time arrives as window properties (Mineflayer's own copy misses them: fuel stays 0).
  bot._client = new EventEmitter();
  bot.openFurnace = async block => { const furnace = await opened(block); furnace.id = 5; furnace.fuel = 0;
    setTimeout(() => { bot._client.emit('craft_progress_bar', { windowId: 5, property: 0, value: 1381 }); furnace.burnLeft = 4; }, 5); return furnace; };
  assert.equal((await body.act({ type: 'smelt', item: 'raw_iron', count: 2 })).detail, 'smelted 2 raw_iron: got 2 iron_ingot');
  assert.ok(!bot.log.some(entry => entry[0] === 'fuel'), 'no fuel added');
  // A cold furnace and no fuel: refused with the reason.
  bot.add('raw_iron', 1); bot.openFurnace = opened;
  assert.equal((await body.act({ type: 'smelt', item: 'raw_iron' })).detail, 'no fuel in the inventory (coal, charcoal, planks or logs)');
});

test('t70: a result the server left on the cursor goes back into the inventory and is counted once', async () => {
  const { bot, body } = spawned();
  bot.add('oak_planks', 4);
  const writes = [];
  bot._client = new EventEmitter();
  bot._client.write = (name, packet) => {
    writes.push([name, packet.windowId]);
    if (name === 'close_window' && packet.windowId === 0 && bot.inventory.selectedItem) { bot.add(bot.inventory.selectedItem.name, bot.inventory.selectedItem.count); bot.inventory.selectedItem = null; }
  };
  const crafts = [];
  bot.craft = async recipe => { crafts.push(recipe.name); bot.inventory.items().forEach(i => { if (i.name === 'oak_planks') i.count -= 2; }); bot.inventory.selectedItem = { name: 'stick', count: 4 }; };
  const result = await body.act({ type: 'craft', item: 'stick', count: 4 });
  assert.equal(result.detail, 'crafted 4 stick; it took 2 oak_planks');
  assert.deepEqual(crafts, ['stick'], 'not crafted a second time');
  assert.deepEqual(writes, [['close_window', 0]]);
  assert.equal(bot.count('stick'), 4);
});

test('t70: pickups arriving one stack at a time are all counted', async () => {
  const { bot, body } = spawned({ pace: { hit: 1, poll: 1, settle: 1, inventory: 400, sync: 10, collect: 30, look: 1 } });
  bot.drop('raw_iron', { x: 2, y: 64, z: 0 }, 3); bot.drop('cobblestone', { x: 2, y: 64, z: 0 }, 2);
  const goto = bot.pathfinder.goto;
  // The walk picks both up at once; the server's updates come 15 and 60 ms later.
  bot.pathfinder.goto = async goal => { await goto(goal);
    for (const [name, ms] of [['raw_iron', 15], ['cobblestone', 60]]) {
      const entry = bot.inventory.items().find(i => i.name === name);
      if (entry?.count) { const n = entry.count; entry.count = 0; setTimeout(() => bot.add(name, n), ms); }
    } };
  assert.equal((await body.act({ type: 'pick_up' })).detail, 'picked up 3 raw_iron, 2 cobblestone (2 item stacks nearby)');
});

test('t70: no X-ray: a buried ore and an ore behind a wall are neither listed nor targeted; an exposed one is, and what she saw is remembered', async () => {
  const { bot, body } = spawned();
  bot.add('stone_pickaxe', 1);
  // Buried: stone on every side (the floor below).
  bot.set(3, 64, 0, 'iron_ore'); for (const [x, y, z] of [[4, 64, 0], [2, 64, 0], [3, 64, 1], [3, 64, -1], [3, 65, 0]]) bot.set(x, y, z, 'stone');
  // In a cave: open air around it.
  bot.set(-3, 64, 2, 'diamond_ore');
  // Behind a wall: air around the ore, but a stone wall between her and it.
  for (let y = 64; y <= 70; y++) for (let z = -5; z <= 5; z++) bot.set(-6, y, z, 'stone');
  bot.set(-8, 64, 0, 'iron_ore');
  const names = () => body.perceive().blocks.map(block => block.name);
  assert.deepEqual(names().filter(name => /_ore$/.test(name)), ['diamond_ore'], 'only the exposed ore');
  assert.equal((await body.act({ type: 'dig', block: 'iron_ore' })).detail, "you haven't seen any iron_ore nearby; explore or mine to find some");
  assert.equal((await body.act({ type: 'goto', block: 'iron_ore' })).detail, "you haven't seen any iron_ore nearby; explore or mine to find some");
  // Explicit coordinates stay allowed (she can only know them from what she was shown or told).
  assert.equal((await body.act({ type: 'dig', x: 3, y: 65, z: 0 })).ok, true, 'dig the stone on top');
  assert.ok(names().includes('iron_ore'), 'mined open: now she sees it');
  // The ore behind the wall: seen from the other side, then remembered back here.
  bot.entity.position = new Vec(-9.5, 64, 0.5);
  assert.ok(body.perceive().blocks.some(block => block.name === 'iron_ore' && block.x === -8), 'seen from the other side');
  bot.entity.position = new Vec(0.5, 64, 0.5);
  const far = await body.act({ type: 'dig', block: 'iron_ore' });
  assert.equal(far.ok, true, far.detail);
  // A remembered block that changed is forgotten.
  bot.set(-8, 64, 0, 'stone'); bot.set(3, 64, 0, 'stone');
  assert.equal((await body.act({ type: 'collect', block: 'iron_ore' })).detail, "you haven't seen any iron_ore nearby; explore or mine to find some");
  assert.equal((await body.act({ type: 'collect', block: 'diamond_ore' })).ok, true, 'the exposed one is collected');
});
