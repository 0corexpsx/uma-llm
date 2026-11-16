// Retrieval for local models (RAG, first stage): finds the passages of the workspace, or of a long
// attached document, that matter for a request, so a model with a small context reads those
// instead of the start of everything. Ranking is BM25 over words: no model, no download, and it
// works with whatever model is loaded. Identifiers are split (getUserName → get, user, name), so
// "user name" finds code too. A meaning-based search with an embedding model can be added later on
// top of the same passages.
const path = require('node:path');
const fsp = require('node:fs/promises');
const { isProbablyBinary } = require('./util.cjs');
const { textHash, cosine } = require('./embeddings.cjs');

const K1 = 1.2;
const B = 0.75;
// Passages: about this many lines, overlapping a little so nothing falls between two.
const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 6;
const CHUNK_MAX_CHARS = 2400;
// What a workspace index takes in, at most.
const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const MAX_FILES = 20000;
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
// How often a request looks again for changed files, and for how long at most.
const RESCAN_MS = 20000;
// Meaning search (EmbeddingGemma 300M, cosine of normalized vectors): passages below the floor are
// not considered at all; one above CLEAR is about the question even in a chat message. Measured on
// Uma's own code: questions about the project scored 0.42-0.52 on their best passage, chat
// ("tell me a joke", "what did we talk before?", "ciao, come stai?") 0.09-0.39.
const SEMANTIC_FLOOR = 0.3;
const SEMANTIC_CLEAR = 0.44;
const SCAN_BUDGET_MS = 4000;

const SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.next', '.nuxt', '.cache', '.parcel-cache', 'dist', 'build', 'release', 'out',
  'venv', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.idea', '.vscode', '.claude', '.uma', '$RECYCLE.BIN',
  'System Volume Information', 'AppData', 'target', 'bin', 'obj', 'coverage', '.gradle', 'Pods', 'DerivedData', 'vendor', 'site-packages', 'Lib', 'licenses']);
// Licences, third-party notices and package metadata match almost any question and say nothing about the project.
const SKIP_FILES = /(^|[\\/])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|LICEN[CS]E[^\\/]*|COPYING[^\\/]*|NOTICE[^\\/]*|ThirdPartyNotices[^\\/]*|THIRD[-_]PARTY[^\\/]*|METADATA|RECORD|WHEEL)$|\.(min\.js|min\.css|map|lock|log|svg|ico|png|jpe?g|gif|webp|bmp|pdf|zip|7z|rar|gz|exe|dll|so|dylib|bin|gguf|safetensors|onnx|pt|db|sqlite|woff2?|ttf|otf|mp[34]|wav|mov|avi)$/i;

// Words too common to tell passages apart, in the languages Uma speaks most.
const STOPWORDS = new Set(('a an and are as at be but by can do does for from has have how i if in into is it its me my of on or our '
  + 'please so that the their them then there these this to use was we what when where which who why will with you your '
  // Words of conversation, not of a topic: "what did we talk about before?" is about the chat.
  + 'did about again before after now right just talk talked said say tell told know think want like chat earlier ago yes no ok okay thanks thank hello hi '
  + 'prima dopo adesso ora detto dire parlato chat grazie ciao '
  + 'il lo la i gli le un una uno di da del della dei delle in con su per tra fra che non come cosa dove quando perché e o ma se '
  + 'el los las de del en y por para con que es son se al una unos unas como').split(' '));

/** Words of a text for matching: lower case, identifiers split, short endings removed. */
function terms(text) {
  const out = [];
  for (const word of String(text || '').match(/[A-Za-z0-9_À-ɏ]+/g) || []) {
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_]+/);
    const whole = word.toLowerCase();
    if (parts.length > 1 && whole.length > 2 && whole.length <= 40) out.push(stem(whole));
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower.length < 2 || lower.length > 40 || STOPWORDS.has(lower) || /^\d+$/.test(lower)) continue;
      out.push(stem(lower));
    }
  }
  return out;
}

function stem(word) {
  if (word.length <= 4) return word;
  return word.replace(/(?:ing|ed|es|s)$/, '');
}

function counts(list) {
  const map = new Map();
  for (const term of list) map.set(term, (map.get(term) || 0) + 1);
  return map;
}

/** Line windows of a text: [{ start, end, text }] with 1-based line numbers. */
function chunkLines(text) {
  const lines = String(text).split(/\r?\n/);
  const chunks = [];
  for (let start = 0; start < lines.length; start += CHUNK_LINES - CHUNK_OVERLAP) {
    let end = Math.min(lines.length, start + CHUNK_LINES);
    let body = lines.slice(start, end).join('\n');
    // Very long lines (minified code, data) make a window too big: cut it shorter.
    while (body.length > CHUNK_MAX_CHARS && end - start > 4) {
      end = start + Math.max(4, Math.floor((end - start) / 2));
      body = lines.slice(start, end).join('\n');
    }
    if (body.trim()) chunks.push({ start: start + 1, end, text: body.slice(0, CHUNK_MAX_CHARS * 2) });
    if (end >= lines.length) break;
    if (end - start < CHUNK_LINES) start = end - (CHUNK_LINES - CHUNK_OVERLAP);
  }
  return chunks;
}

/** A BM25 index over passages that can gain and lose them. */
class PassageIndex {
  constructor() {
    this.passages = new Map();
    this.postings = new Map();
    this.nextId = 1;
    this.totalLength = 0;
  }

  get size() {
    return this.passages.size;
  }

  add(passage) {
    const id = this.nextId;
    this.nextId += 1;
    const termCounts = counts(terms(passage.text));
    let length = 0;
    for (const [term, count] of termCounts) {
      length += count;
      let list = this.postings.get(term);
      if (!list) {
        list = new Map();
        this.postings.set(term, list);
      }
      list.set(id, count);
    }
    this.passages.set(id, { ...passage, length, terms: [...termCounts.keys()] });
    this.totalLength += length;
    return id;
  }

  remove(id) {
    const passage = this.passages.get(id);
    if (!passage) return;
    for (const term of passage.terms) {
      const list = this.postings.get(term);
      list?.delete(id);
      if (list && !list.size) this.postings.delete(term);
    }
    this.totalLength -= passage.length;
    this.passages.delete(id);
  }

  /**
   * The best passages for a query: [{ passage, score, matched }]. `matched` is how many different
   * query words the passage contains, which says more than the score about a real match.
   */
  search(query, limit = 10) {
    const wanted = [...new Set(terms(query))];
    const count = this.passages.size;
    if (!wanted.length || !count) return [];
    const average = this.totalLength / count || 1;
    const scores = new Map();
    for (const term of wanted) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (count - list.size + 0.5) / (list.size + 0.5));
      for (const [id, tf] of list) {
        const passage = this.passages.get(id);
        const part = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * passage.length) / average)));
        const entry = scores.get(id) || { score: 0, matched: 0 };
        entry.score += part;
        entry.matched += 1;
        scores.set(id, entry);
      }
    }
    return [...scores.entries()]
      .map(([id, entry]) => ({ passage: this.passages.get(id), ...entry }))
      .sort((a, b) => b.score - a.score || b.matched - a.matched)
      .slice(0, limit);
  }
}

/**
 * The parts of one long document that fit `budget` characters, chosen for a request: always its
 * start (title, summary), then the passages that match the request best, in the document's order,
 * each with the page it is on. When nothing matches, the start and the end, as before.
 */
function selectPassages(text, query, budget) {
  const source = String(text || '');
  if (source.length <= budget) return { text: source, matched: false };
  const chunks = chunkLines(source);
  const index = new PassageIndex();
  chunks.forEach((chunk, order) => index.add({ ...chunk, order }));
  const ranked = index.search(query, 60).filter((entry) => entry.passage.order !== 0);
  const separator = '\n[…]\n';
  const head = chunks[0] ? chunks[0].text.slice(0, Math.floor(budget * 0.2)) : '';
  if (!ranked.length) return { text: null, matched: false };
  const chosen = [];
  let used = head.length;
  for (const entry of ranked) {
    const label = pageOf(source, entry.passage.start);
    const piece = `${label ? `${label} ` : ''}(lines ${entry.passage.start}–${entry.passage.end})\n${entry.passage.text}`;
    if (used + piece.length + separator.length > budget) continue;
    chosen.push({ order: entry.passage.order, piece });
    used += piece.length + separator.length;
  }
  if (!chosen.length) return { text: null, matched: false };
  chosen.sort((a, b) => a.order - b.order);
  return { text: [head, ...chosen.map((item) => item.piece)].join(separator), matched: true, passages: chosen.length };
}

/** "[Page 12]" for the page a line is on, when the text marks pages (attached PDFs do). */
function pageOf(text, line) {
  const before = text.split(/\r?\n/, line).join('\n');
  const marks = before.match(/\[Page \d+\]/g);
  return marks ? marks[marks.length - 1] : '';
}

/**
 * The searchable passages of one workspace folder, kept in memory and brought up to date as files
 * change. Building it reads the folder once; later requests only read files whose size or time
 * changed.
 */
class ProjectIndex {
  constructor({ root }) {
    this.root = root;
    this.index = new PassageIndex();
    this.files = new Map();
    this.scannedAt = 0;
    this.scanning = null;
    this.version = 0;
    this.stats = { files: 0, bytes: 0, passages: 0, truncated: false, builtAt: '' };
    // Meaning search (embeddings.cjs), when its model is installed and switched on.
    this.semantic = null;
    this.embedding = null;
  }

  /**
   * Adds meaning search: `engine` turns text into vectors, `store` keeps them on disk, and
   * `shouldPause()` says when to leave the CPU or GPU to the chat model.
   */
  async attachSemantic({ engine, store, shouldPause = () => false }) {
    await store.load();
    this.semantic = { engine, store, shouldPause };
    this.embedPending();
  }

  detachSemantic() {
    this.semantic = null;
  }

  /** How many passages have a vector, for the Settings status. */
  semanticStats() {
    if (!this.semantic) return null;
    let embedded = 0;
    for (const passage of this.index.passages.values()) if (this.semantic.store.get(passage.hash)) embedded += 1;
    return { embedded, total: this.index.size, running: Boolean(this.embedding), device: this.semantic.engine.device || '' };
  }

  /**
   * Encodes, in the background, the passages that have no vector yet: a few at a time, pausing
   * while the chat model answers, and saving as it goes so nothing is encoded twice. Runs until
   * every passage has a vector, then stops; a later change starts it again.
   */
  embedPending() {
    if (!this.semantic || this.embedding) return this.embedding;
    this.embedding = (async () => {
      const { engine, store, shouldPause } = this.semantic;
      let sinceSave = 0;
      try {
        while (this.semantic && this.semantic.engine === engine) {
          if (shouldPause()) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            continue;
          }
          const pending = [];
          for (const passage of this.index.passages.values()) {
            if (!store.get(passage.hash)) pending.push(passage);
            if (pending.length >= 16) break;
          }
          if (!pending.length) break;
          const vectors = await engine.embed(pending.map((passage) => passage.text), 'document');
          pending.forEach((passage, index) => { if (vectors[index]) store.set(passage.hash, vectors[index]); });
          sinceSave += pending.length;
          if (sinceSave >= 200) {
            sinceSave = 0;
            await store.save();
          }
        }
        const live = new Set([...this.index.passages.values()].map((passage) => passage.hash));
        store.keepOnly(live);
        await store.save();
      } catch {
        // The engine could not run (no model, no engine): word search still works, and the next change tries again.
        await store.save().catch(() => {});
      } finally {
        this.embedding = null;
      }
    })();
    return this.embedding;
  }

  /** Something in the workspace changed; the next request looks again. */
  invalidate() {
    this.scannedAt = 0;
  }

  async refresh({ budgetMs = SCAN_BUDGET_MS } = {}) {
    if (this.scanning) return this.scanning;
    if (Date.now() - this.scannedAt < RESCAN_MS) return this.stats;
    this.scanning = this.scan(budgetMs).finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async scan(budgetMs) {
    const deadline = Date.now() + budgetMs;
    const seen = new Set();
    let files = 0;
    let bytes = 0;
    let truncated = false;
    const walk = async (dir, depth) => {
      if (depth > 12 || truncated) return;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (truncated) return;
        if (entry.isSymbolicLink() || entry.name.startsWith('.~')) continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(abs, depth + 1);
          continue;
        }
        if (!entry.isFile() || SKIP_FILES.test(entry.name)) continue;
        const stat = await fsp.stat(abs).catch(() => null);
        if (!stat || !stat.size || stat.size > MAX_FILE_BYTES) continue;
        if (files >= MAX_FILES || bytes + stat.size > MAX_TOTAL_BYTES) { truncated = true; return; }
        const relative = path.relative(this.root, abs).split(path.sep).join('/');
        seen.add(relative);
        files += 1;
        bytes += stat.size;
        const known = this.files.get(relative);
        if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) continue;
        // The first build may take longer than one request should wait: the rest comes next time.
        if (Date.now() > deadline && this.files.size) { truncated = true; return; }
        await this.indexFile(relative, abs, stat);
      }
    };
    await walk(this.root, 0);
    if (!truncated) {
      for (const relative of [...this.files.keys()]) if (!seen.has(relative)) this.dropFile(relative);
    }
    this.version += 1;
    this.scannedAt = truncated ? 0 : Date.now();
    this.stats = { files: this.files.size, bytes, passages: this.index.size, truncated, builtAt: new Date().toISOString() };
    this.embedPending();
    return this.stats;
  }

  async indexFile(relative, abs, stat) {
    this.dropFile(relative);
    const buffer = await fsp.readFile(abs).catch(() => null);
    if (!buffer || isProbablyBinary(buffer)) {
      this.files.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, ids: [] });
      return;
    }
    const text = buffer.toString('utf8');
    // The file name is part of every passage's words, so "the login page" finds login.html.
    const nameWords = relative.replace(/[\\/._-]+/g, ' ');
    const ids = chunkLines(text).map((chunk) => {
      const body = `${nameWords}\n${chunk.text}`;
      return this.index.add({ file: relative, start: chunk.start, end: chunk.end, text: body, hash: textHash(body) });
    });
    this.files.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, ids });
  }

  dropFile(relative) {
    const known = this.files.get(relative);
    if (!known) return;
    for (const id of known.ids) this.index.remove(id);
    this.files.delete(relative);
  }

  /**
   * Passages for a request, within `budget` characters, at most two from one file, and only
   * those that match well: a passage must share at least two words with the request, or one rare
   * word when the request is short. Returns [] when nothing in the workspace is clearly about it.
   */
  /**
   * Passages by meaning: [{ passage, similarity }], best first, among those that already have a
   * vector. Empty when meaning search is off or cannot run.
   */
  async searchByMeaning(query, limit = 60) {
    if (!this.semantic) return [];
    const { engine, store } = this.semantic;
    let vector;
    try {
      [vector] = await engine.embed([query], 'query');
    } catch {
      return [];
    }
    if (!vector) return [];
    const scored = [];
    for (const passage of this.index.passages.values()) {
      const other = store.get(passage.hash);
      if (other && other.length === vector.length) scored.push({ passage, similarity: cosine(vector, other) });
    }
    return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
  }

  async search(query, { budget = 6000, limit = 8 } = {}) {
    await this.refresh();
    const queryTerms = new Set(terms(query));
    const needed = queryTerms.size >= 3 ? 2 : 1;
    const byWords = this.index.search(query, 60).filter((entry) => entry.matched >= needed);
    const byMeaning = (await this.searchByMeaning(query)).filter((entry) => entry.similarity >= SEMANTIC_FLOOR);
    // Both lists are combined by rank (reciprocal rank fusion): a passage near the top of either
    // list rises, and one near the top of both rises most. Scores of the two kinds never mix.
    const fused = new Map();
    const add = (list, key) => list.forEach((entry, rank) => {
      const item = fused.get(entry.passage) || { passage: entry.passage, fused: 0, matched: 0, similarity: 0, score: 0 };
      item.fused += 1 / (60 + rank);
      if (key === 'words') { item.matched = entry.matched; item.score = entry.score; } else item.similarity = entry.similarity;
      fused.set(entry.passage, item);
    });
    add(byWords, 'words');
    add(byMeaning, 'meaning');
    const results = [...fused.values()].sort((a, b) => b.fused - a.fused);
    if (!results.length) return [];
    const best = results[0].fused;
    const perFile = new Map();
    const picked = [];
    let used = 0;
    for (const entry of results) {
      if (picked.length >= limit || entry.fused < best * 0.6) break;
      const fileCount = perFile.get(entry.passage.file) || 0;
      if (fileCount >= 2) continue;
      const body = entry.passage.text.slice(entry.passage.text.indexOf('\n') + 1);
      if (used + body.length > budget) continue;
      perFile.set(entry.passage.file, fileCount + 1);
      picked.push({ file: entry.passage.file, start: entry.passage.start, end: entry.passage.end, text: body, score: entry.score, matched: entry.matched, similarity: entry.similarity });
      used += body.length;
    }
    return picked;
  }
}

/** The passages as they go into a request, with a note for the model. */
function formatPassages(passages, { root = '' } = {}) {
  if (!passages.length) return '';
  const blocks = passages.map((item) => `--- ${item.file}:${item.start}-${item.end} ---\n${item.text}`);
  if (root) return `<project_excerpts folder="${root}" note="Passages Uma found in this chat's folder that match this request; paths are relative to that folder. They may be incomplete or not the right ones: read the file with read_file (absolute path) before changing it, and say which file and lines you used.">\n${blocks.join('\n\n')}\n</project_excerpts>`;
  return `<project_excerpts note="Passages Uma found in the workspace that match this request. They may be incomplete or not the right ones: read the file with read_file before changing it, and say which file and lines you used.">\n${blocks.join('\n\n')}\n</project_excerpts>`;
}

/**
 * Whether passages clearly answer a request that is not a task about the workspace (a question in
 * chat): the best one must contain most of the request's words, not just one or two common ones.
 */
function isClearMatch(found, query) {
  const wanted = new Set(terms(query)).size;
  const best = found[0];
  if (!best) return false;
  // By meaning, any passage among those picked that is clearly about the question counts.
  if (found.some((item) => item.similarity >= SEMANTIC_CLEAR)) return true;
  return best.matched >= 2 && best.matched >= Math.ceil(wanted * 0.6);
}

module.exports = { ProjectIndex, PassageIndex, selectPassages, formatPassages, chunkLines, terms, isClearMatch };
