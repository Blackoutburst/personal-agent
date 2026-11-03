// Connector secrets (#45 GitHub, #46 X): AES-256-GCM with one server key, bound to a purpose and an owner through the
// additional data, so a row copied to another owner or connector cannot be opened. Secrets are never returned to clients
// or given to the model; only the server uses them for its own requests.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class SecretBox {
  #keyFile; #key = null;
  // keyFile: hex key, 32 bytes. Made on first use (mode 600) when its folder is writable; the deployed service cannot
  // write its home, so there the file is made once by hand (docs/RUNTIME.md).
  constructor({ keyFile }) { this.#keyFile = keyFile; }

  #secret() {
    if (this.#key) return this.#key;
    if (!this.#keyFile) throw new Error('SECRETS_UNCONFIGURED');
    try { this.#key = Buffer.from(readFileSync(this.#keyFile, 'utf8').trim(), 'hex'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('SECRETS_UNCONFIGURED');
      mkdirSync(dirname(this.#keyFile), { recursive: true, mode: 0o700 });
      try { writeFileSync(this.#keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); } catch { /* another process won */ }
      this.#key = Buffer.from(readFileSync(this.#keyFile, 'utf8').trim(), 'hex');
    }
    if (this.#key.length !== 32) { this.#key = null; throw new Error('SECRETS_UNCONFIGURED'); }
    return this.#key;
  }
  // Throws Error('SECRETS_UNCONFIGURED') when the key cannot be read.
  seal(scope, text) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#secret(), iv);
    cipher.setAAD(Buffer.from(scope));
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
  }
  // Throws Error('SECRETS_UNCONFIGURED') or Error('SECRET_UNREADABLE').
  open(scope, sealed) {
    const key = this.#secret();
    try {
      const [version, iv, tag, body] = sealed.split(':');
      if (version !== 'v1') throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw new Error('SECRET_UNREADABLE'); }
  }
}
