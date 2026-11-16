const path = require('node:path');
const fsp = require('node:fs/promises');
const { ensureDir, newId } = require('./util.cjs');
const { t } = require('./i18n.cjs');

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/** Keeps a copy of each file before the agent changes it, so a change can be reverted. */
class UndoLog {
  constructor({ dir, trash, limit = 200 }) {
    this.dir = dir;
    this.trash = trash;
    this.limit = limit;
  }

  async writeEntry(entry) {
    await ensureDir(this.dir);
    const id = newId('u_');
    await fsp.writeFile(path.join(this.dir, `${id}.json`), JSON.stringify(entry), 'utf8');
    this.prune().catch(() => {});
    return id;
  }

  /** Records the current state of `abs`. Returns an id, or null if it is too large to keep. */
  async snapshot(abs) {
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) return this.writeEntry({ type: 'created', path: abs });
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null;
    const content = await fsp.readFile(abs);
    return this.writeEntry({ type: 'changed', path: abs, content: content.toString('base64') });
  }

  recordMove(from, to) {
    return this.writeEntry({ type: 'moved', from, to });
  }

  /** Reverts one recorded change. Each id can be used once. */
  async restore(id) {
    if (!/^u_[a-z0-9]+$/.test(String(id))) throw new Error(t('Invalid undo id.'));
    const file = path.join(this.dir, `${id}.json`);
    const raw = await fsp.readFile(file, 'utf8').catch(() => null);
    if (raw === null) throw new Error(t('This change can no longer be undone.'));
    const entry = JSON.parse(raw);
    if (entry.type === 'created') {
      if (await fsp.stat(entry.path).catch(() => null)) await this.trash(entry.path);
    } else if (entry.type === 'changed') {
      await ensureDir(path.dirname(entry.path));
      await fsp.writeFile(entry.path, Buffer.from(entry.content, 'base64'));
    } else if (entry.type === 'moved') {
      if (await fsp.stat(entry.from).catch(() => null)) {
        throw new Error(t('Cannot undo the move: a file already exists at the original path.'));
      }
      await ensureDir(path.dirname(entry.from));
      await fsp.rename(entry.to, entry.from);
    }
    await fsp.rm(file, { force: true });
    return { path: entry.path || entry.from };
  }

  async prune() {
    const names = (await fsp.readdir(this.dir).catch(() => [])).filter((name) => name.endsWith('.json'));
    if (names.length <= this.limit) return;
    const stats = await Promise.all(names.map(async (name) => ({
      name,
      time: (await fsp.stat(path.join(this.dir, name)).catch(() => null))?.mtimeMs || 0,
    })));
    stats.sort((a, b) => a.time - b.time);
    await Promise.all(stats.slice(0, stats.length - this.limit)
      .map(({ name }) => fsp.rm(path.join(this.dir, name), { force: true })));
  }
}

module.exports = { UndoLog };
