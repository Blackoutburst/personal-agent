import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

// The Windows desktop app download (docs/DESKTOP.md). <dataDir>/downloads/desktop.json names the current build:
// {"version":"0.4.0","file":"Companion-Setup-0.4.0-x64.exe"} (the NSIS installer). Owner-only; 404 when no valid build is published.
// The same folder is the electron-updater feed (#89): /api/desktop/update/latest.yml, <file> and <file>.blockmap, same owner check.
const FILE = /^[A-Za-z0-9._-]{1,80}\.exe$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const hashes = new Map(); // path:size:mtime -> sha256, so a big exe is hashed once

export function desktopRelease(dataDir) {
  try {
    const dir = join(dataDir, 'downloads'), info = JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8'));
    if (typeof info?.version !== 'string' || !VERSION.test(info.version) || typeof info.file !== 'string' || !FILE.test(info.file)) return null;
    const path = join(dir, info.file), stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0) return null;
    const key = `${path}:${stat.size}:${stat.mtimeMs}`;
    if (!hashes.has(key)) hashes.set(key, createHash('sha256').update(readFileSync(path)).digest('hex'));
    return { version: info.version, path, size: stat.size, sha256: hashes.get(key) };
  } catch { return null; }
}

export function createDesktopHttp({ access, dataDir }) {
  return async function desktopHttp(req, res, headers) {
    const json = (status, body) => { res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    const error = (status, code, message) => json(status, { error: { code, message } });
    if (!['GET', 'HEAD'].includes(req.method)) return error(405, 'METHOD_NOT_ALLOWED', 'GET or HEAD is required.');
    const admitted = await access.authorize(req);
    if (admitted.failure) return json(admitted.failure.status, admitted.failure.body);
    const release = desktopRelease(dataDir);
    if (!release) return error(404, 'NOT_FOUND', 'The desktop app is not available yet.');
    const urlPath = req.url.split('?')[0];   // the query string is ignored (cache busters, tracking)
    const feed = /^\/api\/desktop\/update\/([A-Za-z0-9._-]{1,100})$/.exec(urlPath);
    if (feed) {
      const name = feed[1], base = basename(release.path);
      const file = name === 'latest.yml' ? join(dirname(release.path), 'latest.yml')
        : name === base ? release.path : name === base + '.blockmap' ? release.path + '.blockmap' : null;
      let stat = null;
      try { stat = file && statSync(file); } catch {}
      if (!stat?.isFile()) return error(404, 'NOT_FOUND', 'No such update file.');
      res.writeHead(200, { ...headers, 'content-type': name === 'latest.yml' ? 'text/yaml; charset=utf-8' : 'application/octet-stream',
        'content-length': String(stat.size), 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin' });
      if (req.method === 'HEAD') return res.end();
      const stream = createReadStream(file);
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
      return;
    }
    if (urlPath === '/api/desktop') return json(200, { version: release.version, size: release.size, sha256: release.sha256 });
    if (urlPath !== '/api/desktop/download') return error(404, 'NOT_FOUND', 'No such file.');
    res.writeHead(200, { ...headers, 'content-type': 'application/vnd.microsoft.portable-executable', 'content-length': String(release.size),
      'content-disposition': `attachment; filename="Companion-${release.version}.exe"`, 'x-content-sha256': release.sha256,
      'cross-origin-resource-policy': 'same-origin' });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(release.path);
    stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  };
}
