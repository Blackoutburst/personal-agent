import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { BootstrapStore } from '../src/store.mjs';
import { Conversations } from '../src/conversations.mjs';
import { FileStore, FileError } from '../src/files.mjs';
import { parseAttachment } from '../public/conversation-client.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OGG = Buffer.from('OggS\0\0\0\0OpusHead synthetic voice');
const source = async function* (bytes) { yield bytes; };
const rejects = (promise, code, status) => assert.rejects(promise, error => error instanceof FileError && error.code === code && (status === undefined || error.status === status));

// A fake speech-to-text: lengths and transcripts by file, counted.
function fakeAsr({ duration = 4200, text = 'salut, je rentre du travail' } = {}) {
  const asr = { calls: 0, duration, text, failing: false,
    async durationMs() { return asr.duration; },
    async transcribe() { asr.calls++; await sleep(5); if (asr.failing) throw new Error('synthetic'); return { text: asr.text, language: 'fr-FR' }; } };
  return asr;
}

function fixture(t, { asr = fakeAsr(), gatherMs = 0, texting = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'voice-')), dataDir = join(dir, 'data'), work = join(dir, 'work');
  mkdirSync(work, { mode: 0o700 });
  const store = new BootstrapStore(dataDir, ROOT), owner = randomUUID();
  const files = new FileStore({ store, dataDir, asr, workspaceFor: id => id === owner ? { dir: work } : null });
  const turns = [];
  const runner = { turn: (_id, input) => new Promise(resolve => { turns.push({ input, prompt: input.prompt, resolve }); }) };
  const conversations = new Conversations({ store, runner, files, flushMs: 1, gatherMs, texting, systemPrompt: () => 'persona' });
  t.after(async () => { for (const turn of turns) turn.resolve({ text: 'late' }); await conversations.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  let n = 0;
  const f = { store, files, conversations, owner, turns, asr, thread: null,
    async open() { f.thread = (await conversations.handle(owner, { action: 'createThread', requestId: 'thread-1', title: 'Chat' })).thread.id; },
    upload: (extra = {}, bytes = OGG) => files.upload(owner, { threadId: f.thread, requestId: randomUUID(), name: 'Voice message.ogg', size: bytes.length, voice: true, ...extra }, source(bytes)),
    send: (text, attachments = []) => conversations.handle(owner, { action: 'submit', requestId: `req-${++n}`, threadId: f.thread, text, ...(attachments.length ? { attachments } : {}) }),
    async until(check, label) { for (let i = 0; i < 300; i++) { if (check()) return; await sleep(10); } assert.fail('timed out: ' + label); }
  };
  return f;
}

test('a voice upload is measured, transcribed once in the background and shown as a voice message', async t => {
  const f = fixture(t); await f.open();
  const dto = await f.upload();
  assert.equal(dto.mime, 'audio/ogg');
  assert.deepEqual(dto.voice, { durationMs: 4200 });
  await f.until(() => f.files.dto(f.files.get(f.owner, dto.id)).voice.transcript, 'background transcript');
  assert.deepEqual(f.files.dto(f.files.get(f.owner, dto.id)).voice, { durationMs: 4200, transcript: 'salut, je rentre du travail' });
  assert.deepEqual(await f.files.transcript(f.owner, dto.id), { text: 'salut, je rentre du travail', language: 'fr-FR' });
  assert.equal(f.asr.calls, 1, 'kept, never made twice');
  assert.equal(parseAttachment(f.files.dto(f.files.get(f.owner, dto.id))).voice.transcript, 'salut, je rentre du travail');
  // A plain file is never a voice message.
  const plain = await f.files.upload(f.owner, { threadId: f.thread, requestId: randomUUID(), name: 'song.ogg', size: OGG.length }, source(OGG));
  assert.equal(plain.voice, undefined);
  await rejects(f.files.transcript(f.owner, plain.id), 'FILE_NOT_VOICE', 415);
});

test('a voice upload must be sound of a measurable, bounded length; without speech to text it is refused', async t => {
  const f = fixture(t); await f.open();
  await rejects(f.upload({ name: 'photo.png' }, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'FILE_NOT_VOICE', 415);
  f.asr.duration = null;
  await rejects(f.upload(), 'FILE_NOT_VOICE', 415);
  f.asr.duration = 11 * 60_000;
  await rejects(f.upload(), 'FILE_TOO_LARGE', 413);
  const g = fixture(t, { asr: null }); await g.open();
  await rejects(g.upload(), 'INVALID_FILE');
});

test('the companion reads the transcript in place of the voice message, in order with typed texts', async t => {
  const f = fixture(t, { gatherMs: 30, texting: true }); await f.open();
  const voice = await f.upload();
  await f.send('ok so');
  await f.send('', [voice.id]);
  await f.until(() => f.turns.length === 1, 'reply starts');
  assert.match(f.turns[0].prompt, /^ok so\n\(voice message\) salut, je rentre du travail/);
  assert.doesNotMatch(f.turns[0].prompt, /Files sent by the owner/, 'a voice message is not handed over as a file');
  // The message the owner sees is still the voice message, now with its transcript.
  const page = await f.conversations.handle(f.owner, { action: 'snapshot', threadId: f.thread });
  const shown = page.messages.find(message => message.attachments?.length);
  assert.equal(shown.text, '');
  assert.deepEqual(shown.attachments[0].voice, { durationMs: 4200, transcript: 'salut, je rentre du travail' });
});

test('a voice message that cannot be transcribed is still answered: the companion says it could not hear it', async t => {
  const asr = fakeAsr(); asr.failing = true;
  const f = fixture(t, { asr }); await f.open();
  const voice = await f.upload();
  await f.send('', [voice.id]);
  await f.until(() => f.turns.length === 1, 'reply starts');
  assert.match(f.turns[0].prompt, /could not be transcribed/);
  asr.text = '';
  asr.failing = false;
  const silent = await f.upload();
  f.turns[0].resolve({ text: 'sorry didn’t catch that' });
  await f.send('', [silent.id]);
  await f.until(() => f.turns.length === 2, 'second reply');
  assert.match(f.turns[1].prompt, /no speech in it/);
});

test('a voice message plays everywhere as AAC in MP4, made once and removed with the file', { skip: spawnSync('ffmpeg', ['-version']).status !== 0 && 'no ffmpeg' }, async t => {
  const f = fixture(t); await f.open();
  const dir = mkdtempSync(join(tmpdir(), 'voice-src-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wav = join(dir, 'tone.ogg');
  assert.equal(spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-y', wav]).status, 0);
  const bytes = (await import('node:fs')).readFileSync(wav);
  const dto = await f.upload({}, bytes);
  const first = await f.files.playable(f.owner, dto.id);
  assert.ok(first.size > 0 && first.path.endsWith('.m4a'));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', first.path], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), 'aac');
  assert.deepEqual(await f.files.playable(f.owner, dto.id), first);
  await f.until(() => f.files.get(f.owner, dto.id).transcript !== null, 'transcript settles');
  await f.conversations.handle(f.owner, { action: 'deleteThread', requestId: 'delete-1', threadId: f.thread });
  await f.until(() => !existsSync(first.path), 'removed with the file');
});

test('the web recorder records, cancels, refuses very short clips and names the file by its format', async () => {
  const { createVoiceRecorder, voiceFormat, clock } = await import('../public/voice-ui.mjs');
  const button = () => { const listeners = {}; return { addEventListener: (name, run) => { listeners[name] = run; }, click: () => listeners.click() }; };
  const parts = { '.voice-time': { textContent: '' }, '.voice-cancel': button(), '.voice-send': button() };
  const bar = { hidden: true, querySelector: selector => parts[selector] };
  let time = 0, stopped = 0;
  class Recorder {
    static isTypeSupported(mime) { return mime === 'audio/mp4'; }
    constructor(_stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['sound']) }); this.onstop(); }
  }
  const media = { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }) };
  const sent = [], problems = [], states = [];
  const recorder = createVoiceRecorder({ bar, media, Recorder, now: () => time, onRecorded: (file, ms) => sent.push({ file, ms }),
    onProblem: text => problems.push(text), onStart: () => states.push('start'), onStop: () => states.push('stop') });
  assert.deepEqual(voiceFormat(Recorder), { mime: 'audio/mp4', ext: 'm4a' });
  assert.equal(clock(65_000), '1:05');
  await recorder.start(); assert.equal(bar.hidden, false); assert.ok(recorder.recording());
  time = 3000; parts['.voice-send'].click();
  assert.equal(sent.length, 1); assert.equal(sent[0].file.name, 'Voice message.m4a'); assert.equal(sent[0].file.type, 'audio/mp4'); assert.equal(sent[0].ms, 3000);
  assert.equal(bar.hidden, true); assert.equal(stopped, 1, 'the microphone is released');
  await recorder.start(); time = 4000; parts['.voice-cancel'].click();
  assert.equal(sent.length, 1, 'cancelled is never sent');
  await recorder.start(); time = 4200; recorder.send();
  assert.deepEqual(problems, ['That was too short to send.']);
  assert.deepEqual(states, ['start', 'stop', 'start', 'stop', 'start', 'stop']);
  const denied = createVoiceRecorder({ bar, Recorder, media: { getUserMedia: async () => { throw new Error('denied'); } }, onRecorded() {}, onProblem: text => problems.push(text) });
  await denied.start(); assert.match(problems.at(-1), /Allow the microphone/);
});
