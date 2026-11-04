// Speech to text with NVIDIA Nemotron 3.5 ASR (ops/asr.py, docs/RUNTIME.md): voice messages and X video sound.
// One worker process, started on the first request and stopped after idleMs without work, so the model only holds
// memory (GPU or CPU) while it is being used. Any audio or video file is first turned into 16 kHz mono WAV by ffmpeg.
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class AsrError extends Error { constructor(code) { super(code); this.name = 'AsrError'; this.code = code; } }

const run = (file, args, timeout) => new Promise((resolve, reject) => execFile(file, args, { timeout, maxBuffer: 1024 ** 2,
  env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '' } }, (error, stdout) => error ? reject(error) : resolve(stdout)));

export class Asr {
  #python; #script; #model; #ffmpeg; #ffprobe; #idleMs; #timeoutMs; #spawn; #env;
  #worker = null; #buffer = ''; #waiting = new Map(); #next = 0; #idle = null; #chain = Promise.resolve();
  // python: the ASR venv's interpreter; script: ops/asr.py; model: the downloaded model folder.
  constructor({ python, script, model, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', idleMs = 10 * 60_000, timeoutMs = 5 * 60_000, spawnImpl = spawn, env = {} }) {
    this.#python = python; this.#script = script; this.#model = model; this.#ffmpeg = ffmpeg; this.#ffprobe = ffprobe;
    this.#idleMs = idleMs; this.#timeoutMs = timeoutMs; this.#spawn = spawnImpl; this.#env = env;
  }

  // Length of an audio or video file in milliseconds, or null.
  async durationMs(path) {
    try {
      const seconds = Number((await run(this.#ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], 20_000)).trim());
      return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
    } catch { return null; }
  }

  // { text, language } for any audio/video file the server holds. language: a locale hint such as "fr-FR", or auto.
  // One file at a time; throws AsrError (UNREADABLE, FAILED, TIMEOUT, UNAVAILABLE).
  transcribe(path, { language = 'auto' } = {}) {
    const job = this.#chain.then(() => this.#transcribe(path, language));
    this.#chain = job.catch(() => {});
    return job;
  }

  async #transcribe(path, language) {
    const dir = mkdtempSync(join(tmpdir(), 'asr-')), wav = join(dir, 'audio.wav');
    try {
      try { await run(this.#ffmpeg, ['-nostdin', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-y', wav], 120_000); }
      catch { throw new AsrError('UNREADABLE'); }
      const answer = await this.#ask({ wav, language });
      if (answer.error) throw new AsrError('FAILED');
      return { text: String(answer.text ?? '').trim(), language: typeof answer.language === 'string' ? answer.language : null };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  #ask(request) {
    clearTimeout(this.#idle);
    const worker = this.#start(), id = String(++this.#next);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#waiting.delete(id); this.stop(); reject(new AsrError('TIMEOUT')); }, this.#timeoutMs);
      this.#waiting.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      worker.stdin.write(JSON.stringify({ id, ...request }) + '\n');
    }).finally(() => {
      if (!this.#waiting.size) this.#idle = setTimeout(() => this.stop(), this.#idleMs);
      this.#idle?.unref?.();
    });
  }

  #start() {
    if (this.#worker) return this.#worker;
    const worker = this.#spawn(this.#python, [this.#script, this.#model], { stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', ...this.#env } });
    this.#worker = worker; this.#buffer = '';
    worker.stdout.setEncoding('utf8').on('data', chunk => {
      this.#buffer += chunk;
      let newline;
      while ((newline = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, newline); this.#buffer = this.#buffer.slice(newline + 1);
        let answer; try { answer = JSON.parse(line); } catch { continue; }
        const waiting = this.#waiting.get(String(answer?.id)); this.#waiting.delete(String(answer?.id));
        waiting?.resolve(answer);
      }
    });
    worker.stdin.on('error', () => {});
    const gone = () => {
      if (this.#worker !== worker) return;
      this.#worker = null;
      for (const waiting of this.#waiting.values()) waiting.reject(new AsrError('UNAVAILABLE'));
      this.#waiting.clear();
    };
    worker.on('exit', gone); worker.on('error', gone);
    return worker;
  }

  // Ends the worker (idle, timeout or shutdown); the next request starts a new one.
  stop() {
    clearTimeout(this.#idle);
    const worker = this.#worker;
    if (!worker) return;
    try { worker.stdin.end(); worker.kill('SIGTERM'); } catch { /* already gone */ }
  }
}
