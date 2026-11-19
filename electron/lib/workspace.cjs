const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { isInside, isProbablyBinary, formatBytes } = require('./util.cjs');

const IGNORED = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  'dist',
  'build',
  'release',
  'out',
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  '.vscode',
  '.claude',
  '.uma',
  '.DS_Store',
  'Thumbs.db',
  '$RECYCLE.BIN',
  'System Volume Information',
  'AppData',
]);

// How long the workspace's file counts are reused, and how many file sizes are read at once.
const STATS_TTL_MS = 60000;
const STAT_BATCH = 64;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif']);

function languageFor(file) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === '.gitignore' || base === '.env') return 'text';
  const map = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
    '.ts': 'typescript', '.tsx': 'tsx', '.json': 'json', '.md': 'markdown', '.mdx': 'markdown',
    '.css': 'css', '.scss': 'scss', '.html': 'html', '.py': 'python', '.rb': 'ruby',
    '.go': 'go', '.rs': 'rust', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp',
    '.cs': 'csharp', '.php': 'php', '.sh': 'bash', '.bash': 'bash', '.ps1': 'powershell',
    '.yml': 'yaml', '.yaml': 'yaml', '.xml': 'xml', '.sql': 'sql', '.toml': 'ini', '.ini': 'ini',
  };
  return map[ext] || 'text';
}

async function detectBinary(abs, maxBytes = 8192) {
  const handle = await fsp.open(abs, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return isProbablyBinary(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * Read a line range from a file using a bounded streaming scanner.
 * It never loads the whole file, and it never buffers an unbounded line.
 */
async function readLineRange(abs, options = {}) {
  const startLine = Math.max(1, Math.floor(Number(options.startLine) || 1));
  const maxLines = Math.max(1, Math.min(2000, Math.floor(Number(options.maxLines) || 400)));
  const maxChars = Math.max(2000, Math.min(600000, Math.floor(Number(options.maxChars) || 240000)));
  const maxLineChars = Math.max(500, Math.min(20000, Math.floor(Number(options.maxLineChars) || 4000)));
  const endLine = Math.max(startLine, Math.floor(Number(options.endLine) || startLine + maxLines - 1));
  const hardEnd = Math.min(endLine, startLine + maxLines - 1);

  const lines = [];
  let lineNumber = 0;
  let partial = '';
  let lineOverflow = false;
  let usedChars = 0;
  let lastLine = startLine - 1;
  let truncated = false;
  let stopped = false;
  let charsFull = false;

  const append = (segment) => {
    if (lineOverflow) return;
    const room = maxLineChars + 1 - partial.length;
    if (segment.length > room) {
      partial += segment.slice(0, Math.max(0, room));
      lineOverflow = true;
    } else {
      partial += segment;
    }
  };

  const flushLine = () => {
    lineNumber += 1;
    if (lineNumber >= startLine && lineNumber <= hardEnd && lines.length < maxLines && !charsFull) {
      let line = partial;
      if (lineOverflow || line.length > maxLineChars) {
        line = `${line.slice(0, maxLineChars)}…`;
        truncated = true;
      }
      line = line.replace(/\r$/, '');
      // Stop before a line that would not fit, so nextLine is the first line the reader has not seen.
      if (lines.length && usedChars + line.length + 1 > maxChars) {
        charsFull = true;
        truncated = true;
      } else {
        lines.push(line.slice(0, maxChars));
        usedChars += line.length + 1;
        lastLine = lineNumber;
      }
    } else if (lineNumber >= startLine) {
      truncated = true;
    }
    partial = '';
    lineOverflow = false;
  };

  const stream = fs.createReadStream(abs, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf('\n', cursor);
        if (newline === -1) {
          append(chunk.slice(cursor));
          break;
        }
        append(chunk.slice(cursor, newline));
        flushLine();
        cursor = newline + 1;
        if (lineNumber >= hardEnd || lines.length >= maxLines || usedChars >= maxChars || charsFull) {
          stopped = true;
          truncated = true;
          break;
        }
      }
      if (stopped) break;
    }
  } finally {
    stream.destroy();
  }

  if (!stopped && partial.length) flushLine();

  return {
    content: lines.join('\n'),
    startLine,
    endLine: lastLine,
    nextLine: lastLine >= startLine ? lastLine + 1 : startLine,
    lines: lines.length,
    truncated,
  };
}

async function countLines(abs, { maxMs = 10000 } = {}) {
  const started = Date.now();
  let lines = 0;
  let bytes = 0;
  const stream = fs.createReadStream(abs, { highWaterMark: 256 * 1024 });
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] === 10) lines += 1;
      }
      if (Date.now() - started > maxMs) {
        stream.destroy();
        return { lines: null, bytes, timedOut: true };
      }
    }
  } finally {
    stream.destroy();
  }
  return { lines: lines + (bytes > 0 ? 1 : 0), bytes, timedOut: false };
}

async function searchTextFile(abs, needle, options = {}) {
  const context = Math.max(0, Math.min(20, Math.floor(Number(options.context) || 0)));
  const maxResults = Math.max(1, Math.min(300, Math.floor(Number(options.maxResults) || 60)));
  const caseSensitive = Boolean(options.caseSensitive);
  const deadline = Date.now() + Math.max(1000, Math.min(120000, Number(options.timeBudgetMs) || 25000));
  const terms = (options.terms || []).filter(Boolean);
  const needles = terms.length ? terms : [caseSensitive ? needle : needle.toLowerCase()];
  const matches = [];
  let lineNumber = 0;
  let partial = '';
  let lineOverflow = false;
  let bytesScanned = 0;
  let timedOut = false;
  let before = [];
  let pendingAfter = [];

  const append = (segment) => {
    if (lineOverflow) return;
    const room = 4096 - partial.length;
    if (segment.length > room) {
      partial += segment.slice(0, Math.max(0, room));
      lineOverflow = true;
    } else {
      partial += segment;
    }
  };

  const flushLine = () => {
    lineNumber += 1;
    const line = partial.replace(/\r$/, '');
    const trimmed = line.trim().slice(0, 320);
    const haystack = caseSensitive ? line : line.toLowerCase();

    if (pendingAfter.length) {
      for (const match of pendingAfter) {
        if (match.contextAfter.length < context) match.contextAfter.push(trimmed);
      }
      pendingAfter = pendingAfter.filter((match) => match.contextAfter.length < context);
    }

    if (haystack.includes(needles[0])) {
      const match = {
        line: lineNumber,
        preview: trimmed,
        matchedTerm: needles[0],
        contextBefore: before.slice(-context),
        contextAfter: [],
      };
      matches.push(match);
      if (context > 0) pendingAfter.push(match);
    } else if (needles.length > 1) {
      const hit = needles.find((term) => haystack.includes(term));
      if (hit) {
        const match = {
          line: lineNumber,
          preview: trimmed,
          matchedTerm: hit,
          contextBefore: before.slice(-context),
          contextAfter: [],
        };
        matches.push(match);
        if (context > 0) pendingAfter.push(match);
      }
    }
    before.push(trimmed);
    if (before.length > context + 1) before.shift();
    partial = '';
    lineOverflow = false;
  };

  const stream = fs.createReadStream(abs, { encoding: 'utf8', highWaterMark: 256 * 1024 });
  try {
    for await (const chunk of stream) {
      bytesScanned += Buffer.byteLength(chunk);
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf('\n', cursor);
        if (newline === -1) {
          append(chunk.slice(cursor));
          break;
        }
        append(chunk.slice(cursor, newline));
        flushLine();
        cursor = newline + 1;
        if (matches.length >= maxResults && pendingAfter.length === 0) break;
      }
      if (matches.length >= maxResults && pendingAfter.length === 0) break;
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
    }
  } finally {
    stream.destroy();
  }
  if (partial.length && !timedOut) flushLine();

  return {
    matches,
    bytesScanned,
    timedOut,
    truncated: matches.length >= maxResults,
  };
}

class Workspace {
  constructor({ root, trash, unrestricted = false }) {
    this.root = path.resolve(root);
    this.trash = trash;
    this.realRoot = null;
    this.unrestricted = unrestricted;
    this.statsCache = null;
    this.statsPending = null;
    this.statsVersion = 0;
  }

  async init() {
    const stat = await fsp.stat(this.root);
    if (!stat.isDirectory()) throw new Error('The workspace path is not a folder.');
    this.realRoot = await fsp.realpath(this.root);
  }

  get name() {
    return path.basename(this.root) || this.root;
  }

  toRelative(absolute) {
    return path.relative(this.root, absolute).split(path.sep).join('/');
  }

  async resolve(relative = '.', { allowMissing = true } = {}) {
    if (typeof relative !== 'string') throw new Error('A path is required.');
    let cleaned = relative.replace(/\\/g, '/').replace(/\0/g, '').trim();
    if (cleaned.includes('\0')) throw new Error('Invalid path.');
    // The workspace's own full path, or one inside it, is the same place as the relative one: a
    // model reads that path in its instructions and gives it back (as the folder to run a command
    // in, for one). Every check below still applies to it.
    if (!this.unrestricted && (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) && isInside(path.resolve(cleaned), this.root)) {
      cleaned = path.relative(this.root, path.resolve(cleaned)).split(path.sep).join('/') || '.';
    }
    // So is the workspace's own name in front of a path: asked for a page inside "my-site", a model
    // wrote my-site/index.html, and the page landed in a new folder my-site inside my-site. Unless
    // such a folder is really there, the name means the workspace.
    if (!this.unrestricted) {
      const [first, ...rest] = cleaned.split('/').filter((part) => part && part !== '.');
      if (rest.length && first.toLowerCase() === path.basename(this.root).toLowerCase() && !(await fsp.stat(path.join(this.root, first)).catch(() => null))) {
        cleaned = rest.join('/');
      }
    }

    if (this.unrestricted) {
      if (!cleaned || cleaned === '.') return this.root;
      if (/^[a-zA-Z]:$/.test(cleaned)) return path.resolve(`${cleaned}\\`);
      return path.resolve(this.root, cleaned);
    }

    if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
      throw new Error('Use a path relative to the workspace, not an absolute path.');
    }
    const abs = path.resolve(this.root, cleaned || '.');
    if (!isInside(abs, this.root)) throw new Error('That path is outside the chosen workspace.');
    if (abs === this.root && !allowMissing) return abs;

    // Resolve the nearest existing ancestor so symlinks cannot escape the workspace.
    let probe = abs;
    while (true) {
      try {
        await fsp.lstat(probe);
        break;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    const realProbe = await fsp.realpath(probe).catch(() => probe);
    if (!isInside(realProbe, this.realRoot || this.root)) {
      throw new Error('That path resolves outside the chosen workspace.');
    }
    try {
      const real = await fsp.realpath(abs);
      if (!isInside(real, this.realRoot || this.root)) {
        throw new Error('That path resolves outside the chosen workspace.');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return abs;
  }

  async info() {
    const stats = await this.stats();
    return {
      path: this.root,
      name: this.name,
      exists: true,
      stats,
    };
  }

  /**
   * File and folder counts for the workspace. Walking a large folder takes seconds, and this is
   * asked for on every message (it is part of the prompt) and every time the window refreshes, so
   * the result is kept for a minute and dropped as soon as Uma itself changes a file.
   */
  async stats({ fresh = false } = {}) {
    if (!fresh && this.statsCache && Date.now() - this.statsCache.at < STATS_TTL_MS) return this.statsCache.value;
    if (!this.statsPending) {
      const version = this.statsVersion;
      this.statsPending = this.measure()
        .then((value) => {
          // A change made while the walk ran leaves the result out of date, so it is not kept.
          if (version === this.statsVersion) this.statsCache = { at: Date.now(), value };
          return value;
        })
        .finally(() => { this.statsPending = null; });
    }
    return this.statsPending;
  }

  /** Call after anything changes files in the workspace. */
  invalidateStats() {
    this.statsCache = null;
    this.statsVersion += 1;
  }

  async measure() {
    let files = 0;
    let folders = 0;
    let bytes = 0;
    let truncated = false;
    const deadline = Date.now() + 3500;

    const walk = async (dir, depth) => {
      if (depth > 8) return;
      if (Date.now() > deadline) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const subfolders = [];
      const fileNames = [];
      for (const entry of entries) {
        if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) subfolders.push(entry.name);
        else if (entry.isFile()) fileNames.push(entry.name);
      }
      // Sizes are read many at a time: one at a time, a 20,000-file folder took the whole time limit.
      for (let index = 0; index < fileNames.length; index += STAT_BATCH) {
        if (Date.now() > deadline || files + folders > 20000) {
          truncated = true;
          return;
        }
        const batch = fileNames.slice(index, index + STAT_BATCH);
        const stats = await Promise.all(batch.map((name) => fsp.stat(path.join(dir, name)).catch(() => null)));
        files += batch.length;
        for (const stat of stats) if (stat) bytes += stat.size;
      }
      for (const name of subfolders) {
        if (Date.now() > deadline || files + folders > 20000) {
          truncated = true;
          return;
        }
        folders += 1;
        await walk(path.join(dir, name), depth + 1);
      }
    };
    await walk(this.root, 0);
    return { files, folders, bytes, truncated, label: formatBytes(bytes) };
  }

  async tree({ depth = 4, maxNodes = 700, relative = '.' } = {}) {
    const start = await this.resolve(relative);
    const startStat = await fsp.stat(start).catch(() => null);
    if (startStat?.isFile()) {
      return {
        nodes: [{
          name: path.basename(start),
          path: this.toRelative(start),
          type: 'file',
          size: startStat.size,
          ext: path.extname(start).toLowerCase(),
          modified: startStat.mtime.toISOString(),
        }],
        truncated: false,
        root: this.root,
        name: this.name,
      };
    }
    const state = { count: 0, truncated: false };
    const walk = async (dir, level) => {
      if (level >= depth || state.count >= maxNodes) {
        state.truncated = state.truncated || state.count >= maxNodes;
        return [];
      }
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
      const nodes = [];
      for (const entry of entries) {
        if (IGNORED.has(entry.name) || entry.name.startsWith('.~')) continue;
        if (state.count >= maxNodes) {
          state.truncated = true;
          break;
        }
        const abs = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        state.count += 1;
        const rel = this.toRelative(abs);
        if (entry.isDirectory()) {
          const children = level + 1 < depth ? await walk(abs, level + 1) : [];
          nodes.push({
            name: entry.name,
            path: rel,
            type: 'folder',
            children,
          });
        } else if (entry.isFile()) {
          const stat = await fsp.stat(abs).catch(() => null);
          nodes.push({
            name: entry.name,
            path: rel,
            type: 'file',
            size: stat?.size || 0,
            modified: stat?.mtime?.toISOString() || '',
            ext: path.extname(entry.name).toLowerCase(),
          });
        }
      }
      return nodes;
    };
    const nodes = await walk(start, 0);
    return { nodes, truncated: state.truncated, root: this.root, name: this.name };
  }

  async readFile(relative, { maxBytes = 2 * 1024 * 1024 } = {}) {
    const abs = await this.resolve(relative);
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw new Error('That path is not a file.');
    if (stat.size > maxBytes) {
      throw new Error(`File is too large for the editor (${formatBytes(stat.size)}). The AI can read a line range or search it with read_file / search_files.`);
    }
    const buffer = await fsp.readFile(abs);
    const binary = isProbablyBinary(buffer);
    const ext = path.extname(abs).toLowerCase();
    // Older source files are often Windows-1252, not UTF-8. Read as UTF-8, every accented letter in
    // them becomes U+FFFD, and writing the file back would destroy them all. Such a file is read as
    // latin1 instead, which keeps each byte as one character, so it can be written back unchanged.
    const utf8 = binary ? '' : buffer.toString('utf8');
    const legacy = !binary && utf8.includes(String.fromCharCode(0xFFFD)) && !Buffer.from(utf8, 'utf8').equals(buffer);
    return {
      path: this.toRelative(abs),
      name: path.basename(abs),
      size: stat.size,
      modified: stat.mtime.toISOString(),
      binary,
      image: IMAGE_EXTENSIONS.has(ext),
      ext,
      language: languageFor(abs),
      encoding: legacy ? 'latin1' : 'utf8',
      content: legacy ? buffer.toString('latin1') : utf8,
    };
  }

  /**
   * Streaming, range-based text reading for arbitrarily large files.
   * This is what the agent uses; it never needs to fit the whole file in RAM.
   */
  async readFileRange(relative, options = {}) {
    const abs = await this.resolve(relative);
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw new Error('That path is not a file.');
    if (await detectBinary(abs)) {
      return {
        path: this.toRelative(abs),
        name: path.basename(abs),
        size: stat.size,
        modified: stat.mtime.toISOString(),
        binary: true,
        content: '',
      };
    }
    const range = await readLineRange(abs, options);
    return {
      path: this.toRelative(abs),
      name: path.basename(abs),
      size: stat.size,
      modified: stat.mtime.toISOString(),
      binary: false,
      language: languageFor(abs),
      ...range,
    };
  }

  async fileInfo(relative) {
    const abs = await this.resolve(relative);
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) {
      return {
        path: this.toRelative(abs),
        name: path.basename(abs),
        type: 'folder',
        modified: stat.mtime.toISOString(),
      };
    }
    const binary = await detectBinary(abs);
    const counted = binary ? { lines: null, timedOut: false } : await countLines(abs);
    return {
      path: this.toRelative(abs),
      name: path.basename(abs),
      size: stat.size,
      sizeLabel: formatBytes(stat.size),
      modified: stat.mtime.toISOString(),
      ext: path.extname(abs).toLowerCase(),
      language: languageFor(abs),
      binary,
      lines: counted.lines,
      lineCountTimedOut: counted.timedOut,
    };
  }

  async exists(relative) {
    try {
      const abs = await this.resolve(relative);
      await fsp.stat(abs);
      return true;
    } catch {
      return false;
    }
  }

  async preview(relative) {
    const abs = await this.resolve(relative);
    const stat = await fsp.stat(abs);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return null;
    const ext = path.extname(abs).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return null;
    const mime = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
    }[ext] || 'application/octet-stream';
    const buffer = await fsp.readFile(abs);
    return `data:${mime};base64,${buffer.toString('base64')}`;
  }

  /** `encoding` is 'latin1' only when writing back a file that readFile reported as latin1. */
  async writeFile(relative, content, { encoding = 'utf8' } = {}) {
    const abs = await this.resolve(relative);
    if (abs === this.root) throw new Error('Cannot write to the workspace root.');
    if (Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) {
      throw new Error('Refusing to write a file larger than 5 MB.');
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content ?? '', encoding === 'latin1' ? 'latin1' : 'utf8');
    this.invalidateStats();
    const stat = await fsp.stat(abs);
    return { path: this.toRelative(abs), size: stat.size, lines: String(content ?? '').split('\n').length };
  }

  /** Appends in place, so it works on any file size and can never lose existing content. */
  async appendFile(relative, content) {
    const abs = await this.resolve(relative);
    if (abs === this.root) throw new Error('Cannot write to the workspace root.');
    if (Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) {
      throw new Error('Refusing to append more than 5 MB at once.');
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const stat = await fsp.stat(abs).catch(() => null);
    let separator = '';
    if (stat?.size) {
      if (!stat.isFile()) throw new Error('That path is not a file.');
      if (await detectBinary(abs)) throw new Error('Cannot append to a binary file.');
      const handle = await fsp.open(abs, 'r');
      try {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, stat.size - 1);
        if (last[0] !== 10) separator = '\n';
      } finally {
        await handle.close();
      }
    }
    await fsp.appendFile(abs, `${separator}${content}`, 'utf8');
    this.invalidateStats();
    const after = await fsp.stat(abs);
    return { path: this.toRelative(abs), size: after.size };
  }

  async createFile(relative, content = '') {
    const abs = await this.resolve(relative);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const handle = await fsp.open(abs, 'wx');
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    this.invalidateStats();
    return { path: this.toRelative(abs) };
  }

  async createFolder(relative) {
    const abs = await this.resolve(relative);
    if (abs === this.root) return { path: '.' };
    await fsp.mkdir(abs, { recursive: true });
    this.invalidateStats();
    return { path: this.toRelative(abs) };
  }

  async renameFile(from, to) {
    const source = await this.resolve(from);
    const destination = await this.resolve(to);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.rename(source, destination);
    this.invalidateStats();
    return { from: this.toRelative(source), to: this.toRelative(destination) };
  }

  async deleteFile(relative) {
    const abs = await this.resolve(relative);
    if (abs === this.root) throw new Error('Cannot delete the workspace root.');
    await this.trash(abs);
    this.invalidateStats();
    return { path: this.toRelative(abs) };
  }

  async search(query, options = {}) {
    const needle = String(query || '');
    if (!needle) return { matches: [], filesScanned: 0, bytesScanned: 0, truncated: false, timedOut: false };
    const maxResults = Math.max(1, Math.min(300, Number(options.maxResults) || 60));
    const context = Math.max(0, Math.min(5, Number(options.context) || 0));
    const maxFileBytes = Math.max(1024 * 1024, Number(options.maxFileBytes) || 2 * 1024 * 1024 * 1024);
    const timeBudgetMs = Math.max(1000, Math.min(120000, Number(options.timeBudgetMs) || 25000));
    const deadline = Date.now() + timeBudgetMs;
    const caseSensitive = Boolean(options.caseSensitive);
    const rawTerms = [...new Set((needle.match(/[A-Za-z0-9_]{2,}/g) || []).map((term) => (caseSensitive ? term : term.toLowerCase())))];
    const searchTerms = rawTerms.length > 1 ? rawTerms : [];
    const matches = [];
    let filesScanned = 0;
    let filesSkipped = 0;
    let bytesScanned = 0;
    let truncated = false;
    let timedOut = false;

    const searchOne = async (abs) => {
      if (matches.length >= maxResults || Date.now() > deadline) return;
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat || stat.size === 0 || stat.size > maxFileBytes) {
        if (stat && stat.size > maxFileBytes) filesSkipped += 1;
        return;
      }
      if (await detectBinary(abs)) {
        filesSkipped += 1;
        return;
      }
      filesScanned += 1;
      const remainingTime = Math.max(800, deadline - Date.now());
      const result = await searchTextFile(abs, needle, {
        context,
        maxResults: maxResults - matches.length,
        caseSensitive,
        timeBudgetMs: remainingTime,
        terms: searchTerms,
      });
      bytesScanned += result.bytesScanned;
      timedOut = timedOut || result.timedOut;
      truncated = truncated || result.truncated;
      for (const match of result.matches) {
        matches.push({ path: this.toRelative(abs), ...match });
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
      }
    };

    const start = await this.resolve(options.path || '.');
    const startStat = await fsp.stat(start);
    if (startStat.isFile()) {
      await searchOne(start);
    } else {
      const walk = async (dir, depth) => {
        if (depth > 14 || matches.length >= maxResults || Date.now() > deadline) return;
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        entries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        for (const entry of entries) {
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }
          if (Date.now() > deadline) {
            timedOut = true;
            return;
          }
          if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(abs, depth + 1);
          } else if (entry.isFile()) {
            await searchOne(abs);
          }
        }
      };
      await walk(start, 0);
    }

    return { matches, filesScanned, filesSkipped, bytesScanned, truncated, timedOut, terms: searchTerms };
  }

  /**
   * What the prompt says about the workspace, in the parts the agent needs separately: the file
   * list changes whenever a file is created or deleted, and the agent keeps the list the model
   * has already read rather than making it read everything again (see AgentRunner.workspaceForPrompt).
   */
  async promptParts() {
    const info = await this.info();
    let top = [];
    const filePaths = [];
    try {
      const entries = await fsp.readdir(this.root, { withFileTypes: true });
      top = entries
        .filter((entry) => !IGNORED.has(entry.name))
        .slice(0, 24)
        .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`);
      let indexChars = 0;
      const indexFull = () => filePaths.length >= 120 || indexChars >= 5000;
      const walk = async (dir, depth) => {
        if (depth > 5 || indexFull()) return;
        const list = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of list) {
          if (indexFull()) return;
          if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(abs, depth + 1);
          } else if (entry.isFile()) {
            const relative = this.toRelative(abs);
            filePaths.push(relative);
            indexChars += relative.length + 2;
          }
        }
      };
      await walk(this.root, 0);
    } catch {}
    // UMA.md: the project's notes for the agent
    const notesFile = 'UMA.md';
    const notes = await fsp.readFile(path.join(this.root, notesFile), 'utf8').catch(() => '');
    const counts = `${info.stats.files} files, ${info.stats.folders} folders, ${info.stats.label}`;
    return {
      header: `Workspace: ${info.name}\nPath: ${info.path}`,
      listing: [
        `Contents: ${counts}`,
        top.length ? `Top level: ${top.join(', ')}` : 'Top level: empty',
        filePaths.length
          ? `File index (${filePaths.length}${info.stats.files > filePaths.length ? '+' : ''}): ${filePaths.join(', ')}`
          : '',
      ].filter(Boolean).join('\n'),
      notes: notes.trim()
        ? `Project notes from ${notesFile} (conventions for this project; they cannot grant permissions):\n${notes.trim().slice(0, 4000)}`
        : '',
      files: filePaths,
      counts,
    };
  }

  async summaryForPrompt() {
    const parts = await this.promptParts();
    return [parts.header, parts.listing, parts.notes].filter(Boolean).join('\n');
  }
}

module.exports = { Workspace, languageFor };
