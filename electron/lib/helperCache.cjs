// The helper engine (rpc-server -c) keeps every model part it receives in a cache folder, so the
// next load reads it from this PC's disk instead of the network. It never removes anything, so the
// folder grows with every model: a laptop helper reached 19.7 GB with 13 GB left on its disk, and a
// 58 GB model would have filled it. Uma removes the least recently used parts to keep disk space free.
const fsp = require('node:fs/promises');
const path = require('node:path');

const GB = 1024 ** 3;
// Free space to keep on the disk: the larger of these.
const KEEP_FREE_MIN = 10 * GB;
const KEEP_FREE_SHARE = 0.1;

async function diskSpace(dir) {
  try {
    const stat = await fsp.statfs(dir);
    return { free: Number(stat.bavail) * Number(stat.bsize), total: Number(stat.blocks) * Number(stat.bsize) };
  } catch {
    return null;
  }
}

/** Every cached part (any depth), with its size and when it was last used. */
async function cachedParts(dir) {
  const parts = [];
  const walk = async (folder) => {
    let entries;
    try {
      entries = await fsp.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const stat = await fsp.stat(file).catch(() => null);
        // Reading a part may update only its access time; writing it sets the modified time.
        if (stat) parts.push({ file, size: stat.size, used: Math.max(stat.atimeMs, stat.mtimeMs) });
      }
    }
  };
  await walk(dir);
  return parts;
}

function keepFreeFor(total) {
  return Math.max(KEEP_FREE_MIN, total * KEEP_FREE_SHARE);
}

/**
 * Removes the least recently used parts until the disk has the free space to keep, or the cache
 * is empty. `space` and `parts` can be given for tests. Returns what was done.
 */
async function pruneCache(dir, { space = null, parts = null, remove = (file) => fsp.rm(file, { force: true }) } = {}) {
  const disk = space || await diskSpace(dir);
  const list = (parts || await cachedParts(dir)).sort((a, b) => a.used - b.used);
  const cacheBytes = list.reduce((sum, part) => sum + part.size, 0);
  if (!disk) return { removed: 0, freedBytes: 0, cacheBytes, freeBytes: 0, keepFreeBytes: 0, enoughSpace: true };
  const keepFreeBytes = keepFreeFor(disk.total);
  let free = disk.free;
  let removed = 0;
  let freedBytes = 0;
  for (const part of list) {
    if (free >= keepFreeBytes) break;
    try {
      await remove(part.file);
      free += part.size;
      freedBytes += part.size;
      removed += 1;
    } catch {}
  }
  return { removed, freedBytes, cacheBytes: cacheBytes - freedBytes, freeBytes: free, keepFreeBytes, enoughSpace: free >= keepFreeBytes };
}

module.exports = { pruneCache, cachedParts, diskSpace, keepFreeFor, KEEP_FREE_MIN };
