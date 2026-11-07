// The companion's body in Minecraft (#68, #70, docs/MINECRAFT.md): what it perceives, which events it notices and the
// closed set of skills it can run. It drives one Mineflayer bot object and never decides anything itself: the
// companion's turns (src/minecraft.mjs) choose the actions. Everything here works on an injected bot, so tests use
// a fake one and the worker (src/minecraft-worker.mjs) a real Mineflayer bot.
//
// #70: the skills cover what a normal survival player does (walk, dig and build, craft and smelt, items, fight,
// containers, beds, farming, animals, villagers, server commands as a non-op player). The vocabulary stays closed: no
// action runs code, reads files or reaches anything outside the game, because the worker runs as the service user.

export const ACTION_TYPES = Object.freeze([
  'say', 'goto', 'follow', 'wander', 'look_at', 'jump', 'sprint', 'sneak', 'swim', 'escape',
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
  dismount: 5000, trade: 45_000, breed: 45_000, escape: 120_000, stop: 1000 });
export const LIMITS = Object.freeze({ gotoDistance: 256, wanderMin: 8, wanderMax: 64, followMax: 8, followMaxSeconds: 120,
  collectMax: 64, collectRange: 32, pickupRange: 16, sayChars: 240, players: 8, mobs: 8, items: 8, blocks: 12, inventory: 36, scanRange: 16,
  mobRange: 24, findRange: 64, blockRange: 64, buildBlocks: 64, buildOffset: 16, craftMax: 64, smeltMax: 64, tossMax: 2304, attackRange: 32,
  defendMaxSeconds: 300, defendRange: 12, swimMaxSeconds: 30, shieldMaxSeconds: 30, useMaxSeconds: 5, fishMaxSeconds: 120, farmRange: 16,
  farmMax: 64, entityRange: 16, resultChars: 400, commandLines: 4, pillarMax: 8, stairMax: 10 });
// Blocks worth noticing as a "found" event (once per position): rare things.
const NOTABLE = /^(?:deepslate_)?(?:diamond|emerald|gold|lapis|redstone)_ore$|^(?:ancient_debris|spawner|chest|trial_spawner|vault|nether_portal|end_portal_frame|budding_amethyst|bee_nest|suspicious_sand|suspicious_gravel)$/;
// Blocks shown in the perception: places to use and resources.
const PERCEIVED = /_bed$|_ore$|_log$|_stem$|shulker_box$|^(?:chest|trapped_chest|barrel|ender_chest|crafting_table|furnace|blast_furnace|smoker|anvil|enchanting_table|brewing_stand|ancient_debris|spawner|nether_portal|farmland|composter|bell|lectern)$/;
const CONTAINER = /shulker_box$|^(?:chest|trapped_chest|barrel|ender_chest)$/;
const FURNACE = /^(?:furnace|blast_furnace|smoker)$/;
const OPENABLE = /shulker_box$|^(?:chest|trapped_chest|barrel|ender_chest|hopper|dispenser|dropper|crafter)$/;
// t70: what dig refuses as "nothing to dig": air and fluids only. Grass, flowers, snow layers, vines and other blocks
// without a collision box are dug like any other (REPLACEABLE is about placing and standing, not digging).
const NOTHING = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'bubble_column']);
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
// Blocks walking and escape may use as scaffolding (pillar steps, stair steps).
const SCAFFOLD = /^(?:dirt|cobblestone|cobbled_deepslate|netherrack|stone|andesite|diorite|granite|tuff|blackstone|end_stone|[a-z_]+_planks)$/;
const WATERY = new Set(['water', 'bubble_column', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// t70 (doors): walking takes the door, not the wall. mineflayer-pathfinder 2.4.5 cannot use doors: its "openable" set
// holds only fence gates, a door is a solid block to it (open or closed), and with digging on (#70) a house wall was
// the cheapest way in. Walking now plans twice: first without digging (doors and fence gates count as passable and the
// body opens them on the way, see #doorKeeper), and only when that finds no way, with digging at a high cost. Neither
// pass breaks what players build (BUILT) or anything near a door or bed; logs stay breakable (trees).
export const BUILT = /_planks$|_door$|_trapdoor$|_fence$|_fence_gate$|_wall$|_stairs$|_slab$|glass|_pane$|^iron_bars$|_wool$|_carpet$|^bricks$|_bricks$|_brick_|_concrete$|_concrete_powder$|terracotta$|_bed$|chest$|^barrel$|shulker_box$|^(?:hopper|dispenser|dropper|crafter)$|furnace$|^smoker$|^crafting_table$|torch$|lantern$|_sign$|^(?:rail|powered_rail|detector_rail|activator_rail)$|^glowstone$|^sea_lantern$|^farmland$|^(?:wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_melon_stem|attached_pumpkin_stem|sweet_berry_bush|nether_wart|cocoa|torchflower_crop|pitcher_crop)$|^ladder$|^bookshelf$|^chiseled_bookshelf$|anvil$|^(?:enchanting_table|brewing_stand|lectern|composter|bell|beacon|cartography_table|fletching_table|smithing_table|stonecutter|loom|grindstone|jukebox|note_block|respawn_anchor|lodestone|decorated_pot|flower_pot)$|^potted_|_banner$|^(?:smooth_stone|smooth_sandstone|smooth_red_sandstone|smooth_quartz)$|^polished_|^chiseled_|^cut_|^quartz_|^(?:iron|gold|diamond|emerald|lapis|redstone|netherite|copper|coal)_block$|_candle$/;
// What escape may dig through: natural ground only.
export const NATURAL = /^(?:dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|clay|mycelium|moss_block|sand|red_sand|gravel|stone|deepslate|andesite|diorite|granite|tuff|calcite|dripstone_block|sandstone|red_sandstone|netherrack|soul_sand|soul_soil|basalt|blackstone|end_stone|magma_block|snow_block|snow|ice|packed_ice|[a-z_]+_ore|[a-z_]+_leaves|obsidian)$/;
const DOORWAY = /^(?!iron_)[a-z_]+_(?:door|fence_gate)$/;
export const DIG_COST = 12;
const NEAR_PROTECTED = 3;

// Configures one pathfinder Movements for a walk pass. dig: false = the first pass (no digging, building blocks only
// at a high cost); dig: true = the fallback. protectedAt: door and bed positions nearby (nothing within 3 blocks of
// them is broken). Works on mineflayer-pathfinder 2.4.5's Movements (getBlock, blocksCantBreak, exclusionAreasBreak).
export function configureMovements(movements, registry, { dig = false, protectedAt = [] } = {}) {
  const blocks = Object.values(registry?.blocksByName ?? {}), items = registry?.itemsByName ?? {};
  movements.canDig = dig; movements.digCost = DIG_COST;
  movements.allow1by1towers = true; movements.allowParkour = true; movements.allowSprinting = true;
  // The pathfinder's own gate opening (canOpenDoors) toggles gates blindly; the body opens doors and gates itself.
  movements.canOpenDoors = false;
  movements.placeCost = dig ? 2 : 6;
  const names = Object.keys(items).filter(name => SCAFFOLD.test(name));
  movements.scafoldingBlocks = [...new Set(names.map(name => items[name].id).filter(Number.isInteger))];
  if (movements.blocksCantBreak instanceof Set) for (const block of blocks) if (BUILT.test(block.name)) movements.blocksCantBreak.add(block.id);
  const doorways = new Set(blocks.filter(block => DOORWAY.test(block.name)).map(block => block.id));
  if (typeof movements.getBlock === 'function' && !movements.getBlock.doorways) {
    const base = movements.getBlock.bind(movements);
    movements.getBlock = Object.assign((pos, dx, dy, dz) => {
      const b = base(pos, dx, dy, dz);
      if (b && doorways.has(b.type)) { b.safe = true; b.physical = false; b.replaceable = false; b.doorway = true; }
      return b;
    }, { doorways: true });
    // A door's panel blocks a diagonal step through its block: diagonals touching a doorway are dropped.
    if (typeof movements.getMoveDiagonal === 'function') {
      const diagonal = movements.getMoveDiagonal.bind(movements);
      movements.getMoveDiagonal = (node, dir, neighbors) => {
        const before = neighbors.length;
        diagonal(node, dir, neighbors);
        if (neighbors.length === before) return;
        const touches = [[dir.x, 0], [0, dir.z], [dir.x, dir.z]].some(([dx, dz]) => [-1, 0, 1, 2].some(dy => movements.getBlock(node, dx, dy, dz)?.doorway));
        if (touches) neighbors.length = before;
      };
    }
  }
  if (Array.isArray(movements.exclusionAreasBreak) && protectedAt.length) {
    movements.exclusionAreasBreak.push(block => {
      const p = block?.position;
      return p && protectedAt.some(q => Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y), Math.abs(p.z - q.z)) <= NEAR_PROTECTED) ? 100 : 0;
    });
  }
  return movements;
}
// t70 (fair play): she knows a block only when she could see it, like a player (no X-ray). A block counts as seen
// when one of its faces touches a block she can see through and a straight line from her eyes reaches it first.
export const SIGHT = Object.freeze({ range: 32, underground: 16, candidates: 48, memory: 300, cacheMs: 1000 });
const SEE_THROUGH = /glass|_pane$|leaves$|^(?:ice|iron_bars|barrier|chain|ladder|scaffolding|cobweb|water|lava|bubble_column)$|_fence$|_fence_gate$|_door$|_trapdoor$|_slab$|_stairs$|_carpet$|_wall$|torch$|lantern$|_sign$|rail$|_bed$|chest$|shulker_box$|^(?:snow|farmland|composter|bell|lectern|enchanting_table|brewing_stand|anvil|cauldron|hopper)$/;
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
// Does a straight line from `from` to the point `to` (inside the block at `target`) reach that block before any block she
// cannot see through? A voxel walk (Amanatides-Woo) over blockAt.
export function lineOfSight(blockAt, from, to, target, opaque) {
  let x = Math.floor(from.x), y = Math.floor(from.y), z = Math.floor(from.z);
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, length = Math.hypot(dx, dy, dz);
  if (!length) return x === target.x && y === target.y && z === target.z;
  const step = [Math.sign(dx), Math.sign(dy), Math.sign(dz)];
  const next = (p, d, s) => s > 0 ? (Math.floor(p) + 1 - p) / d : s < 0 ? (p - Math.floor(p)) / -d : Infinity;
  let tx = next(from.x, dx, step[0]), ty = next(from.y, dy, step[1]), tz = next(from.z, dz, step[2]);
  const ddx = step[0] ? Math.abs(1 / dx) : Infinity, ddy = step[1] ? Math.abs(1 / dy) : Infinity, ddz = step[2] ? Math.abs(1 / dz) : Infinity;
  for (let i = 0; i < 256; i++) {
    if (tx <= ty && tx <= tz) { if (tx > 1) return false; x += step[0]; tx += ddx; }
    else if (ty <= tz) { if (ty > 1) return false; y += step[1]; ty += ddy; }
    else { if (tz > 1) return false; z += step[2]; tz += ddz; }
    if (x === target.x && y === target.y && z === target.z) return true;
    if (opaque(blockAt({ x, y, z }))) return false;
  }
  return false;
}
const isDoorway = block => Boolean(block?.name && DOORWAY.test(block.name));
// mineflayer-pathfinder's postProcessPath puts every path node "on top of" the shape of the block there: a door's
// lower half is a full-height panel, so the step through the doorway became a point one block up, on the door
// (measured: node 0.297,-59,8.5 for the doorway at 0,-60,8; she stood still and the pathfinder reset "stuck" every
// 3.5 s). The nodes are fixed in place on each path_update, before the pathfinder walks them (same array).
export function fixDoorNodes(blockAt, path) {
  if (!Array.isArray(path) || typeof blockAt !== 'function') return 0;
  let fixed = 0;
  for (const node of path) {
    if (!node || !finite(node.x) || !finite(node.y) || !finite(node.z) || (node.toBreak?.length ?? 0) || (node.toPlace?.length ?? 0)) continue;
    // The node sits on top of the shape: the doorway block is just below it (a door: 1 below, a closed gate: 1.5).
    const x = Math.floor(node.x), z = Math.floor(node.z), top = Math.floor(node.y - 0.001);
    const door = [top, top - 1].map(y => blockAt({ x, y, z })).find(block => isDoorway(block) && block.getProperties?.().half !== 'upper' && node.y - block.position.y > 0.5);
    if (!door?.position) continue;
    node.x = x + 0.5; node.y = door.position.y; node.z = z + 0.5; fixed++;
  }
  return fixed;
}
const isOpen = block => { try { const open = block.getProperties?.().open; return open === true || open === 'true'; } catch { return false; } };

// t70: prismarine-physics 1.11.1 (the newest on npm, used by mineflayer 4.39.0) gives the player a hitbox exactly 0.6
// wide (half-width 0.3), so pressed against a wall its box ends exactly on the block face. The 26.1 server's own
// player box is the float 0.6f (a hair wider) and it treats that exact touch as moving into the block: it silently
// sends her back to her last good position, every tick, for as long as she pushes on the wall (no "moved wrongly" log).
// That froze her in holes and water (no climbing out, no jumping onto a ledge, no pillaring) while open ground was
// fine. A hitbox 0.00002 wider keeps her a hair off every face, so the server accepts each move. Measured on a local
// 26.1.2 server: 53-113 corrections per 3-6 s against a wall before, 0 after (docs/MINECRAFT.md, "Physics on 26.1").
export const PHYSICS_HALF_WIDTH = 0.30001;
export function patchPhysics(bot) {
  const physics = bot?.physics;
  if (!physics || typeof physics.playerHalfWidth !== 'number') return false;
  if (physics.playerHalfWidth < PHYSICS_HALF_WIDTH) physics.playerHalfWidth = PHYSICS_HALF_WIDTH;
  return true;
}

// t70 (windows): every window click carries the state id of the window it clicks. Mineflayer 4.39.0 keeps ONE state id,
// taken from every set_slot / window_items packet whatever window it is for. The 26.1 server keeps syncing the player
// inventory (window 0: a set_slot for the off-hand slot after each click) while a crafting table, furnace or chest is
// open, so every click on that window went out with window 0's id. The server then answers each click with a full
// resync of the window's state from before Mineflayer's next (already predicted) clicks; Mineflayer's model of the
// window falls behind, it clicks the wrong slots, and a craft "succeeds" while the server made nothing and used
// nothing (measured on a local 26.1.2 server; docs/MINECRAFT.md, "Windows on 26.1"). The fix keeps the state id per
// window and hands Mineflayer only the open window's. Idempotent; false when Mineflayer's listener is not there (yet).
const STATE_LISTENER = /^\(?packet\)?=>\{stateId=packet\.stateId;?\}$/;
const WINDOWS_PATCHED = Symbol('t70 window state ids');
export function patchWindowState(bot) {
  const client = bot?._client;
  if (!client || typeof client.listeners !== 'function') return false;
  if (client[WINDOWS_PATCHED]) return true;
  const original = client.listeners('set_slot').find(fn => STATE_LISTENER.test(String(fn).replace(/\s/g, '')));
  if (!original || !client.listeners('window_items').includes(original)) return false;
  const latest = new Map(), active = () => bot.currentWindow?.id ?? 0;
  const perWindow = packet => {
    if (!packet || typeof packet.stateId !== 'number') return;
    latest.set(packet.windowId, packet.stateId);
    if (packet.windowId === active()) original(packet);
  };
  client.removeListener('set_slot', original); client.removeListener('window_items', original);
  client.prependListener('set_slot', perWindow); client.prependListener('window_items', perWindow);
  // A window's contents can arrive just before its open_window (villagers); a closed window hands back window 0's id.
  client.on('open_window', packet => { if (latest.has(packet?.windowId)) original({ stateId: latest.get(packet.windowId) }); });
  bot.on?.('windowClose', window => { if (window && window.id !== 0) latest.delete(window.id); original({ stateId: latest.get(0) ?? -1 }); });
  client[WINDOWS_PATCHED] = true;
  return true;
}

// t70 (chat): the 26.1 server checks every chat_message's "last seen" update against the signed messages it sent her
// (LastSeenMessagesValidator, read from the Paper 26.1.2 jar): the window offset, one bit per tracked message (oldest
// first, a once-acknowledged message must stay acknowledged) and a checksum (0 = not checked). Any mismatch kicks her
// with "Chat message validation failure". minecraft-protocol 1.68.0 gets two things wrong: its checksum walks its ring
// buffer in storage order instead of oldest first, so it is wrong once more than 20 signed messages arrived since login
// (her own signed lines count too), and an unsigned /command (which carries no acknowledgements) still resets its
// pending count, so the next chat line's offset is short and its bits point at the wrong messages. This keeps her own
// tracker, like the vanilla client's LastSeenMessagesTracker, and writes its update into every chat_message (and signed
// command); minecraft-protocol's own message_acknowledgement packets are dropped, this tracker sends its own after 64.
// It assumes unsigned chat (the worker passes disableChatSigning): a signed line's signature would cover
// minecraft-protocol's acknowledgements, not these.
// Measured against a port of the server's validator (docs/MINECRAFT.md, "Chat on 26.1"). Idempotent.
export const LAST_SEEN = 20;
const CHAT_PATCHED = Symbol('t70 last seen tracker');
export function patchChatAcks(client) {
  if (!client || typeof client.write !== 'function' || typeof client.on !== 'function') return false;
  if (client[CHAT_PATCHED]) return true;
  const ring = new Array(LAST_SEEN).fill(null), write = client.write;
  let tail = 0, offset = 0, last = null;
  const send = (name, params) => write.call(client, name, params);
  const update = () => {
    const acknowledged = Buffer.alloc(Math.ceil(LAST_SEEN / 8));
    for (let j = 0; j < LAST_SEEN; j++) {
      const k = (tail + j) % LAST_SEEN;
      if (ring[k]) { acknowledged[j >> 3] |= 1 << (j & 7); ring[k].pending = false; }
    }
    const count = offset;
    offset = 0;
    return { count, acknowledged };
  };
  const onChat = packet => {
    const signature = packet?.signature;
    if (!Buffer.isBuffer(signature) || !signature.length || (last && last.equals(signature))) return;
    last = signature; ring[tail] = { signature, pending: true }; tail = (tail + 1) % LAST_SEEN; offset++;
    if (offset > 64) send('message_acknowledgement', { count: update().count });
  };
  if (typeof client.prependListener === 'function') client.prependListener('player_chat', onChat); else client.on('player_chat', onChat);
  client.write = function (name, params, ...rest) {
    if (name === 'message_acknowledgement') return undefined;
    if (name === 'chat_message' && object(params)) { const { count, acknowledged } = update(); params = { ...params, offset: count, acknowledged, checksum: 0 }; }
    else if (name === 'chat_command_signed' && object(params)) { const { count, acknowledged } = update(); params = { ...params, messageCount: count, acknowledged, checksum: 0 }; }
    return write.call(this, name, params, ...rest);
  };
  client[CHAT_PATCHED] = true;
  return true;
}

// t70 (oxygen): Mineflayer 4.39.0 sets bot.oxygenLevel from the air_supply metadata of EVERY entity, not only her own:
// a fish on land or a mob under water nearby made her "drown" on dry land (measured on a local 26.1.2 server: a cod
// beside her drove bot.oxygenLevel to 4 while she stood on the ground with full air). This keeps the value from her
// own entity's metadata only (air_supply's index from the registry, 1 on 26.1; 300 ticks = 20) and writes it back
// after Mineflayer's handler. ownOxygen(bot) reads it: 20 until her own metadata says otherwise (a bot without a client
// to patch keeps Mineflayer's value).
const OXYGEN = Symbol('t70 own oxygen');
export function patchOxygen(bot) {
  const client = bot?._client;
  if (!client || typeof client.on !== 'function') return false;
  if (bot[OXYGEN]) return true;
  bot[OXYGEN] = { level: 20 };
  const airKey = () => { const keys = bot.registry?.entitiesByName?.player?.metadataKeys; const i = Array.isArray(keys) ? keys.indexOf('air_supply') : -1; return i >= 0 ? i : 1; };
  client.on('entity_metadata', packet => {
    const own = bot[OXYGEN];
    if (bot.entity && packet?.entityId === bot.entity.id && Array.isArray(packet.metadata)) {
      const key = airKey(), air = packet.metadata.find(entry => entry?.key === key);
      if (air && finite(air.value)) own.level = Math.max(0, Math.min(20, Math.round(air.value / 15)));
    }
    bot.oxygenLevel = own.level;
  });
  bot.on?.('spawn', () => { bot[OXYGEN].level = 20; bot.oxygenLevel = 20; });
  return true;
}
export const ownOxygen = bot => bot?.[OXYGEN]?.level ?? (finite(bot?.oxygenLevel) ? bot.oxygenLevel : 20);

// t70 (kicks): on 26.1 the disconnect reason is an NBT text component ({ type: 'compound', value: { translate: … } }),
// which the old reader turned into "no reason". This unwraps NBT or JSON components into plain text and names the
// server's translation keys.
export const SECURE_CHAT_REASON = 'server enforces secure chat (set enforce-secure-profile=false)';
const DISCONNECT_KEYS = {
  'multiplayer.disconnect.chat_validation_failed': 'Chat message validation failure',
  'multiplayer.disconnect.out_of_order_chat': 'Out-of-order chat packet received',
  'multiplayer.disconnect.too_many_pending_chats': 'Too many unacknowledged chat messages',
  'multiplayer.disconnect.unsigned_chat': SECURE_CHAT_REASON,
  'multiplayer.disconnect.missing_public_key': SECURE_CHAT_REASON,
  'multiplayer.disconnect.expired_public_key': SECURE_CHAT_REASON,
  'multiplayer.disconnect.invalid_public_key_signature': SECURE_CHAT_REASON,
  'chat.disabled.missingProfileKey': SECURE_CHAT_REASON,
  'multiplayer.disconnect.kicked': 'Kicked by an operator',
  'multiplayer.disconnect.banned': 'You are banned from this server',
  'multiplayer.disconnect.not_whitelisted': 'You are not white-listed on this server',
  'multiplayer.disconnect.duplicate_login': 'You logged in from another location',
  'multiplayer.disconnect.name_taken': 'That name is already taken',
  'multiplayer.disconnect.unverified_username': 'Failed to verify username',
  'multiplayer.disconnect.server_shutdown': 'Server closed',
  'multiplayer.disconnect.server_full': 'Server is full',
  'multiplayer.disconnect.idling': 'You have been idle for too long',
  'multiplayer.disconnect.flying': 'Flying is not enabled on this server',
  'multiplayer.disconnect.invalid_player_movement': 'Invalid move player packet received',
  'multiplayer.disconnect.invalid_vehicle_movement': 'Invalid move vehicle packet received',
  'multiplayer.disconnect.invalid_entity_attacked': 'Attempting to attack an invalid entity',
  'multiplayer.disconnect.illegal_characters': 'Illegal characters in chat',
  'multiplayer.disconnect.generic': 'Disconnected',
  'disconnect.spam': 'Kicked for spamming',
  'disconnect.timeout': 'Timed out',
  'disconnect.closed': 'Connection closed'
};
const NBT_TYPES = new Set(['compound', 'list', 'string', 'byte', 'short', 'int', 'long', 'float', 'double', 'byteArray', 'intArray', 'longArray', 'bool']);
function plainComponent(value, depth = 0) {
  if (depth > 16) return null;
  if (object(value) && NBT_TYPES.has(value.type) && 'value' in value) {
    if (value.type === 'compound') return object(value.value) ? Object.fromEntries(Object.entries(value.value).map(([k, v]) => [k, plainComponent(v, depth + 1)])) : null;
    if (value.type === 'list') return Array.isArray(value.value?.value) ? value.value.value.map(v => plainComponent(value.value.type ? { type: value.value.type, value: v } : v, depth + 1)) : [];
    return value.value;
  }
  if (Array.isArray(value)) return value.map(v => plainComponent(v, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainComponent(v, depth + 1)]));
  return value;
}
function componentText(value, depth = 0) {
  if (depth > 16 || value === null || value === undefined) return '';
  if (typeof value === 'string') {
    if (/^\s*[{["]/.test(value)) { try { return componentText(JSON.parse(value), depth + 1); } catch { /* plain text */ } }
    return value;
  }
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(v => componentText(v, depth + 1)).filter(Boolean).join('');
  const own = typeof value.translate === 'string'
    ? (DISCONNECT_KEYS[value.translate] ?? [value.translate, ...(Array.isArray(value.with) ? value.with.map(v => componentText(v, depth + 1)) : [])].filter(Boolean).join(' '))
    : componentText(value.text ?? (typeof value[''] === 'string' ? value[''] : ''), depth + 1);
  return [own, ...(Array.isArray(value.extra) ? value.extra.map(v => componentText(v, depth + 1)) : [])].filter(Boolean).join('');
}
export function disconnectReason(reason) {
  return clean(componentText(plainComponent(reason)), 300);
}

// t70 (secure chat): she sends chat unsigned (disableChatSigning). A server that enforces secure profiles still lets her
// in but refuses every chat line ("chat.disabled.missingProfileKey") and every command with a message argument, so she
// would be mute: the login packet's enforcesSecureChat flag (and the older server_data one) ends the connection with
// one clear reason instead. minecraft-protocol's own check throws from inside its packet handler.
export function isSecureChatError(error) {
  return /disableChatSigning.*enforcing secure chat|enforces secure chat/i.test(String(error?.message ?? error ?? ''));
}
export function watchSecureChat(client, onEnforced) {
  if (!client || typeof client.on !== 'function') return false;
  let fired = false;
  const check = packet => { if (!fired && packet?.enforcesSecureChat === true) { fired = true; onEnforced(SECURE_CHAT_REASON); } };
  client.on('login', check); client.on('server_data', check);
  return true;
}

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
    case 'jump': case 'pick_up': case 'wake': case 'dismount': case 'stop': case 'escape':
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
// Counts by item name: what she carries (see #items), compared before and after an action.
const carried = bot => { const window = bot.currentWindow; return (window && typeof window.items === 'function' ? window.items() : bot.inventory?.items?.()) ?? []; };
const counts = items => { const map = new Map(); for (const item of items) map.set(item.name, (map.get(item.name) ?? 0) + (item.count ?? 1)); return map; };
const delta = (before, after, name) => (after.get(name) ?? 0) - (before.get(name) ?? 0);
const changed = (before, after) => [...new Set([...before.keys(), ...after.keys()])].some(name => delta(before, after, name) !== 0);
const changes = (before, after, skip = new Set()) => {
  const gained = [], lost = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (skip.has(name)) continue;
    const d = delta(before, after, name);
    if (d > 0) gained.push({ name, count: d }); else if (d < 0) lost.push({ name, count: -d });
  }
  return { gained, lost };
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
  #night = null; #spawnedAt = 0; #players = ''; #commandUntil = 0; #commandLines = 0; #perceivedIds = null; #protectedIds = null; #memory = new Map(); #sight = new Map(); #sightKey = ''; #names = null; #range = null;

  // bot: a Mineflayer bot (or a fake). pathfinder: the mineflayer-pathfinder module ({ goals, Movements }) once loaded, or
  // null (movement skills then fail cleanly). onEvent(event): what the body noticed. companions: other companions' names.
  // pace: waits in ms ({ hit, poll, settle, rise, swim, step, inventory, sync, collect, look }); tests make them short.
  constructor({ bot, pathfinder = null, onEvent = () => {}, companions = [], now = Date.now, scanMs = 5000, pace = {}, Vec3 = null }) {
    this.#bot = bot; this.#pathfinder = pathfinder; this.#emit = onEvent; this.#companions = new Set(companions.map(name => name.toLowerCase()));
    this.#now = now; this.#scanMs = scanMs; this.#pace = { hit: 650, poll: 250, settle: 400, rise: 1500, swim: 12_000, step: 1500, inventory: 2000, sync: 1500, collect: 3500, look: 150, ...pace }; this.#Vec3 = Vec3;
  }

  get username() { return this.#bot.username; }

  // Never lets a handler error escape into Mineflayer's emitter.
  #on(name, handler) {
    this.#bot.on(name, (...args) => { try { handler(...args); } catch { /* one bad packet must not stop the body */ } });
  }
  #event(event) { try { this.#emit({ at: this.#now(), ...event }); } catch { /* the agent isolates itself */ } }

  // #70: walking may dig through blocks and place scaffolding blocks from the inventory, like a player getting out of a
  // pit or across a gap. t70 (doors): two passes, see configureMovements: on foot through doors first, digging (never
  // building blocks, never near a door or bed) only when that finds no way.
  #movements(dig = false) {
    const bot = this.#bot, movements = new this.#pathfinder.Movements(bot);
    return configureMovements(movements, this.#registry(), { dig, protectedAt: dig ? this.#protectedSpots() : [] });
  }
  // Doors and beds within 48 blocks: the dig pass breaks nothing within 3 blocks of them.
  #protectedSpots() {
    const bot = this.#bot;
    if (typeof bot.findBlocks !== 'function' || !bot.entity) return [];
    this.#protectedIds ??= this.#ids(/_door$|_bed$/);
    if (!this.#protectedIds.length) return [];
    try { return (bot.findBlocks({ matching: this.#protectedIds, maxDistance: 48, count: 128 }) ?? []).map(p => ({ x: p.x, y: p.y, z: p.z })); } catch { return []; }
  }
  #setMoves(dig) { try { this.#bot.pathfinder?.setMovements?.(this.#movements(dig)); } catch { /* fake or missing pathfinder */ } }

  // t70 (doors): while she walks, opens a closed wooden door or fence gate on the next steps of her path and closes it
  // behind her once she is through (at most 2 blocks past, within reach), like a player. Returns a stop function.
  #doorKeeper() {
    const bot = this.#bot, opened = new Map();
    let path = [], busy = false, last = 0;
    const onPath = results => { path = Array.isArray(results?.path) ? results.path.slice(0, 64) : []; };
    bot.on?.('path_update', onPath);
    const key = p => `${p.x},${p.y},${p.z}`;
    const doorAt = (x, y, z) => { const block = bot.blockAt?.(this.#vec(Math.floor(x), Math.floor(y), Math.floor(z))); return isDoorway(block) ? block : null; };
    const toggle = async block => { busy = true; try { await bot.activateBlock(block); } catch { /* next tick */ } finally { busy = false; last = this.#now(); } };
    const tick = (final = false) => {
      if (busy || !bot.entity?.position || typeof bot.activateBlock !== 'function' || this.#now() - last < 250) return;
      const here = bot.entity.position, feet = this.#feet();
      // The path does not shrink as she walks it: drop the steps up to the one she stands on.
      const reached = path.findIndex(p => Math.floor(p.x) === feet.x && Math.floor(p.z) === feet.z && Math.abs(Math.floor(p.y) - feet.y) <= 1);
      if (reached >= 0) path = path.slice(reached + 1);
      const ahead = [{ x: feet.x, y: feet.y, z: feet.z }, ...path.map(p => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }))];
      for (const p of ahead) {
        for (const dy of [0, 1]) {
          const door = doorAt(p.x, p.y + dy, p.z);
          if (!door || distance(here, centre(door.position)) > 3) continue;
          const lower = door.getProperties?.().half === 'upper' ? (doorAt(p.x, p.y + dy - 1, p.z) ?? door) : door;
          // Only a door she opened herself is closed again; one standing open stays open.
          if (!isOpen(lower)) { opened.set(key(lower.position), lower.position); toggle(lower); return; }
        }
      }
      for (const [k, position] of opened) {
        const door = doorAt(position.x, position.y, position.z), d = distance(here, centre(position));
        if (!door) { opened.delete(k); continue; }
        const inIt = feet.x === position.x && feet.z === position.z && Math.abs(feet.y - position.y) <= 1;
        const upcoming = ahead.slice(1).some(p => p.x === position.x && p.z === position.z);
        // At the end of the walk she closes it once she is out of the doorway, however close.
        if (!inIt && (final || (!upcoming && d >= 1.8)) && d <= 4.5) { opened.delete(k); if (isOpen(door)) { toggle(door); return; } }
        else if (d > 4.5) opened.delete(k);
      }
    };
    const timer = setInterval(() => { try { tick(); } catch { /* next tick */ } }, 100);
    timer.unref?.();
    return { tick, stop: async () => {
      clearInterval(timer); bot.removeListener?.('path_update', onPath);
      path = [];
      // Close what she walked through, if still in reach.
      for (let i = 0; i < 40 && busy; i++) await new Promise(resolve => setTimeout(resolve, 50));
      last = 0;
      try { tick(true); } catch { /* gone */ }
      for (let i = 0; i < 40 && busy; i++) await new Promise(resolve => setTimeout(resolve, 50));
    } };
  }

  attach() {
    const bot = this.#bot;
    if (this.#pathfinder && typeof bot.loadPlugin === 'function' && !bot.pathfinder) bot.loadPlugin(this.#pathfinder.pathfinder);
    // Mineflayer injects its physics plugin after attach() (once the version is known): patch it at login and spawn.
    patchChatAcks(bot._client);
    // A changed block can open or close a line of sight: forget the cached answers (cheap: they are per second).
    this.#on('blockUpdate', () => { this.#sight.clear(); });
    this.#on('path_update', results => { fixDoorNodes(position => bot.blockAt?.(this.#vec(position.x, position.y, position.z)), results?.path); });
    this.#on('login', () => { patchPhysics(bot); patchWindowState(bot); patchOxygen(bot); });
    this.#on('spawn', () => {
      patchPhysics(bot); patchWindowState(bot);
      if (this.#spawnedAt) return;
      this.#spawnedAt = this.#now();
      if (this.#pathfinder && bot.pathfinder) this.#setMoves(false);
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

  // ---------- Sight (t70: no X-ray) ----------

  #opaque(block) { return !block || (block.boundingBox === 'block' && !SEE_THROUGH.test(block.name ?? '')); }
  #eyes() { const p = this.#bot.entity.position; return { x: p.x, y: p.y + (this.#bot.entity.eyeHeight ?? 1.62), z: p.z }; }
  // Under a roof of rock (an opaque block within 24 above her head) she sees less far.
  #sightRange() {
    const e = this.#eyes(), x = Math.floor(e.x), z = Math.floor(e.z);
    for (let y = Math.floor(e.y) + 1; y <= Math.floor(e.y) + 24; y++) {
      const block = this.#bot.blockAt(this.#vec(x, y, z));
      if (block && block.boundingBox === 'block' && !SEE_THROUGH.test(block.name ?? '') && !/_log$|_planks$|leaves$/.test(block.name ?? '')) return SIGHT.underground;
    }
    return SIGHT.range;
  }
  // Could she see this block from where she stands? Cached per block for her current cell and one second.
  #canSee(block) {
    const bot = this.#bot, p = block?.position;
    if (!p || !bot.entity?.position) return false;
    const f = this.#feet(), now = this.#now(), cell = `${f.x},${f.y},${f.z}|${Math.floor(now / SIGHT.cacheMs)}`;
    if (cell !== this.#sightKey) { this.#sight.clear(); this.#sightKey = cell; this.#range = null; }
    const key = `${p.x},${p.y},${p.z}`;
    if (this.#sight.has(key)) return this.#sight.get(key);
    let seen = false;
    try {
      const eyes = this.#eyes(), range = (this.#range ??= this.#sightRange()), blockAt = q => bot.blockAt(this.#vec(q.x, q.y, q.z));
      if (distance(eyes, centre(p)) <= range) {
        // Faces that touch something see-through, and face her.
        const faces = FACES.filter(([dx, dy, dz]) => !this.#opaque(blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz }))
          && (dx * (eyes.x - (p.x + 0.5)) + dy * (eyes.y - (p.y + 0.5)) + dz * (eyes.z - (p.z + 0.5))) > 0);
        const opaque = b => this.#opaque(b);
        seen = faces.some(([dx, dy, dz]) => lineOfSight(blockAt, eyes, { x: p.x + 0.5 + dx * 0.45, y: p.y + 0.5 + dy * 0.45, z: p.z + 0.5 + dz * 0.45 }, p, opaque));
      }
    } catch { seen = false; }
    this.#sight.set(key, seen);
    if (seen) this.#remember(block);
    return seen;
  }
  // Blocks she has seen this session (capped; forgotten when the block there changes).
  #remember(block) {
    const p = block.position, key = `${p.x},${p.y},${p.z}`;
    this.#memory.delete(key);
    this.#memory.set(key, { name: block.name, x: p.x, y: p.y, z: p.z });
    while (this.#memory.size > SIGHT.memory) this.#memory.delete(this.#memory.keys().next().value);
  }
  #remembered(block) {
    const p = block?.position;
    if (!p) return false;
    const entry = this.#memory.get(`${p.x},${p.y},${p.z}`);
    if (!entry) return false;
    if (entry.name !== block.name) { this.#memory.delete(`${p.x},${p.y},${p.z}`); return false; }
    return true;
  }
  #known(block) { return this.#canSee(block) || this.#remembered(block); }
  // Remembered blocks of these ids within range, still there.
  #recall(ids, range) {
    const here = this.#bot.entity.position, names = new Set(ids.map(id => this.#nameOf(id)).filter(Boolean)), out = [];
    for (const entry of this.#memory.values()) {
      if (!names.has(entry.name) || distance(here, centre(entry)) > range) continue;
      const block = this.#bot.blockAt(this.#vec(entry.x, entry.y, entry.z));
      if (block?.name === entry.name) out.push(block);
    }
    return out;
  }
  #nameOf(id) {
    this.#names ??= new Map(Object.values(this.#registry().blocksByName ?? {}).map(block => [block.id, block.name]));
    return this.#names.get(id);
  }

  #scan() {
    const bot = this.#bot;
    if (!bot.entity || typeof bot.findBlocks !== 'function') return;
    const ids = this.#ids(NOTABLE);
    if (!ids.length) return;
    // Only what she can see is "found" (t70: no X-ray).
    for (const position of (bot.findBlocks({ matching: ids, maxDistance: LIMITS.scanRange, count: SIGHT.candidates }) ?? []).slice(0, SIGHT.candidates)) {
      const key = `${position.x},${position.y},${position.z}`;
      if (this.#seen.has(key)) continue;
      const block = bot.blockAt(position);
      if (!block?.name || !this.#canSee(block)) continue;
      if (this.#seen.size > 2000) this.#seen.clear();
      this.#seen.add(key);
      this.#event({ type: 'found', block: block.name, x: position.x, y: position.y, z: position.z });
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
        // Only blocks she can see (t70: no X-ray): the nearest candidates, checked for a visible face and a line of sight.
        for (const position of (bot.findBlocks({ matching: this.#perceivedIds, maxDistance: LIMITS.scanRange, count: 96 }) ?? []).slice(0, 96)) {
          const block = bot.blockAt(position);
          if (!block || (nearest.has(block.name) && nearest.get(block.name).distance <= round(distance(here, centre(position))))) continue;
          if (!this.#canSee(block)) continue;
          const name = block.name ?? 'block', d = round(distance(here, centre(position)));
          if (!nearest.has(name) || nearest.get(name).distance > d) nearest.set(name, { name, x: position.x, y: position.y, z: position.z, distance: d });
        }
        blocks = [...nearest.values()].sort((a, b) => a.distance - b.distance).slice(0, LIMITS.blocks);
      }
    } catch { blocks = []; }
    const inventory = [...counts(carried(bot))].sort((a, b) => b[1] - a[1]).slice(0, LIMITS.inventory).map(([name, count]) => `${clean(name, 40)} ${count}`);
    const slots = bot.inventory?.slots ?? [];
    const armor = [5, 6, 7, 8].map(slot => slots[slot]?.name).filter(Boolean).map(name => clean(name, 40));
    let biome = null;
    try { biome = bot.blockAt(here)?.biome?.name ?? null; } catch { biome = null; }
    const held = bot.heldItem;
    return { spawned: true, username: bot.username,
      position: { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) },
      dimension: clean(String(bot.game?.dimension ?? 'overworld').replace(/^minecraft:/, ''), 32), biome: biome ? clean(biome, 40) : null,
      time: { phase: timeOfDay(bot.time?.timeOfDay ?? 0), ticks: Math.floor(bot.time?.timeOfDay ?? 0) },
      health: round(bot.health ?? 0), food: Math.round(bot.food ?? 0), ...(ownOxygen(bot) < 20 ? { oxygen: ownOxygen(bot) } : {}),
      ...(self.isInWater ? { inWater: true } : {}),
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
  // t70 (doors): on foot first (through doors, no digging); only when that finds no way (or takes too long to decide),
  // once more with digging at a high cost. Doors on the way are opened and closed behind her.
  async #walk(goal, signal) {
    if (signal.aborted) throw new Error('stopped');
    const pathfinder = this.#bot.pathfinder, doors = this.#doorKeeper();
    try {
      this.#setMoves(false);
      try { await pathfinder.goto(goal); return; } catch (error) { if (signal.aborted || !/^(?:NoPath|Timeout)$/.test(error?.name ?? '')) throw error; }
      if (signal.aborted) throw new Error('stopped');
      this.#setMoves(true);
      await pathfinder.goto(goal);
    } finally { this.#setMoves(false); await doors.stop(); }
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
  // What she carries. While a window (crafting table, furnace, chest) is open the server updates that window's copy
  // of her inventory, and Mineflayer's bot.inventory only catches up when the window closes: count from the window.
  #items() { return carried(this.#bot); }
  // An inventory item to equip or toss: its slot must be an inventory slot, never a window slot.
  #item(name) { return (this.#bot.inventory?.items?.() ?? []).find(item => item.name === name) ?? null; }
  #count(name) { return this.#items().filter(item => item.name === name).reduce((sum, item) => sum + (item.count ?? 1), 0); }
  #snapshot() { return counts(this.#items()); }
  #gained(before) {
    const gains = [];
    for (const [name, n] of this.#snapshot()) if (n > (before.get(name) ?? 0)) gains.push({ name, count: n - (before.get(name) ?? 0) });
    return summarise(gains, 8);
  }
  // ---------- Inventory checks (t70 windows) ----------
  // Every action that changes the inventory measures it: counts before, the server's answer after (waiting up to
  // pace.inventory ms, 2 s, for its slot updates), and the result says what really changed.

  // Asks the server for the real contents of the open window (or the inventory): a click it must answer with a full
  // resync (Mineflayer's own _syncWindow). Resolves to false when that is not available or it did not answer in time.
  async #sync() {
    const bot = this.#bot;
    if (typeof bot._syncWindow !== 'function') return false;
    const window = bot.currentWindow ?? bot.inventory;
    if (!window) return false;
    let timer;
    try {
      return await Promise.race([Promise.resolve(bot._syncWindow(window)).then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.#pace.sync); })]);
    } catch { return false; } finally { clearTimeout(timer); }
  }
  async #fresh() { await this.#sync(); return this.#snapshot(); }
  // Waits until test(counts) holds, up to pace.inventory ms; if it never does, asks the server once and counts again.
  async #settle(before, test = counts => changed(before, counts), signal = null) {
    if (await this.#until(() => test(this.#snapshot()), this.#pace.inventory, signal)) return this.#snapshot();
    await this.#sync();
    return this.#snapshot();
  }
  // Pickups arrive one stack at a time: wait for the first change, then until nothing changed for a moment (300 ms), up
  // to pace.inventory ms in all.
  async #settleAll(before, signal) {
    const key = counts => [...counts].sort().join(','), quiet = Math.min(300, this.#pace.inventory / 4);
    let last = key(this.#snapshot()), since = this.#now();
    const done = await this.#until(() => {
      const now = this.#snapshot(), k = key(now);
      if (k !== last) { last = k; since = this.#now(); }
      return changed(before, now) && this.#now() - since >= quiet;
    }, this.#pace.inventory, signal);
    if (!done && !changed(before, this.#snapshot())) await this.#sync();
    return this.#snapshot();
  }
  // Ingredients left in her 2x2 grid by a failed craft, or a result left on the cursor, go back into the inventory when
  // the inventory "closes", as when a player closes the inventory screen. (Seen twice on 26.1 during testing: right
  // after a 2x2 craft the server's full state had the result outside her inventory slots; it showed up there later.)
  // Resolves to whether there was anything to put back.
  async #clearGrid() {
    const bot = this.#bot;
    if (bot.currentWindow || !bot.inventory) return false;
    await this.#sync();
    const slots = bot.inventory.slots ?? [];
    if (![1, 2, 3, 4].some(slot => slots[slot]) && !bot.inventory.selectedItem) return false;
    try { bot._client?.write?.('close_window', { windowId: 0 }); } catch { /* not connected */ }
    await this.#sync();
    return true;
  }

  #block(position) { return this.#bot.blockAt(this.#vec(position.x, position.y, position.z)); }
  // The nearest blocks matching (ids or a name test), nearest first.
  // t70 (no X-ray): only blocks she can see now or has seen this session (and that are still there).
  #find(match, range, count = 1, filter = () => true) {
    const bot = this.#bot;
    if (typeof bot.findBlocks !== 'function') return [];
    const ids = typeof match === 'string' ? [this.#registry().blocksByName?.[match]?.id].filter(value => value !== undefined) : match instanceof RegExp ? this.#ids(match) : match;
    if (!ids.length) return [];
    const here = bot.entity.position, byKey = new Map();
    for (const block of this.#recall(ids, range)) byKey.set(`${block.position.x},${block.position.y},${block.position.z}`, block);
    let checked = 0;
    for (const position of (bot.findBlocks({ matching: ids, maxDistance: range, count: Math.max(count * 4, 64) }) ?? [])) {
      const key = `${position.x},${position.y},${position.z}`;
      if (byKey.has(key)) continue;
      const block = bot.blockAt(position);
      if (!block?.position) continue;
      if (this.#remembered(block) || (checked++ < SIGHT.candidates * 2 && this.#canSee(block))) byKey.set(key, block);
    }
    return [...byKey.values()].filter(block => filter(block))
      .sort((a, b) => distance(here, centre(a.position)) - distance(here, centre(b.position))).slice(0, count);
  }
  #unseen(what) { return `you haven't seen any ${what} nearby; explore or mine to find some`; }
  #blockTarget(action, match, range, what) {
    if (action.x !== undefined) {
      if (distance(this.#bot.entity.position, action) > LIMITS.blockRange) fail(`${at(action)} is too far (more than ${LIMITS.blockRange} blocks)`);
      const block = this.#block(action);
      if (!block) fail(`the block at ${at(action)} is not loaded`);
      return block;
    }
    if (typeof match === 'string' && !this.#registry().blocksByName?.[match]) fail(`no block called ${match}`);
    return this.#find(match, range)[0] ?? fail(this.#unseen(what));
  }
  #entities(test, range) {
    const here = this.#bot.entity.position;
    return Object.values(this.#bot.entities ?? {}).filter(entity => entity && entity !== this.#bot.entity && entity.position && test(entity)
      && distance(here, entity.position) <= range).sort((a, b) => distance(here, a.position) - distance(here, b.position));
  }
  async #equipBestTool(block) {
    let tool = null;
    try { tool = this.#bot.pathfinder?.bestHarvestTool?.(block) ?? null; } catch { tool = null; }
    // For blocks that break at once (grass, flowers) any item "harvests" as fast: hold only a real tool.
    if (tool && !/_(?:pickaxe|axe|shovel|hoe|sword)$|^shears$/.test(tool.name ?? '')) tool = null;
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
    if (!block || NOTHING.has(block.name)) fail(`nothing to dig at ${block ? at(block.position) : 'that spot'}`);
    if (block.diggable === false || block.hardness === null || block.hardness < 0) fail(`${block.name} cannot be broken`);
    // A block without a collision box (grass, a flower) is invisible to the line-of-sight goal: walk near it instead.
    await this.#reach(block.position, signal, { look: block.boundingBox !== 'empty' });
    const fresh = this.#bot.blockAt(block.position) ?? block;
    if (fresh.name !== block.name) fail(`the ${block.name} at ${at(block.position)} is gone`);
    if (typeof this.#bot.canDigBlock === 'function' && !this.#bot.canDigBlock(fresh)) fail(`cannot reach the ${fresh.name} at ${at(fresh.position)}`);
    const tool = await this.#equipBestTool(fresh);
    await this.#bot.dig(fresh, true);
    this.#sight.clear(); // what she sees changed
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

  // ---------- Movement checks and getting unstuck (t70) ----------
  // Every movement skill measures where she really is afterwards: a pathfinder that "arrives" without moving (it
  // resolves goto on an empty path, which is what it finds from inside water) or a server that keeps sending her
  // back must come out as a failure with her real position, never as "arrived".

  #here() { const p = this.#bot.entity.position; return { x: p.x, y: p.y, z: p.z }; }
  #feet() { const p = this.#bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }; }
  #where() { const f = this.#feet(); return at(f); }
  #solid(x, y, z) {
    const block = this.#block({ x, y, z });
    return !block || (!REPLACEABLE.has(block.name) && block.boundingBox !== 'empty'); // unloaded counts as solid
  }
  #watery(x, y, z) {
    const block = this.#block({ x, y, z });
    return Boolean(block && (WATERY.has(block.name) || block.getProperties?.()?.waterlogged === true));
  }
  #inWater() { const f = this.#feet(); return this.#bot.entity.isInWater === true || this.#watery(f.x, f.y, f.z); }
  #headUnder() {
    const p = this.#bot.entity.position;
    return this.#watery(Math.floor(p.x), Math.floor(p.y + 1.62), Math.floor(p.z));
  }
  // Ways out from the block she is in: a side she can walk into (two free blocks) or step up onto (a block with two
  // free above it and head room for the jump).
  #exits() {
    const f = this.#feet(), exits = [];
    for (const [dx, dz] of SIDES) {
      const x = f.x + dx, z = f.z + dz;
      if (!this.#solid(x, f.y, z) && !this.#solid(x, f.y + 1, z)) exits.push({ dx, dz, up: 0 });
      else if (this.#solid(x, f.y, z) && !this.#solid(x, f.y + 1, z) && !this.#solid(x, f.y + 2, z) && !this.#solid(f.x, f.y + 2, f.z)) exits.push({ dx, dz, up: 1 });
    }
    return exits;
  }
  // Stuck: in water (a dug hole fills up; pathfinding out of water finds nothing), or in a hole with no side to walk
  // or step out of.
  #stuck() { return this.#inWater() || !this.#exits().length; }
  // The best way out first: onto dry ground before into more water, walking before stepping up.
  #bestExit() {
    const f = this.#feet();
    return this.#exits().map(exit => ({ ...exit, wet: this.#watery(f.x + exit.dx, f.y + exit.up, f.z + exit.dz) ? 1 : 0 }))
      .sort((a, b) => a.wet - b.wet || a.up - b.up)[0] ?? null;
  }
  // The rim of the hole she is in: the lowest block beside her column where she could stand (two free blocks on solid
  // ground, not water), up to 12 blocks up. null in open water or when nothing is in reach.
  #rim() {
    const f = this.#feet();
    let best = null;
    for (const [dx, dz] of SIDES) {
      const x = f.x + dx, z = f.z + dz;
      for (let y = f.y; y <= f.y + 12; y++) {
        if (!this.#solid(x, y, z) && !this.#solid(x, y + 1, z) && this.#solid(x, y - 1, z) && !this.#watery(x, y, z)) {
          if (!best || y < best.y) best = { y, dx, dz };
          break;
        }
      }
    }
    return best;
  }
  // Out: not in water, on solid ground (not hanging over the hole), and up at the rim (or with a way on foot).
  #out(rim) {
    const f = this.#feet();
    return !this.#inWater() && this.#solid(f.x, f.y - 1, f.z) && (rim ? f.y >= rim.y : this.#exits().length > 0);
  }
  // Which way to step: toward the rim once it is level or one block up, else the best exit.
  #toward(rim) {
    const f = this.#feet();
    if (!rim) return this.#bestExit();
    const up = rim.y - f.y;
    return up === 0 || (up === 1 && !this.#solid(f.x, f.y + 2, f.z)) ? { dx: rim.dx, dz: rim.dz, up } : null;
  }
  #moved(from) { const p = this.#bot.entity.position; return Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z); }

  // Polls test() until true or ms ran out; resolves to whether it became true.
  async #until(test, ms, signal) {
    const end = this.#now() + ms;
    for (;;) {
      if (test()) return true;
      if (this.#now() >= end) return false;
      await this.#wait(Math.min(this.#pace.poll, 50), signal);
    }
  }
  #release(...controls) { for (const control of controls) { try { this.#bot.setControlState(control, false); } catch { /* fake */ } } }

  #reached(goal, target, range) {
    const p = this.#bot.entity.position, node = this.#vec(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    if (typeof goal?.isEnd === 'function') {
      try { return goal.isEnd(node) || goal.isEnd(node.offset(0, 1, 0)); } catch { /* fall back to the distance */ }
    }
    if (!target) return true;
    return Math.hypot(p.x - target.x, (target.y === undefined ? 0 : p.y - target.y), p.z - target.z) <= range + 1.5;
  }

  // Walks to the goal and checks she got there. Stuck in water or a hole, she escapes and tries once more.
  // Returns a note on the escape ('' when there was none); throws with her real position when she did not arrive.
  async #walkTo(goal, signal, { target = null, range = 1, makeGoal = () => goal } = {}) {
    const start = this.#here();
    let problem = null;
    try { await this.#walk(goal, signal); } catch (error) { if (signal.aborted) throw error; problem = error; }
    if (this.#reached(goal, target, range)) return '';
    let note = '';
    if (this.#stuck()) {
      try { note = await this.#escape(signal); } catch (error) { if (signal.aborted) throw error; note = ''; problem = error; }
      if (note) {
        const again = makeGoal();
        problem = null;
        try { await this.#walk(again, signal); } catch (error) { if (signal.aborted) throw error; problem = error; }
        if (this.#reached(again, target, range)) return ` (first got out: ${note})`;
      }
    }
    const why = problem ? clean(String(problem.message ?? problem).replace(/[.!]+$/, ''), 120) : 'the path finder found no way';
    fail(`did not get there: ${why}; still at ${this.#where()} (moved ${round(this.#moved(start))} blocks)${note ? `; ${note}` : ''}`);
  }

  // One pillar step: a block under her feet. In water she swims up first; on the ground she jumps.
  async #pillarStep(name, signal) {
    const bot = this.#bot, p = bot.entity.position, x = Math.floor(p.x), z = Math.floor(p.z), y = Math.floor(p.y);
    const under = this.#block({ x, y: y - 1, z });
    if (!under) fail('the block under you is not loaded');
    await this.#hold(name);
    let target = { x, y: y - 1, z };
    // A caller swimming up holds jump already: leave it held.
    const held = typeof bot.getControlState === 'function' ? bot.getControlState('jump') === true : bot.controls?.jump === true;
    const letGo = () => { if (!held) this.#release('jump'); };
    if (!REPLACEABLE.has(under.name)) {
      // On something solid: rise a full block, then fill the block she was standing in.
      target = { x, y, z };
      bot.setControlState('jump', true);
      // Near the top of the jump (it peaks 1.25 up): the server, a tick behind, must see her clear of the block.
      const water = this.#inWater(), height = water ? 1 : 1.1;
      const rose = await this.#until(() => bot.entity.position.y >= y + height, water ? this.#pace.rise * 2 : this.#pace.rise, signal);
      if (!rose) { letGo(); fail(`could not rise high enough to put a block under you (still at ${this.#where()})`); }
    }
    const reference = this.#reference(target);
    if (!reference) { letGo(); fail(`nothing to place the ${name} against at ${at(target)}`); }
    try { await bot.placeBlock(reference.block, reference.face); } finally { letGo(); }
    return target;
  }

  // Swim up (holding jump, sprint-swimming), then out over the rim. Returns a note, or null when she is not out.
  async #swimOut(signal, rim, out) {
    const bot = this.#bot, start = this.#here();
    bot.setControlState('jump', true); bot.setControlState('sprint', true);
    try {
      const end = this.#now() + this.#pace.swim;
      while (this.#now() < end && !signal.aborted && !out()) {
        const exit = this.#headUnder() ? null : this.#toward(rim);
        if (exit) {
          const f = this.#feet();
          await bot.lookAt?.(this.#vec(f.x + 0.5 + exit.dx, f.y + exit.up + 1.6, f.z + 0.5 + exit.dz), true);
          bot.setControlState('forward', true);
        } else this.#release('forward');
        await this.#wait(Math.min(this.#pace.poll, 50), signal);
      }
    } finally { this.#release('forward', 'sprint', 'jump'); }
    await this.#wait(this.#pace.settle, signal);
    return out() ? `swam up and out (${round(bot.entity.position.y - start.y)} blocks up)` : null;
  }

  // Step onto the next block (level or one up): face it, walk, jump if it is higher.
  async #stepOut(signal, exit) {
    const bot = this.#bot;
    if (!exit) return false;
    const f = this.#feet(), cell = { x: f.x + exit.dx, y: f.y + exit.up, z: f.z + exit.dz };
    await bot.lookAt?.(this.#vec(cell.x + 0.5, cell.y + 1.6, cell.z + 0.5), true);
    bot.setControlState('forward', true);
    if (exit.up) bot.setControlState('jump', true);
    try {
      return await this.#until(() => { const now = this.#feet(); return now.x === cell.x && now.z === cell.z && now.y >= cell.y; }, this.#pace.step, signal);
    } finally { this.#release('forward', 'jump'); }
  }

  async #pillarOut(signal, rim, out) {
    const name = this.#items().find(item => SCAFFOLD.test(item.name))?.name;
    if (!name) throw new Error('no dirt, cobblestone or planks to pillar with');
    const start = this.#here(), inWater = this.#inWater();
    let placed = 0;
    if (inWater) this.#bot.setControlState('jump', true);
    try {
      while (!out() && !signal.aborted && placed < LIMITS.pillarMax) {
        const exit = this.#headUnder() ? null : this.#toward(rim);
        if (exit && await this.#stepOut(signal, exit)) { await this.#wait(this.#pace.settle, signal); if (out()) break; }
        if (!this.#count(name)) break;
        await this.#pillarStep(name, signal);
        placed++;
        this.#progress(`placed ${placed} ${name} under you`);
        await this.#wait(this.#pace.settle, signal);
      }
      if (!out()) await this.#stepOut(signal, this.#toward(rim));
    } finally { if (inWater) this.#release('jump'); }
    return out() ? `pillared up ${plural(placed, `${name} block`)} and stepped out (${round(this.#bot.entity.position.y - start.y)} blocks up)` : null;
  }

  // Dig a staircase up toward the rim: head room, the two blocks ahead, a step (placed if missing), and up onto it.
  async #stairsOut(signal, rim, out) {
    const start = this.#here();
    let steps = 0;
    const filler = () => this.#items().find(item => SCAFFOLD.test(item.name))?.name ?? null;
    const sides = rim ? [[rim.dx, rim.dz], ...SIDES.filter(([dx, dz]) => dx !== rim.dx || dz !== rim.dz)] : SIDES;
    for (const [dx, dz] of sides) {
      for (let n = 0; n < LIMITS.stairMax && !signal.aborted && !out(); n++) {
        const f = this.#feet(), x = f.x + dx, z = f.z + dz;
        let blocked = false;
        for (const [bx, by, bz] of [[f.x, f.y + 2, f.z], [x, f.y + 1, z], [x, f.y + 2, z]]) {
          if (!this.#solid(bx, by, bz)) continue;
          const block = this.#block({ x: bx, y: by, z: bz });
          if (!NATURAL.test(block?.name ?? '')) { blocked = true; break; } // escape digs natural ground only, never a build
          try { await this.#dig(block, signal); } catch (error) { if (signal.aborted) throw error; blocked = true; break; }
        }
        if (blocked) break;
        if (!this.#solid(x, f.y, z)) {
          const name = filler();
          if (name) { try { await this.#placeAt({ x, y: f.y, z }, name, signal); } catch (error) { if (signal.aborted) throw error; } }
        }
        if (!await this.#stepOut(signal, { dx, dz, up: this.#solid(x, f.y, z) ? 1 : 0 })) break; // did not get onto it: another side
        steps++;
        this.#progress(`dug ${plural(steps, 'stair step')}`);
      }
      if (out()) break;
    }
    return out() ? `dug ${plural(steps, 'stair step')} out (${round(this.#bot.entity.position.y - start.y)} blocks up)` : null;
  }

  // Out of water, a hole or a pit: swim up (sprint-swim), else pillar up with a scaffold block, else dig stairs.
  // Each way is tried only while she is not out yet; what failed is said, on success too.
  async #escape(signal) {
    const start = this.#here(), rim = this.#rim(), out = () => this.#out(rim), tried = [];
    if (out()) return 'not stuck: you are on your feet with a way to walk on';
    for (const [label, run] of [['swimming up', this.#swimOut], ['pillaring', this.#pillarOut], ['digging stairs', this.#stairsOut]]) {
      if (label === 'swimming up' && !this.#inWater()) continue;
      let note = null;
      try { note = await run.call(this, signal, rim, out); } catch (error) { if (signal.aborted) throw error; tried.push(`${label}: ${clean(error?.message, 80)}`); }
      if (out()) return `${note ?? `${label} got you out`}; now at ${this.#where()}${tried.length ? ` (${tried.join('; ')})` : ''}`;
      if (!note && !tried.some(entry => entry.startsWith(label))) tried.push(`${label} did not get you out`);
    }
    fail(`still stuck at ${this.#where()} (moved ${round(this.#moved(start))} blocks${rim ? `; the rim is at y ${rim.y}` : ''}): ${tried.join('; ')}`);
  }

  // ---------- Skills ----------

  async #skill(action, signal) {
    const bot = this.#bot, here = bot.entity.position;
    switch (action.type) {
      case 'goto': {
        const goals = this.#goals();
        const near = (target, range) => ({ target, range, makeGoal: () => new goals.GoalNear(target.x, target.y, target.z, range) });
        if (action.player) {
          const entity = this.#player(action.player), target = { x: entity.position.x, y: entity.position.y, z: entity.position.z };
          const how = near(target, 2), note = await this.#walkTo(how.makeGoal(), signal, how);
          return `reached ${action.player}; now at ${this.#where()}${note}`;
        }
        if (action.block) {
          const block = this.#find(action.block, LIMITS.findRange)[0] ?? fail(this.#unseen(action.block));
          const how = near(block.position, 2), note = await this.#walkTo(how.makeGoal(), signal, how);
          return `reached the ${action.block} at ${at(block.position)}; now at ${this.#where()}${note}`;
        }
        if (distance(here, action) > LIMITS.gotoDistance) throw new Error(`too far (more than ${LIMITS.gotoDistance} blocks)`);
        const how = near(action, 1), note = await this.#walkTo(how.makeGoal(), signal, how);
        return `arrived near ${Math.floor(action.x)} ${Math.floor(action.y)} ${Math.floor(action.z)}; now at ${this.#where()}${note}`;
      }
      case 'follow': {
        const goals = this.#goals(), entity = this.#player(action.player), doors = this.#doorKeeper();
        // On foot through doors; digging (the second pass) only after the pathfinder found no way.
        let digging = false;
        const onPath = results => { if (!digging && ['noPath', 'timeout'].includes(results?.status)) { digging = true; this.#setMoves(true); } };
        this.#setMoves(false);
        bot.on?.('path_update', onPath);
        try {
          bot.pathfinder.setGoal(new goals.GoalFollow(entity, action.distance), true);
          await this.#wait(action.seconds * 1000, signal);
        } finally {
          bot.removeListener?.('path_update', onPath);
          try { bot.pathfinder.setGoal(null); } catch { /* not moving */ }
          this.#setMoves(false); await doors.stop();
        }
        return `followed ${action.player} for ${action.seconds}s`;
      }
      case 'wander': {
        const goals = this.#goals(), angle = Math.random() * Math.PI * 2;
        const x = Math.floor(here.x + Math.cos(angle) * action.distance), z = Math.floor(here.z + Math.sin(angle) * action.distance);
        const note = await this.#walkTo(new goals.GoalNearXZ(x, z, 3), signal, { target: { x, z }, range: 3, makeGoal: () => new goals.GoalNearXZ(x, z, 3) });
        return `wandered to ${this.#where()}${note}`;
      }
      case 'look_at': {
        const target = action.player ? this.#player(action.player).position.offset(0, 1.6, 0) : this.#vec(action.x, action.y, action.z);
        await bot.lookAt(target);
        return action.player ? `looking at ${action.player}` : 'looking there';
      }
      case 'jump': {
        // Success is leaving the ground (half a block up at least), not having pressed the key.
        const startY = here.y;
        let peak = startY;
        bot.setControlState('jump', true);
        try { await this.#until(() => { peak = Math.max(peak, bot.entity.position.y); return peak - startY >= 0.5; }, this.#pace.settle, signal); } finally { bot.setControlState('jump', false); }
        if (peak - startY >= 0.5) return `jumped (${round(peak - startY)} blocks up)`;
        const f = this.#feet();
        if (this.#inWater()) fail(`jumping in water barely moves you (rose ${round(peak - startY)}; still at ${at(f)}): use swim to rise, or escape to get out`);
        fail(`did not leave the ground (rose ${round(peak - startY)}; still at ${at(f)})${this.#solid(f.x, f.y + 2, f.z) ? ': a block is right above your head' : ''}`);
      }
      case 'sprint': case 'sneak':
        bot.setControlState(action.type, action.on);
        return `${action.type} ${action.on ? 'on' : 'off'}`;
      case 'swim': {
        // Hold jump (and sprint-swim forward); the result is what she really did.
        const start = this.#here(), wasIn = this.#inWater();
        let peak = start.y;
        bot.setControlState('jump', true);
        if (action.forward) { bot.setControlState('sprint', true); bot.setControlState('forward', true); }
        try { await this.#until(() => { peak = Math.max(peak, bot.entity.position.y); return false; }, action.seconds * 1000, signal); }
        finally { this.#release('jump', 'forward', ...(action.forward ? ['sprint'] : [])); }
        const end = bot.entity.position, up = peak - start.y, across = Math.hypot(end.x - start.x, end.z - start.z), under = this.#headUnder();
        const did = `${up >= 0.3 ? `rose ${round(up)} blocks` : 'did not rise'}${action.forward ? `, ${round(across)} blocks forward` : ''}`;
        if (up < 0.3 && across < 0.5 && (under || !wasIn)) fail(`swam for ${action.seconds}s but did not move: still at ${this.#where()}${wasIn ? ', head under water' : ' (not in water)'}; try escape`);
        return `swam ${action.seconds}s: ${did}; now at ${this.#where()}${under ? ', head still under water' : wasIn ? ', head above water' : ''}`;
      }
      case 'escape': {
        if (!this.#stuck()) return `not stuck: there is a way out on foot from ${this.#where()}`;
        return `got out: ${await this.#escape(signal)}`;
      }

      case 'dig': {
        const block = this.#blockTarget(action, action.block, LIMITS.collectRange, action.block);
        const dug = await this.#dig(block, signal);
        return `dug ${dug.name} at ${at(block.position)}${dug.tool ? ` with ${dug.tool}` : ''}`;
      }
      case 'collect': {
        if (!this.#registry().blocksByName?.[action.block]) fail(`no block called ${action.block}`);
        const before = await this.#fresh();
        let got = 0, problem = null;
        for (let attempt = 0; got < action.count && attempt < action.count + 4 && !signal.aborted; attempt++) {
          const block = this.#find(action.block, LIMITS.collectRange)[0];
          if (!block) break;
          try { await this.#dig(block, signal); got++; this.#progress(`mined ${got} ${action.block}`); } catch (error) { if (signal.aborted) throw error; problem = error; }
        }
        if (!got) throw problem ?? new Error(this.#unseen(action.block));
        await this.#pickUp(signal).catch(() => {});
        // Drops reach the inventory a moment after she walks over them: wait for them (up to 2 s) before counting.
        const { gained } = changes(before, await this.#settleAll(before, signal));
        return `mined ${got} ${action.block}${got < action.count ? ` (only ${got} of ${action.count} found)` : ''}; ${gained.length ? `picked up ${summarise(gained, 8)}` : 'nothing reached your inventory yet (the drops may still be on the ground)'}`;
      }
      case 'pick_up': {
        const before = await this.#fresh(), count = await this.#pickUp(signal);
        if (!count) throw new Error('no dropped items nearby');
        const { gained } = changes(before, await this.#settleAll(before, signal));
        if (!gained.length) fail(`walked over ${plural(count, 'item stack')} but nothing reached your inventory (full, or not pickable yet)`);
        return `picked up ${summarise(gained, 8)} (${plural(count, 'item stack')} nearby)`;
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
        // A pillar step: only once she is a full block up (in water that takes longer), else the server refuses it.
        const target = await this.#pillarStep(action.item, signal);
        return `${this.#inWater() ? 'swam up' : 'jumped'} and placed ${action.item} under you at ${at(target)}`;
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
            const all = bot.recipesAll?.(item.id, null, true) ?? [];
            if (!all.length) fail(`${action.item} cannot be crafted`);
            // Name what is missing for the variant she is closest to (oak planks she has, not cherry planks she has not).
            const names = this.#registry().items ?? {};
            const short = recipe => (recipe.delta ?? []).filter(d => d.count < 0 && (this.#bot.inventory.count?.(d.id, d.metadata) ?? 0) < -d.count);
            const best = all.map(recipe => ({ recipe, missing: short(recipe) })).sort((a, b) => a.missing.length - b.missing.length)[0];
            const missing = best.missing.map(d => `${-d.count} ${names[d.id]?.name ?? 'item ' + d.id}`);
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
        // t70: crafts in rounds and measures each one: what the server really made, never what was asked. At a table
        // one craft per round (the window is opened fresh, so its slots are the server's); in the 2x2 grid as many as
        // the ingredients cover. A round that made nothing is tried once more, then the craft stops.
        const atTable = Boolean(recipe.requiresTable), before = await this.#fresh();
        let made = 0, problem = null, retried = false;
        while (made < action.count && !signal.aborted) {
          const current = bot.recipesFor(item.id, null, 1, atTable ? true : null)?.[0];
          if (!current) break;
          const per = current.result?.count ?? 1;
          let times = atTable ? 1 : Math.ceil((action.count - made) / per);
          while (times > 1 && !bot.recipesFor(item.id, null, times * per, null)?.length) times--;
          const start = this.#snapshot();
          problem = null;
          try { await bot.craft(current, times, atTable ? table : undefined); } catch (error) { if (signal.aborted) throw error; problem = error; }
          const enough = counts => delta(start, counts, action.item) >= times * per;
          let after = await this.#settle(start, enough, signal);
          if (delta(start, after, action.item) <= 0 && await this.#clearGrid()) after = await this.#settle(start, enough, signal);
          const got = delta(start, after, action.item);
          if (got > 0) { made += got; this.#progress(`crafted ${made} ${action.item}`); continue; }
          if (problem || retried) break;
          retried = true;
        }
        await this.#clearGrid();
        // The result can arrive before the ingredients' updates: count after the server's full answer.
        await this.#settle(before, counts => delta(before, counts, action.item) >= made, signal);
        const after = await this.#fresh();
        const real = delta(before, after, action.item), { lost } = changes(before, after, new Set([action.item]));
        const why = problem ? clean(problem.message, 80) : null, where = used ? `; ${used}` : '';
        if (real <= 0) {
          fail(`crafting ${action.item} did not work: the server made none${why ? ` (${why})` : ''}; ${lost.length ? `your inventory lost ${summarise(lost, 8)}` : 'your inventory is unchanged'}${where}`);
        }
        const more = Boolean(bot.recipesFor(item.id, null, 1, atTable ? true : null)?.length);
        const short = real >= action.count ? '' : why ? ` (only ${real} of ${action.count}: ${why})`
          : more ? ` (only ${real} of ${action.count}: the server made no more)` : ` (only enough ingredients for ${real} of ${action.count})`;
        return `crafted ${real} ${action.item}${short}${where}${lost.length ? `; it took ${summarise(lost, 8)}` : ''}`;
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
        // t70: the result is what really came out, counted in her inventory after the furnace window is closed.
        const before = await this.#fresh();
        // The furnace's state (0 burn time left, 2 cooking progress) comes as window properties. Mineflayer attaches its
        // listener only after the window opened and misses the first burst (measured on 26.1: a furnace still burning
        // from the last smelt looked cold), so the body keeps its own copy.
        const properties = new Map(), onProperty = packet => {
          if (!properties.has(packet?.windowId)) properties.set(packet?.windowId, new Map());
          properties.get(packet?.windowId).set(packet?.property, packet?.value);
        };
        bot._client?.on?.('craft_progress_bar', onProperty);
        let furnace;
        try { furnace = await bot.openFurnace(block); } catch (error) { bot._client?.removeListener?.('craft_progress_bar', onProperty); throw error; }
        const registry = this.#registry().itemsByName ?? {}, property = n => properties.get(furnace.id)?.get(n);
        const lit = () => furnace.fuel > 0 || property(0) > 0, cooking = () => furnace.progress > 0 || property(2) > 0;
        let fuelName = null, put = 0, left = 0, problem = null, stuckOut = null;
        try {
          // A furnace still burning from an earlier smelt needs no fuel: wait for its burn time to arrive.
          if (!furnace.fuelItem?.() && bot._client) await this.#until(() => property(0) !== undefined, this.#pace.settle * 2.5, signal);
          const fuelHere = furnace.fuelItem?.();
          if (!fuelHere && !lit()) {
            const choices = action.fuel ? [[action.fuel, action.fuel === 'stick' ? 0.5 : WOOD_FUEL.test(action.fuel) ? 1.5 : FUELS.find(([name]) => name === action.fuel)?.[1] ?? 1]]
              : [...FUELS, ...this.#items().filter(i => WOOD_FUEL.test(i.name)).map(i => [i.name, 1.5])];
            const fuel = choices.find(([name]) => this.#count(name) > 0) ?? fail(action.fuel ? `no ${action.fuel} in the inventory` : 'no fuel in the inventory (coal, charcoal, planks or logs)');
            fuelName = fuel[0];
            await furnace.putFuel(registry[fuel[0]].id, null, Math.min(this.#count(fuel[0]), Math.max(1, Math.ceil(count / fuel[1]))));
          }
          const inBefore = furnace.inputItem?.()?.name === action.item ? furnace.inputItem().count : 0;
          await furnace.putInput(registry[action.item].id, null, count);
          await this.#sync();
          put = (furnace.inputItem?.()?.name === action.item ? furnace.inputItem().count : 0) - inBefore;
          if (put <= 0) fail(`the furnace did not take the ${action.item}`);
          // Wait while it cooks: until everything put in came out, or nothing is left cooking, or the fuel ran out.
          const out0 = furnace.outputItem?.()?.count ?? 0;
          for (let idle = 0; !signal.aborted;) {
            const input = furnace.inputItem?.(), out = furnace.outputItem?.()?.count ?? 0;
            if (out - out0 >= put || out >= 64) break;
            const burning = lit() || Boolean(furnace.fuelItem?.());
            if (!input && !cooking()) { if (++idle > 4) break; } else if (!burning) { if (++idle > 8) break; } else idle = 0;
            this.#progress(`${out - out0} of ${put} smelted so far`);
            await this.#wait(this.#pace.poll * 4, signal);
          }
          try { if (furnace.outputItem?.()) await furnace.takeOutput(); } catch (error) { problem = error; }
          left = furnace.inputItem?.()?.name === action.item ? furnace.inputItem().count : 0;
          if (left) { try { await furnace.takeInput(); } catch (error) { problem ??= error; } }
          await this.#sync();
          stuckOut = furnace.outputItem?.() ?? null;
        } finally { try { furnace.close(); } catch { /* closed */ } bot._client?.removeListener?.('craft_progress_bar', onProperty); }
        const skip = new Set([action.item, ...(fuelName ? [fuelName] : [])]);
        await this.#settle(before, counts => changes(before, counts, skip).gained.length > 0, signal);
        const after = await this.#fresh(), { gained } = changes(before, after, skip);
        const used = -delta(before, after, action.item);
        const stuck = stuckOut ? `; ${stuckOut.count ?? 1} ${stuckOut.name} still in the furnace's output at ${at(block.position)}${problem ? ` (${clean(problem.message, 60)})` : ''}`
          : problem ? ` (${clean(problem.message, 60)})` : '';
        if (!gained.length) {
          const input = left ? ` (it ran out of fuel${used > 0 ? '' : `; your ${action.item} is back in your inventory`})` : '';
          fail(`nothing came out of the furnace${input}${stuck}${placed}`);
        }
        const back = left && used < put ? `; ${put - used} ${action.item} not smelted (out of fuel) taken back` : '';
        return `smelted ${used} ${action.item}: got ${summarise(gained, 8)}${back}${stuck}${placed}`;
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
        const before = await this.#fresh(), have = before.get(action.item) ?? 0;
        if (!have) fail(`no ${action.item} in the inventory`);
        const n = Math.min(have, action.count);
        await bot.toss(this.#item(action.item).type, null, n);
        const gone = -delta(before, await this.#settle(before, counts => -delta(before, counts, action.item) >= n, signal), action.item);
        if (gone <= 0) fail(`tossing ${action.item} did not work: you still have ${have}`);
        return `tossed ${gone} ${action.item}${gone < n ? ` (only ${gone} of ${n} left your inventory)` : n < action.count ? ' (all you had)' : ''}`;
      }
      case 'give': {
        const before = await this.#fresh(), have = before.get(action.item) ?? 0;
        if (!have) fail(`no ${action.item} in the inventory`);
        const entity = this.#player(action.player);
        await this.#approach(entity, signal, 2);
        // Aimed low, and only thrown once the server has her new look (sent with the next physics tick): tossed right
        // after lookAt, the items flew off in her old direction (measured on 26.1).
        await bot.lookAt(entity.position.offset(0, 0.5, 0), true);
        await this.#wait(this.#pace.look, signal);
        const n = Math.min(have, action.count);
        // Giving is dropping the items in front of them: watch whether they pick them up (dropped items wait 2 s).
        let collected = false;
        const onCollect = collector => { if (collector === entity || (collector?.username && collector.username === action.player)) collected = true; };
        bot.on?.('playerCollect', onCollect);
        try {
          await bot.toss(this.#item(action.item).type, null, n);
          const gone = -delta(before, await this.#settle(before, counts => -delta(before, counts, action.item) >= n, signal), action.item);
          if (gone <= 0) fail(`giving ${action.item} did not work: you still have ${have}`);
          await this.#until(() => collected, this.#pace.collect, signal);
          const all = gone < n ? ` (only ${gone} of ${n} left your inventory)` : n < action.count ? ' (all you had)' : '';
          return collected ? `gave ${action.player} ${gone} ${action.item}${all}; they picked it up`
            : `dropped ${gone} ${action.item} for ${action.player}${all}; they have not picked it up yet (it is on the ground near them)`;
        } finally { bot.removeListener?.('playerCollect', onCollect); }
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
        const before = await this.#fresh(), hunger = bot.food;
        await bot.equip(this.#item(food.name) ?? food, 'hand');
        await bot.consume();
        const eaten = -delta(before, await this.#settle(before, counts => delta(before, counts, food.name) < 0, signal), food.name);
        if (eaten <= 0) fail(`eating ${food.name} did not work: it is still in your inventory`);
        return `ate ${food.name}${finite(hunger) && finite(bot.food) && bot.food !== hunger ? ` (food ${Math.round(hunger)} -> ${Math.round(bot.food)})` : ''}`;
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
        const type = this.#registry().itemsByName?.[action.item]?.id ?? fail(`no item called ${action.item}`);
        const { block, window } = await this.#container(action, signal);
        try {
          // t70: counted in the open window (its copy of her inventory is the one the server updates), after asking the
          // server for the window's real contents: what really moved, never what was asked.
          await this.#sync();
          const before = this.#snapshot(), inside = () => counts(window.containerItems?.() ?? []).get(action.item) ?? 0;
          const deposit = action.type === 'deposit', have = deposit ? before.get(action.item) ?? 0 : inside();
          if (!have) fail(deposit ? `no ${action.item} in the inventory` : `no ${action.item} in it; ${this.#contents(block, window)}`);
          const n = Math.min(have, action.count ?? have);
          let problem = null;
          try { await (deposit ? window.deposit(type, null, n) : window.withdraw(type, null, n)); } catch (error) { if (signal.aborted) throw error; problem = error; }
          await this.#sync();
          const moved = (deposit ? -1 : 1) * delta(before, this.#snapshot(), action.item);
          const why = problem ? ` (${clean(problem.message, 60)})` : '';
          if (moved <= 0) fail(`${deposit ? `putting ${action.item} in` : `taking ${action.item} out`} did not work${why}; ${this.#contents(block, window)}`);
          const part = moved < n ? ` (only ${moved} of ${n}${why || (deposit ? ': it is full' : ': your inventory is full')})` : '';
          return `${deposit ? 'put' : 'took'} ${moved} ${action.item}${deposit ? ' in' : ''}${part}; ${this.#contents(block, window)}`;
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
        await this.#settleAll(before, signal);
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
