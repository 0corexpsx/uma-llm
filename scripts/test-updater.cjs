// Tests for the update check (electron/lib/updater.cjs), against a small server that answers the
// way GitHub's "latest release" does. Run with: node scripts/test-updater.cjs (part of npm test).
const path = require('node:path');
const fsp = require('node:fs/promises');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert');
const { Updater, parseVersion, isNewer, assetFor } = require('../electron/lib/updater.cjs');

const root = path.join(__dirname, '..', '.testdata', 'updater');
const installer = Buffer.from('MZ this stands for an installer '.repeat(4000));
const digest = `sha256:${crypto.createHash('sha256').update(installer).digest('hex')}`;

async function main() {
  await fsp.rm(root, { recursive: true, force: true });

  // Versions.
  assert.deepEqual(parseVersion('v0.2.88'), [0, 2, 88]);
  assert.deepEqual(parseVersion('Uma LLM 1.10.0'), [1, 10, 0]);
  assert.equal(parseVersion('latest'), null);
  assert.equal(isNewer('0.2.88', '0.2.87'), true);
  assert.equal(isNewer('0.10.0', '0.9.9'), true, 'numbers, not text');
  assert.equal(isNewer('0.2.87', '0.2.87'), false);
  assert.equal(isNewer('0.2.86', '0.2.87'), false);
  assert.equal(isNewer('nonsense', '0.2.87'), false);

  // The file for this computer.
  const files = ['Uma-LLM-Setup-0.2.88.exe', 'Uma-LLM-Setup-0.2.88.exe.blockmap', 'Uma-LLM-0.2.88-mac-arm64.dmg', 'Uma-LLM-0.2.88-mac-x64.dmg', 'Uma-LLM-0.2.88-mac-x64.zip', 'uma-llm_0.2.88_amd64.deb']
    .map((name) => ({ name }));
  assert.equal(assetFor(files, 'win32', 'x64').name, 'Uma-LLM-Setup-0.2.88.exe');
  assert.equal(assetFor(files, 'darwin', 'arm64').name, 'Uma-LLM-0.2.88-mac-arm64.dmg');
  assert.equal(assetFor(files, 'darwin', 'x64').name, 'Uma-LLM-0.2.88-mac-x64.dmg');
  assert.equal(assetFor(files, 'linux', 'x64').name, 'uma-llm_0.2.88_amd64.deb');
  assert.equal(assetFor(files, 'linux', 'arm64'), null);
  assert.equal(assetFor([], 'win32', 'x64'), null);

  // A server standing for the repository's releases.
  let release = null;
  let status = 200;
  let served = installer;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/latest') {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(typeof release === 'function' ? release() : release));
    } else if (request.url.startsWith('/download/')) {
      response.writeHead(200, { 'Content-Length': served.length });
      response.end(served);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const publish = (version, extra = {}) => ({
    tag_name: `v${version}`,
    html_url: `${base}/page/v${version}`,
    body: 'What is new:\n- faster\n- fewer bugs',
    assets: [{ name: `Uma-LLM-Setup-${version}.exe`, browser_download_url: `${base}/download/Uma-LLM-Setup-${version}.exe`, size: installer.length, digest }],
    ...extra,
  });
  const started = [];
  const states = [];
  const make = (options = {}) => new Updater({
    version: '0.2.87', feed: `${base}/latest`, downloads: `${base}/download/`, page: `${base}/page`, dir: path.join(root, 'updates'),
    platform: 'win32', arch: 'x64', onChange: (state) => states.push(state.status), start: (file) => started.push(file), ...options,
  });

  try {
    // Nothing published yet, the same version, an older one, a draft: nothing to do.
    let updater = make();
    status = 404;
    assert.equal((await updater.check()).status, 'current', 'a repository without releases is not an error');
    status = 200;
    for (const nothing of [publish('0.2.87'), publish('0.2.80'), publish('0.2.99', { prerelease: true }), publish('0.2.99', { draft: true }), { tag_name: 'weekly' }]) {
      release = nothing;
      assert.equal((await updater.check()).status, 'current', JSON.stringify(nothing.tag_name));
    }
    await assert.rejects(updater.download(), /no update to download/);

    // A newer version: found, shown with its notes, downloaded, checked, and started on request.
    release = publish('0.2.88');
    let state = await updater.check();
    assert.equal(state.status, 'available');
    assert.equal(state.version, '0.2.88');
    assert.equal(state.current, '0.2.87');
    assert.equal(state.canInstall, true);
    assert.match(state.notes, /fewer bugs/);
    assert.equal(state.page, `${base}/page/v0.2.88`);
    await assert.rejects(updater.install(), /no update to install/, 'nothing starts before the download');
    state = await updater.download();
    assert.equal(state.status, 'ready');
    const file = path.join(root, 'updates', 'Uma-LLM-Setup-0.2.88.exe');
    assert.equal((await fsp.readFile(file)).equals(installer), true);
    assert.deepEqual(started, [], 'downloading starts nothing');
    assert.equal((await updater.check()).status, 'ready', 'looking again does not throw the download away');
    await updater.install();
    assert.deepEqual(started, [file]);
    assert.ok(states.includes('checking') && states.includes('downloading') && states.includes('ready'), 'the window is told each step');

    // A file that is not the published one is deleted, and never started.
    started.length = 0;
    updater = make();
    release = publish('0.2.89');
    served = Buffer.from(installer.toString().replace('installer', 'INSTALLER'));
    assert.equal(served.length, installer.length);
    await updater.check();
    await assert.rejects(updater.download(), /does not match the published file/);
    assert.equal(updater.state.status, 'available');
    assert.match(updater.state.error, /does not match/);
    assert.equal(await fsp.stat(path.join(root, 'updates', 'Uma-LLM-Setup-0.2.89.exe')).catch(() => null), null);
    assert.equal(await fsp.stat(path.join(root, 'updates', 'Uma-LLM-Setup-0.2.88.exe')).catch(() => null), null, 'the installer of an earlier update is not kept');
    await assert.rejects(updater.install(), /no update to install/);
    assert.deepEqual(started, []);
    // A file cut short is refused too.
    served = installer.subarray(0, 1000);
    release = publish('0.2.89', { assets: [{ name: 'Uma-LLM-Setup-0.2.89.exe', browser_download_url: `${base}/download/Uma-LLM-Setup-0.2.89.exe`, size: installer.length }] });
    await updater.check();
    await assert.rejects(updater.download(), /not complete/);
    served = installer;

    // An installer anywhere but in Uma's own releases is not downloaded: the page is offered instead.
    updater = make();
    release = publish('0.2.90', { assets: [{ name: 'Uma-LLM-Setup-0.2.90.exe', browser_download_url: 'http://127.0.0.1:1/elsewhere/Uma-LLM-Setup-0.2.90.exe', size: 10 }], html_url: 'http://elsewhere.example/page' });
    state = await updater.check();
    assert.equal(state.status, 'available');
    assert.equal(state.canInstall, false);
    assert.equal(state.page, `${base}/page`, 'a link that is not Uma\'s page is not shown');
    await assert.rejects(updater.download(), /no update to download/);

    // On a Mac the version is announced and the page is opened: Uma cannot replace itself there.
    updater = make({ platform: 'darwin', arch: 'arm64' });
    release = publish('0.2.88', { assets: [{ name: 'Uma-LLM-0.2.88-mac-arm64.dmg', browser_download_url: `${base}/download/Uma-LLM-0.2.88-mac-arm64.dmg`, size: 5 }] });
    state = await updater.check();
    assert.equal(state.status, 'available');
    assert.equal(state.canInstall, false);
    await assert.rejects(updater.download(), /no update to download/);

    // A server that fails says so, and the next look works again.
    updater = make();
    status = 500;
    state = await updater.check();
    assert.equal(state.status, 'error');
    assert.match(state.error, /500/);
    status = 200;
    release = publish('0.2.88');
    assert.equal((await updater.check()).status, 'available');
    // No feed: the check is off and asks nothing.
    const before = requests.length;
    assert.equal((await make({ feed: '' }).check()).status, 'off');
    assert.equal(requests.length, before);

    // By itself Uma looks once a day at most.
    updater = make();
    const now = Date.now();
    assert.equal(updater.due(0, now), true);
    assert.equal(updater.due(now - 23 * 3600 * 1000, now), false);
    assert.equal(updater.due(now - 25 * 3600 * 1000, now), true);
    assert.equal(make({ feed: '' }).due(0, now), false);
    // Two looks at once ask the server once.
    const asked = requests.filter((url) => url === '/latest').length;
    await Promise.all([updater.check(), updater.check()]);
    assert.equal(requests.filter((url) => url === '/latest').length, asked + 1);
  } finally {
    server.close();
  }
  console.log('update check: versions, download, verification, refusals: OK');
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
