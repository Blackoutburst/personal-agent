// The companion's body in Minecraft (#68, #70, docs/MINECRAFT.md): what it perceives, which events it notices and the
// closed set of skills it can run. It drives one Mineflayer bot object and never decides anything itself: the
// companion's turns (src/minecraft.mjs) choose the actions. Everything here works on an injected bot, so tests use
// a fake one and the worker (src/minecraft-worker.mjs) a real Mineflayer bot.
//
// #70: the skills cover what a normal survival player does (walk, dig and build, craft and smelt, items, fight,
// containers, beds, farming, animals, villagers, server commands as a non-op player). The vocabulary stays closed: no
// action runs code, reads files or reaches anything outside the game, because the worker runs as the service user.

export const ACTION_TYPES = Object.freeze([
  'say', 'goto', 'follow', 'wander', 'look_at', 'jump', 'sprint', 'sneak', 'swim',
  'dig', 'collect', 'pick_up', 'place', 'build',
  'craft', 'smelt',
  'equip', 'unequip', 'toss', 'drop', 'give', 'use_item', 'eat',
  'attack', 'shield', 'defend',
  'open', 'deposit', 'withdraw',
  'activate', 'sleep', 'wake', 'mount', 'dismount', 'fish', 'till', 'plant', 'harvest', 'breed', 'trade',
  'stop']);
// Fixed per-action time limits (ms). Actions with a size (count, blocks, seconds) get theirs from actionTimeout().
export const ACTION_TIMEOUTS = Object.freeze({ say: 2000, goto: 90_000, wander: 60_000, look_at: 3000, jump: 3000, sprint: 1000, sneak: 1000,
  dig: 60_000, pick_up: 30_000, place: 30_000, equip: 5000, unequip: 5000, toss: 10_000, drop: 10_000, give: 60_000, eat: 10_000,
  attack: 60_000, open: 45_000, deposit: 45_000, withdraw: 45_000, activate: 30_000, sleep: 45_000, wake: 5000, mount: 30_000,
  dismount: 5000, trade: 45_000, breed: 45_000, stop: 1000 });
export const LIMITS = Object.freeze({ gotoDistance: 256, wanderMin: 8, wanderMax: 64, followMax: 8, followMaxSeconds: 120,
  collectMax: 64, collectRange: 32, pickupRange: 16, sayChars: 240, players: 8, mobs: 8, items: 8, blocks: 12, inventory: 36, scanRange: 16,
  mobRange: 24, findRange: 64, blockRange: 64, buildBlocks: 64, buildOffset: 16, craftMax: 64, smeltMax: 64, tossMax: 2304, attackRange: 32,
  defendMaxSeconds: 300, defendRange: 12, swimMaxSeconds: 30, shieldMaxSeconds: 30, useMaxSeconds: 5, fishMaxSeconds: 120, farmRange: 16,
  farmMax: 64, entityRange: 16, resultChars: 400, commandLines: 4 });
// Blocks worth noticing as a "found" event (once per position): rare things.
const NOTABLE = /^(?:deepslate_)?(?:diamond|emerald|gold|lapis|redstone)_ore$|^(?:ancient_debris|spawner|chest|trial_spawner|vault|nether_portal|end_portal_frame|budding_amethyst|bee_nest|suspicious_sand|suspicious_gravel)$/;
// Blocks shown in the perception: places to use and resources.
const PERCEIVED = /_bed$|_ore$|_log$|_stem$|shulker_box$|^(?:chest|trapped_chest|barrel|ender_chest|crafting_table|furnace|blast_furnace|smoker|anvil|enchanting_table|brewing_stand|ancient_debris|spawner|nether_portal|farmland|composter|bell|lectern)$/;
const CONTAINER = /shulker_box$|^(?:chest|trapped_chest|barrel|ender_chest)$/;
const FURNACE = /^(?:furnace|blast_furnace|smoker)$/;
const OPENABLE = /shulker_box$|^(?:chest|trapped_chest|barrel|ender_chest|hopper|dispenser|dropper|crafter)$/;
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'snow', 'dead_bush', 'seagrass', 'tall_seagrass', 'vine', 'fire', 'bubble_column']);
const HOSTILE_NAMES = new Set(['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'creeper', 'spider', 'cave_spider',
  'witch', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'blaze', 'ghast', 'hoglin', 'zoglin', 'piglin_brute',
  'guardian', 'elder_guardian', 'silverfish', 'endermite', 'shulker', 'warden', 'breeze', 'creaking']);
const RIDEABLE = /boat$|raft$|minecart$|^(?:horse|donkey|mule|pig|strider|camel|llama|skeleton_horse|zombie_horse)$/;
const ARMOR = [[/_helmet$|^carved_pumpkin$|_skull$|_head$/, 'head'], [/_chestplate$|^elytra$/, 'torso'], [/_leggings$/, 'legs'], [/_boots$/, 'feet']];
const SLOTS = Object.freeze({ hand: 'hand', 'off-hand': 'off-hand', offhand: 'off-hand', head: 'head', torso: 'torso', chest: 'torso', legs: 'legs', feet: 'feet' });
const FUELS = [['coal_block', 80], ['lava_bucket', 100], ['blaze_rod', 12], ['coal', 8], ['charcoal', 8], ['dried_kelp_block', 20]];
const WOOD_FUEL = /_planks$|_log$|_wood$|_stem$/;
const CROPS = Object.freeze({ wheat: [7, 'wheat_seeds'], carrots: [7, 'carrot'], potatoes: [7, 'potato'], beetroots: [3, 'beetroot_seeds'], nether_wart: [3, 'nether_wart'],
  cocoa: [2, 'cocoa_beans'], melon: [0, null], pumpkin: [0, null], torchflower: [0, 'torchflower_seeds'], pitcher_crop: [4, 'pitcher_pod'] });
const TILLABLE = new Set(['dirt', 'grass_block', 'dirt_path', 'coarse_dirt', 'rooted_dirt']);
const BREED_FOOD = Object.freeze({ cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'], pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds', 'pitcher_pod'], horse: ['golden_carrot', 'golden_apple'],
  donkey: ['golden_carrot', 'golden_apple'], rabbit: ['carrot', 'golden_carrot', 'dandelion'], wolf: ['beef', 'cooked_beef', 'porkchop', 'cooked_porkchop', 'chicken', 'cooked_chicken', 'mutton', 'cooked_mutton', 'rotten_flesh'],
  cat: ['cod', 'salmon'], ocelot: ['cod', 'salmon'], fox: ['sweet_berries', 'glow_berries'], llama: ['hay_block'], trader_llama: ['hay_block'], turtle: ['seagrass'],
  panda: ['bamboo'], bee: ['dandelion', 'poppy', 'sunflower', 'oxeye_daisy', 'cornflower', 'allium'], frog: ['slime_ball'], axolotl: ['tropical_fish_bucket'],
  camel: ['cactus'], sniffer: ['torchflower_seeds'], armadillo: ['spider_eye'], strider: ['warped_fungus'], hoglin: ['crimson_fungus'] });
const DRINKS = /potion$|^(?:milk_bucket|honey_bottle|ominous_bottle)$/;
const MATERIAL = { wooden: 1, golden: 1, stone: 2, copper: 2, iron: 3, diamond: 4, netherite: 5 };

const round = value => Math.round(value * 10) / 10;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const centre = p => ({ x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });
const clean = (value, max) => String(value ?? '').replace(/[\x00-\x1f\x7f§]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const at = p => `${p.x} ${p.y} ${p.z}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fail = message => { throw new Error(message); };

// ---------- Validation ----------

const PLAYER = /^[A-Za-z0-9_]{1,16}$/;
const ID = /^[a-z0-9_]{1,48}$/;
const isId = value => typeof value === 'string' && ID.test(value.replace(/^minecraft:/, ''));
const id = value => value.replace(/^minecraft:/, '');
const coordinate = value => finite(value) && Math.abs(value) <= 30_000_000;
const intIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// Shape check of one action, before the world is consulted. Returns { action } or { error }.
export function validateAction(input) {
  if (!object(input) || typeof input.type !== 'string' || !ACTION_TYPES.includes(input.type)) return { error: 'unknown action type' };
  const type = input.type, keys = Object.keys(input).filter(key => key !== 'type');
  const unknown = allowed => keys.find(key => !allowed.includes(key));
  const err = error => ({ error });
  // Optional x, y, z: all three or none. Block actions use whole block coordinates.
  const xyz = (block = true) => {
    const given = ['x', 'y', 'z'].filter(key => input[key] !== undefined);
    if (!given.length) return null;
    if (given.length < 3 || !given.every(key => coordinate(input[key]))) return false;
    return block ? { x: Math.floor(input.x), y: Math.floor(input.y), z: Math.floor(input.z) } : { x: input.x, y: input.y, z: input.z };
  };
  const optional = (key, check, fallback) => input[key] === undefined ? { ok: true, value: fallback } : { ok: check(input[key]), value: input[key] };
  const count = (max, fallback = 1) => optional('count', value => intIn(value, 1, max), fallback);
  const seconds = (min, max, fallback) => optional('seconds', value => intIn(value, min, max), fallback);
  const flag = (key, fallback) => optional(key, value => typeof value === 'boolean', fallback);
  const extra = (...allowed) => { const key = unknown(allowed); return key ? `${type} does not take "${clean(key, 20)}"` : null; };
  let bad;
  switch (type) {
    case 'say': {
      const text = typeof input.text === 'string' ? clean(input.text, LIMITS.sayChars) : '';
      return !extra('text') && text ? { action: { type, text } } : err('say needs text');
    }
    case 'goto': {
      if ((bad = extra('player', 'block', 'x', 'y', 'z'))) return err(bad);
      const pos = xyz(false), forms = [input.player !== undefined, input.block !== undefined, pos !== null].filter(Boolean).length;
      if (forms !== 1) return err('goto needs one of: a player, a block, or x, y, z');
      if (input.player !== undefined) return typeof input.player === 'string' && PLAYER.test(input.player) ? { action: { type, player: input.player } } : err('goto needs a player name');
      if (input.block !== undefined) return isId(input.block) ? { action: { type, block: id(input.block) } } : err('goto needs a block name');
      return pos ? { action: { type, ...pos } } : err('goto needs numbers for x, y, z');
    }
    case 'follow': {
      const distance = input.distance ?? 3, secs = input.seconds ?? 60;
      return !extra('player', 'distance', 'seconds') && typeof input.player === 'string' && PLAYER.test(input.player) && intIn(distance, 1, LIMITS.followMax)
        && intIn(secs, 5, LIMITS.followMaxSeconds)
        ? { action: { type, player: input.player, distance, seconds: secs } } : err(`follow needs a player, distance 1-${LIMITS.followMax}, seconds 5-${LIMITS.followMaxSeconds}`);
    }
    case 'wander': {
      const value = input.distance ?? 24;
      return !extra('distance') && intIn(value, LIMITS.wanderMin, LIMITS.wanderMax)
        ? { action: { type, distance: value } } : err(`wander distance must be ${LIMITS.wanderMin}-${LIMITS.wanderMax}`);
    }
    case 'look_at': {
      if (!extra('player') && typeof input.player === 'string' && PLAYER.test(input.player)) return { action: { type, player: input.player } };
      const pos = !extra('x', 'y', 'z') && xyz(false);
      return pos ? { action: { type, ...pos } } : err('look_at needs a player or x, y, z');
    }
    case 'jump': case 'pick_up': case 'wake': case 'dismount': case 'stop':
      return keys.length ? err(`${type} takes no arguments`) : { action: { type } };
    case 'sprint': case 'sneak': {
      const on = flag('on', true);
      return !extra('on') && on.ok ? { action: { type, on: on.value } } : err(`${type} takes "on": true or false`);
    }
    case 'swim': {
      const secs = seconds(1, LIMITS.swimMaxSeconds, 5), forward = flag('forward', false);
      return !extra('seconds', 'forward') && secs.ok && forward.ok ? { action: { type, seconds: secs.value, forward: forward.value } } : err(`swim takes seconds 1-${LIMITS.swimMaxSeconds} and forward true/false`);
    }
    case 'dig': case 'activate': {
      if ((bad = extra('block', 'x', 'y', 'z'))) return err(bad);
      const pos = xyz();
      if (pos === false) return err(`${type} needs whole numbers for x, y, z`);
      if (pos && input.block === undefined) return { action: { type, ...pos } };
      if (!pos && isId(input.block)) return { action: { type, block: id(input.block) } };
      return err(`${type} needs a block name or x, y, z`);
    }
    case 'collect': {
      const n = count(LIMITS.collectMax);
      if ((bad = extra('block', 'count'))) return err(bad);
      if (!isId(input.block)) return err('collect needs a block name');
      return n.ok ? { action: { type, block: id(input.block), count: n.value } } : err(`collect count must be 1-${LIMITS.collectMax}`);
    }
    case 'place': {
      if ((bad = extra('item', 'x', 'y', 'z', 'at'))) return err(bad);
      if (!isId(input.item)) return err('place needs the item to place');
      const pos = xyz();
      if (pos === false) return err('place needs whole numbers for x, y, z');
      if (pos && input.at === undefined) return { action: { type, item: id(input.item), ...pos } };
      const where = input.at ?? 'front';
      return !pos && ['front', 'below', 'above'].includes(where) ? { action: { type, item: id(input.item), at: where } } : err('place takes x, y, z or at: front, below or above');
    }
    case 'build': {
      if ((bad = extra('blocks', 'x', 'y', 'z'))) return err(bad);
      const pos = xyz();
      if (pos === false) return err('build needs whole numbers for x, y, z');
      if (!Array.isArray(input.blocks) || !input.blocks.length || input.blocks.length > LIMITS.buildBlocks) return err(`build needs blocks: a list of 1-${LIMITS.buildBlocks} placements`);
      const blocks = [], off = value => intIn(value, -LIMITS.buildOffset, LIMITS.buildOffset);
      for (const [index, entry] of input.blocks.entries()) {
        const [dx, dy, dz, item] = Array.isArray(entry) ? entry : object(entry) ? [entry.x, entry.y, entry.z, entry.item] : [];
        if (!off(dx) || !off(dy) || !off(dz) || !isId(item)) return err(`build block ${index + 1} must be [dx, dy, dz, "item"] with offsets -${LIMITS.buildOffset}..${LIMITS.buildOffset}`);
        blocks.push([dx, dy, dz, id(item)]);
      }
      return { action: { type, ...(pos ?? {}), blocks } };
    }
    case 'craft': {
      const n = count(LIMITS.craftMax);
      if ((bad = extra('item', 'count'))) return err(bad);
      return isId(input.item) && n.ok ? { action: { type, item: id(input.item), count: n.value } } : err(`craft needs an item and count 1-${LIMITS.craftMax}`);
    }
    case 'smelt': {
      const n = count(LIMITS.smeltMax);
      if ((bad = extra('item', 'count', 'fuel'))) return err(bad);
      if (input.fuel !== undefined && !isId(input.fuel)) return err('smelt fuel must be an item name');
      return isId(input.item) && n.ok ? { action: { type, item: id(input.item), count: n.value, ...(input.fuel ? { fuel: id(input.fuel) } : {}) } } : err(`smelt needs an item and count 1-${LIMITS.smeltMax}`);
    }
    case 'equip': {
      if ((bad = extra('item', 'slot'))) return err(bad);
      if (!isId(input.item)) return err('equip needs an item');
      if (input.slot !== undefined && !SLOTS[input.slot]) return err('equip slot must be hand, off-hand, head, torso, legs or feet');
      return { action: { type, item: id(input.item), ...(input.slot ? { slot: SLOTS[input.slot] } : {}) } };
    }
    case 'unequip': {
      const slot = input.slot ?? 'hand';
      return !extra('slot') && SLOTS[slot] ? { action: { type, slot: SLOTS[slot] } } : err('unequip slot must be hand, off-hand, head, torso, legs or feet');
    }
    case 'toss': case 'drop': {
      const n = count(LIMITS.tossMax);
      if ((bad = extra('item', 'count'))) return err(bad);
      return isId(input.item) && n.ok ? { action: { type: 'toss', item: id(input.item), count: n.value } } : err(`${type} needs an item and count 1-${LIMITS.tossMax}`);
    }
    case 'give': {
      const n = count(LIMITS.tossMax);
      if ((bad = extra('player', 'item', 'count'))) return err(bad);
      return typeof input.player === 'string' && PLAYER.test(input.player) && isId(input.item) && n.ok
        ? { action: { type, player: input.player, item: id(input.item), count: n.value } } : err(`give needs a player, an item and count 1-${LIMITS.tossMax}`);
    }
    case 'use_item': {
      const secs = optional('seconds', value => finite(value) && value >= 0 && value <= LIMITS.useMaxSeconds, 0), offhand = flag('offhand', false);
      return !extra('seconds', 'offhand') && secs.ok && offhand.ok ? { action: { type, offhand: offhand.value, seconds: secs.value } } : err(`use_item takes seconds 0-${LIMITS.useMaxSeconds} and offhand true/false`);
    }
    case 'eat': {
      if ((bad = extra('item'))) return err(bad);
      if (input.item !== undefined && !isId(input.item)) return err('eat item must be a food name');
      return { action: { type, ...(input.item ? { item: id(input.item) } : {}) } };
    }
    case 'attack': {
      if ((bad = extra('player', 'mob'))) return err(bad);
      if (input.player !== undefined && input.mob !== undefined) return err('attack takes a player or a mob, not both');
      if (input.player !== undefined) return typeof input.player === 'string' && PLAYER.test(input.player) ? { action: { type, player: input.player } } : err('attack needs a player name');
      if (input.mob !== undefined) return isId(input.mob) ? { action: { type, mob: id(input.mob) } } : err('attack needs a mob name such as zombie');
      return { action: { type } };
    }
    case 'shield': {
      const secs = seconds(1, LIMITS.shieldMaxSeconds, 5);
      return !extra('seconds') && secs.ok ? { action: { type, seconds: secs.value } } : err(`shield takes seconds 1-${LIMITS.shieldMaxSeconds}`);
    }
    case 'defend': {
      const secs = seconds(5, LIMITS.defendMaxSeconds, 60);
      return !extra('seconds') && secs.ok ? { action: { type, seconds: secs.value } } : err(`defend takes seconds 5-${LIMITS.defendMaxSeconds}`);
    }
    case 'open': case 'sleep': {
      const allowed = type === 'open' ? ['block', 'x', 'y', 'z'] : ['x', 'y', 'z'];
      if ((bad = extra(...allowed))) return err(bad);
      const pos = xyz();
      if (pos === false) return err(`${type} needs whole numbers for x, y, z`);
      if (input.block !== undefined && (pos || !isId(input.block))) return err('open takes a block name or x, y, z');
      return { action: { type, ...(pos ?? {}), ...(input.block ? { block: id(input.block) } : {}) } };
    }
    case 'deposit': case 'withdraw': {
      if ((bad = extra('item', 'count', 'x', 'y', 'z'))) return err(bad);
      const pos = xyz(), n = optional('count', value => intIn(value, 1, LIMITS.tossMax), null);
      if (pos === false) return err(`${type} needs whole numbers for x, y, z`);
      return isId(input.item) && n.ok ? { action: { type, item: id(input.item), ...(n.value ? { count: n.value } : {}), ...(pos ?? {}) } } : err(`${type} needs an item and an optional count 1-${LIMITS.tossMax}`);
    }
    case 'mount': {
      if ((bad = extra('entity'))) return err(bad);
      if (input.entity !== undefined && !isId(input.entity)) return err('mount entity must be a name such as boat or horse');
      return { action: { type, ...(input.entity ? { entity: id(input.entity) } : {}) } };
    }
    case 'fish': {
      const secs = seconds(5, LIMITS.fishMaxSeconds, 60);
      return !extra('seconds') && secs.ok ? { action: { type, seconds: secs.value } } : err(`fish takes seconds 5-${LIMITS.fishMaxSeconds}`);
    }
    case 'till': case 'plant': case 'harvest': {
      const allowed = { till: ['x', 'y', 'z', 'count'], plant: ['item', 'x', 'y', 'z', 'count'], harvest: ['block', 'count', 'replant'] }[type];
      if ((bad = extra(...allowed))) return err(bad);
      const pos = type === 'harvest' ? null : xyz(), n = count(LIMITS.farmMax, type === 'harvest' ? 8 : 1), replant = flag('replant', true);
      if (pos === false) return err(`${type} needs whole numbers for x, y, z`);
      if (!n.ok) return err(`${type} count must be 1-${LIMITS.farmMax}`);
      if (type === 'plant' && !isId(input.item)) return err('plant needs the seed item, such as wheat_seeds or carrot');
      if (type === 'harvest' && input.block !== undefined && !CROPS[id(String(input.block))]) return err(`harvest block must be one of: ${Object.keys(CROPS).join(', ')}`);
      if (!replant.ok) return err('harvest replant must be true or false');
      return { action: { type, ...(pos ?? {}), count: pos ? 1 : n.value, ...(type === 'plant' ? { item: id(input.item) } : {}),
        ...(type === 'harvest' ? { ...(input.block ? { block: id(input.block) } : {}), replant: replant.value } : {}) } };
    }
    case 'breed': {
      if ((bad = extra('mob'))) return err(bad);
      return isId(input.mob) && BREED_FOOD[id(input.mob)]?.length ? { action: { type, mob: id(input.mob) } } : err('breed needs an animal that breeds, such as cow, sheep, pig or chicken');
    }
    case 'trade': {
      if ((bad = extra('index', 'count'))) return err(bad);
      const n = count(64);
      if (input.index !== undefined && !intIn(input.index, 0, 63)) return err('trade index must be 0-63 (no index lists the offers)');
      return n.ok ? { action: { type, ...(input.index !== undefined ? { index: input.index } : {}), count: n.value } } : err('trade count must be 1-64');
    }
  }
  return err('unknown action type');
}

// How long one validated action may run (ms): sized for it (craft and smelt longer, build per block).
export function actionTimeout(action) {
  const n = action?.count ?? 1;
  switch (action?.type) {
    case 'follow': return action.seconds * 1000 + 5000;
    case 'swim': case 'shield': case 'defend': return action.seconds * 1000 + 5000;
    case 'fish': return action.seconds * 1000 + 15_000;
    case 'use_item': return (action.seconds ?? 0) * 1000 + 8000;
    case 'collect': return 30_000 + n * 15_000;
    case 'harvest': return 20_000 + n * 8000;
    case 'till': case 'plant': return 20_000 + n * 6000;
    case 'build': return 20_000 + action.blocks.length * 6000;
    case 'craft': return 60_000 + n * 2000;
    case 'smelt': return 45_000 + n * 11_000;
    default: return ACTION_TIMEOUTS[action?.type] ?? 30_000;
  }
}

export function timeOfDay(ticks) {
  const t = ((Number(ticks) % 24000) + 24000) % 24000;
  return t < 12000 ? 'day' : t < 13800 ? 'dusk' : t < 22200 ? 'night' : 'dawn';
}

// "4 cobblestone, 1 flint": a compact list of names and counts.
const summarise = (items, max = 16) => {
  const counts = new Map();
  for (const item of items) if (item?.name) counts.set(item.name, (counts.get(item.name) ?? 0) + (item.count ?? 1));
  const list = [...counts].sort((a, b) => b[1] - a[1]);
  return list.slice(0, max).map(([name, n]) => `${n} ${name}`).join(', ') + (list.length > max ? `, +${list.length - max} more kinds` : '');
};
const isHostile = entity => entity?.type === 'hostile' || HOSTILE_NAMES.has(entity?.name);
const weaponScore = name => {
  const match = /^([a-z]+)_(sword|axe)$/.exec(name ?? '');
  if (match && MATERIAL[match[1]]) return MATERIAL[match[1]] * 2 + (match[2] === 'sword' ? 1 : 0);
  return name === 'trident' || name === 'mace' ? 9 : 0;
};
const armorSlot = name => ARMOR.find(([pattern]) => pattern.test(name))?.[1] ?? null;

export class BotBody {
  #bot; #pathfinder; #emit; #companions; #now; #scanMs; #pace; #Vec3; #scanTimer = null; #seen = new Set(); #current = null; #lastHealth = null;
  #night = null; #spawnedAt = 0; #players = ''; #commandUntil = 0; #commandLines = 0; #perceivedIds = null;

  // bot: a Mineflayer bot (or a fake). pathfinder: the mineflayer-pathfinder module ({ goals, Movements }) once loaded, or
  // null (movement skills then fail cleanly). onEvent(event): what the body noticed. companions: other companions' names.
  // pace: waits in ms ({ hit, poll, settle }); tests make them short.
  constructor({ bot, pathfinder = null, onEvent = () => {}, companions = [], now = Date.now, scanMs = 5000, pace = {}, Vec3 = null }) {
    this.#bot = bot; this.#pathfinder = pathfinder; this.#emit = onEvent; this.#companions = new Set(companions.map(name => name.toLowerCase()));
    this.#now = now; this.#scanMs = scanMs; this.#pace = { hit: 650, poll: 250, settle: 400, ...pace }; this.#Vec3 = Vec3;
  }

  get username() { return this.#bot.username; }

  // Never lets a handler error escape into Mineflayer's emitter.
  #on(name, handler) {
    this.#bot.on(name, (...args) => { try { handler(...args); } catch { /* one bad packet must not stop the body */ } });
  }
  #event(event) { try { this.#emit({ at: this.#now(), ...event }); } catch { /* the agent isolates itself */ } }

  // #70: walking may dig through blocks and place scaffolding blocks from the inventory, like a player getting out of a
  // pit or across a gap. Chests stay unbreakable for the pathfinder (its default), so walking never breaks a container.
  #movements() {
    const bot = this.#bot, movements = new this.#pathfinder.Movements(bot), items = this.#registry().itemsByName ?? {};
    movements.canDig = true; movements.allow1by1towers = true; movements.allowParkour = true; movements.allowSprinting = true;
    movements.canOpenDoors = true;
    const names = Object.keys(items).filter(name => /^(?:dirt|cobblestone|cobbled_deepslate|netherrack|stone|andesite|diorite|granite|tuff|blackstone|end_stone|[a-z_]+_planks)$/.test(name));
    movements.scafoldingBlocks = [...new Set(names.map(name => items[name].id).filter(Number.isInteger))];
    return movements;
  }

  attach() {
    const bot = this.#bot;
    if (this.#pathfinder && typeof bot.loadPlugin === 'function' && !bot.pathfinder) bot.loadPlugin(this.#pathfinder.pathfinder);
    this.#on('spawn', () => {
      if (this.#spawnedAt) return;
      this.#spawnedAt = this.#now();
      if (this.#pathfinder && bot.pathfinder) bot.pathfinder.setMovements(this.#movements());
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
    // The server's answer to her own /command: system lines in the few seconds after it (at most a few lines).
    this.#on('messagestr', (message, position) => {
      if (position !== 'system' || this.#now() > this.#commandUntil || this.#commandLines >= LIMITS.commandLines) return;
      const text = clean(message, 200);
      if (!text) return;
      this.#commandLines++;
      this.#event({ type: 'server', text });
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

  #ids(pattern) { return Object.values(this.#registry().blocksByName ?? {}).filter(block => pattern.test(block.name)).map(block => block.id); }

  #scan() {
    const bot = this.#bot;
    if (!bot.entity || typeof bot.findBlocks !== 'function') return;
    const ids = this.#ids(NOTABLE);
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
    const bot = this.#bot, self = bot.entity;
    if (!self?.position) return { spawned: false };
    const here = self.position, kind = name => this.#companions.has(name.toLowerCase()) ? 'companion' : 'human';
    const online = Object.keys(bot.players ?? {}).filter(name => name !== bot.username);
    const players = online.map(name => ({ name, entity: bot.players[name]?.entity }))
      .filter(player => player.entity?.position).map(player => ({ name: player.name, kind: kind(player.name), distance: round(distance(here, player.entity.position)) }))
      .sort((a, b) => a.distance - b.distance).slice(0, LIMITS.players);
    const entities = Object.values(bot.entities ?? {}).filter(entity => entity !== self && entity?.position && entity.type !== 'player');
    const mobs = entities.filter(entity => entity.name !== 'item' && ['hostile', 'animal', 'passive', 'mob', 'water_creature', 'ambient', 'living'].includes(entity.type))
      .map(entity => ({ name: clean(entity.name ?? entity.displayName ?? 'mob', 32), ...(isHostile(entity) ? { hostile: true } : {}), distance: round(distance(here, entity.position)) }))
      .filter(mob => mob.distance <= LIMITS.mobRange).sort((a, b) => a.distance - b.distance).slice(0, LIMITS.mobs);
    const items = entities.filter(entity => entity.name === 'item' && distance(here, entity.position) <= LIMITS.pickupRange).map(entity => {
      let dropped = null;
      try { dropped = entity.getDroppedItem?.() ?? null; } catch { dropped = null; }
      return { name: clean(dropped?.name ?? 'item', 40), count: dropped?.count ?? 1, distance: round(distance(here, entity.position)) };
    }).sort((a, b) => a.distance - b.distance).slice(0, LIMITS.items);
    let blocks = [];
    try {
      this.#perceivedIds ??= this.#ids(PERCEIVED);
      if (this.#perceivedIds.length && typeof bot.findBlocks === 'function') {
        const nearest = new Map();
        for (const position of (bot.findBlocks({ matching: this.#perceivedIds, maxDistance: LIMITS.scanRange, count: 96 }) ?? [])) {
          const name = bot.blockAt(position)?.name ?? 'block', d = round(distance(here, centre(position)));
          if (!nearest.has(name) || nearest.get(name).distance > d) nearest.set(name, { name, x: position.x, y: position.y, z: position.z, distance: d });
        }
        blocks = [...nearest.values()].sort((a, b) => a.distance - b.distance).slice(0, LIMITS.blocks);
      }
    } catch { blocks = []; }
    const counts = new Map();
    for (const item of bot.inventory?.items?.() ?? []) counts.set(item.name, (counts.get(item.name) ?? 0) + (item.count ?? 1));
    const inventory = [...counts].sort((a, b) => b[1] - a[1]).slice(0, LIMITS.inventory).map(([name, count]) => `${clean(name, 40)} ${count}`);
    const slots = bot.inventory?.slots ?? [];
    const armor = [5, 6, 7, 8].map(slot => slots[slot]?.name).filter(Boolean).map(name => clean(name, 40));
    let biome = null;
    try { biome = bot.blockAt(here)?.biome?.name ?? null; } catch { biome = null; }
    const held = bot.heldItem;
    return { spawned: true, username: bot.username,
      position: { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) },
      dimension: clean(String(bot.game?.dimension ?? 'overworld').replace(/^minecraft:/, ''), 32), biome: biome ? clean(biome, 40) : null,
      time: { phase: timeOfDay(bot.time?.timeOfDay ?? 0), ticks: Math.floor(bot.time?.timeOfDay ?? 0) },
      health: round(bot.health ?? 0), food: Math.round(bot.food ?? 0), ...(finite(bot.oxygenLevel) && bot.oxygenLevel < 20 ? { oxygen: bot.oxygenLevel } : {}),
      ...(finite(bot.experience?.level) ? { level: bot.experience.level } : {}),
      online: online.slice(0, 16).map(name => ({ name, kind: kind(name) })), players, mobs, items, blocks,
      holding: held ? `${clean(held.name, 40)} ${held.count ?? 1}` : null, offhand: slots[45]?.name ? clean(slots[45].name, 40) : null, armor,
      inventory, freeSlots: typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null,
      ...(bot.vehicle ? { riding: clean(bot.vehicle.name ?? 'something', 32) } : {}), ...(bot.isSleeping ? { sleeping: true } : {}),
      doing: this.#current?.action.type ?? null };
  }

  // #70: a line starting with "/" is a server command, run with her account's normal (non-op) permissions.
  say(text) {
    const line = clean(text, LIMITS.sayChars);
    if (!line) return false;
    if (line.startsWith('/')) { this.#commandUntil = this.#now() + 3000; this.#commandLines = 0; }
    this.#bot.chat(line);
    return true;
  }

  #abort(reason) {
    const current = this.#current;
    if (!current) return;
    current.controller.abort(reason);
    const bot = this.#bot;
    try { bot.pathfinder?.stop(); } catch { /* not moving */ }
    try { bot.pathfinder?.setGoal(null); } catch { /* not moving */ }
    try { if (bot.targetDigBlock) bot.stopDigging(); } catch { /* not digging */ }
    try { if (bot.usingHeldItem) bot.deactivateItem(); } catch { /* not using */ }
    try { bot.currentWindow && bot.closeWindow(bot.currentWindow); } catch { /* no window */ }
    for (const control of ['jump', 'forward', 'back', 'left', 'right']) { try { bot.setControlState?.(control, false); } catch { /* fake */ } }
  }

  // Runs one validated action with its time limit. A new movement or work action replaces the running one; say
  // (a chat line) and refused actions never touch it (#69: talking mid-task must not drop the task). Never throws: the
  // result ({ type, ok, detail }) is what the companion's next turn hears.
  async act(input, { timeoutMs } = {}) {
    const checked = validateAction(input);
    if (checked.error) return { type: String(input?.type ?? 'unknown').slice(0, 20), ok: false, detail: checked.error };
    const action = checked.action;
    if (action.type === 'say') return this.say(action.text) ? { type: 'say', ok: true, detail: action.text.startsWith('/') ? 'sent the command' : 'said it' } : { type: 'say', ok: false, detail: 'nothing to say' };
    if (action.type === 'stop') {
      const was = this.#current?.action.type ?? null;
      this.#abort('stopped');
      return { type: 'stop', ok: true, detail: was ? `stopped ${was}` : 'nothing to stop' };
    }
    if (!this.#bot.entity?.position) return { type: action.type, ok: false, detail: 'not in the world yet' };
    this.#abort('replaced by a new action');
    const controller = new AbortController(), entry = { action, controller };
    this.#current = entry;
    const limit = timeoutMs ?? actionTimeout(action);
    let timer;
    try {
      const detail = await Promise.race([
        this.#skill(action, controller.signal),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), limit); }),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(String(controller.signal.reason ?? 'stopped'))), { once: true }))
      ]);
      return { type: action.type, ok: true, detail: clean(detail, LIMITS.resultChars) };
    } catch (error) {
      if (this.#current === entry && !controller.signal.aborted) this.#abort(error?.message === 'timed out' ? 'timed out' : 'failed');
      const partial = entry.progress ? ` (before that: ${entry.progress})` : '';
      return { type: action.type, ok: false, detail: clean((error?.message ?? 'failed') + partial, LIMITS.resultChars) };
    } finally {
      clearTimeout(timer);
      if (this.#current === entry) this.#current = null;
    }
  }

  // ---------- Helpers ----------

  #vec(x, y, z) {
    const Vec3 = this.#Vec3 ?? this.#bot.entity.position.constructor;
    return new Vec3(x, y, z);
  }
  #progress(text) { if (this.#current) this.#current.progress = text; }
  #wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error(String(signal.reason ?? 'stopped'))); return; }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error(String(signal.reason ?? 'stopped'))); }, { once: true });
    });
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
  // Walk until the position is within reach (4.5 blocks of its centre) unless it already is.
  async #reach(position, signal, { look = false } = {}) {
    if (distance(this.#bot.entity.position, centre(position)) <= 4.5) return;
    const goals = this.#goals();
    const goal = look && goals.GoalLookAtBlock ? new goals.GoalLookAtBlock(position, this.#bot.world) : new goals.GoalNear(position.x, position.y, position.z, 2);
    await this.#walk(goal, signal);
  }
  async #approach(entity, signal, range = 2.5) {
    if (distance(this.#bot.entity.position, entity.position) <= range + 0.5) return;
    const goals = this.#goals();
    await this.#walk(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, range), signal);
  }
  #items() { return this.#bot.inventory?.items?.() ?? []; }
  #item(name) { return this.#items().find(item => item.name === name) ?? null; }
  #count(name) { return this.#items().filter(item => item.name === name).reduce((sum, item) => sum + (item.count ?? 1), 0); }
  #snapshot() { const map = new Map(); for (const item of this.#items()) map.set(item.name, (map.get(item.name) ?? 0) + (item.count ?? 1)); return map; }
  #gained(before) {
    const gains = [];
    for (const [name, n] of this.#snapshot()) if (n > (before.get(name) ?? 0)) gains.push({ name, count: n - (before.get(name) ?? 0) });
    return summarise(gains, 8);
  }
  #block(position) { return this.#bot.blockAt(this.#vec(position.x, position.y, position.z)); }
  // The nearest blocks matching (ids or a name test), nearest first.
  #find(match, range, count = 1, filter = () => true) {
    const bot = this.#bot;
    if (typeof bot.findBlocks !== 'function') return [];
    const ids = typeof match === 'string' ? [this.#registry().blocksByName?.[match]?.id].filter(value => value !== undefined) : match instanceof RegExp ? this.#ids(match) : match;
    if (!ids.length) return [];
    const here = bot.entity.position;
    return (bot.findBlocks({ matching: ids, maxDistance: range, count: Math.max(count * 4, 16) }) ?? [])
      .map(position => bot.blockAt(position)).filter(block => block?.position && filter(block))
      .sort((a, b) => distance(here, centre(a.position)) - distance(here, centre(b.position))).slice(0, count);
  }
  #blockTarget(action, match, range, what) {
    if (action.x !== undefined) {
      if (distance(this.#bot.entity.position, action) > LIMITS.blockRange) fail(`${at(action)} is too far (more than ${LIMITS.blockRange} blocks)`);
      const block = this.#block(action);
      if (!block) fail(`the block at ${at(action)} is not loaded`);
      return block;
    }
    if (typeof match === 'string' && !this.#registry().blocksByName?.[match]) fail(`no block called ${match}`);
    return this.#find(match, range)[0] ?? fail(`no ${what} within ${range} blocks`);
  }
  #entities(test, range) {
    const here = this.#bot.entity.position;
    return Object.values(this.#bot.entities ?? {}).filter(entity => entity && entity !== this.#bot.entity && entity.position && test(entity)
      && distance(here, entity.position) <= range).sort((a, b) => distance(here, a.position) - distance(here, b.position));
  }
  async #equipBestTool(block) {
    let tool = null;
    try { tool = this.#bot.pathfinder?.bestHarvestTool?.(block) ?? null; } catch { tool = null; }
    if (tool && this.#bot.heldItem?.name !== tool.name) await this.#bot.equip(tool, 'hand');
    return tool;
  }
  async #equipWeapon() {
    const best = this.#items().map(item => ({ item, score: weaponScore(item.name) })).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score)[0];
    if (best && this.#bot.heldItem?.name !== best.item.name) await this.#bot.equip(best.item, 'hand');
    return best?.item.name ?? null;
  }
  async #hold(name, destination = 'hand') {
    const item = this.#item(name) ?? fail(`no ${name} in the inventory`);
    if (destination !== 'hand' || this.#bot.heldItem?.name !== name) await this.#bot.equip(item, destination);
    return item;
  }

  async #dig(block, signal) {
    if (!block || REPLACEABLE.has(block.name)) fail(`nothing to dig at ${block ? at(block.position) : 'that spot'}`);
    if (block.diggable === false || block.hardness === null || block.hardness < 0) fail(`${block.name} cannot be broken`);
    await this.#reach(block.position, signal, { look: true });
    const fresh = this.#bot.blockAt(block.position) ?? block;
    if (fresh.name !== block.name) fail(`the ${block.name} at ${at(block.position)} is gone`);
    if (typeof this.#bot.canDigBlock === 'function' && !this.#bot.canDigBlock(fresh)) fail(`cannot reach the ${fresh.name} at ${at(fresh.position)}`);
    const tool = await this.#equipBestTool(fresh);
    await this.#bot.dig(fresh, true);
    return { name: fresh.name, tool: tool?.name ?? null };
  }

  // A solid neighbour to place against and the face pointing at the target; below first, then the sides, then above.
  #reference(target) {
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const block = this.#bot.blockAt(this.#vec(target.x + dx, target.y + dy, target.z + dz));
      if (block && !REPLACEABLE.has(block.name) && block.boundingBox !== 'empty') return { block, face: this.#vec(-dx, -dy, -dz) };
    }
    return null;
  }

  async #placeAt(target, name, signal) {
    const existing = this.#block(target);
    if (existing && !REPLACEABLE.has(existing.name)) {
      if (existing.name === name) return 'already there';
      fail(`there is already ${existing.name} at ${at(target)}`);
    }
    if (!this.#item(name)) fail(`no ${name} in the inventory`);
    const feet = this.#bot.entity.position.floored?.() ?? this.#vec(Math.floor(this.#bot.entity.position.x), Math.floor(this.#bot.entity.position.y), Math.floor(this.#bot.entity.position.z));
    if (target.x === feet.x && target.z === feet.z && (target.y === feet.y || target.y === feet.y + 1)) {
      // Standing in the spot: step out of the way first.
      const goals = this.#goals();
      await this.#walk(new goals.GoalInvert(new goals.GoalNear(target.x, target.y, target.z, 1.5)), signal);
    }
    await this.#reach(target, signal);
    const reference = this.#reference(target) ?? fail(`nothing to place the ${name} against at ${at(target)}`);
    await this.#hold(name);
    await this.#bot.placeBlock(reference.block, reference.face);
    return 'placed';
  }

  // A free spot next to her (air with a solid block below) for a crafting table or furnace.
  async #placeNearby(name, signal) {
    const p = this.#bot.entity.position, x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const target = { x: x + dx, y, z: z + dz }, here = this.#block(target), below = this.#block({ x: x + dx, y: y - 1, z: z + dz });
      if (here && REPLACEABLE.has(here.name) && below && !REPLACEABLE.has(below.name)) {
        await this.#placeAt(target, name, signal);
        return this.#block(target);
      }
    }
    fail(`no free spot next to you to put the ${name}`);
  }

  async #container(action, signal) {
    const block = this.#blockTarget(action, action.block ?? CONTAINER, LIMITS.collectRange, action.block ?? 'chest, barrel or shulker box');
    if (!OPENABLE.test(block.name)) fail(`${block.name} at ${at(block.position)} is not something to open (chest, barrel, shulker box, hopper…)`);
    await this.#reach(block.position, signal);
    const window = await this.#bot.openContainer(block);
    return { block, window };
  }
  #contents(block, window) {
    const items = window.containerItems?.() ?? [];
    return `${block.name} at ${at(block.position)} holds: ${items.length ? summarise(items, 24) : 'nothing'}`;
  }

  // Hits the entity until it is gone or out of range, following it. Returns the number of hits.
  async #fight(entity, signal, range = LIMITS.attackRange) {
    const bot = this.#bot, goals = this.#goals();
    await this.#equipWeapon();
    let hits = 0;
    try {
      while (!signal.aborted) {
        if (bot.entities?.[entity.id] !== entity || entity.isValid === false || (finite(entity.health) && entity.health <= 0)) return { hits, gone: true };
        const d = distance(bot.entity.position, entity.position);
        if (d > range) return { hits, gone: false };
        if (d > 3) bot.pathfinder.setGoal(new goals.GoalFollow(entity, 1), true);
        else { await bot.lookAt?.(entity.position.offset(0, (entity.height ?? 1.6) * 0.8, 0), true); bot.attack(entity); hits++; }
        await this.#wait(d > 3 ? this.#pace.poll : this.#pace.hit, signal);
      }
    } finally { try { bot.pathfinder.setGoal(null); } catch { /* not moving */ } }
    return { hits, gone: false };
  }

  async #pickUp(signal) {
    const goals = this.#goals(), bot = this.#bot;
    const items = Object.values(bot.entities ?? {}).filter(entity => entity?.name === 'item' && entity.position
      && distance(bot.entity.position, entity.position) <= LIMITS.pickupRange).slice(0, 12);
    let count = 0;
    for (const item of items) {
      if (signal.aborted) break;
      try { await this.#walk(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.5), signal); count++; } catch { /* next item */ }
    }
    return count;
  }

  // ---------- Skills ----------

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
        if (action.block) {
          const block = this.#find(action.block, LIMITS.findRange)[0] ?? fail(`no ${action.block} within ${LIMITS.findRange} blocks`);
          await this.#walk(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), signal);
          return `reached the ${action.block} at ${at(block.position)}`;
        }
        if (distance(here, action) > LIMITS.gotoDistance) throw new Error(`too far (more than ${LIMITS.gotoDistance} blocks)`);
        await this.#walk(new goals.GoalNear(action.x, action.y, action.z, 1), signal);
        return `arrived near ${Math.floor(action.x)} ${Math.floor(action.y)} ${Math.floor(action.z)}`;
      }
      case 'follow': {
        const goals = this.#goals(), entity = this.#player(action.player);
        bot.pathfinder.setGoal(new goals.GoalFollow(entity, action.distance), true);
        await this.#wait(action.seconds * 1000, signal);
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
        const target = action.player ? this.#player(action.player).position.offset(0, 1.6, 0) : this.#vec(action.x, action.y, action.z);
        await bot.lookAt(target);
        return action.player ? `looking at ${action.player}` : 'looking there';
      }
      case 'jump':
        bot.setControlState('jump', true);
        try { await this.#wait(this.#pace.settle, signal); } finally { bot.setControlState('jump', false); }
        return 'jumped';
      case 'sprint': case 'sneak':
        bot.setControlState(action.type, action.on);
        return `${action.type} ${action.on ? 'on' : 'off'}`;
      case 'swim':
        bot.setControlState('jump', true);
        if (action.forward) bot.setControlState('forward', true);
        try { await this.#wait(action.seconds * 1000, signal); } finally { bot.setControlState('jump', false); bot.setControlState('forward', false); }
        return `swam ${action.forward ? 'forward and ' : ''}up for ${action.seconds}s`;

      case 'dig': {
        const block = this.#blockTarget(action, action.block, LIMITS.collectRange, action.block);
        const dug = await this.#dig(block, signal);
        return `dug ${dug.name} at ${at(block.position)}${dug.tool ? ` with ${dug.tool}` : ''}`;
      }
      case 'collect': {
        if (!this.#registry().blocksByName?.[action.block]) fail(`no block called ${action.block}`);
        const before = this.#snapshot();
        let got = 0, problem = null;
        for (let attempt = 0; got < action.count && attempt < action.count + 4 && !signal.aborted; attempt++) {
          const block = this.#find(action.block, LIMITS.collectRange)[0];
          if (!block) break;
          try { await this.#dig(block, signal); got++; this.#progress(`mined ${got} ${action.block}`); } catch (error) { if (signal.aborted) throw error; problem = error; }
        }
        if (!got) throw problem ?? new Error(`no ${action.block} within ${LIMITS.collectRange} blocks`);
        await this.#pickUp(signal).catch(() => {});
        const gained = this.#gained(before);
        return `mined ${got} ${action.block}${got < action.count ? ` (only ${got} of ${action.count} found)` : ''}${gained ? `; picked up ${gained}` : ''}`;
      }
      case 'pick_up': {
        const before = this.#snapshot(), count = await this.#pickUp(signal);
        if (!count) throw new Error('no dropped items nearby');
        const gained = this.#gained(before);
        return `picked up ${plural(count, 'item stack')}${gained ? `: ${gained}` : ''}`;
      }
      case 'place': {
        if (action.x !== undefined) {
          if (distance(here, action) > LIMITS.blockRange) fail(`${at(action)} is too far`);
          const result = await this.#placeAt(action, action.item, signal);
          return `${result === 'placed' ? 'placed' : 'already'} ${action.item} at ${at(action)}`;
        }
        const x = Math.floor(here.x), y = Math.floor(here.y), z = Math.floor(here.z);
        if (action.at === 'above') { const target = { x, y: y + 2, z }; await this.#placeAt(target, action.item, signal); return `placed ${action.item} above you at ${at(target)}`; }
        if (action.at === 'front') {
          const yaw = bot.entity.yaw ?? 0, dx = Math.round(-Math.sin(yaw)), dz = Math.round(-Math.cos(yaw));
          const target = { x: x + (Math.abs(dx) >= Math.abs(dz) ? dx : 0), y, z: z + (Math.abs(dz) > Math.abs(dx) ? dz : 0) };
          await this.#placeAt(target, action.item, signal);
          return `placed ${action.item} in front of you at ${at(target)}`;
        }
        // below: under her feet if that is open (bridging), otherwise jump and place under her (a pillar step).
        const below = { x, y: y - 1, z }, under = this.#block(below);
        if (under && REPLACEABLE.has(under.name)) { await this.#placeAt(below, action.item, signal); return `placed ${action.item} below you at ${at(below)}`; }
        if (!under) fail('the block under you is not loaded');
        await this.#hold(action.item);
        bot.setControlState('jump', true);
        try {
          for (let waited = 0; bot.entity.position.y < y + 1 && waited < 1000; waited += 50) await this.#wait(50, signal);
          await bot.placeBlock(under, this.#vec(0, 1, 0));
        } finally { bot.setControlState('jump', false); }
        return `jumped and placed ${action.item} under you at ${x} ${y} ${z}`;
      }
      case 'build': {
        const origin = action.x !== undefined ? action : { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) };
        if (distance(here, origin) > LIMITS.blockRange) fail(`${at(origin)} is too far`);
        let placed = 0, already = 0;
        const failures = [];
        for (const [index, [dx, dy, dz, item]] of action.blocks.entries()) {
          if (signal.aborted) break;
          const target = { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz };
          try {
            const result = await this.#placeAt(target, item, signal);
            if (result === 'placed') placed++; else already++;
          } catch (error) {
            if (signal.aborted) throw error;
            failures.push(`#${index + 1} ${item} at ${at(target)}: ${clean(error?.message, 60)}`);
          }
          this.#progress(`placed ${placed} of ${action.blocks.length} blocks`);
        }
        const total = action.blocks.length, summary = `placed ${placed} of ${total} blocks${already ? ` (${already} were already there)` : ''}`;
        if (!placed && !already) fail(`${summary}; ${failures.slice(0, 3).join('; ')}`);
        return failures.length ? `${summary}; ${failures.length} failed: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '; …' : ''}` : summary;
      }

      case 'craft': {
        const item = this.#registry().itemsByName?.[action.item] ?? fail(`no item called ${action.item}`);
        let table = this.#find('crafting_table', LIMITS.collectRange)[0] ?? null;
        let recipe = bot.recipesFor(item.id, null, 1, null)?.[0] ?? null, used = null;
        if (!recipe) {
          recipe = bot.recipesFor(item.id, null, 1, true)?.[0] ?? null;
          if (!recipe) {
            const any = bot.recipesAll?.(item.id, null, true)?.[0];
            if (!any) fail(`${action.item} cannot be crafted`);
            const names = this.#registry().items ?? {};
            const missing = (any.delta ?? []).filter(d => d.count < 0 && this.#bot.inventory.count?.(d.id, d.metadata) < -d.count)
              .map(d => `${-d.count} ${names[d.id]?.name ?? 'item ' + d.id}`);
            fail(`missing ingredients for ${action.item}${missing.length ? `: one craft needs ${missing.join(', ')}` : ''}`);
          }
          if (!table) {
            if (!this.#item('crafting_table')) fail(`${action.item} needs a crafting table: none within ${LIMITS.collectRange} blocks and none in the inventory (craft one from 4 planks)`);
            table = await this.#placeNearby('crafting_table', signal);
            used = 'placed a crafting table';
          }
          await this.#reach(table.position, signal);
          used ??= `used the crafting table at ${at(table.position)}`;
        }
        const per = recipe.result?.count ?? 1, needs = recipe.requiresTable ? table : null;
        let times = Math.ceil(action.count / per);
        while (times > 1 && !bot.recipesFor(item.id, null, times * per, needs ?? (recipe.requiresTable ? true : null))?.length) times--;
        await bot.craft(recipe, times, needs ?? undefined);
        const made = times * per;
        return `crafted ${made} ${action.item}${made < action.count ? ` (only enough ingredients for ${made} of ${action.count})` : ''}${used ? `; ${used}` : ''}`;
      }
      case 'smelt': {
        const have = this.#count(action.item);
        if (!have) fail(`no ${action.item} in the inventory`);
        const count = Math.min(have, action.count);
        let block = this.#find(FURNACE, LIMITS.collectRange)[0] ?? null, placed = '';
        if (!block) {
          if (!this.#item('furnace')) fail(`no furnace within ${LIMITS.collectRange} blocks and none in the inventory (craft one from 8 cobblestone)`);
          block = await this.#placeNearby('furnace', signal); placed = '; placed a furnace';
        }
        await this.#reach(block.position, signal);
        const furnace = await bot.openFurnace(block), registry = this.#registry().itemsByName ?? {};
        const before = this.#snapshot();
        try {
          const fuelHere = furnace.fuelItem?.();
          if (!fuelHere && !(furnace.fuel > 0)) {
            const choices = action.fuel ? [[action.fuel, action.fuel === 'stick' ? 0.5 : WOOD_FUEL.test(action.fuel) ? 1.5 : FUELS.find(([name]) => name === action.fuel)?.[1] ?? 1]]
              : [...FUELS, ...this.#items().filter(i => WOOD_FUEL.test(i.name)).map(i => [i.name, 1.5])];
            const fuel = choices.find(([name]) => this.#count(name) > 0) ?? fail(action.fuel ? `no ${action.fuel} in the inventory` : 'no fuel in the inventory (coal, charcoal, planks or logs)');
            await furnace.putFuel(registry[fuel[0]].id, null, Math.min(this.#count(fuel[0]), Math.max(1, Math.ceil(count / fuel[1]))));
          }
          await furnace.putInput(registry[action.item].id, null, count);
          // Wait while it cooks: until the input is used up, or the fuel runs out.
          for (let idle = 0; !signal.aborted;) {
            const input = furnace.inputItem?.(), output = furnace.outputItem?.();
            if (!input) break;
            if (!furnace.fuelItem?.() && !(furnace.fuel > 0) && ++idle > 8) break;
            if (output?.count >= 64) break;
            this.#progress(`${output?.count ?? 0} smelted so far`);
            await this.#wait(this.#pace.poll * 4, signal);
          }
          if (furnace.outputItem?.()) await furnace.takeOutput();
          const left = furnace.inputItem?.();
          if (left) await furnace.takeInput();
          const gained = this.#gained(before);
          if (!gained) fail(`nothing came out of the furnace${left ? ' (it ran out of fuel)' : ''}`);
          return `smelted ${action.item}: got ${gained}${left ? `; ${left.count} ${action.item} not smelted (out of fuel) taken back` : ''}${placed}`;
        } finally { try { furnace.close(); } catch { /* closed */ } }
      }

      case 'equip': {
        const item = this.#item(action.item) ?? fail(`no ${action.item} in the inventory`);
        const slot = action.slot ?? armorSlot(action.item) ?? 'hand';
        await bot.equip(item, slot);
        return `equipped ${action.item} (${slot})`;
      }
      case 'unequip':
        await bot.unequip(action.slot);
        return `unequipped ${action.slot}`;
      case 'toss': {
        const have = this.#count(action.item);
        if (!have) fail(`no ${action.item} in the inventory`);
        const n = Math.min(have, action.count);
        await bot.toss(this.#item(action.item).type, null, n);
        return `tossed ${n} ${action.item}${n < action.count ? ` (all you had)` : ''}`;
      }
      case 'give': {
        const have = this.#count(action.item);
        if (!have) fail(`no ${action.item} in the inventory`);
        const entity = this.#player(action.player);
        await this.#approach(entity, signal, 2);
        await bot.lookAt(entity.position.offset(0, 1.6, 0), true);
        const n = Math.min(have, action.count);
        await bot.toss(this.#item(action.item).type, null, n);
        return `gave ${action.player} ${n} ${action.item}${n < action.count ? ' (all you had)' : ''}`;
      }
      case 'use_item': {
        const held = action.offhand ? bot.inventory?.slots?.[45] : bot.heldItem;
        if (!held) fail(`nothing in your ${action.offhand ? 'off-hand' : 'hand'}`);
        if (!action.offhand && (this.#registry().foodsByName?.[held.name] || DRINKS.test(held.name))) { await bot.consume(); return `used ${held.name} (ate or drank it)`; }
        bot.activateItem(action.offhand);
        if (action.seconds > 0) { await this.#wait(action.seconds * 1000, signal); bot.deactivateItem(); return `used ${held.name} for ${action.seconds}s, then released`; }
        return `used ${held.name}`;
      }
      case 'eat': {
        const foods = this.#registry().foodsByName ?? {};
        if ((bot.food ?? 20) >= 20 && !['golden_apple', 'enchanted_golden_apple', 'chorus_fruit'].includes(action.item)) throw new Error('not hungry');
        const food = action.item ? (foods[action.item] ? this.#item(action.item) : fail(`${action.item} is not food`)) ?? fail(`no ${action.item} in the inventory`)
          : this.#items().filter(item => foods[item.name] && !/^(?:rotten_flesh|spider_eye|poisonous_potato|pufferfish|suspicious_stew|chorus_fruit)$/.test(item.name))
            .sort((a, b) => (foods[b.name].foodPoints ?? 0) - (foods[a.name].foodPoints ?? 0))[0] ?? fail('no food in the inventory');
        await bot.equip(food, 'hand');
        await bot.consume();
        return `ate ${food.name}`;
      }

      case 'attack': {
        const entity = action.player ? this.#player(action.player)
          : (this.#entities(e => action.mob ? e.name === action.mob : isHostile(e), action.mob ? LIMITS.attackRange : LIMITS.entityRange)[0]
            ?? fail(action.mob ? `no ${action.mob} within ${LIMITS.attackRange} blocks` : `no hostile mob within ${LIMITS.entityRange} blocks`));
        const name = action.player ?? entity.name ?? 'it', weapon = await this.#equipWeapon();
        const { hits, gone } = await this.#fight(entity, signal);
        if (!gone) fail(`${name} got away after ${plural(hits, 'hit')}`);
        return `${action.player ? 'beat' : 'killed'} ${name} after ${plural(hits, 'hit')}${weapon ? ` with ${weapon}` : ''}`;
      }
      case 'shield': {
        if (bot.inventory?.slots?.[45]?.name !== 'shield') await this.#hold('shield', 'off-hand');
        bot.activateItem(true);
        try { await this.#wait(action.seconds * 1000, signal); } finally { bot.deactivateItem(); }
        return `held up the shield for ${action.seconds}s`;
      }
      case 'defend': {
        const end = this.#now() + action.seconds * 1000, killed = [];
        while (this.#now() < end && !signal.aborted) {
          const enemy = this.#entities(isHostile, LIMITS.defendRange)[0];
          if (!enemy) { await this.#wait(this.#pace.poll * 2, signal); continue; }
          const { gone } = await this.#fight(enemy, signal, LIMITS.defendRange + 4);
          if (gone) { killed.push(enemy.name ?? 'mob'); this.#progress(`killed ${killed.length}`); }
        }
        return killed.length ? `defended for ${action.seconds}s: killed ${summarise(killed.map(name => ({ name })), 6)}` : `defended for ${action.seconds}s: no hostile mob came close`;
      }

      case 'open': {
        const { block, window } = await this.#container(action, signal);
        try { return this.#contents(block, window); } finally { try { window.close(); } catch { /* closed */ } }
      }
      case 'deposit': case 'withdraw': {
        const { block, window } = await this.#container(action, signal);
        try {
          const type = this.#registry().itemsByName?.[action.item]?.id ?? fail(`no item called ${action.item}`);
          if (action.type === 'deposit') {
            const have = this.#count(action.item);
            if (!have) fail(`no ${action.item} in the inventory`);
            const n = Math.min(have, action.count ?? have);
            await window.deposit(type, null, n);
            return `put ${n} ${action.item} in; ${this.#contents(block, window)}`;
          }
          const inside = (window.containerItems?.() ?? []).filter(item => item.name === action.item).reduce((sum, item) => sum + (item.count ?? 1), 0);
          if (!inside) fail(`no ${action.item} in it; ${this.#contents(block, window)}`);
          const n = Math.min(inside, action.count ?? inside);
          await window.withdraw(type, null, n);
          return `took ${n} ${action.item}; ${this.#contents(block, window)}`;
        } finally { try { window.close(); } catch { /* closed */ } }
      }

      case 'activate': {
        const block = this.#blockTarget(action, action.block, LIMITS.farmRange, action.block);
        await this.#reach(block.position, signal);
        await bot.activateBlock(block);
        await this.#wait(this.#pace.settle, signal).catch(() => {});
        const props = this.#bot.blockAt(block.position)?.getProperties?.() ?? {};
        const state = props.open !== undefined ? (props.open ? ' (now open)' : ' (now closed)') : props.powered !== undefined ? (props.powered ? ' (now on)' : ' (now off)') : '';
        return `activated ${block.name} at ${at(block.position)}${state}`;
      }
      case 'sleep': {
        const block = this.#blockTarget(action, /_bed$/, LIMITS.collectRange, 'bed');
        if (!/_bed$/.test(block.name)) fail(`${block.name} at ${at(block.position)} is not a bed`);
        await this.#reach(block.position, signal);
        await bot.sleep(block);
        return `sleeping in the ${block.name} at ${at(block.position)}`;
      }
      case 'wake':
        if (!bot.isSleeping) fail('not sleeping');
        await bot.wake();
        return 'woke up';
      case 'mount': {
        const entity = this.#entities(e => action.entity ? e.name === action.entity : RIDEABLE.test(e.name ?? ''), LIMITS.entityRange)[0]
          ?? fail(`no ${action.entity ?? 'boat, minecart or rideable animal'} within ${LIMITS.entityRange} blocks`);
        await this.#approach(entity, signal, 2);
        bot.mount(entity);
        await this.#wait(this.#pace.settle, signal).catch(() => {});
        return `got on the ${entity.name}`;
      }
      case 'dismount':
        if (!bot.vehicle) fail('not riding anything');
        bot.dismount();
        return 'got off';
      case 'fish': {
        await this.#hold('fishing_rod');
        const before = this.#snapshot();
        let timer;
        try {
          await Promise.race([bot.fish(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no bite in ${action.seconds}s`)), action.seconds * 1000); })]);
        } catch (error) { try { bot.activateItem(); } catch { /* reel in */ } throw error; } finally { clearTimeout(timer); }
        await this.#wait(this.#pace.settle * 3, signal).catch(() => {});
        const gained = this.#gained(before);
        return gained ? `caught ${gained}` : 'caught something (it has not reached the inventory yet)';
      }
      case 'till': {
        const hoe = this.#items().find(item => /_hoe$/.test(item.name)) ?? fail('no hoe in the inventory');
        const open = block => REPLACEABLE.has(this.#bot.blockAt(block.position.offset(0, 1, 0))?.name ?? 'air');
        const targets = action.x !== undefined ? [this.#blockTarget(action, null, 0, '')] : this.#find([...TILLABLE].map(name => this.#registry().blocksByName?.[name]?.id).filter(v => v !== undefined), LIMITS.farmRange, action.count, open);
        if (!targets.length) fail(`no dirt or grass with open air above within ${LIMITS.farmRange} blocks`);
        let done = 0;
        for (const block of targets) {
          if (signal.aborted) break;
          if (!TILLABLE.has(block.name)) { if (action.x !== undefined) fail(`${block.name} cannot be tilled`); continue; }
          await this.#reach(block.position, signal);
          if (bot.heldItem?.name !== hoe.name) await bot.equip(hoe, 'hand');
          await bot.activateBlock(block);
          done++; this.#progress(`tilled ${done}`);
        }
        return `tilled ${plural(done, 'block')} into farmland`;
      }
      case 'plant': {
        if (!this.#count(action.item)) fail(`no ${action.item} in the inventory`);
        const soil = action.item === 'nether_wart' ? 'soul_sand' : 'farmland';
        const open = block => REPLACEABLE.has(this.#bot.blockAt(block.position.offset(0, 1, 0))?.name ?? 'air') && this.#bot.blockAt(block.position.offset(0, 1, 0))?.name !== 'water';
        const targets = action.x !== undefined ? [this.#blockTarget(action, null, 0, '')] : this.#find(soil, LIMITS.farmRange, action.count, open);
        if (!targets.length) fail(`no free ${soil} within ${LIMITS.farmRange} blocks (till dirt with a hoe first)`);
        let done = 0;
        for (const block of targets) {
          if (signal.aborted || !this.#count(action.item)) break;
          if (block.name !== soil) fail(`${action.item} needs ${soil}, not ${block.name}`);
          await this.#reach(block.position, signal);
          await this.#hold(action.item);
          await bot.placeBlock(block, this.#vec(0, 1, 0));
          done++; this.#progress(`planted ${done}`);
        }
        return `planted ${done} ${action.item}${done < action.count ? ` (${done} of ${action.count})` : ''}`;
      }
      case 'harvest': {
        const names = action.block ? [action.block] : Object.keys(CROPS);
        const mature = block => {
          const [age] = CROPS[block.name] ?? [];
          if (age === undefined) return false;
          if (!age) return true;
          const props = block.getProperties?.() ?? {};
          return Number(props.age ?? block.metadata ?? 0) >= age;
        };
        const ids = names.map(name => this.#registry().blocksByName?.[name]?.id).filter(v => v !== undefined);
        const crops = this.#find(ids, LIMITS.farmRange, action.count, mature);
        if (!crops.length) fail(`no ripe ${action.block ?? 'crops'} within ${LIMITS.farmRange} blocks`);
        const before = this.#snapshot();
        let done = 0, replanted = 0;
        for (const crop of crops) {
          if (signal.aborted) break;
          await this.#dig(crop, signal);
          done++; this.#progress(`harvested ${done}`);
          const seed = CROPS[crop.name][1];
          if (action.replant && seed && crop.name !== 'cocoa' && this.#count(seed)) {
            const soil = this.#bot.blockAt(crop.position.offset(0, -1, 0));
            if (soil && ['farmland', 'soul_sand'].includes(soil.name)) {
              try { await this.#hold(seed); await bot.placeBlock(soil, this.#vec(0, 1, 0)); replanted++; } catch { /* the next one */ }
            }
          }
        }
        await this.#pickUp(signal).catch(() => {});
        const gained = this.#gained(before);
        return `harvested ${done}${replanted ? `, replanted ${replanted}` : ''}${gained ? `; got ${gained}` : ''}`;
      }
      case 'breed': {
        const food = BREED_FOOD[action.mob].find(name => this.#count(name) >= 2) ?? fail(`breeding ${action.mob} needs 2 of: ${BREED_FOOD[action.mob].join(', ')}`);
        const animals = this.#entities(e => e.name === action.mob, LIMITS.entityRange).slice(0, 2);
        if (animals.length < 2) fail(`need two ${action.mob}s within ${LIMITS.entityRange} blocks, found ${animals.length}`);
        for (const animal of animals) {
          await this.#approach(animal, signal, 2);
          await this.#hold(food);
          await bot.activateEntity(animal);
        }
        return `fed two ${action.mob}s ${food}; they should make a baby if they are adults and not on cooldown`;
      }
      case 'trade': {
        const villager = this.#entities(e => e.name === 'villager' || e.name === 'wandering_trader', LIMITS.entityRange)[0] ?? fail(`no villager within ${LIMITS.entityRange} blocks`);
        await this.#approach(villager, signal, 2);
        const window = await bot.openVillager(villager);
        try {
          const offer = (trade, index) => {
            const inputs = [[trade.realPrice ?? trade.inputItem1?.count, trade.inputItem1], [trade.inputItem2?.count, trade.hasItem2 === false ? null : trade.inputItem2]]
              .filter(([, item]) => item?.name).map(([n, item]) => `${n ?? 1} ${item.name}`).join(' + ');
            return `#${index}: ${inputs || '?'} -> ${trade.outputItem?.count ?? 1} ${trade.outputItem?.name ?? '?'}${trade.tradeDisabled ? ' (sold out)' : ''}`;
          };
          const offers = (window.trades ?? []).map(offer);
          const list = offers.length ? offers.join('; ') : 'no offers';
          if (action.index === undefined) return `the ${villager.name} offers: ${list}`;
          const trade = window.trades?.[action.index] ?? fail(`no offer #${action.index}; offers: ${list}`);
          if (trade.tradeDisabled) fail(`offer #${action.index} is sold out; offers: ${list}`);
          await bot.trade(window, action.index, action.count);
          return `traded offer #${action.index} x${action.count}; offers: ${list}`;
        } finally { try { window.close(); } catch { /* closed */ } }
      }
    }
    throw new Error('unknown action');
  }

  quit(reason = 'bye') { this.detach(); try { this.#bot.quit(reason); } catch { /* already gone */ } }
}
