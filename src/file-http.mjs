import { createReadStream, closeSync } from 'node:fs';
import { FileError, FILE_ID, inlineMime } from './files.mjs';

const messages = { INVALID_FILE: 'Choose a valid file and upload request.', FILE_TOO_LARGE: 'The file exceeds the size limit.',
  FILE_QUOTA: 'Your companion file storage is full. Delete old conversations or pending files.',
  FILE_NOT_AVAILABLE: 'This file is already attached or is no longer available.', CONFLICT: 'This upload request changed or is still running.',
  FILE_UNAVAILABLE: 'The private file store is temporarily unavailable.', NOT_FOUND: 'File not found.',
  FILE_PATH_REJECTED: 'Only regular files in this companion workspace can be sent.', FILE_TURN_ENDED: 'This reply is no longer active.',
  FILE_TOO_MANY: 'At most eight files can be attached to one reply.',
  FILE_NOT_VOICE: 'That recording could not be read as a voice message.' };
export function fileFailure(error) {
  const known = error instanceof FileError;
  return { status: known ? error.status : 503, body: { error: { code: known ? error.code : 'FILE_UNAVAILABLE',
    message: messages[known ? error.code : 'FILE_UNAVAILABLE'] ?? messages.INVALID_FILE } } };
}
export function byteRange(value, size) {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new FileError('INVALID_RANGE', 416);
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2] || size === 0) throw new FileError('INVALID_RANGE', 416);
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix < 1) throw new FileError('INVALID_RANGE', 416); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new FileError('INVALID_RANGE', 416);
  return { start, end: Math.min(end, size - 1) };
}
function unique(request, name) {
  const values = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === name) values.push(request.rawHeaders[i + 1]);
  if (values.length !== 1) throw new FileError('INVALID_FILE');
  return values[0];
}
export function createFileHttp({ access, files }) {
  return async function fileHttp(req, res, headers) {
    const json = result => { if (!res.headersSent && !res.destroyed) { res.writeHead(result.status, { ...headers, 'content-type': 'application/json; charset=utf-8', ...(result.closeConnection ? { connection: 'close' } : {}) }); res.end(JSON.stringify(result.body)); } };
    try {
      const path = req.url, upload = path === '/api/files', remove = path === '/api/files/remove';
      if (upload || remove) {
        const rejected = access.admit(req, upload);
        if (rejected) return json(rejected);
      } else if (!['GET', 'HEAD'].includes(req.method)) return json({ status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED', message: 'GET or HEAD is required.' } } });
      const admitted = await access.authorize(req);
      if (admitted.failure) return json({ ...admitted.failure, ...(upload ? { closeConnection: true } : {}) });
      const companionId = admitted.companionId;
      if (upload) {
        let name;
        try { name = decodeURIComponent(unique(req, 'x-file-name')); } catch { throw new FileError('INVALID_FILE'); }
        const length = unique(req, 'content-length');
        if (!/^(0|[1-9][0-9]{0,9})$/.test(length) || req.headers['transfer-encoding']) throw new FileError('INVALID_FILE');
        const size = Number(length), threadId = unique(req, 'x-thread-id'), requestId = unique(req, 'x-request-id');
        // x-file-voice: 1 marks a recorded voice message (shown as one; the companion reads its transcript).
        const voiceHeader = req.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'x-file-voice') ? unique(req, 'x-file-voice') : null;
        if (voiceHeader !== null && voiceHeader !== '1') throw new FileError('INVALID_FILE');
        req.setTimeout(120_000, () => req.destroy(new FileError('FILE_UNAVAILABLE', 408)));
        try { return json({ status: 200, body: { file: await files.upload(companionId, { name, size, threadId, requestId, ...(voiceHeader ? { voice: true } : {}) }, req) } }); }
        finally { req.setTimeout(0); }
      }
      if (remove) {
        const parsed = await access.read(req, 1024);
        if (parsed.failure) return json(parsed.failure);
        const body = parsed.value;
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.id !== 'string' || !FILE_ID.test(body.id)) throw new FileError('INVALID_FILE');
        return json({ status: 200, body: files.removePending(companionId, body.id) });
      }
      // A voice message as AAC/MP4 for playback on every client.
      const voiceId = /^\/api\/files\/([a-f0-9-]{36})\/voice$/.exec(path)?.[1];
      if (voiceId && FILE_ID.test(voiceId)) {
        const audio = await files.playable(companionId, voiceId);
        let range;
        try { range = byteRange(req.headers.range, audio.size); }
        catch { res.writeHead(416, { ...headers, 'content-range': 'bytes */' + audio.size, 'content-length': '0' }); return res.end(); }
        const length = range ? range.end - range.start + 1 : audio.size;
        res.writeHead(range ? 206 : 200, { ...headers, 'content-type': 'audio/mp4', 'content-length': String(length), 'accept-ranges': 'bytes',
          'content-disposition': 'inline; filename="voice.m4a"', 'cross-origin-resource-policy': 'same-origin',
          ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${audio.size}` } : {}) });
        if (req.method === 'HEAD' || length === 0) return res.end();
        const stream = createReadStream(audio.path, range ?? {});
        stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
        return;
      }
      const id = /^\/api\/files\/([a-f0-9-]{36})$/.exec(path)?.[1];
      if (!id || !FILE_ID.test(id)) throw new FileError('NOT_FOUND', 404);
      const row = files.get(companionId, id);
      let range;
      try { range = byteRange(req.headers.range, row.size); }
      catch { res.writeHead(416, { ...headers, 'content-range': 'bytes */' + row.size, 'content-length': '0' }); return res.end(); }
      const fd = files.open(row), length = range ? range.end - range.start + 1 : row.size;
      const disposition = (inlineMime(row.mime) ? 'inline' : 'attachment') + "; filename=\"file\"; filename*=UTF-8''" + encodeURIComponent(row.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      res.writeHead(range ? 206 : 200, { ...headers, 'content-type': row.mime, 'content-length': String(length),
        'accept-ranges': 'bytes', 'content-disposition': disposition, 'cross-origin-resource-policy': 'same-origin',
        ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${row.size}` } : {}) });
      if (req.method === 'HEAD' || length === 0) { closeSync(fd); return res.end(); }
      const stream = createReadStream(null, { fd, autoClose: true, ...(range ?? {}) });
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    } catch (error) { json({ ...fileFailure(error), ...(!req.complete ? { closeConnection: true } : {}) }); }
  };
}
