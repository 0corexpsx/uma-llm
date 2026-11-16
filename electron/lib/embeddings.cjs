// Meaning search for Uma's project search (RAG, second stage). A small embedding model turns each
// passage into a vector, so a question finds passages that mean the same thing in other words or
// another language ("dove si controlla la password" finds checkPassword()). It runs in its own
// llama.cpp process beside the chat model: on the GPU when there is room, otherwise on the CPU.
// Vectors are stored on disk by the passage's content, so a passage is only encoded once.
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { ensureDir, downloadFile, sleep } = require('./util.cjs');

// The model Uma downloads for meaning search (see scripts in the 0.2.21 notes for how it was chosen).
const EMBEDDING_MODEL = {
  id: 'embeddinggemma-300m',
  name: 'EmbeddingGemma 300M',
  url: 'https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf',
  file: 'embeddinggemma-300M-Q8_0.gguf',
  sizeBytes: 333590944,
  pooling: 'mean',
  // The prompts the model was trained with for search.
  query: (text) => `task: search result | query: ${text}`,
  document: (text) => `title: none | text: ${text}`,
  // Room it needs on a GPU, weights and buffers.
  gpuMB: 900,
};

// Passages encoded per request: larger batches are faster but hold the engine longer.
const BATCH = 16;
// The engine stops after this long unused, to give its memory back.
const IDLE_MS = 5 * 60 * 1000;

function textHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) out[index] = vector[index] / length;
  return out;
}

function cosine(a, b) {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * The vectors of one workspace, kept in memory and in one binary file:
 * "UMAV" | version u32 | dims u32 | count u32 | then count × (16-char hash as 8 bytes | dims × float32).
 */
class VectorStore {
  constructor(file) {
    this.file = file;
    this.vectors = new Map();
    this.dims = 0;
    this.dirty = false;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    const buffer = await fsp.readFile(this.file).catch(() => null);
    if (!buffer || buffer.length < 16 || buffer.toString('latin1', 0, 4) !== 'UMAV' || buffer.readUInt32LE(4) !== 1) return;
    const dims = buffer.readUInt32LE(8);
    const count = buffer.readUInt32LE(12);
    const row = 8 + dims * 4;
    if (buffer.length < 16 + count * row) return;
    this.dims = dims;
    for (let index = 0; index < count; index += 1) {
      const at = 16 + index * row;
      const hash = buffer.toString('hex', at, at + 8);
      const vector = new Float32Array(dims);
      for (let d = 0; d < dims; d += 1) vector[d] = buffer.readFloatLE(at + 8 + d * 4);
      this.vectors.set(hash, vector);
    }
  }

  get(hash) {
    return this.vectors.get(hash) || null;
  }

  set(hash, vector) {
    if (this.dims && vector.length !== this.dims) this.vectors.clear();
    this.dims = vector.length;
    this.vectors.set(hash, vector);
    this.dirty = true;
  }

  /** Keeps only the vectors of passages that still exist, so the file does not grow forever. */
  keepOnly(hashes) {
    for (const hash of [...this.vectors.keys()]) {
      if (!hashes.has(hash)) {
        this.vectors.delete(hash);
        this.dirty = true;
      }
    }
  }

  async save() {
    if (!this.dirty || !this.dims) return;
    this.dirty = false;
    const row = 8 + this.dims * 4;
    const buffer = Buffer.alloc(16 + this.vectors.size * row);
    buffer.write('UMAV', 0, 'latin1');
    buffer.writeUInt32LE(1, 4);
    buffer.writeUInt32LE(this.dims, 8);
    buffer.writeUInt32LE(this.vectors.size, 12);
    let at = 16;
    for (const [hash, vector] of this.vectors) {
      buffer.write(hash, at, 'hex');
      for (let d = 0; d < this.dims; d += 1) buffer.writeFloatLE(vector[d], at + 8 + d * 4);
      at += row;
    }
    await ensureDir(path.dirname(this.file));
    const temp = `${this.file}.${process.pid}.tmp`;
    await fsp.writeFile(temp, buffer);
    await fsp.rename(temp, this.file);
  }
}

/**
 * The embedding model: downloaded once into app data, started on demand as its own llama-server,
 * stopped when unused. `serverPath()` gives the installed engine; `freeVramMB()` how much GPU
 * memory is free now, to decide between GPU and CPU.
 */
class EmbeddingEngine {
  constructor({ dir, serverPath, freeVramMB = async () => 0, emit = () => {}, model = EMBEDDING_MODEL }) {
    this.dir = dir;
    this.serverPath = serverPath;
    this.freeVramMB = freeVramMB;
    this.emit = emit;
    this.model = model;
    this.child = null;
    this.port = 0;
    this.apiKey = '';
    this.starting = null;
    this.idleTimer = null;
    this.download = null;
    this.device = '';
  }

  get file() {
    return path.join(this.dir, this.model.file);
  }

  installed() {
    const stat = fs.statSync(this.file, { throwIfNoEntry: false });
    return Boolean(stat && stat.size === this.model.sizeBytes);
  }

  status() {
    return {
      model: this.model.name,
      sizeBytes: this.model.sizeBytes,
      installed: this.installed(),
      downloading: this.download ? { ...this.download.progress } : null,
      running: Boolean(this.child),
      device: this.device,
    };
  }

  /** Downloads the model; progress goes out as 'rag:download' events. */
  async install() {
    if (this.installed()) return this.status();
    if (this.download) return this.download.promise;
    const controller = new AbortController();
    this.download = { controller, progress: { percent: 0, received: 0, total: this.model.sizeBytes } };
    this.download.promise = (async () => {
      try {
        await ensureDir(this.dir);
        await downloadFile(this.model.url, this.file, {
          signal: controller.signal,
          expectedSize: this.model.sizeBytes,
          label: this.model.name,
          onProgress: (progress) => {
            this.download.progress = { percent: progress.percent, received: progress.received, total: progress.total || this.model.sizeBytes };
            this.emit('rag:download', this.status());
          },
        });
        return this.status();
      } finally {
        this.download = null;
        this.emit('rag:download', this.status());
      }
    })();
    return this.download.promise;
  }

  async start() {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const serverPath = this.serverPath();
      if (!serverPath || !this.installed()) throw new Error('The meaning search model is not installed.');
      if (!fs.existsSync(serverPath)) throw new Error(`The llama.cpp engine is missing (${serverPath}). Install it again in Models.`);
      // On the GPU only with room to spare, so the chat model keeps what it needs.
      const freeMB = await this.freeVramMB().catch(() => 0);
      const onGpu = freeMB >= this.model.gpuMB * 2;
      this.device = onGpu ? 'GPU' : 'CPU';
      this.port = await freePort();
      this.apiKey = crypto.randomBytes(16).toString('hex');
      const threads = Math.max(2, Math.floor(require('node:os').cpus().length / 2));
      const args = ['-m', this.file, '--embedding', '--pooling', this.model.pooling, '-c', '8192', '-b', '4096', '-ub', '4096',
        '--parallel', '1', '-t', String(threads), '--host', '127.0.0.1', '--port', String(this.port), '--api-key', this.apiKey,
        ...(onGpu ? ['-ngl', 'all'] : ['-ngl', '0', '-dev', 'none'])];
      const child = spawn(serverPath, args, { cwd: path.dirname(serverPath), windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      this.child = child;
      // Without this, a program that cannot start would crash all of Uma with an error dialog.
      let failure = null;
      child.on('error', (err) => {
        failure = err;
        if (this.child === child) this.child = null;
      });
      child.on('exit', () => { if (this.child === child) this.child = null; });
      for (let attempt = 0; attempt < 240; attempt += 1) {
        await sleep(250);
        if (failure) throw new Error(`The meaning search engine could not start: ${failure.message}`);
        if (this.child !== child) throw new Error('The meaning search engine stopped while starting.');
        try {
          const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(2000) });
          if (response.ok) return;
        } catch {}
      }
      this.stop();
      throw new Error('The meaning search engine did not start.');
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  stop() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.child = null;
    this.device = '';
    if (!child) return;
    try {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill();
    } catch {}
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  /** Vectors (normalized) for texts; kind 'query' or 'document' picks the model's prompt. */
  async embed(texts, kind = 'document') {
    if (!texts.length) return [];
    await this.start();
    this.touch();
    const format = kind === 'query' ? this.model.query : this.model.document;
    const out = [];
    for (let index = 0; index < texts.length; index += BATCH) {
      const response = await fetch(`http://127.0.0.1:${this.port}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ input: texts.slice(index, index + BATCH).map((text) => format(String(text).slice(0, 6000))) }),
        signal: AbortSignal.timeout(300000),
      });
      if (!response.ok) throw new Error(`Meaning search failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
      const data = await response.json();
      for (const item of data.data || []) out.push(normalize(item.embedding));
    }
    return out;
  }
}

module.exports = { EmbeddingEngine, VectorStore, EMBEDDING_MODEL, textHash, cosine, normalize };
