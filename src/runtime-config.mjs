import { readFileSync } from 'node:fs';
import { principalKey } from './provisioning.mjs';
import { ISSUER } from './pilot-config.mjs';

export const PROVIDERS = ['claude', 'codex'];
const LABEL = /^[a-z][a-z0-9-]{0,31}$/;

// Runtime file (COMPANION_RUNTIME_FILE), kept outside the checkout:
// {"owners":[{"subject":"<platform account id>","label":"blackout","provider":"claude","model":"opus"}]}
// "model" is optional; "issuer" defaults to the platform issuer. The file holds no credentials.
export function parseRuntimeConfig(text) {
  const config = JSON.parse(text);
  if (!config || !Array.isArray(config.owners) || config.owners.length === 0) throw new Error('Runtime config needs an "owners" list');
  const labels = new Set(), subjects = new Set();
  return config.owners.map(owner => {
    const { subject, label, provider, model = null, issuer = ISSUER } = owner ?? {};
    if (typeof issuer !== 'string' || !/^https:\/\/[^\s/]+$/.test(issuer)) throw new Error(`Invalid issuer for ${label}`);
    if (typeof subject !== 'string' || !subject || subject.length > 200) throw new Error('Each owner needs a "subject"');
    if (typeof label !== 'string' || !LABEL.test(label)) throw new Error(`Invalid label for ${subject}: use lowercase letters, digits and dashes`);
    if (!PROVIDERS.includes(provider)) throw new Error(`Provider for ${label} must be one of: ${PROVIDERS.join(', ')}`);
    if (model !== null && (typeof model !== 'string' || !model || model.length > 100)) throw new Error(`Invalid model for ${label}`);
    if (labels.has(label) || subjects.has(subject)) throw new Error(`Duplicate owner ${label}`);
    labels.add(label); subjects.add(subject);
    return Object.freeze({ subject, label, provider, model, issuer });
  });
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
