#!/usr/bin/env node
// Prints the offline-mode UUID of each Minecraft name and a whitelist.json for them (#68, docs/MINECRAFT.md).
//   node ops/minecraft/offline-uuid.mjs SentientToaster Cirno > whitelist.json
import { offlineUuid } from '../../src/minecraft.mjs';

const names = process.argv.slice(2);
if (!names.length) { console.error('Usage: node ops/minecraft/offline-uuid.mjs <name> [name...]'); process.exit(2); }
try { console.log(JSON.stringify(names.map(name => ({ uuid: offlineUuid(name), name })), null, 2)); }
catch { console.error('Minecraft names are 3-16 letters, digits or underscores.'); process.exit(2); }
