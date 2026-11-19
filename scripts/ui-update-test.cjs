// Opens Settings → Updates in the real app, with its own data folder, a hidden window and a small
// server standing for Uma's releases: looks for a version, finds a newer one, downloads it. The
// installer is never started. Saves screenshots in .shots.
//   node_modules\electron\dist\electron.exe scripts\ui-update-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-update', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), loadModelAtStart: false }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => fs.appendFileSync(path.join(shots, 'ui-update.log'), `${text}\n`);
fs.rmSync(path.join(shots, 'ui-update.log'), { force: true });

const installer = Buffer.from('MZ this stands for an installer '.repeat(20000));
let published = null;
const server = http.createServer((request, response) => {
  if (request.url === '/latest') {
    response.writeHead(published ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(published || {}));
  } else if (request.url.startsWith('/download/')) {
    response.writeHead(200, { 'Content-Length': installer.length });
    response.end(installer);
  } else {
    response.writeHead(404);
    response.end();
  }
});

async function run() {
  let window;
  for (let attempt = 0; attempt < 200 && !window; attempt += 1) {
    await sleep(150);
    [window] = BrowserWindow.getAllWindows();
  }
  if (!window) throw new Error('the app opened no window');
  window.setSize(1400, 950);
  const page = window.webContents;
  const js = async (code) => {
    const result = await page.executeJavaScript(`(async () => { try { return { value: await (${code}) }; } catch (error) { return { error: String(error && error.message || error) }; } })()`, true);
    if (result.error) throw new Error(`${result.error} — in: ${code.slice(0, 90)}`);
    return result.value;
  };
  const waitFor = async (code, label, timeout = 30000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await js(code).catch(() => false)) return;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const shot = async (name) => fs.writeFileSync(path.join(shots, name), (await page.capturePage()).toPNG());
  const section = "document.querySelector('#settings-updates')";
  const text = () => js(`${section}.innerText`);
  const press = (label) => js(`[...${section}.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(label)})).click()`);

  await waitFor("Boolean(document.querySelector('.app'))", 'the app');
  await js("(window.__errors = [], window.addEventListener('error', (e) => window.__errors.push(String(e.message))), true)");
  await waitFor("Boolean(document.querySelector('.rail-bottom .rail-item'))", 'the navigation rail', 40000);
  await js("document.querySelector('.rail-bottom .rail-item').click()");
  await waitFor(`Boolean(${section})`, 'the Updates section');
  await js(`${section}.scrollIntoView()`);
  const version = require('../package.json').version;
  await waitFor(`${section}.innerText.includes('Uma ${version} is installed')`, 'the installed version');
  log(`start: ${(await text()).replace(/\n+/g, ' | ')}`);

  // Nothing published: this is the newest version.
  await press('Check now');
  await waitFor(`${section}.innerText.includes('This is the newest version.')`, 'the answer that nothing is newer');
  await shot('update-current.png');

  // A newer version is published: it is announced with its notes, and nothing is downloaded yet.
  const base = `http://127.0.0.1:${server.address().port}`;
  published = {
    tag_name: 'v9.9.9',
    html_url: `${base}/page/v9.9.9`,
    body: 'What is new in this version:\n- A shorter prompt, so more of your files fit\n- Requests in Italian are understood as tasks',
    assets: [{ name: 'Uma-LLM-Setup-9.9.9.exe', browser_download_url: `${base}/download/Uma-LLM-Setup-9.9.9.exe`, size: installer.length, digest: `sha256:${crypto.createHash('sha256').update(installer).digest('hex')}` }],
  };
  await press('Check now');
  await waitFor(`${section}.innerText.includes('Uma 9.9.9 is available')`, 'the newer version');
  if (!(await text()).includes('A shorter prompt')) throw new Error('the notes of the release are not shown');
  if (fs.existsSync(path.join(dataDir, 'updates', 'Uma-LLM-Setup-9.9.9.exe'))) throw new Error('downloaded before the user asked');
  await shot('update-available.png');
  log(`available: ${(await text()).replace(/\n+/g, ' | ')}`);

  if (process.platform === 'win32') {
    await press('Download');
    await waitFor(`${section}.innerText.includes('Install and restart')`, 'the downloaded update', 60000);
    const file = path.join(dataDir, 'updates', 'Uma-LLM-Setup-9.9.9.exe');
    if (!fs.readFileSync(file).equals(installer)) throw new Error('the downloaded file differs');
    await shot('update-ready.png');
    log(`ready: ${(await text()).replace(/\n+/g, ' | ')}`);
  }

  // The switch is saved.
  await js(`${section}.querySelector('.toggle').click()`);
  await waitFor(`${section}.querySelector('.toggle').getAttribute('aria-checked') === 'false'`, 'the switch off');
  await sleep(500);
  if (JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).checkForUpdates !== false) throw new Error('the switch was not saved');
  const errors = await js('window.__errors');
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  log('updates section: OK');
}

server.listen(0, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.UMA_UPDATE_FEED = `${base}/latest`;
  process.env.UMA_UPDATE_DOWNLOADS = `${base}/download/`;
  require('../electron/main.cjs');
  app.whenReady().then(() => run())
    .then(() => app.exit(0))
    .catch((err) => {
      log(`UI TEST FAILED: ${err.message}`);
      app.exit(1);
    });
});
