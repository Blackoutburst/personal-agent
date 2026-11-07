# Minecraft (#68, #69, #70)

The companions play on a shared PaperMC survival server as real players, not chat-command bots. C-chan (owner
`blackout`, Claude) first played as **SentientToaster** (offline mode) and now plays in online mode with her own
non-op account **Yakusuna**; Cirno (owner `screamer`, Codex) gets a name once its owner picks one. Since #70 she can do
what a normal survival player does (the owner: "she should be able to do everything you can do in the game").
What happens in the game (what was said, found, built, a death, a trip) becomes the companion's own memories, the same way
a chat does, so it can talk about it later in the app.

References studied for ideas only (no code copied): Mineflayer, Mindcraft, Voyager (skill library), Project AIRI's
`services/minecraft`.

## How it works

| Piece | File | Role |
| --- | --- | --- |
| Connector service | `src/minecraft.mjs` (`MinecraftConnector`) | One agent per companion whose owners.json entry has a `minecraft` block; status for Me › Connectors; game sessions. |
| Agent loop | `src/minecraft.mjs` (`MinecraftAgent`, `TurnGate`) | Decides when to take a turn, builds the prompt, parses the reply, runs the action or plan, reconnects. |
| Body | `src/minecraft-body.mjs` (`BotBody`) | Perception, events and the closed skill library on one Mineflayer bot; `validateAction`, `actionTimeout`. |
| Worker | `src/minecraft-worker.mjs` | Runs Mineflayer in its own worker thread: one connection per worker. |
| Sign-in | `src/minecraft-auth.mjs` | Online mode: per-companion Microsoft sign-in folder (0700, files 0600), device-code view, sign-out wipe. |
| Packages | `src/deps.mjs` | Loads `mineflayer` and `mineflayer-pathfinder` lazily; missing packages only switch the feature off. |

### The loop

1. The body notices events: chat (and whispers), a player joining or leaving, damage, death, nightfall, a notable block
   in sight (ores such as diamond, spawners, chests, portals…, once per position), and the result of its own action.
2. The `TurnGate` turns them into reasons for a turn (#69: she plays continuously while a person is online).
   **Urgent** reasons take a turn as soon as the spacing allows: being addressed (whisper, its name in chat, or a person
   answering within 90 s of the companion speaking), a join or leave, damage (2+ or health ≤ 8), death, its action or
   plan finishing or failing. **Minor** reasons (a find, nightfall) take a turn only while nothing runs; while an action
   or plan runs they are batched (at most 8) and ride on the next turn. Reasons are coalesced: one turn answers them all.
   With nothing running and nothing happening for `idleSeconds` (default 20 s) while a person is online, an idle turn
   comes so she does something of her own.
3. A turn is the companion's own native agent turn (Claude Code or Codex) in its **workspace**, with its normal
   instructions and memory files (SOUL.md, USER.md, MEMORY.md, the last diary days). The prompt says why it is up, the
   last action's or plan's result, **what is running now** (the action, or the plan with its current step, what is
   still to come and how long ago it started), the reply rules, and a bounded game state: position, dimension, biome,
   time of day, health, food, oxygen (her own, when under water) and level, who is online (person or companion), nearby players,
   mobs (hostile marked) and dropped items with their distance, notable blocks nearby that she can see (the nearest bed, chest, barrel,
   crafting table, furnace, ores, logs… one per kind, with coordinates), the inventory (names and counts), armor, the
   held and off-hand items, whether she rides or sleeps, the recent chat and the recent events (her own commands'
   answers included). Chat and names are marked as untrusted data.
4. The reply is one JSON object: `{"say": "...", "action": {...}, "diary": "..."}` or
   `{"say": "...", "plan": [{...}, {...}], "diary": "..."}`, every field optional. `say` is one chat line (240
   characters; since #70 it may be a `/command`, see "Commands"), `action` one action from the closed vocabulary, `plan` 1-8 actions (5 before #70) from the same
   vocabulary run one after another (`say` steps included, `stop` not), `diary` one line (300 characters) appended by
   the app to today's `memory/YYYY-MM-DD.md` as `- Minecraft: ...`. Invalid parts are refused and the reason goes into
   the next turn; a plan with one invalid step is refused whole. Both `action` and `plan`: the plan is used.
5. **What runs keeps running** unless the reply changes it: no `action` and no `plan` (absent or `null`, `{}` included)
   keeps the current action or plan; only an explicit new action or plan replaces it; `{"type":"stop"}` stops it. A
   chat-only turn never touches the action, and a refused action or plan keeps it too. Each step runs in the body with
   its own time limit; its result is an event; a failing step drops the rest of the plan. When the action or plan ends
   (finished, or failed at a step) the next turn may follow at once, subject only to the minimum spacing, and hears
   the result.

Why chat used to cancel the work (#68, fixed in #69): the reply's `say` line was sent to the body as a `say` action, and
`BotBody.act` aborted the running action ("replaced by a new action") before every action except `stop`, so any
turn that talked (being addressed always does) stopped the walk, follow or collect. That aborted result then came back
as "your collect failed", a reason for yet another turn. The prompt also said "a new one replaces the running one", so
the model tended to re-issue or drop the task. Now `say` is a plain chat line that never touches the running action,
results of replaced actions are ignored, and the prompt states the keep/replace/stop rules. Chat, look and other body
events, and `perceive()`, never touched the action (checked).

### Actions (the skill library, #70)

Every action is one JSON object `{"type": "...", ...}`, checked whole by `validateAction` before the world is consulted
(unknown fields, bad names or numbers out of range are refused with the reason). Blocks, items and mobs are Minecraft
ids (`oak_log`, `minecraft:oak_log` is accepted too). Coordinates are block coordinates. Each action has its own time
limit (`actionTimeout`); a result says what happened, including partial success ("mined 2 iron_ore (only 2 of 5
found)", "placed 10 of 12 blocks; 2 failed: …"), and a failed or timed-out action adds what it got done before.

| Group | Action | Arguments | What it does | Time limit |
| --- | --- | --- | --- | --- |
| Talk | `say` | `text` | one chat line, 240 characters, control characters removed; may be a `/command` | 2 s |
| Move | `goto` | `x, y, z`, `player` or `block` | walk there (256 blocks at most) or to the nearest block of a type within 64 | 90 s |
| | `follow` | `player`, `distance` 1-8, `seconds` 5-120 | keep near a player | the seconds + 5 s |
| | `wander` | `distance` 8-64 | explore in a random direction | 60 s |
| | `look_at` | `player` or `x, y, z` | turn the head | 3 s |
| | `jump` | none | one jump; ok only when she left the ground (half a block up at least) | 3 s |
| | `sprint`, `sneak` | `on` (default true) | toggle | 1 s |
| | `swim` | `seconds` 1-30, `forward` | hold jump (swim up, stay afloat), optionally sprint-swim forward; reports how far she really rose and moved, fails when she did not move with her head under water | the seconds + 5 s |
| | `escape` | none | out of water, a hole or a pit: swim up (sprint-swim) and over the rim, else pillar up with dirt, cobblestone or planks, else dig a staircase out; says what failed | 120 s |
| Blocks | `dig` | `x, y, z` or `block` (nearest within 32) | break any breakable block with the best tool from the inventory | 60 s |
| | `collect` | `block`, `count` 1-64 | mine that many of the nearest, then pick up the drops (reports what really reached the inventory, waiting up to 2 s for it) | 30 s + 15 s per block |
| | `pick_up` | none | walk over dropped items within 16 blocks; reports what really reached the inventory (up to 2 s later), fails when nothing did | 30 s |
| | `place` | `item` and `x, y, z` or `at`: `front`, `below`, `above` | place a block from the inventory against a solid neighbour; `below` over a gap bridges, on the ground it jumps and pillars up | 30 s |
| | `build` | `blocks`: up to 64 `[dx, dy, dz, "item"]` (offsets -16..16), optional `x, y, z` origin (default: her feet) | ordered placements; each one walks near, places or reports why not, and the rest go on | 20 s + 6 s per block |
| Make | `craft` | `item`, `count` 1-64 | `bot.recipesFor` in the 2x2 grid; a 3x3 recipe uses a crafting table within 32 blocks (she walks to it) or places one from the inventory, one craft per round; reports what the server really made and used (t70), fails when it made nothing; missing ingredients are named | 60 s + 2 s per item |
| | `smelt` | `item`, `count` 1-64, optional `fuel` | nearest furnace, blast furnace or smoker within 32 (or places a furnace), adds fuel (coal, charcoal, blaze rods, planks, logs…) when it has none and is not still burning, waits for the last item, takes the output (and any unsmelted input back); reports what really came out | 45 s + 11 s per item |
| Items | `equip` | `item`, optional `slot`: `hand`, `off-hand`, `head`, `torso`, `legs`, `feet` | armor goes to its slot by itself | 5 s |
| | `unequip` | `slot` (default hand) | | 5 s |
| | `toss` (or `drop`) | `item`, `count` 1-2304 (default 1) | throw items on the ground; counts what left the inventory | 10 s |
| | `give` | `player`, `item`, `count` | walk to the player, aim low at them, toss; says whether they picked it up (watched for 3.5 s) | 60 s |
| | `use_item` | `seconds` 0-5, `offhand` | activate the held item (food and drinks are consumed; with seconds it holds then releases: bow, crossbow, trident; buckets, throwables) | seconds + 8 s |
| | `eat` | optional `item` | the best food in the inventory (never rotten flesh or poison by choice); fails when it was not eaten | 10 s |
| Fight | `attack` | `mob`, `player`, or none (nearest hostile within 16) | equips the best weapon, follows and hits until the target is dead, or reports that it got away (more than 32 blocks) | 60 s |
| | `shield` | `seconds` 1-30 | shield to the off-hand if needed, raise it, lower it after | seconds + 5 s |
| | `defend` | `seconds` 5-300 | fight every hostile mob that comes within 12 blocks for that long | seconds + 5 s |
| Storage | `open` | `x, y, z`, `block` or none (nearest chest, barrel, shulker box) | open it and list the contents | 45 s |
| | `deposit`, `withdraw` | `item`, optional `count` (default all), optional `x, y, z` | move items in or out; reports how many really moved and lists the contents after | 45 s |
| World | `activate` | `x, y, z` or `block` (nearest within 16) | use a door, lever, button, trapdoor, gate, bell…; reports the new state | 30 s |
| | `sleep`, `wake` | optional `x, y, z` of a bed | nearest bed within 32 (night or thunderstorm only, the server decides) | 45 s / 5 s |
| | `mount`, `dismount` | optional `entity` (boat, minecart, horse…) | nearest rideable within 16 | 30 s / 5 s |
| | `fish` | `seconds` 5-120 | cast with a fishing rod and wait for a bite; reports the catch | seconds + 15 s |
| | `till` | optional `x, y, z`, `count` 1-64 | hoe on dirt or grass with open air above (nearest within 16) | 20 s + 6 s each |
| | `plant` | `item` (seed, carrot, potato, nether wart…), `count`, optional `x, y, z` | on free farmland (soul sand for nether wart) | 20 s + 6 s each |
| | `harvest` | optional `block` (wheat, carrots, potatoes, beetroots, nether_wart, cocoa, melon, pumpkin…), `count` (default 8), `replant` (default true) | dig only ripe crops, replant from the inventory, pick up | 20 s + 8 s each |
| | `breed` | `mob` | two nearest of that animal within 16, fed the right food (wheat for cows, carrots for pigs, seeds for chickens…) | 45 s |
| | `trade` | optional `index` 0-63, `count` | nearest villager or wandering trader: lists the offers (`#0: 1 emerald -> 6 bread`), with an index trades that offer | 45 s |
| | `stop` | none | stops the running action or plan (as `action` only, not a plan step) | 1 s |

Walking (#70): the pathfinder may dig through blocks and place scaffolding blocks from the inventory (dirt,
cobblestone, cobbled deepslate, stone, netherrack, planks…; `canDig = true`, `allow1by1towers`, parkour, sprinting,
doors), so she gets out of a pit or across a gap like a player. The pathfinder still never breaks a chest (its default
`blocksCantBreak`). Before #70 walking never dug or placed and `collect` only broke natural blocks; the owner asked to
remove those limits. What she does to other people's builds on the shared server is now up to her, like for any player:
AGENTS.md asks her to treat others' builds, chests and animals as theirs and to ask first.

### Physics on 26.1 and getting unstuck (t70)

**Symptom** (live, Yakusuna near spawn): "jump says done but my position never changed", "goto says arrived but I'm
still at 9 77 -12", oxygen dropping while idle, swimming rose 1 block in about 8 minutes, a pillar block refused. She was
in a water-filled hole she had dug; the server log had no "moved wrongly" or "moved too quickly".

**Root cause**, measured on a private local Paper 26.1.2 server (offline, 127.0.0.1:25599) with the same jar:

1. *The server rolls her back whenever her hitbox touches a block face.* prismarine-physics 1.11.1 (the newest on npm;
   mineflayer 4.39.0 uses it) makes the player box exactly 0.6 wide, so pressed against a wall its edge lies exactly on
   the block face (z = 500.7 next to a block at 501). The server's own box is the float 0.6f, a hair wider, and it
   treats that as moving into the block: it silently teleports her to her last good position, every tick she pushes on
   the wall. Placing her by hand with physics off: z = 500.69999 accepted, z = 500.7 corrected. Open ground never
   touches a wall, which is why walking on dry land (and the E2E harness) worked; in a hole every way out (jumping onto
   a ledge, leaving the water at the rim, the pathfinder's towering) presses on a wall. Before: 53-57 corrections in
   3 s walking into a wall on dry land, 104-113 in 6 s swimming up along one; after: 0. Water physics itself is fine
   (swimming up a 1x1 water hole: 3.4 blocks in 8 s), and physics ticks run at 20 per second in the worker thread.
   **Fix**: `patchPhysics` (src/minecraft-body.mjs) sets `bot.physics.playerHalfWidth` to 0.30001 at login and spawn
   (Mineflayer injects its physics plugin after `attach()`). A runtime patch in our code because there is no newer
   prismarine-physics or minecraft-data release to pin, and a Movements setting cannot change the collision box.
2. *goto "arrived" without moving.* mineflayer-pathfinder's `goto` resolves when it computes an empty path, which is
   what it finds from inside water (it never plans a move out of a water block). **Fix**: goto and wander check where
   she really is afterwards (the goal's `isEnd`); not there means a failure with her real position. In water or a hole
   with no way out on foot, goto runs `escape` first and walks once more, and says so.
3. *jump and swim reported success blindly*, and `place below` placed the pillar block after waiting at most 1 s for
   her to rise, which in water is not a full block, so the server refused a block inside her. **Fix**: jump is ok only
   if she left the ground, swim reports the real numbers, a pillar step waits until she is a full block up (1.1 on
   land, near the top of the jump, because the server sees her a tick late).

`escape`: the rim is the lowest block beside her column she could stand on; she is out when she is out of the water,
on solid ground, at the rim. In order: swim up holding jump and sprint, then forward over the rim; pillar up with a
scaffold block (dirt, cobblestone, planks…) and step off; dig a staircase toward the rim (head room, the two blocks
ahead, a step placed if missing). Each way runs only while she is not out; what failed is part of the result.

Measured through the real worker and BotBody on the local server (before = main e126313, after = this branch):

| Scenario | Before | After |
| --- | --- | --- |
| goto 6 blocks from the bottom of a 1x1 water hole 4 deep | "arrived" in 0.4 s, did not move | ok in 3.8 s: swam out, walked to 700 -55 705 |
| goto from a 1x1 water hole 2 deep | "arrived" in 0.4 s, did not move | ok in 3.3 s |
| goto out of a dry 1x1 pit 2 deep | timed out after 90 s, 1 block up | ok in 2.0 s (the pathfinder alone) |
| escape from the 4-deep water hole | (no such action) | swam up and out, 3.0 s |
| escape from a dry 3-deep pit in stone, with dirt | | pillared 2 dirt and stepped out, 2.8 s |
| escape from a dry 3-deep pit in dirt, no blocks | | dug 3 stair steps out, 6.6 s |
| goto 6 blocks on flat ground | ok, 1.3 s | ok, 1.3 s |

### Windows on 26.1: crafting, smelting and honest inventory results (t70)

**Symptom** (live, Yakusuna): "it says it crafted the iron pick but my bag still has 4 ingots and no pick" (twice),
"4 iron ingots! the furnace says it failed but my bag says otherwise", "got 3 raw iron! (my bag just took a sec to
notice)". Crafting planks, sticks and a table in the 2x2 grid seemed fine.

**Root causes**, measured on a private local Paper 26.1.2 server (offline, 127.0.0.1:25599) through the real worker and
BotBody, with the server's own count (`clear <player> <item> 0` on the console) before and after every action:

1. *Clicks on an open window carried the wrong state id.* Mineflayer 4.39.0 keeps one state id and takes it from every
   `set_slot`/`window_items` packet, whatever window it is for. While a crafting table, furnace or chest is open the
   26.1 server keeps syncing the player inventory (window 0: a `set_slot` for the off-hand slot after each click), so
   every click on the table went out with window 0's id. The server then answered each click with a full resync of
   the window *as it was before Mineflayer's next clicks*, which Mineflayer had already predicted; its model fell
   behind, it clicked the wrong slots (a packet trace showed the second stick never placed and the result slot empty),
   and `bot.craft` still resolved, because Mineflayer writes the expected result into the result slot itself. Whether a
   table craft worked was a race: right after placing the table, after a pickup or after crafting sticks it made
   nothing and used nothing (the live symptom); a second craft at the same table always failed.
   **Fix**: `patchWindowState` (src/minecraft-body.mjs, at login and spawn like `patchPhysics`) keeps the state id per
   window and hands Mineflayer only the open window's (window 0's again once it closes). A runtime patch because the
   pinned Mineflayer has no option for it; a unit test checks the listener it replaces is still in the installed
   Mineflayer.
2. *Results were what was asked, not what happened.* `craft` reported `times x per` (12 planks asked from 3 logs: the
   server made 8), `smelt` counted Mineflayer's `bot.inventory`, which is only updated when the furnace window closes
   (so a smelt that worked "failed"), and it stopped waiting when the input slot emptied, while the last item was still
   cooking. `pick_up`/`collect` counted right after walking over the items, before the server's pickup arrived.
   **Fix**: every inventory action (craft, smelt, deposit, withdraw, give, toss, pick_up, collect, eat; harvest too)
   counts before, then waits up to 2 s for the server's slot updates, asks the server for the full state if they never
   come (Mineflayer's `_syncWindow`: a click with an impossible state id that the server answers with a full resync),
   and reports what really changed. While a window is open, counts (and perception) come from that window's copy of
   her inventory. `craft` runs in rounds, one craft per round at a table (a fresh window each time), measures each
   round, tries an empty round once more, then stops: "crafted 1 wooden_pickaxe (only 1 of 2: the server made no
   more)", or a failure "the server made none; your inventory is unchanged". Ingredients left in the 2x2 grid or a
   result left on the cursor are put back by closing the inventory (window 0), as a player closing the inventory
   screen does. `smelt` waits until everything put in came out (or nothing is cooking, or the fuel ran out) and reports
   what came out. Missing ingredients name the closest recipe variant (oak planks she has, not cherry planks).
3. *A furnace still burning from the last smelt looked cold.* Mineflayer attaches its window-property listener after
   the window opened and misses the first burst, so `furnace.fuel` stays 0. **Fix**: the body keeps its own copy of
   the furnace properties (burn time left, cooking progress) and uses no new fuel while it burns.
4. *give* tossed right after `lookAt`, before the server had her new look (it goes out with the next physics tick):
   in one of two runs on main the other player got nothing while the result said "gave" (aimed at the feet without
   the wait, the bread landed 2.2 blocks from them). **Fix**: aim low (half a block up), wait 150 ms, toss; the result says whether they picked it
   up (watched for 3.5 s: dropped items wait 2 s) or that it is on the ground near them.

Measured (before = main 4d71840, after = this branch; server counts). The table-craft sequences were run four times
after the fix (once in the full run, three times more on their own), all right; before the cursor/grid clean-up was
added, two of seven 2x2 crafts in one run had been reported as "made none" while the server had made them:

| Scenario | Before | After |
| --- | --- | --- |
| 2x2: oak_planks x12 from 3 logs | "crafted 12"; server: 8 planks, 1 log left | "crafted 12 oak_planks; it took 3 oak_log"; server: 12, 0 logs |
| table: iron_pickaxe after crafting planks and sticks in the 2x2 grid | "crafted 1 iron_pickaxe"; server: 3 ingots, 4 sticks, no pick | ok; server: 0 ingots, 2 sticks, 1 pick |
| table: iron_pickaxe right after placing the table from the inventory | "crafted 1"; server: 3 ingots, 2 sticks, no pick | ok; server: 0, 0, 1 pick |
| table: iron_pickaxe after a pick_up of the ingots | "crafted 1"; server: no pick | ok; server: 1 pick |
| table: wooden_pickaxe x2 | "crafted 2"; server: 1 pick, 3 planks and 2 sticks left | "crafted 2"; server: 2 picks, 0 left |
| table: iron_pickaxe, wooden_pickaxe, furnace, chest (fresh table) | ok in this run (a race; it failed in a packet-traced run) | ok, each one counted |
| smelt 3 raw_iron with 1 coal | "nothing came out of the furnace"; server: 3 iron_ingot | "smelted 3 raw_iron: got 3 iron_ingot" |
| smelt 2 more, furnace still burning, no coal left | "no fuel in the inventory" | "smelted 2 raw_iron: got 2 iron_ingot"; server 3 -> 5 ingots |
| smelt 3 raw_iron with 1 stick (half an item of fuel) | | fails: "nothing came out of the furnace (it ran out of fuel; your raw_iron is back in your inventory)"; server: 3 raw_iron |
| smelt without fuel anywhere | "no fuel in the inventory" | same (nothing moved) |
| deposit 12 / withdraw 5 / withdraw 64 cobblestone | right (12, 5, 7) | right, counted (12, 5, 7) |
| toss 4 dirt | right | right, counted |
| give 3 bread to a player 3 blocks away | "gave" both runs; the other player got 0 in one, 3 in the other | "gave Friend 3 bread; they picked it up"; Friend: 3 (3 runs) |
| pick_up 3 raw_iron + 2 cobblestone | right | right, counted after the pickup arrived |
| eat (food 2, after a hunger effect) | "ate bread" (not checked; her view still showed 3 bread); server 3 -> 2 | "ate bread (food 2 -> 11)", counted; server 3 -> 2 |
| collect 2 oak_log (a 2-high trunk) | "picked up 2 oak_log"; server 2 | "picked up 2 oak_log"; server 2. One run got 1 (the other drop stayed on the ground) and said "picked up 1 oak_log"; since then pickups are counted until nothing changed for 300 ms, as stacks arrive one at a time |

### Chat on 26.1: unsigned chat and the "last seen" window (t70)

**Symptom** (live, Yakusuna, online mode): two kicks in 2 minutes while she chatted a lot and ran commands; the
server log said `Yakusuna lost connection: Chat message validation failure`, the worker said "kicked: no reason".

**Root causes**, read from the Paper 26.1.2 jar (javap of `LastSeenMessagesValidator`, `LastSeenMessages`,
`ServerGamePacketListenerImpl`) and checked by driving minecraft-protocol 1.68.0's own chat code with fake signed
messages against a port of that validator (test/minecraft-connection.test.mjs):

1. Every `chat_message` (and signed command) carries a "last seen" update: how many new signed messages arrived
   (offset), one bit per message in the 20-message window (oldest first; once acknowledged, a message must stay
   acknowledged) and a checksum (0 means "not checked"). Any mismatch kicks with
   `multiplayer.disconnect.chat_validation_failed`, after the server logs
   `Failed to validate message acknowledgements from <name>: <why>` at ERROR.
2. minecraft-protocol computes the checksum over its ring buffer in storage order, not oldest first. Once more than 20
   signed messages reached her since login (her own signed lines come back to her and count too), the checksum is
   wrong: in the port, a chat line after each incoming signed message failed at the 21st ("Checksum mismatch").
3. An unsigned `/command` (`chat_command`, no acknowledgements in the packet) still resets minecraft-protocol's pending
   count, so the next chat line's offset is short and its bits point at the wrong messages ("acknowledged unknown or
   previously ignored message at index 17" after 2 messages, a command, 1 message, a line). With signing simply turned
   off every command goes out this way, so `disableChatSigning` alone would have made the kicks more frequent.

**Fix**: the worker passes `disableChatSigning: true` (no chat certificates are fetched; her lines and commands go out
unsigned, the server marks them "[Not Secure]"), and `patchChatAcks` (src/minecraft-body.mjs) keeps her own tracker,
like the vanilla client's `LastSeenMessagesTracker`: it counts signed `player_chat` messages (a repeat of the last one
once, like the server), writes offset, bits and checksum 0 into every `chat_message`, sends its own
`message_acknowledgement` after 64 and drops minecraft-protocol's. Kick reasons are NBT components on 26.1
(`{type:'compound', value:{translate:{type:'string', value:'multiplayer.disconnect.chat_validation_failed'}}}`,
measured), which the old reader turned into "no reason"; `disconnectReason` unwraps NBT or JSON and names the keys
("kicked: Chat message validation failure", "kicked: Kicked for spamming", unknown keys by name).

**Server requirement**: `enforce-secure-profile=false`. A server that enforces it lets an unsigned player in but
refuses each chat line (`chat.disabled.missingProfileKey`, a red system line) and each command with a message argument
(/msg, /me), so she would be mute. The login packet's `enforcesSecureChat` flag (and minecraft-protocol's own throw,
and those kick keys) end the connection with `server enforces secure chat (set enforce-secure-profile=false)`, which
waits 30 minutes before the next try. The server only enforces it in online mode (`DedicatedServer.enforceSecureProfile`
also needs online mode and the services key), so this case is unit-tested with fakes; offline with
`enforce-secure-profile=true` the login flag was measured false.

Measured on a private local Paper 26.1.2 server (offline, 127.0.0.1:25599) through the real worker: 30 chat lines
(1.1 s apart; faster than about one a second a non-op is kicked for spam, `disconnect.spam`) and `/me`, `/msg`,
`/list`, `/say` went out unsigned without a kick; a deliberately wrong acknowledgement (bit 0, nothing tracked) was
kicked as `chat_validation_failed`; an operator kick ended as "kicked: Kicked by an operator". Offline there are no
signed messages, so the window itself is checked against the ported validator only.

### Oxygen on 26.1 (t70)

**Symptom** (live): her perception showed oxygen dropping 17 -> 10 while she stood on dry land at about (0, 80, -18)
with full health; the server's saved data at the next disconnect said Air=300, OnGround=1.

**Root cause**: Mineflayer 4.39.0 (entities.js) sets `bot.oxygenLevel` from the `air_supply` metadata of *every*
entity, not only hers. The index itself is right on 26.1 (air_supply is key 1 in minecraft-data's player
metadataKeys, and her own packets count down 299, 298, … under water). Measured on the local server: a cod summoned
on dry land two blocks from her sent its falling air (299 -> 60) and `bot.oxygenLevel` went 20 -> 4 while she stood on
the ground; any mob losing air nearby (fish out of water, a squid, a mob under water) does the same.
**Fix**: `patchOxygen` reads air_supply from her own entity's metadata only (the index from the registry), writes it
back over Mineflayer's value and resets to 20 on (re)spawn; perception reports `oxygen` from it. Measured after: a cod,
a salmon and a squid beached beside her for 12 s: no `oxygen` in her perception; submerged herself: 16, 12, 8 at
3 s steps; back on land: no `oxygen`.

### Doors and building blocks: walking takes the door, not the wall (t70)

**Symptom** (owner): "pathfinding doesn't acknowledge doors and the bot breaks the wall instead of going through the
door".

**Root causes** (mineflayer-pathfinder 2.4.5, read and run): its "openable" set holds only fence gates; a door, open or
closed, is a solid block to it (its panel has a collision box), so with digging on since #70 (dig cost 1) breaking the
door or two wall planks was the cheapest way in. The real planner on a fake 26.1.2 plank hut broke 2 oak_planks with the
old setup (test/minecraft-pathing.test.mjs). On the local server, main went into a closed 5x5 plank hut with a wooden
door by breaking 2 of its blocks (the door in one run, two wall blocks in the other). And even with a door counted as
passable, its `postProcessPath` puts each path step "on top of" the block's shape: the doorway step became a point one
block up on the door (0.297, -59, 8.5 for the doorway at 0, -60, 8), she stood still and the pathfinder reset "stuck"
every 3.5 s until the 90 s limit.

**Fix** (`configureMovements`, `fixDoorNodes`, `#doorKeeper` in src/minecraft-body.mjs):
- Two passes for goto, follow, wander and every walk to a block: first without digging (scaffolding only at a high
  place cost), wooden doors and fence gates counted as passable (iron ones are not: they need redstone), diagonal steps
  through a doorway dropped; only when that finds no way (NoPath or Timeout), once more with digging at cost 12.
  follow switches to the digging pass after the pathfinder reports no path.
- Neither pass breaks building blocks (`BUILT`: planks, doors, trapdoors, fences and gates, walls, stairs, slabs, glass
  and panes, wool, carpets, bricks, concrete, terracotta, beds, containers, furnaces, tables and work blocks, torches,
  lanterns, signs, rails, glowstone, farmland, crops, ladders, polished/chiseled/cut blocks, metal blocks, …) or
  anything within 3 blocks of a door or bed. Logs stay breakable (trees). `dig`, `collect` and `harvest` still break what
  they are told to; `escape` digs natural ground only (`NATURAL`: dirt, grass, stone, sand, gravel, ores, leaves, …).
- The doorway steps are put back in the doorway on each `path_update`; while she walks, a closed wooden door or gate on
  the next steps of her path (within 3 blocks) is opened, and one she opened is closed behind her (at least 1.8 blocks
  past it while walking, or at the end of the walk once she is out of the doorway, within reach). A door standing open
  stays open.

Measured on the local server (a closed 5x5 hut, walls 3 high and a roof, wooden door facing north; she starts 5 blocks
from it; the hut is compared block by block with a copy after each walk):

| Walk | main 2ba0390 | this branch |
| --- | --- | --- |
| outside -> inside (oak_planks) | arrived, 9.2-11.3 s, 2 of 73 hut blocks broken | arrived, 2.7-3.7 s, door opened and closed, 73/73 |
| inside -> outside | arrived (through the hole) | arrived, 2.4-3.6 s, door opened and closed, 73/73 |
| from the far side, around the hut -> inside | arrived (through the hole) | arrived, 4.6-5.7 s, 73/73 |
| inside -> the far side | arrived | arrived, 4.4-4.7 s, door closed behind her, 73/73 |
| the same four in a stone_bricks hut | | all arrived, door closed, 73/73 |
| a sealed plank hut (no door) -> inside | | fails: "did not get there: the path finder found no way", 73/73 |

### Digging plants (t70)

**Symptom** (owner): "she can't break tall grass, it says nothing to dig". `dig` refused every block in the
"replaceable" set (the set placing uses: grass, tall grass, ferns, snow layers, vines, seagrass, dead bushes).
**Fix**: only air, cave_air, void_air and fluids are "nothing to dig"; blocks without a collision box are walked up to
(the line-of-sight goal cannot see them) and dug like any other; a block that breaks at once is dug with an empty hand
or a real tool, never "with wheat_seeds". Measured on the local server: short_grass, the upper half of tall_grass (both
halves went), a second tall_grass by its lower half, a poppy (`dig {block: "poppy"}`) and a 2-layer snow layer were each
dug ("dug short_grass at 2 -60 0"), every spot air on the server afterwards; `collect short_grass` mined one.

### Fair sight: no X-ray (t70)

**Symptom** (owner): "Bot has Xray, this is not normal." Perception listed notable blocks (ores, chests, beds, logs…)
within 16 blocks whatever was in between, the "found" events did the same, and `collect`, `dig`/`goto`/`open`/`sleep`
"nearest of type" used `bot.findBlocks`, which sees through walls. Measured on the local server with main: an iron ore
embedded in stone 5 blocks away was listed (`iron_ore@5,-59,0 (5.2)`) and `dig {block: iron_ore}` dug it.

**Fix** (`#canSee`, `lineOfSight`, `#find` in src/minecraft-body.mjs): a block counts as seen only when one of its
faces that points at her touches a block she can see through (air, water, glass, leaves, doors, slabs, …) and a straight
line from her eyes to just inside that face reaches it before any block she cannot see through (a voxel walk over
`blockAt`). Range 32 blocks, 16 under a roof of rock (an opaque block within 24 above her head, not counting wood and
leaves). Perception and "found" events list only seen blocks (the 96 nearest candidates are checked; answers are cached
for her current cell for one second and dropped on any block update or dig). What she saw is remembered for the session
(type and position, at most 300, forgotten when the block there changes). Targeting by type picks only seen or
remembered blocks; otherwise the result is "you haven't seen any iron_ore nearby; explore or mine to find some".
Explicit coordinates stay allowed: the model only knows coordinates from what it was shown or what players said.

Measured on the local server (iron ore at 5 blocks inside a 9x5x9 stone block):

| Step | main 2ba0390 | this branch |
| --- | --- | --- |
| ore embedded in stone | listed; `dig {block}` dug it | not listed; "you haven't seen any iron_ore nearby; explore or mine to find some" |
| a 1x2 tunnel dug to it | (already dug) | listed: `iron_ore@5,-59,0 (5.2)` |
| tunnel filled again | | not listed (not visible), remembered: `goto {block: iron_ore}` reached it |

### Commands (#70)

A chat line starting with `/` is sent as a command (the leading-slash stripping of #68 is gone, in the body and in the
reply's `say`). She runs it with her account's own permissions, which on this server are those of a normal **non-op**
player (`/msg`, `/me`, `/list`, plugin commands the server grants everyone…). The 240-character limit and the
control-character cleanup stay. The server's answer (system lines in the 3 s after her command, at most 4 lines of
200 characters) comes back as a `server` event: it goes into the event log ("the server said: …") and is a minor reason
for a turn.

**Operator status is a privilege decision for the owner.** Her account is not in `ops.json`. If it is ever made op,
`/op`, `/give`, `/gamemode`, `/tp`, `/stop`, `/whitelist` and every other admin command become available to the
model's chat lines, and player chat (which is never instructions, but is in her prompt) could talk her into them.
Do not op the companion account without deciding that explicitly; a permissions plugin granting a few extra commands
is the safer way to give more.

### The one hard limit: no code

There is no action that runs code, evaluates an expression, writes a script, reads or writes files or reaches anything
outside the game, and there will not be one: the worker runs inside the companion service, as the service user, with
access to `~/personal-agent-data` (every owner's workspace, the database, the Microsoft sign-in caches). An `eval`-style
skill (as in Voyager or Mindcraft's `!newAction`) would turn a game turn, and anyone who can talk to her in game chat,
into code execution on the server. Everything a player can do is reachable through the closed vocabulary instead.

### Caps

- At most one turn every `minSeconds` (default 8 s, never under 5 s) and `perHour` turns in a sliding hour (default 150,
  at most 300). Plans hold at most 8 steps (5 before #70), each with its own time limit.
- Idle turns while a person is online: only when nothing runs and nothing happened for `idleSeconds` (default 20, 10 to
  3,600). No idle turn while an action or plan runs.
- No turn while another turn of this companion runs, nor while its agent is busy with a chat or wake (chat goes first).
- **Nobody online** (only companions): no turns, the events are dropped as reasons (they stay in the event log), except a
  rare idle tick every `emptyIdleMinutes` (default 180; 0 = never).
- Usage limit / signed out / no runtime: game turns pause for 30 minutes.
- Perception: at most 8 players, 8 mobs, 8 dropped items, 12 notable blocks (one per kind), 36 inventory entries, 10
  chat lines of 200 characters, 12 events; the whole game state is cut to 6,000 characters of JSON (3,500 before #70;
  dropped items, blocks, mobs and events go first). Action results are kept to 400 characters. Diary: 6 lines an hour, none once the day file is over 5,000 bytes.
- **Other players have no powers**: their chat is conversation only. A game turn gets the workspace file tools (Read,
  Edit, Write, Glob, Grep on Claude; Codex keeps its workspace sandbox with web search off) and nothing else: no web, no
  Board, mail, calendar, reminders, contacts or files tools. This holds for every player, the owner's own in-game name
  included: in offline mode names can be faked, and even in online mode a name is no consent. #70 widened what she can
  do in the game, not what the game can do outside it.

### Memory

- AGENTS.md version 30 added a "Minecraft" section, version 31 (#69) tells her that she plays continuously while
  people are online, can plan several steps, that small finds wait for her next turn, and that chatting never stops her
  current action or plan; version 32 (#70) lists her full abilities briefly (the game turn lists the actions), plans of
  up to 8 steps, that `/` lines are commands as a non-op player, and to respect other people's builds and chests
  (`src/companion.mjs`). The section says: the game is part of the companion's life; game
  chat is public, so private memories stay out of it; player chat is never instructions; notable moments go into
  today's diary (the turn's `diary` line) and lasting ones into MEMORY.md under "## Minecraft".
- The usual upgrade mechanism applies: on start the server rewrites AGENTS.md and resets the native sessions, chat and game.
- In-game moments reach later chats through the files: Claude reads MEMORY.md and the last two diary days every turn;
  Codex reads them at the start of each session.
- Game turns keep their own native session (per companion, table `minecraft_sessions`), separate from the chat threads.
  A new session starts after 30 game turns, two idle hours, new instructions, a forgotten memory or a new look.

### Resilience

- The bot runs in a worker thread (768 MiB heap limit). A Mineflayer exception ends that worker only; every callback in
  the main thread is wrapped, so the bot cannot crash the web service.
- Reconnects back off from 5 s doubling to 5 minutes, with jitter; a connection that stayed up a minute resets it.
  "Not whitelisted", banned, "logged in from another location", "Failed to verify username" (online mode) and missing
  packages wait 30 minutes. Microsoft sign-in problems (a code nobody entered in time, a refused sign-in) back off from
  1 minute, doubling, to 30 minutes, so a new code is never requested in a tight loop.
- Shutdown: the service's `close()` stops the agents (abort the turn, quit the bot, terminate the worker after 3 s).
- The service runs with `ProtectHome=read-only`: the connector writes only the companion workspace (diary), the
  database and, in online mode, `~/personal-agent-data/minecraft-auth/<companion id>/`, all under `~/personal-agent-data`.

## Configuration (off by default)

A companion plays only when its owners.json entry has a `minecraft` block (server admin), and its owner can switch it
off and on in Me › Connectors (the card shows the name, the server and how many people are online).

```json
{ "subject": "…", "label": "blackout", "provider": "claude",
  "minecraft": { "username": "SentientToaster", "host": "127.0.0.1", "port": 25566, "version": "26.1.2",
    "turns": { "minSeconds": 8, "perHour": 150, "idleSeconds": 20, "emptyIdleMinutes": 180 } } }
```

Only `username` is required; the rest are the defaults shown. `minSeconds` 5-3600, `perHour` 1-300, `idleSeconds`
10-3600, `emptyIdleMinutes` 0 or 30-10080; anything else refuses the owners.json entry. `idleMinutes` (the #68 online
idle) is still accepted so an older owners.json parses, but it no longer does anything. An entry that sets the old
values explicitly (`"minSeconds": 25, "perHour": 40`) keeps them: drop them or set the new ones to get continuous play. Two companions cannot share a name. `ownerName` (the
owner's in-game name) is accepted for later use and grants nothing.

### Online mode: each companion's own Microsoft account

With `"auth": "microsoft"` the companion signs in with its own Minecraft (Microsoft) account; `"offline"` is the default
and the behaviour above. In online mode `username` is optional: the in-game name comes from the account. If given, it is
only a label and the sign-in cache key (without it the owner label is the key).

```json
"minecraft": { "auth": "microsoft" }
"minecraft": { "auth": "microsoft", "username": "SentientToaster" }
```

- **Sign-in** (Mineflayer `auth: 'microsoft'`, prismarine-auth 3.1.1, already a dependency of mineflayer 4.39.0: no new
  package). On the first connection, or when the saved sign-in no longer works, the bot asks Microsoft for a device code.
  Me › Connectors then shows, **only to that companion's owner**: "Sign in to Minecraft: open
  https://www.microsoft.com/link and enter ABCD-1234", with the code's expiry (about 15 minutes). The owner opens the
  link, signs in with the companion's account and enters the code; the bot then joins normally. The card refreshes by
  itself while it waits.
- **Tokens** stay in `~/personal-agent-data/minecraft-auth/<companion id>/` (folder 0700, each cache file 0600, written
  atomically, never through a link). Access, refresh and Xbox tokens are never logged, returned by the API, shown on the
  card, put in a prompt or sent to the Board; the journal says only that a sign-in is needed or done, never the code.
  Library messages from failed sign-ins are replaced by fixed texts.
- **Expiry and failures**: an unused code expires; the next code comes after 1 minute, then 2, 4… up to 30 minutes. A
  refused session ("session rejected", "Failed to verify username") makes the next connection fetch the Xbox and
  Minecraft tokens again from the Microsoft sign-in; if that is refused as well, a new code is shown.
- **Sign out**: Me › Connectors › "Sign out of Minecraft" (once signed in) stops the bot, deletes the contents of the
  companion's sign-in folder and forgets the account name; with the connector on, a new code follows (to switch
  accounts). "Disconnect" just switches the connector off and keeps the sign-in.
- The account must own Minecraft Java Edition. One account per companion: the same account cannot play twice at once
  (the server kicks with "You logged in from another location", which waits 30 minutes).

## Packages and releases

- `mineflayer` 4.39.0 (latestSupportedVersion 26.1, protocol 775) and `mineflayer-pathfinder` 2.4.5 are pinned exactly in
  package.json and package-lock.json (92 packages, about 537 MB, almost all `minecraft-data`). No install scripts are needed.
- Releases (`ops/release.mjs`) stay Git source only. After extracting a release, the tool runs
  `npm ci --omit=dev --ignore-scripts --no-bin-links --no-audit --no-fund` once per lock file into
  `~/personal-agent/deps/<sha256 of package-lock.json>/node_modules` (staged, link-free, then renamed), before the
  service is stopped. Releases with the same lock file share that folder; a failed install refuses the release with the
  service untouched. `src/deps.mjs` finds packages there (or in `COMPANION_DEPS_DIR`, or a development `npm ci` in the
  checkout). `npm` is the one next to the running node, or `COMPANION_NPM`. Old `deps/` folders can be deleted by hand
  when no release in `releases/` uses their lock file.
- Development: `npm ci` in the checkout. `npm test` skips the two real-Mineflayer tests without the packages.

## Server setup (root, reproducible)

The owner decided (2026-11-07) that the server is **public on port 25566**. Port 25565 belongs to a separate, unrelated
Paper server: never use or touch it. The connector itself still connects over loopback (127.0.0.1:25566). No RCON.

```sh
# 1. System user and folders: runtime and jar root-owned, data owned by the server user.
sudo useradd --system --home-dir /srv/companion-survival --shell /usr/sbin/nologin companion-survival
sudo install -d -o root -g root -m 0755 /opt/companion-survival
sudo install -d -o companion-survival -g companion-survival -m 0750 /srv/companion-survival

# 2. Temurin 25 JRE (25.0.5+8, x64) from Adoptium, checked against its published SHA-256.
cd /tmp
curl -fLO https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jre_x64_linux_hotspot_25.0.5_8.tar.gz
echo '6fac98f0c8202efc3135a9e9e42aa61963ec42d1c5cbb40caf231e7b14a24ef6  OpenJDK25U-jre_x64_linux_hotspot_25.0.5_8.tar.gz' | sha256sum -c -
sudo install -d -o root -g root -m 0755 /opt/companion-survival/runtime
sudo tar -xzf OpenJDK25U-jre_x64_linux_hotspot_25.0.5_8.tar.gz -C /opt/companion-survival/runtime --strip-components=1 --no-same-owner
/opt/companion-survival/runtime/bin/java -version   # openjdk 25.0.5

# 3. Paper 26.1.2 build 74, checked against its SHA-256.
curl -fL -o paper-26.1.2-74.jar https://fill-data.papermc.io/v1/objects/1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7/paper-26.1.2-74.jar
echo '1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7  paper-26.1.2-74.jar' | sha256sum -c -
sudo install -o root -g root -m 0644 paper-26.1.2-74.jar /opt/companion-survival/paper.jar

# 4. EULA: running a Minecraft server means accepting the Minecraft EULA (https://aka.ms/MinecraftEULA).
#    The owner accepts it by writing this file.
echo 'eula=true' | sudo -u companion-survival tee /srv/companion-survival/eula.txt

# 5. server.properties (Paper fills in the remaining keys on first start).
sudo -u companion-survival tee /srv/companion-survival/server.properties >/dev/null <<'PROPS'
server-ip=
server-port=25566
online-mode=false
white-list=true
enforce-whitelist=true
gamemode=survival
force-gamemode=true
difficulty=normal
hardcore=false
pvp=true
max-players=10
view-distance=8
simulation-distance=6
spawn-protection=16
enable-rcon=false
enable-query=false
enable-command-block=false
motd=Companion survival
PROPS
#    online-mode=false is the original offline setup; online mode sets it to true ("Switching to online mode" below).
#    server-ip= (empty) listens on every interface because the server is public; for loopback only use server-ip=127.0.0.1.

# 6. (Offline mode only; for online mode see below.) whitelist.json with offline-mode UUIDs (computed by ops/minecraft/offline-uuid.mjs; add the humans' names too).
#    SentientToaster -> 58367002-f226-35b0-9678-4a622d6b424d
node ~/src/personal-agent/ops/minecraft/offline-uuid.mjs SentientToaster | sudo -u companion-survival tee /srv/companion-survival/whitelist.json
sudo -u companion-survival sh -c 'echo "[]" > /srv/companion-survival/ops.json'

# 7. The unit, from this repository.
sudo install -o root -g root -m 0644 ~/src/personal-agent/ops/minecraft/companion-survival.service /etc/systemd/system/companion-survival.service
sudo systemd-analyze verify /etc/systemd/system/companion-survival.service
sudo systemctl daemon-reload
sudo systemctl enable --now companion-survival.service
sudo journalctl -u companion-survival -f        # wait for "Done (…)! For help, type "help""

# 8. Public port (owner decision): open 25566/tcp only, e.g. with ufw:
sudo ufw allow 25566/tcp comment 'companion survival'
```

The unit (`ops/minecraft/companion-survival.service`) runs `java -Xms1G -Xmx3G` with Paper's recommended (Aikar) G1
flags as `companion-survival`, with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`,
`ReadWritePaths=/srv/companion-survival`, `PrivateTmp`, `PrivateDevices`, no capabilities, `MemoryMax=4G` (3 GiB heap
plus JVM overhead), `CPUQuota=200%` and `Nice=5`, so it stays modest on the 15 GiB host shared with other services
(the GTX 1060 is not used). Whitelist changes later: edit `/srv/companion-survival/whitelist.json` (UUIDs from
`offline-uuid.mjs`) and `sudo systemctl restart companion-survival`; there is no console access (no RCON).

Then enable a companion: add the `minecraft` block to its owners.json entry (above) and restart the companion service
with a release that contains this connector.

### Switching to online mode (owner decision: online-mode=true, one real account per companion, no Velocity)

The UUIDs change: an online-mode server knows players by their **real** Mojang UUIDs, so every offline UUID in the
current `whitelist.json` and `ops.json` (the `OfflinePlayer:` MD5 UUIDs from `offline-uuid.mjs`, e.g.
SentientToaster → 58367002-…) becomes invalid. Those entries no longer match anyone, and the old offline players' data
in `world/playerdata/<offline uuid>.dat` (inventory, position) is not carried over to the real UUIDs.

```sh
# 1. Stop the server and keep a copy of the current lists.
sudo systemctl stop companion-survival
sudo -u companion-survival cp /srv/companion-survival/whitelist.json /srv/companion-survival/whitelist.offline.json
sudo -u companion-survival cp /srv/companion-survival/ops.json /srv/companion-survival/ops.offline.json

# 2. server.properties: online-mode=true (keep white-list=true and enforce-whitelist=true).
sudo -u companion-survival sed -i 's/^online-mode=.*/online-mode=true/' /srv/companion-survival/server.properties
grep -E '^(online-mode|white-list|enforce-whitelist)=' /srv/companion-survival/server.properties

# 3. Whitelist by real name, with real UUIDs. Either (a) write whitelist.json yourself, one entry per account, with
#    the UUID from the Mojang API (it answers {"id":"<32 hex>","name":"<exact name>"}; add the dashes 8-4-4-4-12):
curl -fsS https://api.mojang.com/users/profiles/minecraft/<name>
#    the same, printed as a dashed UUID:
curl -fsS https://api.mojang.com/users/profiles/minecraft/<name> \
  | sed -E 's/.*"id" *: *"([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})".*/\1-\2-\3-\4-\5/'
#    e.g. for one companion account and one human:
sudo -u companion-survival tee /srv/companion-survival/whitelist.json >/dev/null <<'JSON'
[ { "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "name": "<companion account name>" },
  { "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "name": "<human name>" } ]
JSON
sudo -u companion-survival sh -c 'echo "[]" > /srv/companion-survival/ops.json'   # or real UUIDs, same format plus "level": 4
#    or (b) start the server and use the console command, which looks the real UUID up itself:
#    whitelist add <name>   (and op <name>; whitelist reload after editing the file by hand)
#    The unit has no console and RCON is off, so (a) is the way on this host unless a console is attached.

# 4. Restart and check the log.
sudo systemctl start companion-survival
sudo journalctl -u companion-survival -f        # "Done (…)!"; no "offline mode" warning any more

# 5. Companions: set "auth": "microsoft" in their owners.json minecraft blocks (username optional), restart the
#    companion service, then each owner opens Me › Connectors and signs the companion in with the shown code.
```

A companion that is not whitelisted under its account's real name is kicked with "You are not whitelisted" (30-minute
wait); add its account's name (the card shows it once the companion has signed in) and it joins on the next try.
`ops/minecraft/offline-uuid.mjs` is for offline mode only.

## Checking it

### E2E harness (fake turns, no model)

```sh
cd ~/src/personal-agent && npm ci        # once, for the packages
node ops/minecraft/e2e.mjs               # 127.0.0.1:25566 as SentientToaster, 120 s at most
# MC_E2E_HOST, MC_E2E_PORT, MC_E2E_NAME, MC_E2E_SECONDS, MC_E2E_VERSION override the defaults (port 25565 is refused).
# Online mode: MC_E2E_AUTH=microsoft MC_E2E_PROFILES=~/mc-e2e-auth MC_E2E_SECONDS=900 (the code prints on the terminal).
```

It runs the real worker and Mineflayer with a fake turn function (scripted replies: say a line with a nonce and wander,
wander again, stop) at a fast test cadence, and prints a JSON report. It passes (exit 0) when the bot joined, at least
two turns ran, the server echoed the chat line back, and the position in a later turn's game state moved by 2+ blocks.
The name must be whitelisted, and C-chan's own bot must not be online under the same name (switch Minecraft off in
Me › Connectors first, or whitelist and use another name).

### One real turn (acceptance)

1. Deploy a release with this connector (the release tool installs the packages), add
   `"minecraft": { "username": "SentientToaster" }` to C-chan's owners.json entry and restart the companion service.
2. Me › Connectors shows Minecraft for Blackout; within a minute it says "In game on 127.0.0.1:25566".
3. Join the server yourself as a whitelisted player. SentientToaster gets a turn for your join (within the 8 s spacing):
   it should greet you and start moving on its own; while you are online it keeps playing: a new turn when its action
   or plan ends, and an idle turn after 20 quiet seconds with nothing running. Talk to it mid-task: it answers and
   keeps doing what it was doing.
4. Say something to it in chat with its name ("SentientToaster, look, diamonds!") or give it a moment worth remembering
   (show it something, let it see you die, travel somewhere together). It should answer in chat.
5. Check its memory: `memory/<today>.md` in C-chan's workspace gets a `- Minecraft: …` line (Me › Memory shows the diary),
   or MEMORY.md a "## Minecraft" bullet. Then ask C-chan in the app "what did we do in Minecraft?": it answers from that.
6. The service log (`journalctl -u personal-agent-account`) shows only connection lines and failed turns, never chat text.

## Open decisions for the owner

- **Public port and name spoofing** (offline mode; online mode, decided 2026-11-07, removes this: Mojang verifies each
  account). The server is public on 25566 in offline mode. Offline mode means anyone can
  connect under any name, and the whitelist only checks the name (offline UUIDs are derived from the name), so a
  stranger who guesses a whitelisted name can join as that player, including as SentientToaster or as a human.
  The app side is safe by construction (nobody's chat, not even the owner's name, can make a companion use tools), but
  in-game impersonation and griefing are possible. Mitigations, from simplest: (a) firewall 25566 to the human players'
  IP addresses (`ufw allow from <ip> to any port 25566 proto tcp`) and keep loopback for the bots; (b) a login plugin
  (for example nLogin or LibreLogin) so humans register a password; the bots would then need a login step and a stored
  password (not built); (c) bind Paper to 127.0.0.1 and reach it over a VPN (Tailscale/WireGuard) instead of a public port.
- **Human whitelist names**: which players to add (their exact names; real UUIDs from the Mojang API in online mode).
- **Cirno's account** (TheScreamer's companion): its own Minecraft account; then add its `minecraft` block
  (`"auth": "microsoft"`) and whitelist entry.
- Whether game turns should count against a daily budget as well (now: up to 150 an hour per companion while people play).
