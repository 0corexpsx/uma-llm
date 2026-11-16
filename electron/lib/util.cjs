const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { t } = require('./i18n.cjs');

function newId(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

const writeQueues = new Map();

/** Writes to one file run in order: Windows refuses a rename onto a file being replaced. */
function writeJsonAtomic(file, value, { pretty = true } = {}) {
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  const write = async () => {
    await ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    // The data must be on the disk before the rename. Otherwise, after a crash or power loss, Windows
    // can keep the new file's length but not its contents, and the file reads back as zeros (this
    // happened to settings.json and models.json on 2026-11-14).
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsp.rename(tmp, file);
        return;
      } catch (err) {
        // Antivirus and search indexers hold new files open for a moment.
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
          await fsp.rm(tmp, { force: true }).catch(() => {});
          throw err;
        }
        await sleep(40 * (attempt + 1));
      }
    }
  };
  const run = (writeQueues.get(file) || Promise.resolve()).catch(() => {}).then(write);
  writeQueues.set(file, run);
  run.finally(() => {
    if (writeQueues.get(file) === run) writeQueues.delete(file);
  }).catch(() => {});
  return run;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const n = bytes / 1024 ** i;
  return `${n >= 10 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / Math.max(sample.length, 1) > 0.08;
}

function truncate(text, max = 16000) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.72));
  const tail = text.slice(-Math.floor(max * 0.22));
  return `${head}\n\n… [${formatBytes(Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail))} truncated] …\n\n${tail}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Stream a URL to disk with progress, cancellation and basic resume support.
 */
async function downloadFile(url, destination, options = {}) {
  const {
    onProgress = () => {},
    signal,
    expectedSize = 0,
    headers = {},
    label = path.basename(destination),
    stallMs = 90000,
  } = options;

  await ensureDir(path.dirname(destination));
  const part = `${destination}.part`;
  let existing = 0;
  try {
    existing = (await fsp.stat(part)).size;
  } catch {}

  const requestHeaders = {
    'User-Agent': 'UmaLLM/0.2 (+local desktop app)',
    Accept: 'application/octet-stream',
    ...headers,
  };
  if (existing > 0) requestHeaders.Range = `bytes=${existing}-`;

  // A connection that goes quiet (Wi-Fi dropped, server stalled) never ends by itself: without this
  // the download sat at the same percentage forever. The part file is kept, so trying again resumes.
  const stall = new AbortController();
  let stalled = false;
  let lastData = Date.now();
  const stallTimer = setInterval(() => {
    if (Date.now() - lastData > stallMs) {
      stalled = true;
      clearInterval(stallTimer);
      stall.abort();
    }
  }, Math.min(5000, stallMs));
  stallTimer.unref?.();
  const stopWatching = () => clearInterval(stallTimer);
  const stalledError = () => new Error(t('The download stopped receiving data for {0} seconds. Check the connection, then try again to resume.', [Math.round(stallMs / 1000)]));

  let response;
  try {
    response = await fetch(url, {
      headers: requestHeaders,
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal,
    });
  } catch (err) {
    stopWatching();
    throw stalled ? stalledError() : err;
  }
  lastData = Date.now();

  if (!response.ok) {
    stopWatching();
    if (response.status === 416 && existing > 0) {
      // The partial file is already the complete object; finalize it.
      await fsp.rm(destination, { force: true });
      await fsp.rename(part, destination);
      const stat = await fsp.stat(destination);
      onProgress({ received: stat.size, total: stat.size, percent: 100, speed: 0, label });
      return { path: destination, size: stat.size };
    }
    throw new Error(t('Download failed ({0} {1})', [response.status, response.statusText]));
  }

  let startAt = 0;
  if (existing > 0 && response.status === 206) {
    startAt = existing;
  } else if (existing > 0) {
    // Server ignored the range; start again from zero.
    await fsp.rm(part, { force: true });
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  const total = contentLength > 0 ? contentLength + startAt : expectedSize || 0;
  const handle = await fsp.open(part, startAt > 0 ? 'a' : 'w');
  let received = startAt;
  let lastEmit = 0;
  let speed = 0;
  let lastBytes = received;
  let lastTime = Date.now();

  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastData = Date.now();
      await handle.write(value);
      received += value.length;
      const now = Date.now();
      if (now - lastEmit > 140) {
        const dt = (now - lastTime) / 1000;
        if (dt > 0.25) {
          speed = (received - lastBytes) / dt;
          lastBytes = received;
          lastTime = now;
        }
        onProgress({
          received,
          total,
          percent: total > 0 ? Math.min(100, (received / total) * 100) : 0,
          speed,
          label,
        });
        lastEmit = now;
      }
    }
  } catch (err) {
    throw stalled ? stalledError() : err;
  } finally {
    stopWatching();
    await handle.close();
  }

  const stat = await fsp.stat(part);
  // The server's length is exact, so anything short is a broken model. A catalog size is only approximate.
  const compressed = Boolean(response.headers.get('content-encoding'));
  const required = contentLength > 0 && !compressed ? total : total * 0.985;
  if (total > 0 && stat.size < required) {
    throw new Error(
      t('Download ended early ({0} of {1}). Try again to resume.', [formatBytes(stat.size), formatBytes(total)]),
    );
  }
  await fsp.rm(destination, { force: true });
  await fsp.rename(part, destination);
  onProgress({ received: stat.size, total: stat.size, percent: 100, speed: 0, label });
  return { path: destination, size: stat.size };
}

module.exports = {
  newId,
  ensureDir,
  readJson,
  writeJsonAtomic,
  formatBytes,
  isProbablyBinary,
  truncate,
  sleep,
  isInside,
  downloadFile,
};
