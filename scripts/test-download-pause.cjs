// Pause, Resume and Cancel of a model download, against a small local server (no internet).
// Resume must continue from the bytes already on disk (an HTTP Range request), not start again.
//   node scripts/test-download-pause.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../electron/lib/store.cjs');
const { ModelManager } = require('../electron/lib/models.cjs');

const SIZE = 24 * 1024 * 1024;
const body = Buffer.alloc(SIZE, 7);
body.write('GGUF', 0, 'ascii');
const ranges = [];

// Sends the file slowly (about 8 MB/s), and honours "Range: bytes=N-" like Hugging Face does.
const server = http.createServer((req, res) => {
  const range = /bytes=(\d+)-/.exec(req.headers.range || '');
  const start = range ? Number(range[1]) : 0;
  ranges.push(start);
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': SIZE - start,
    ...(range ? { 'Content-Range': `bytes ${start}-${SIZE - 1}/${SIZE}` } : {}),
  });
  let offset = start;
  const timer = setInterval(() => {
    if (offset >= SIZE) { clearInterval(timer); res.end(); return; }
    const next = Math.min(SIZE, offset + 256 * 1024);
    res.write(body.subarray(offset, next));
    offset = next;
  }, 30);
  res.on('close', () => clearInterval(timer));
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = (name) => `http://127.0.0.1:${server.address().port}/${name}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uma-pause-'));
  const store = new Store(root);
  await store.init();
  const events = [];
  const models = new ModelManager({ store, modelsDir: path.join(root, 'models'), downloadsDir: path.join(root, 'downloads'), emit: (_name, state) => events.push(state) });
  await models.init();
  const state = (id) => models.states.get(id) || {};

  // 1. Pause keeps the partial file; Resume continues from it and finishes.
  const id = 'custom:pause-test';
  const part = path.join(root, 'models', 'pause-test.gguf.part');
  models.startDownload(id, { url: url('pause-test.gguf'), filename: 'pause-test.gguf', sizeBytes: SIZE, name: 'Pause test' }).catch(() => {});
  await waitFor(() => (state(id).received || 0) > 4 * 1024 * 1024, 'some bytes to arrive');
  assert.equal(models.pauseDownload(id), true);
  await waitFor(() => state(id).status === 'paused', 'the download to pause');
  const kept = fs.statSync(part).size;
  assert.ok(kept > 0 && kept < SIZE, `the partial file is kept (${kept} bytes)`);
  console.log(`paused at ${(kept / 1048576).toFixed(1)} MB of ${(SIZE / 1048576).toFixed(0)} MB, partial file kept`);
  await sleep(300);
  assert.equal(fs.statSync(part).size, kept, 'nothing is written while paused');

  models.resumeDownload(id);
  await waitFor(() => state(id).status === 'done', 'the resumed download to finish', 60000);
  assert.equal(ranges.at(-1), kept, 'Resume asked only for the missing bytes');
  const done = path.join(root, 'models', 'pause-test.gguf');
  assert.equal(fs.statSync(done).size, SIZE, 'the finished file is complete');
  assert.ok(fs.readFileSync(done).subarray(0, 4).toString() === 'GGUF', 'and starts like a model');
  assert.ok(store.getInstalledModels().some((entry) => entry.path === done), 'and is installed');
  console.log(`resumed from byte ${ranges.at(-1)} and finished: OK`);

  // 2. Cancel while downloading deletes the partial file.
  const id2 = 'custom:cancel-test';
  const part2 = path.join(root, 'models', 'cancel-test.gguf.part');
  models.startDownload(id2, { url: url('cancel-test.gguf'), filename: 'cancel-test.gguf', sizeBytes: SIZE, name: 'Cancel test' }).catch(() => {});
  await waitFor(() => (state(id2).received || 0) > 2 * 1024 * 1024, 'bytes for the second download');
  await models.cancelDownload(id2);
  await waitFor(() => state(id2).status === 'cancelled', 'the download to cancel');
  await sleep(200);
  assert.equal(fs.existsSync(part2), false, 'the partial file is deleted');
  console.log('cancel while downloading deletes the partial file: OK');

  // 3. Cancel while paused deletes it too.
  const id3 = 'custom:paused-cancel';
  const part3 = path.join(root, 'models', 'paused-cancel.gguf.part');
  models.startDownload(id3, { url: url('paused-cancel.gguf'), filename: 'paused-cancel.gguf', sizeBytes: SIZE, name: 'Paused cancel' }).catch(() => {});
  await waitFor(() => (state(id3).received || 0) > 2 * 1024 * 1024, 'bytes for the third download');
  models.pauseDownload(id3);
  await waitFor(() => state(id3).status === 'paused', 'the third download to pause');
  assert.ok(fs.existsSync(part3));
  await models.cancelDownload(id3);
  assert.equal(state(id3).status, 'cancelled');
  assert.equal(fs.existsSync(part3), false, 'cancelling a paused download deletes its partial file');
  console.log('cancel while paused deletes the partial file: OK');

  // 4. Cancel never deletes a file that was complete before the download began (a model already on
  //    disk whose version is chosen again, or the first part of a split model).
  const hubDir = path.join(root, 'models', 'hub', 'someone__Model-GGUF');
  fs.mkdirSync(hubDir, { recursive: true });
  const firstPart = path.join(hubDir, 'model-00001-of-00002.gguf');
  fs.writeFileSync(firstPart, body.subarray(0, SIZE));
  const id4 = 'hub:someone/Model-GGUF:model';
  models.startDownload(id4, {
    name: 'Split model',
    url: url('model-00001-of-00002.gguf'),
    filename: 'model-00001-of-00002.gguf',
    folder: 'someone__Model-GGUF',
    files: [
      { url: url('model-00001-of-00002.gguf'), filename: 'model-00001-of-00002.gguf', size: SIZE },
      { url: url('model-00002-of-00002.gguf'), filename: 'model-00002-of-00002.gguf', size: SIZE },
    ],
  }).catch(() => {});
  await waitFor(() => (state(id4).received || 0) > SIZE + 2 * 1024 * 1024, 'the second part to start');
  await models.cancelDownload(id4);
  await waitFor(() => state(id4).status === 'cancelled', 'the split download to cancel');
  await sleep(200);
  assert.equal(fs.existsSync(firstPart) && fs.statSync(firstPart).size, SIZE, 'the file that was already complete is kept');
  assert.equal(fs.existsSync(path.join(hubDir, 'model-00002-of-00002.gguf.part')), false, 'the partial second part is deleted');
  console.log('cancel keeps files that were complete before the download: OK');

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('download pause, resume and cancel: OK');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  server.close();
  process.exit(1);
});
