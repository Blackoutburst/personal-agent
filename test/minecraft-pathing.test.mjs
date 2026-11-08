// t70 (doors): walking takes the door, not the wall. The real mineflayer-pathfinder 2.4.5 planner (Movements + A*) on
// a fake 26.1.2 block world (minecraft-data, prismarine-block), and the body's two passes and door keeper on fakes.
// No server, no network, no model. The planner tests skip when the packages are missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { BotBody, configureMovements, fixDoorNodes, BUILT, NATURAL, DIG_COST } from '../src/minecraft-body.mjs';

const require = createRequire(import.meta.url);
function packages() {
  try {
    return { registry: require('minecraft-data')('26.1.2'), Block: require('prismarine-block')(require('minecraft-data')('26.1.2')), Vec3: require('vec3').Vec3,
      Movements: require('mineflayer-pathfinder/lib/movements'), AStar: require('mineflayer-pathfinder/lib/astar'),
      Move: require('mineflayer-pathfinder/lib/move'), goals: require('mineflayer-pathfinder/lib/goals') };
  } catch { return null; }
}

// A stone floor at y 63, she walks at y 64. hut: a 5x5 plank (or stone brick) hut from x -2..2, z -2..2, walls 3 high,
// a roof, a wooden door in the south wall at (0, 64, 2) unless door is false, optionally a bed inside.
function hutWorld(p, { wall = 'oak_planks', door = 'oak_door', open = false, bed = false } = {}) {
  const { registry, Block, Vec3 } = p, blocks = new Map(), key = (x, y, z) => `${x},${y},${z}`;
  const state = (name, props = {}) => {
    const def = registry.blocksByName[name];
    if (!Object.keys(props).length) return def.defaultState;
    for (let id = def.minStateId; id <= def.maxStateId; id++) {
      const got = Block.fromStateId(id, 0).getProperties();
      if (Object.entries(props).every(([k, v]) => got[k] === v)) return id;
    }
    throw new Error(`no state ${name} ${JSON.stringify(props)}`);
  };
  const set = (x, y, z, name, props) => blocks.set(key(x, y, z), state(name, props));
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) { set(x, 63, z, 'stone'); set(x, 62, z, 'stone'); set(x, 61, z, 'stone'); }
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    for (let y = 64; y <= 66; y++) if (Math.abs(x) === 2 || Math.abs(z) === 2) set(x, y, z, wall);
    set(x, 67, z, wall);
  }
  if (door) {
    set(0, 64, 2, door, { half: 'lower', facing: 'south', open, hinge: 'left' }); set(0, 65, 2, door, { half: 'upper', facing: 'south', open, hinge: 'left' });
  }
  if (bed) set(-1, 64, -1, 'red_bed', { part: 'head', facing: 'north' });
  const bot = { registry, entity: { position: new Vec3(0.5, 64, 6.5), effects: {}, onGround: true }, entities: {}, game: { minY: -64 },
    inventory: { items: () => [] }, pathfinder: { bestHarvestTool: () => null },
    blockAt(pos) {
      const id = blocks.get(key(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))) ?? (Math.floor(pos.y) < 61 ? state('stone') : state('air'));
      const block = Block.fromStateId(id, 0); block.position = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)); return block;
    },
    findBlocks({ matching }) { return [...blocks].filter(([, id]) => matching.includes(Block.fromStateId(id, 0).type)).map(([k]) => new Vec3(...k.split(',').map(Number))); } };
  return { bot, set, name: (x, y, z) => bot.blockAt({ x, y, z }).name };
}

function plan(p, bot, movements, from, goal) {
  const start = new p.Move(from.x, from.y, from.z, movements.countScaffoldingItems(), 0);
  const result = new p.AStar(start, movements, goal, 4000, 4000, 24).compute();
  return { status: result.status, path: result.path, broken: result.path.flatMap(move => move.toBreak.map(b => bot.blockAt(b).name)),
    through: result.path.some(move => move.x === 0 && move.z === 2) };
}
const movementsFor = (p, bot, dig, protectedAt = []) => configureMovements(new p.Movements(bot), bot.registry, { dig, protectedAt });

test('t70: the building-block and natural-ground lists', () => {
  for (const name of ['oak_planks', 'spruce_planks', 'stone_bricks', 'mossy_stone_bricks', 'bricks', 'glass', 'glass_pane', 'white_stained_glass_pane', 'white_wool', 'red_bed',
    'oak_door', 'iron_door', 'oak_trapdoor', 'oak_fence', 'oak_fence_gate', 'cobblestone_wall', 'chest', 'barrel', 'furnace', 'blast_furnace', 'crafting_table', 'torch',
    'wall_torch', 'lantern', 'oak_sign', 'oak_wall_sign', 'rail', 'glowstone', 'white_carpet', 'farmland', 'wheat', 'white_concrete', 'terracotta', 'oak_stairs', 'stone_slab', 'ladder'])
    assert.ok(BUILT.test(name), name);
  for (const name of ['stone', 'dirt', 'grass_block', 'sand', 'red_sand', 'gravel', 'oak_log', 'oak_leaves', 'iron_ore', 'deepslate_diamond_ore', 'deepslate', 'netherrack', 'cobblestone'])
    assert.ok(!BUILT.test(name), name);
  for (const name of ['stone', 'dirt', 'grass_block', 'sand', 'gravel', 'iron_ore', 'oak_leaves', 'deepslate', 'netherrack']) assert.ok(NATURAL.test(name), name);
  for (const name of ['oak_planks', 'stone_bricks', 'cobblestone', 'oak_door', 'glass', 'oak_log', 'chest']) assert.ok(!NATURAL.test(name), `${name} is not dug by escape`);
});

test('t70: the planner walks through a closed wooden door into a plank hut and out again, breaking nothing (skipped without packages)', t => {
  const p = packages();
  if (!p) { t.skip('pathfinder packages not installed'); return; }
  const { bot } = hutWorld(p);
  const inside = new p.goals.GoalBlock(0, 64, 0), outside = new p.goals.GoalBlock(0, 64, 6);
  for (const dig of [false, true]) {
    const inward = plan(p, bot, movementsFor(p, bot, dig), { x: 0, y: 64, z: 6 }, inside);
    assert.equal(inward.status, 'success', `dig ${dig}`); assert.deepEqual(inward.broken, [], `dig ${dig}: nothing broken`); assert.ok(inward.through, 'through the doorway');
    const outward = plan(p, bot, movementsFor(p, bot, dig), { x: 0, y: 64, z: 0 }, outside);
    assert.equal(outward.status, 'success'); assert.deepEqual(outward.broken, []); assert.ok(outward.through);
  }
  // A stone-brick hut, and an open door: the same.
  const bricks = hutWorld(p, { wall: 'stone_bricks', open: true });
  const viaOpen = plan(p, bricks.bot, movementsFor(p, bricks.bot, false), { x: 0, y: 64, z: 6 }, inside);
  assert.equal(viaOpen.status, 'success'); assert.deepEqual(viaOpen.broken, []); assert.ok(viaOpen.through);
  // Before the fix (the pathfinder's own setup since #70: digging at cost 1, doors usable): it tunnels in.
  const old = new p.Movements(bot); old.canDig = true; old.canOpenDoors = true;
  const before = plan(p, bot, old, { x: 0, y: 64, z: 6 }, inside);
  assert.ok(before.broken.length > 0, `the old setup breaks blocks: ${before.broken.join(', ')}`);
});

test('t70: no door: the walk pass finds no way, the dig pass never breaks a wall and nothing near a bed or door (skipped without packages)', t => {
  const p = packages();
  if (!p) { t.skip('pathfinder packages not installed'); return; }
  const inside = new p.goals.GoalBlock(0, 64, 0);
  const sealed = hutWorld(p, { door: false });
  assert.equal(plan(p, sealed.bot, movementsFor(p, sealed.bot, false), { x: 0, y: 64, z: 6 }, inside).status, 'noPath');
  const dug = plan(p, sealed.bot, movementsFor(p, sealed.bot, true), { x: 0, y: 64, z: 6 }, inside);
  assert.ok(dug.broken.every(name => NATURAL.test(name)), `only natural ground: ${dug.broken.join(', ')}`);
  assert.ok(!dug.broken.some(name => BUILT.test(name)));
  // A bed inside: nothing within 3 blocks of it is broken, so there is no way in at all.
  const withBed = hutWorld(p, { door: false, bed: true });
  const spots = withBed.bot.findBlocks({ matching: [p.registry.blocksByName.red_bed.id] });
  assert.equal(plan(p, withBed.bot, movementsFor(p, withBed.bot, true, spots), { x: 0, y: 64, z: 6 }, inside).status, 'noPath');
  const moves = movementsFor(p, sealed.bot, true);
  assert.equal(moves.canDig, true); assert.ok(moves.digCost >= 10); assert.equal(DIG_COST, moves.digCost);
  assert.ok(moves.blocksCantBreak.has(p.registry.blocksByName.oak_planks.id)); assert.ok(!moves.blocksCantBreak.has(p.registry.blocksByName.oak_log.id), 'logs stay breakable');
  const iron = hutWorld(p, { door: 'iron_door' });
  assert.equal(plan(p, iron.bot, movementsFor(p, iron.bot, false), { x: 0, y: 64, z: 6 }, inside).status, 'noPath', 'an iron door needs redstone: not a doorway');
});

// ---------- The body: two passes and the door keeper ----------

class Vec {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  offset(dx, dy, dz) { return new Vec(this.x + dx, this.y + dy, this.z + dz); }
  floored() { return new Vec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
}
function fakeWalker({ noPathFirst = false } = {}) {
  const bot = new EventEmitter(), moves = [], doors = new Map(), activated = [];
  const door = (x, y, z, open = false) => { doors.set(`${x},${y},${z}`, { open, half: 'lower' }); doors.set(`${x},${y + 1},${z}`, { open, half: 'upper' }); };
  Object.assign(bot, { username: 'Yakusuna', entity: { position: new Vec(0.5, 64, 4.5), id: 1 }, registry: { blocksByName: { stone: { id: 1, name: 'stone' }, oak_door: { id: 2, name: 'oak_door' } }, itemsByName: {} },
    players: {}, entities: {}, inventory: { items: () => [], slots: [] },
    blockAt(pos) {
      const k = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`, d = doors.get(k);
      const position = new Vec(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
      if (d) return { name: 'oak_door', type: 2, position, boundingBox: 'block', getProperties: () => ({ open: d.open, half: d.half }) };
      return { name: pos.y < 64 ? 'stone' : 'air', type: pos.y < 64 ? 1 : 0, position, boundingBox: pos.y < 64 ? 'block' : 'empty', getProperties: () => ({}) };
    },
    async activateBlock(block) {
      activated.push(`${block.position.x},${block.position.y},${block.position.z}`);
      for (const dy of [0, 1]) { const d = doors.get(`${block.position.x},${block.position.y + dy},${block.position.z}`); if (d) d.open = !d.open; }
    },
    findBlocks: () => [], chat() {}, quit() {}, setControlState() {} });
  let calls = 0;
  bot.pathfinder = { setMovements(m) { moves.push(m.canDig); }, setGoal() {}, stop() {},
    async goto() { calls++; if (noPathFirst && calls === 1) { const error = new Error('No path to the goal!'); error.name = 'NoPath'; throw error; } } };
  const goal = name => class { constructor(...args) { this.kind = name; this.args = args; } isEnd() { return true; } };
  const pathfinder = { pathfinder: () => {}, Movements: class { constructor() { this.blocksCantBreak = new Set(); this.exclusionAreasBreak = []; } },
    goals: { GoalNear: goal('near'), GoalNearXZ: goal('nearxz'), GoalFollow: goal('follow'), GoalInvert: goal('invert') } };
  const body = new BotBody({ bot, pathfinder, scanMs: 60_000 });
  body.attach(); bot.emit('spawn');
  return { bot, body, moves, door, doors, activated, calls: () => calls };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('t70: goto plans on foot first and digs only when that finds no way; the movements go back to walking', async () => {
  const easy = fakeWalker();
  assert.equal((await easy.body.act({ type: 'goto', x: 3, y: 64, z: 3 })).ok, true);
  assert.equal(easy.calls(), 1); assert.ok(!easy.moves.includes(true), 'never digs when the walk works');
  const hard = fakeWalker({ noPathFirst: true });
  assert.equal((await hard.body.act({ type: 'goto', x: 3, y: 64, z: 3 })).ok, true);
  assert.equal(hard.calls(), 2); assert.deepEqual(hard.moves.slice(-3), [false, true, false], 'walk, then dig, then back to walking');
});

test('t70 tunneling: an empty "noPath" (walled in underground) resolves goto in mineflayer-pathfinder, and still brings the dig pass', async () => {
  const walled = fakeWalker();
  let calls = 0, ended = false;
  walled.bot.pathfinder.goto = async () => {
    calls++;
    if (calls === 1) { walled.bot.emit('path_update', { status: 'noPath', path: [] }); return; } // resolves: no error
    ended = true;
  };
  // Not at the goal after the walk pass: isEnd is false until the dig pass got her there.
  const NearFalse = class { constructor(...args) { this.args = args; } isEnd() { return ended; } };
  const result = await (async () => {
    const pf = { pathfinder: () => {}, Movements: class { constructor() { this.blocksCantBreak = new Set(); this.exclusionAreasBreak = []; } },
      goals: { GoalNear: NearFalse, GoalNearXZ: NearFalse, GoalFollow: NearFalse, GoalInvert: NearFalse } };
    const body = new BotBody({ bot: walled.bot, pathfinder: pf, scanMs: 60_000 }); body.attach();
    return body.act({ type: 'goto', x: 3, y: 64, z: 3 });
  })();
  assert.equal(calls, 2, 'the dig pass ran'); assert.equal(result.ok, true, result.detail);
  assert.deepEqual(walled.moves.slice(-3), [false, true, false]);
});

test('t70: the door keeper opens a closed door on her path and closes it behind her', async () => {
  const { bot, body, door, doors, activated } = fakeWalker();
  door(0, 64, 2);
  let release;
  bot.pathfinder.goto = () => new Promise(resolve => { release = resolve; });
  const walking = body.act({ type: 'goto', x: 0, y: 64, z: -2 });
  await sleep(20);
  bot.emit('path_update', { status: 'success', path: [{ x: 0.5, y: 64, z: 3.5 }, { x: 0.5, y: 64, z: 2.5 }, { x: 0.5, y: 64, z: 1.5 }] });
  await sleep(250);
  assert.deepEqual(activated, ['0,64,2'], 'opened once'); assert.equal(doors.get('0,64,2').open, true);
  // She walks through and on: past the door, it is closed behind her.
  bot.entity.position = new Vec(0.5, 64, 2.5); bot.emit('path_update', { status: 'success', path: [{ x: 0.5, y: 64, z: 1.5 }, { x: 0.5, y: 64, z: 0.5 }] });
  await sleep(350);
  assert.equal(activated.length, 1, 'not closed while she stands in the doorway');
  bot.entity.position = new Vec(0.5, 64, -0.5); bot.emit('path_update', { status: 'success', path: [{ x: 0.5, y: 64, z: -1.5 }] });
  await sleep(350);
  assert.deepEqual(activated, ['0,64,2', '0,64,2']); assert.equal(doors.get('0,64,2').open, false, 'closed behind her');
  release();
  assert.equal((await walking).ok, true);
});

test('t70: an open door on her path is left alone; a door far away is never touched', async () => {
  const { bot, body, door, activated } = fakeWalker();
  door(0, 64, 2, true); door(9, 64, 9);
  let release;
  bot.pathfinder.goto = () => new Promise(resolve => { release = resolve; });
  const walking = body.act({ type: 'goto', x: 0, y: 64, z: -2 });
  await sleep(20);
  bot.emit('path_update', { status: 'success', path: [{ x: 0.5, y: 64, z: 3.5 }, { x: 0.5, y: 64, z: 2.5 }] });
  await sleep(250);
  assert.deepEqual(activated, []);
  release(); await walking;
  assert.deepEqual(activated, [], 'she did not walk through it: nothing to close');
});

test('t70: a path step through a doorway is put back in the doorway, not on top of the door\'s panel', () => {
  const doorAt = { x: 0, y: -60, z: 8 };
  const blockAt = p => {
    if (p.x === 0 && p.z === 8 && (p.y === -60 || p.y === -59)) return { name: 'oak_door', position: { x: 0, y: p.y, z: 8 }, getProperties: () => ({ half: p.y === -60 ? 'lower' : 'upper' }) };
    if (p.x === 3 && p.z === 3 && p.y === -60) return { name: 'oak_fence_gate', position: { x: 3, y: -60, z: 3 }, getProperties: () => ({ open: false }) };
    return { name: p.y < -60 ? 'grass_block' : 'air', position: p, getProperties: () => ({}) };
  };
  // As mineflayer-pathfinder 2.4.5's postProcessPath leaves them (measured: 0.296875,-59,8.5 for this doorway).
  const path = [{ x: 0.5, y: -60, z: 9.5, toBreak: [], toPlace: [] }, { x: 0.296875, y: -59, z: 8.5, toBreak: [], toPlace: [] },
    { x: 3.5, y: -58.5, z: 3.5, toBreak: [], toPlace: [] }, { x: 0.5, y: -60, z: 7.5, toBreak: [], toPlace: [] }];
  assert.equal(fixDoorNodes(blockAt, path), 2);
  assert.deepEqual(path.map(p => [p.x, p.y, p.z]), [[0.5, -60, 9.5], [0.5, doorAt.y, 8.5], [3.5, -60, 3.5], [0.5, -60, 7.5]]);
  assert.equal(fixDoorNodes(blockAt, path), 0, 'idempotent');
  assert.equal(fixDoorNodes(blockAt, null), 0);
});
