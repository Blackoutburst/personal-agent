// t70: movement that is checked against where she really is, and getting out of water, holes and pits. A fake bot in a
// small block world with a crude physics tick (swimming up, jumping, walls, leaving the water at a ledge, the server
// refusing a block placed inside her). No server, no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BotBody, validateAction, actionTimeout, patchPhysics, PHYSICS_HALF_WIDTH } from '../src/minecraft-body.mjs';

class Vec {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  offset(dx, dy, dz) { return new Vec(this.x + dx, this.y + dy, this.z + dz); }
  plus(v) { return new Vec(this.x + v.x, this.y + v.y, this.z + v.z); }
  floored() { return new Vec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
}
const NAMES = ['air', 'stone', 'dirt', 'water', 'bedrock'];
const REGISTRY = { blocksByName: Object.fromEntries(NAMES.map((name, id) => [name, { id, name }])), itemsByName: { dirt: { id: 100, name: 'dirt' }, cobblestone: { id: 101, name: 'cobblestone' } } };
const GROUND = 60; // she stands at y 60 on the surface; stone below

// world: 'pit' (1x1, 3 deep, dry), 'water' (1x1, 4 deep, full of water), 'flat'. walks: whether the pathfinder moves
// her when she is out on the surface (it never does from inside water or a hole, like the real one there).
function world({ kind = 'flat', walls = 'stone', items = [], ceiling = false, walks = true } = {}) {
  const bot = new EventEmitter(), blocks = new Map(), controls = {}, inventory = items.map(([name, count]) => ({ name, count, type: REGISTRY.itemsByName[name].id }));
  const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  const name = (x, y, z) => blocks.get(key(x, y, z)) ?? (y < GROUND ? walls : 'air');
  const solid = (x, y, z) => !['air', 'water'].includes(name(x, y, z));
  const water = (x, y, z) => name(x, y, z) === 'water';
  if (kind === 'pit') for (let y = GROUND - 3; y < GROUND; y++) blocks.set(key(0, y, 0), 'air');
  if (kind === 'water') for (let y = GROUND - 4; y < GROUND; y++) blocks.set(key(0, y, 0), 'water');
  const bottom = kind === 'pit' ? GROUND - 3 : kind === 'water' ? GROUND - 4 : GROUND;
  if (ceiling) blocks.set(key(0, bottom + 2, 0), 'stone');
  let vy = 0, look = null;
  const entity = { position: new Vec(0.5, bottom, 0.5), yaw: 0, get isInWater() { return water(this.position.x, this.position.y, this.position.z); } };
  const onGround = () => { const p = entity.position; return p.y === Math.floor(p.y) && solid(p.x, p.y - 1, p.z); };
  // One physics tick.
  const tick = () => {
    const p = entity.position, inWater = entity.isInWater;
    if (inWater) vy = controls.jump ? 0.12 : -0.05;
    else if (controls.jump && onGround()) vy = 0.42;
    else if (!onGround()) vy -= 0.08; else vy = 0;
    let { x, z } = p;
    if (controls.forward && look) {
      const dx = look.x - p.x, dz = look.z - p.z, d = Math.hypot(dx, dz);
      if (d > 0.05) {
        const nx = p.x + dx / d * Math.min(0.2, d), nz = p.z + dz / d * Math.min(0.2, d);
        if (!solid(nx, p.y, nz) && !solid(nx, p.y + 1, nz)) { x = nx; z = nz; }
        else if (inWater && !solid(nx, p.y + 1, nz) && !solid(nx, p.y + 2, nz)) vy = 0.3; // out of the water onto a ledge
      }
    }
    let y = p.y + vy;
    if (vy < 0 && solid(x, y, z)) { y = Math.floor(y) + 1; vy = 0; }
    if (vy > 0 && solid(x, y + 1.8, z)) { y = Math.floor(y + 1.8) - 1.8; vy = 0; }
    entity.position = new Vec(x, y, z);
  };
  const timer = setInterval(tick, 1);
  timer.unref();
  Object.assign(bot, { username: 'Yakusuna', entity, registry: REGISTRY, oxygenLevel: 20, health: 20, food: 20, players: {}, entities: {}, heldItem: null, controls, placed: [],
    physics: { playerHalfWidth: 0.3 },
    inventory: { items: () => inventory.filter(item => item.count > 0), slots: [] },
    blockAt(p) {
      const n = name(p.x, p.y, p.z);
      return { name: n, type: REGISTRY.blocksByName[n].id, position: new Vec(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: solid(p.x, p.y, p.z) ? 'block' : 'empty',
        hardness: n === 'bedrock' ? null : 1, getProperties: () => ({}) };
    },
    setControlState(control, state) { controls[control] = state; },
    getControlState(control) { return controls[control] === true; },
    async lookAt(target) { look = target; },
    async equip(item) { bot.heldItem = item; },
    canDigBlock: () => true,
    async dig(block) { blocks.set(key(block.position.x, block.position.y, block.position.z), 'air'); },
    async placeBlock(reference, face) {
      const t = reference.position.plus(face), p = entity.position;
      if (!bot.heldItem?.count) throw new Error('nothing held');
      // The server refuses a block that would be inside her.
      if (t.x === Math.floor(p.x) && t.z === Math.floor(p.z) && t.y + 1 > p.y && t.y < p.y + 1.8) throw new Error(`No block has been placed : the block is still ${name(t.x, t.y, t.z)}`);
      blocks.set(key(t.x, t.y, t.z), bot.heldItem.name); bot.heldItem.count--; bot.placed.push([t.x, t.y, t.z]);
    },
    chat() {}, quit() {}, stop: () => clearInterval(timer), blocks, solid, water });
  const goal = kind => class { constructor(...args) { this.kind = kind; this.args = args; } };
  bot.pathfinder = { setMovements() {}, setGoal() {}, stop() {}, gotos: 0,
    async goto(g) {
      bot.pathfinder.gotos++;
      const p = entity.position;
      // Like mineflayer-pathfinder: from water or the bottom of a hole it finds an empty path and resolves at once.
      if (!walks || entity.isInWater || p.y < GROUND) return;
      entity.position = new Vec(g.args[0], g.kind === 'nearxz' ? GROUND : g.args[1], g.kind === 'nearxz' ? g.args[1] : g.args[2]);
    } };
  const pathfinder = { pathfinder: () => {}, Movements: class { constructor() { this.scafoldingBlocks = []; } },
    goals: { GoalNear: goal('near'), GoalNearXZ: goal('nearxz'), GoalFollow: goal('follow'), GoalInvert: goal('invert') } };
  const body = new BotBody({ bot, pathfinder, scanMs: 60_000, pace: { hit: 1, poll: 1, settle: 5, rise: 400, swim: 2500, step: 600 } });
  body.attach(); bot.emit('login'); bot.emit('spawn');
  return { bot, body, done: () => { clearInterval(timer); body.detach(); } };
}

test('t70 root cause: the physics hitbox is widened a hair so the 26.1 server accepts moves along a wall', () => {
  const bot = new EventEmitter();
  assert.equal(patchPhysics(bot), false, 'no physics plugin yet: nothing to patch');
  bot.physics = { playerHalfWidth: 0.3 };
  assert.equal(patchPhysics(bot), true); assert.equal(bot.physics.playerHalfWidth, PHYSICS_HALF_WIDTH);
  assert.ok(PHYSICS_HALF_WIDTH > Math.fround(0.3) && PHYSICS_HALF_WIDTH - 0.3 < 0.0001, 'wider than the server\'s 0.6f box, by a negligible amount');
  bot.physics.playerHalfWidth = 0.4; patchPhysics(bot); assert.equal(bot.physics.playerHalfWidth, 0.4, 'never narrows');
  // The body patches it when Mineflayer has injected its physics (at login and spawn, after attach()).
  const { bot: real, done } = world();
  assert.equal(real.physics.playerHalfWidth, PHYSICS_HALF_WIDTH);
  done();
});

test('t70: goto reports where she really is: an "arrival" without moving is a failure', async () => {
  const { body, done } = world({ walks: false });
  const result = await body.act({ type: 'goto', x: 6, y: GROUND, z: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'did not get there: the path finder found no way; still at 0 60 0 (moved 0 blocks)');
  done();
});

test('t70: goto from a water-filled hole swims out first, then walks, and says so', async () => {
  const { bot, body, done } = world({ kind: 'water' });
  assert.equal(body.perceive().inWater, true, 'perception says she is in water');
  const result = await body.act({ type: 'goto', x: 6, y: GROUND, z: 0 });
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /^arrived near 6 60 0; now at 6 60 0 \(first got out: swam up and out \(4(?:\.\d)? blocks up\); now at -?\d+ 60 -?\d+\)$/);
  assert.equal(bot.pathfinder.gotos, 2, 'walked, escaped, walked again');
  assert.equal(bot.controls.jump, false); assert.equal(bot.controls.forward, false); assert.equal(bot.controls.sprint, false);
  done();
});

test('t70: jump succeeds only when she leaves the ground', async () => {
  const flat = world();
  assert.match((await flat.body.act({ type: 'jump' })).detail, /^jumped \((?:0\.[5-9]|1(?:\.\d)?) blocks up\)$/);
  assert.equal(flat.bot.controls.jump, false);
  flat.done();
  const low = world({ kind: 'pit', ceiling: true });
  const result = await low.body.act({ type: 'jump' });
  assert.deepEqual(result, { type: 'jump', ok: false, detail: 'did not leave the ground (rose 0.2; still at 0 57 0): a block is right above your head' });
  low.done();
});

test('t70: swim reports what she really did, and fails when she did not move', async () => {
  const pool = world({ kind: 'water' });
  const result = await pool.body.act({ type: 'swim', seconds: 1 });
  assert.equal(result.ok, true);
  assert.match(result.detail, /^swam 1s: rose [34](?:\.\d)? blocks; now at 0 (?:58|59|60) 0, head above water$/);
  assert.equal(pool.bot.controls.jump, false);
  pool.done();
  const capped = world({ kind: 'water', ceiling: true });
  const stuck = await capped.body.act({ type: 'swim', seconds: 1, forward: true });
  assert.deepEqual(stuck, { type: 'swim', ok: false, detail: 'swam for 1s but did not move: still at 0 56 0, head under water; try escape' });
  assert.equal(capped.bot.controls.sprint, false, 'sprint-swim is released');
  capped.done();
});

test('t70: escape swims out of a water-filled hole', async () => {
  const { bot, body, done } = world({ kind: 'water', items: [['dirt', 8]] });
  const result = await body.act({ type: 'escape' });
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /^got out: swam up and out \(4(?:\.\d)? blocks up\); now at -?\d+ 60 -?\d+$/);
  assert.equal(bot.placed.length, 0, 'no block needed');
  assert.equal(bot.entity.isInWater, false);
  done();
});

test('t70: escape pillars out of a dry pit with a scaffold block, placing each block only once she is high enough', async () => {
  const { bot, body, done } = world({ kind: 'pit', items: [['dirt', 8]] });
  const result = await body.act({ type: 'escape' });
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /^got out: pillared up 2 dirt blocks and stepped out \(3(?:\.\d)? blocks up\); now at -?\d+ 60 -?\d+$/);
  assert.deepEqual(bot.placed, [[0, 57, 0], [0, 58, 0]]);
  done();
});

test('t70: escape digs stairs out of a pit when there is nothing to pillar with', async () => {
  const { body, done } = world({ kind: 'pit', walls: 'dirt' });
  const result = await body.act({ type: 'escape' });
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /^got out: dug 3 stair steps out \(3(?:\.\d)? blocks up\); now at -?\d+ 60 -?\d+ \(pillaring: no dirt, cobblestone or planks to pillar with\)$/);
  done();
});

test('t70: escape says honestly when nothing worked, and when she was not stuck', async () => {
  const trapped = world({ kind: 'pit', walls: 'bedrock' });
  const result = await trapped.body.act({ type: 'escape' });
  assert.deepEqual(result, { type: 'escape', ok: false,
    detail: 'still stuck at 0 57 0 (moved 0 blocks; the rim is at y 60): pillaring: no dirt, cobblestone or planks to pillar with; digging stairs did not get you out' });
  trapped.done();
  const flat = world();
  assert.deepEqual(await flat.body.act({ type: 'escape' }), { type: 'escape', ok: true, detail: 'not stuck: there is a way out on foot from 0 60 0' });
  flat.done();
});

test('t70: place below in water rises a full block first, so the server accepts it', async () => {
  const { bot, body, done } = world({ kind: 'water', items: [['dirt', 4]] });
  const result = await body.act({ type: 'place', item: 'dirt', at: 'below' });
  assert.deepEqual(result, { type: 'place', ok: true, detail: 'swam up and placed dirt under you at 0 56 0' });
  assert.deepEqual(bot.placed, [[0, 56, 0]]);
  done();
});

test('t70: escape is a closed, argument-free action with its own time limit', () => {
  assert.deepEqual(validateAction({ type: 'escape' }), { action: { type: 'escape' } });
  assert.equal(validateAction({ type: 'escape', x: 1 }).error, 'escape takes no arguments');
  assert.equal(actionTimeout({ type: 'escape' }), 120_000);
});
