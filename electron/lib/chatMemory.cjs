// Chat memory: what the engine has already read of each conversation, saved to disk (llama.cpp
// slot save), so going back to a chat after a restart, an idle unload or another chat continues in
// seconds instead of reading the whole conversation again. One file per conversation, all of them
// together kept under a limit (50 GB unless changed in Settings → Chat memory).
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { t } = require('./i18n.cjs');

const GB = 1024 * 1024 * 1024;
const DEFAULT_LIMIT_GB = 50;
// Below this much free disk space the user is warned (once per run of the app).
const LOW_DISK_BYTES = 20 * GB;
// Never fill the disk completely: a save that would leave less than this is skipped.
const DISK_RESERVE_BYTES = 2 * GB;
const INDEX = 'index.json';
// The only files Uma ever removes from the folder: its own (the folder may be one the user chose).
const OWN_FILE = /^(chat-[A-Za-z0-9_-]+\.bin|uma-last\.(bin|json)|index\.json\.tmp)$/;
// The folder made inside a folder the user picks, so Uma's files never mix with theirs.
const FOLDER_NAME = 'Uma LLM chat memory';

/** llama.cpp only accepts plain file names: letters, digits, '-', '_' and '.'. */
function fileFor(conversationId) {
  return `chat-${String(conversationId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}.bin`;
}

async function diskFreeBytes(dir) {
  const stats = await fsp.statfs(dir).catch(() => null);
  return stats ? stats.bavail * stats.bsize : Infinity;
}

class ChatMemory {
  /**
   * `getSettings()` gives chatMemoryLimitGB and chatMemoryOverLimit ('ask' | 'overwrite' | 'continue');
   * `ask(kind, info)` asks the user ('limit' → 'continue' | 'overwrite'; 'disk' → anything) and
   * `setOverLimit(mode)` stores the answer.
   */
  constructor({ dir, defaultDir = dir, getSettings = () => ({}), setOverLimit = async () => {}, ask = async () => null, freeBytes = diskFreeBytes, titleOf = async () => '' }) {
    this.dir = dir;
    this.defaultDir = defaultDir;
    // Set when the folder cannot be used (a drive that is not connected): nothing is saved.
    this.unavailable = '';
    this.getSettings = getSettings;
    this.setOverLimit = setOverLimit;
    this.ask = ask;
    this.freeBytes = freeBytes;
    this.titleOf = titleOf;
    this.entries = new Map();
    this.loaded = null;
    this.warnedDisk = false;
    this.asking = null;
  }

  load() {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          await fsp.mkdir(this.dir, { recursive: true });
        } catch (err) {
          this.unavailable = err.message;
          return;
        }
        try {
          const data = JSON.parse(await fsp.readFile(path.join(this.dir, INDEX), 'utf8'));
          for (const [id, entry] of Object.entries(data.chats || {})) this.entries.set(id, entry);
        } catch {}
        // Files no entry describes were cut short (a crash while saving) or come from older
        // versions (uma-last.bin): they are removed.
        const known = new Set([...this.entries.values()].map((entry) => entry.file));
        for (const name of await fsp.readdir(this.dir).catch(() => [])) {
          if (OWN_FILE.test(name) && !known.has(name)) await fsp.rm(path.join(this.dir, name), { force: true }).catch(() => {});
        }
        for (const [id, entry] of this.entries) {
          if (!fs.existsSync(path.join(this.dir, entry.file))) this.entries.delete(id);
        }
      })();
    }
    return this.loaded;
  }

  async writeIndex() {
    const temp = path.join(this.dir, `${INDEX}.tmp`);
    await fsp.writeFile(temp, JSON.stringify({ chats: Object.fromEntries(this.entries) }, null, 1));
    await fsp.rename(temp, path.join(this.dir, INDEX));
  }

  limitBytes() {
    const gb = Number(this.getSettings().chatMemoryLimitGB);
    return (Number.isFinite(gb) && gb > 0 ? gb : DEFAULT_LIMIT_GB) * GB;
  }

  mode() {
    const mode = this.getSettings().chatMemoryOverLimit;
    return ['ask', 'overwrite', 'continue'].includes(mode) ? mode : 'ask';
  }

  totalBytes() {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes || 0;
    return total;
  }

  /** The saved memory of a conversation, if it was made by an engine started the same way (`key`). */
  async find(conversationId, key) {
    await this.load();
    const entry = this.entries.get(conversationId);
    return entry && entry.key === key ? entry : null;
  }

  /**
   * Before saving a conversation: is there room? Returns the file name to save to, or null.
   * Its old file is dropped from the index first, so a save cut short is never read back.
   */
  async prepareSave(conversationId) {
    await this.load();
    if (this.unavailable) return null;
    const old = this.entries.get(conversationId);
    const free = await this.freeBytes(this.dir);
    // The new file replaces the old one and is usually a little larger.
    const expected = Math.max(old?.bytes || 0, this.lastBytes || 0) * 1.3;
    if (free + (old?.bytes || 0) - expected < DISK_RESERVE_BYTES) {
      this.warnLowDisk(free);
      return null;
    }
    if (free < LOW_DISK_BYTES) this.warnLowDisk(free);
    if (old) {
      this.entries.delete(conversationId);
      await this.writeIndex();
    }
    return fileFor(conversationId);
  }

  /** After a save: records it, then keeps the total under the limit as the user chose. */
  async saved(conversationId, { key, tokens, bytes }) {
    this.lastBytes = bytes;
    this.entries.set(conversationId, { file: fileFor(conversationId), key, tokens, bytes, savedAt: new Date().toISOString() });
    await this.writeIndex();
    // Not waited for: keeping the limit may wait for the user's answer.
    this.enforcing = this.enforceLimit(conversationId).catch(() => {});
  }

  async enforceLimit(keepId) {
    const limit = this.limitBytes();
    if (this.totalBytes() <= limit) return;
    let mode = this.mode();
    if (mode === 'ask') {
      // Asked once; until the answer, nothing is removed.
      if (!this.asking) {
        this.asking = this.ask('limit', { totalBytes: this.totalBytes(), limitBytes: limit })
          .then(async (answer) => {
            const chosen = answer === 'continue' ? 'continue' : 'overwrite';
            await this.setOverLimit(chosen);
            return chosen;
          })
          .finally(() => { this.asking = null; });
      }
      mode = await this.asking;
    }
    if (mode === 'continue') return;
    // Keep the limit: the memories of the chats used longest ago go first.
    const oldest = [...this.entries.entries()]
      .filter(([id]) => id !== keepId)
      .sort((a, b) => String(a[1].savedAt).localeCompare(String(b[1].savedAt)));
    for (const [id] of oldest) {
      if (this.totalBytes() <= limit) break;
      await this.remove(id);
    }
  }

  warnLowDisk(free) {
    if (this.warnedDisk) return;
    this.warnedDisk = true;
    this.ask('disk', { freeBytes: free, totalBytes: this.totalBytes() }).catch(() => {});
  }

  async remove(conversationId) {
    await this.load();
    const entry = this.entries.get(conversationId);
    if (!entry) return false;
    this.entries.delete(conversationId);
    await this.writeIndex();
    await fsp.rm(path.join(this.dir, entry.file), { force: true }).catch(() => {});
    return true;
  }

  async removeAll() {
    await this.load();
    for (const id of [...this.entries.keys()]) await this.remove(id);
    this.warnedDisk = false;
  }

  /**
   * Moves every saved chat memory to another folder (another disk, for example), then saves there.
   * The engine must not be saving meanwhile (main.cjs stops it first). `onProgress({ done, total })`.
   */
  async moveTo(target, onProgress = () => {}) {
    await this.load();
    const from = this.dir;
    if (path.resolve(target).toLowerCase() === path.resolve(from).toLowerCase()) return;
    try {
      await fsp.mkdir(target, { recursive: true });
      const probe = path.join(target, `.uma-write-test-${process.pid}`);
      await fsp.writeFile(probe, 'ok');
      await fsp.rm(probe, { force: true });
    } catch (err) {
      throw new Error(t('Uma cannot save in that folder: {0}', [err.message]));
    }
    const total = this.totalBytes();
    const sameDisk = path.parse(path.resolve(target)).root.toLowerCase() === path.parse(path.resolve(from)).root.toLowerCase();
    if (!sameDisk && (await this.freeBytes(target)) < total + DISK_RESERVE_BYTES) {
      throw new Error(t('Not enough free space there: chat memory needs {0} GB.', [(total / GB).toFixed(1)]));
    }
    // Memory already in the target folder (chosen before) is kept beside what moves in.
    try {
      const data = JSON.parse(await fsp.readFile(path.join(target, INDEX), 'utf8'));
      for (const [id, entry] of Object.entries(data.chats || {})) {
        if (!this.entries.has(id) && fs.existsSync(path.join(target, entry.file))) this.entries.set(id, { ...entry, moved: true });
      }
    } catch {}
    let done = 0;
    onProgress({ done, total });
    for (const [id, entry] of [...this.entries]) {
      if (entry.moved) {
        delete entry.moved;
        continue;
      }
      const source = path.join(from, entry.file);
      const destination = path.join(target, entry.file);
      try {
        await fsp.rename(source, destination);
      } catch (err) {
        if (err.code === 'ENOENT') {
          this.entries.delete(id);
          continue;
        }
        if (err.code !== 'EXDEV' && err.code !== 'EPERM') throw err;
        await fsp.copyFile(source, destination);
        await fsp.rm(source, { force: true });
      }
      done += entry.bytes || 0;
      onProgress({ done, total });
    }
    this.dir = target;
    this.unavailable = '';
    await this.writeIndex();
    await fsp.rm(path.join(from, INDEX), { force: true }).catch(() => {});
    // The old folder is removed when it is empty and is Uma's own.
    if (path.basename(from) === FOLDER_NAME || from === this.defaultDir) await fsp.rmdir(from).catch(() => {});
  }

  /** For Settings: every saved chat memory, newest first, and the totals. */
  async list() {
    await this.load();
    const chats = [];
    for (const [id, entry] of this.entries) {
      if (this.unavailable) break;
      chats.push({ id, title: await this.titleOf(id).catch(() => '') || '', tokens: entry.tokens, bytes: entry.bytes, savedAt: entry.savedAt });
    }
    chats.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    return {
      chats,
      totalBytes: this.totalBytes(),
      limitBytes: this.limitBytes(),
      mode: this.mode(),
      freeBytes: this.unavailable ? 0 : await this.freeBytes(this.dir),
      lowDiskBytes: LOW_DISK_BYTES,
      dir: this.dir,
      isDefault: path.resolve(this.dir).toLowerCase() === path.resolve(this.defaultDir).toLowerCase(),
      unavailable: this.unavailable,
    };
  }
}

module.exports = { ChatMemory, fileFor, DEFAULT_LIMIT_GB, LOW_DISK_BYTES, GB, FOLDER_NAME };
