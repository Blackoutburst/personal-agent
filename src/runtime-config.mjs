import { readFileSync } from 'node:fs';
import { principalKey } from './provisioning.mjs';
import { ISSUER } from './pilot-config.mjs';
import { CLAUDE_FILE_TOOLS, WEB_TOOLS, normalizeToolPolicy } from './tool-policy.mjs';
import { parseMailConfig } from './mail.mjs';
import { parseMinecraftConfig } from './minecraft.mjs';

export const PROVIDERS = ['claude', 'codex'];
const LABEL = /^[a-z][a-z0-9-]{0,31}$/;

// Runtime file (COMPANION_RUNTIME_FILE), kept outside the checkout:
// {"owners":[{"subject":"<platform account id>","label":"blackout","provider":"claude","model":"opus"}]}
// "model" and "name" (how the companion calls its owner) are optional; "issuer" defaults to the platform
// issuer. The file holds no credentials.
export function parseRuntimeConfig(text, env = process.env) {
  const config = JSON.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some(key => key !== 'owners')
      || !Array.isArray(config.owners) || config.owners.length === 0) throw new Error('Runtime config needs only an "owners" list');
  const labels = new Set(), subjects = new Set();
  const owners = config.owners.map(owner => {
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
        || Object.keys(owner).some(key => !['subject', 'label', 'provider', 'model', 'issuer', 'name', 'tools', 'board', 'mail', 'minecraft'].includes(key))) {
      throw new Error('Invalid runtime owner fields');
    }
    const { subject, label, provider, model = null, issuer = ISSUER, name = null } = owner ?? {};
    if (name !== null && (typeof name !== 'string' || !name.trim() || name.length > 40 || /[\u0000-\u001f<>]/.test(name))) throw new Error(`Invalid name for ${label}`);
    if (typeof issuer !== 'string' || !/^https:\/\/[^\s/]+$/.test(issuer)) throw new Error(`Invalid issuer for ${label}`);
    if (typeof subject !== 'string' || !subject || subject.length > 200) throw new Error('Each owner needs a "subject"');
    if (typeof label !== 'string' || !LABEL.test(label)) throw new Error(`Invalid label for ${subject}: use lowercase letters, digits and dashes`);
    if (!PROVIDERS.includes(provider)) throw new Error(`Provider for ${label} must be one of: ${PROVIDERS.join(', ')}`);
    if (model !== null && (typeof model !== 'string' || !model || model.length > 100)) throw new Error(`Invalid model for ${label}`);
    // Defaults: native web search/fetch for chat (#42), plus workspace file tools on Claude. "tools": [] turns them off.
    const toolPolicy = normalizeToolPolicy({ tools: owner.tools === undefined
      ? provider === 'claude' ? [...WEB_TOOLS, ...CLAUDE_FILE_TOOLS] : [...WEB_TOOLS] : owner.tools, board: owner.board }, env);
    if (provider === 'codex' && toolPolicy.tools.length
        && (toolPolicy.tools.length !== WEB_TOOLS.length || !WEB_TOOLS.every(tool => toolPolicy.tools.includes(tool)))) {
      throw new Error(`Codex tools for ${label} must be the web pair or empty`);
    }
    // "mail" (#50, docs/MAIL.md): the mailbox this owner's companion handles (may be shared, #64); no secret, only the password file's path.
    const mail = owner.mail === undefined ? null : parseMailConfig(owner.mail, label);
    // "minecraft" (#68, docs/MINECRAFT.md): this companion plays on the shared survival server. Absent = off.
    const minecraft = owner.minecraft === undefined ? null : parseMinecraftConfig(owner.minecraft, label);
    if (labels.has(label) || subjects.has(subject)) throw new Error(`Duplicate owner ${label}`);
    labels.add(label); subjects.add(subject);
    return Object.freeze({ subject, label, provider, model, issuer, ...(name !== null ? { name: name.trim() } : {}), ...(mail ? { mail } : {}), ...(minecraft ? { minecraft } : {}), ...toolPolicy });
  });
  // #64: owners may share one mailbox (their companions share its state); the same address must mean the same mailbox.
  const mailboxes = new Map();
  for (const owner of owners) {
    if (!owner.mail) continue;
    const first = mailboxes.get(owner.mail.address);
    if (!first) { mailboxes.set(owner.mail.address, owner); continue; }
    const a = first.mail, b = owner.mail;
    if (a.maildir !== b.maildir || ['port', 'servername', 'user', 'passwordFile'].some(key => a.smtp[key] !== b.smtp[key])) {
      throw new Error(`Owners ${first.label} and ${owner.label} share the mail address ${b.address} but not its maildir and smtp settings`);
    }
  }
  const players = new Set();
  for (const owner of owners) {
    const name = owner.minecraft?.username?.toLowerCase();
    if (!name) continue;
    if (players.has(name)) throw new Error(`Two companions cannot share the Minecraft name ${owner.minecraft.username}`);
    players.add(name);
  }
  const viewers = new Set();
  for (const owner of owners) for (const label of owner.mail?.studioViewers ?? []) {
    if (!labels.has(label) || viewers.has(label)) throw new Error('Studio viewers must name configured owners and select only one mailbox');
    viewers.add(label);
  }
  return owners;
}

export function loadRuntimeConfig(path) {
  if (!path) return [];
  return parseRuntimeConfig(readFileSync(path, 'utf8'));
}

// The companion ID for an owner, as provisioned on their first sign-in (null before that).
export function companionIdFor(store, owner) {
  const record = store.get('companion-identity-v1', principalKey({ issuer: owner.issuer ?? ISSUER, subject: owner.subject }));
  return record?.companionId ?? null;
}
