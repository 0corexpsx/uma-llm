// The model library in the real app (own data folder, hidden window): the original models, the
// abliterated & modified view, and the Pause / Resume / Cancel buttons of a download.
//   node_modules\electron\dist\electron.exe scripts\ui-library-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-library', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, loadModelAtStart: false }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, 'ui-library.log');
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
fs.rmSync(logFile, { force: true });

async function run() {
  let window;
  for (let attempt = 0; attempt < 200 && !window; attempt += 1) {
    await sleep(150);
    [window] = BrowserWindow.getAllWindows();
  }
  if (!window) throw new Error('the app opened no window');
  window.setSize(1500, 950);
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
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const shot = async (name) => fs.writeFileSync(path.join(shots, name), (await page.capturePage()).toPNG());
  await waitFor("Boolean(document.querySelector('.rail-item[data-view=\"models\"]'))", 'the app', 40000);
  await js("(window.__errors = [], window.addEventListener('error', (e) => window.__errors.push(String(e.message))), true)");
  await js("document.querySelector('.rail-item[data-view=\"models\"]').click()");
  await waitFor("Boolean(document.querySelector('.edition-switch'))", 'the library');
  await js("(() => { try { localStorage.removeItem('uma.models.edition'); } catch {} return true; })()");

  const cards = () => js("[...document.querySelectorAll('.catalog-card h3')].map((el) => el.firstChild.textContent.trim())");
  const chips = () => js("[...document.querySelectorAll('.family-chip')].map((el) => el.innerText.trim())");
  const original = await cards();
  log(`original: ${original.length} cards; families: ${(await chips()).join(', ')}`);
  for (const family of ['Qwen3.8', 'Qwen3.5', 'Gemma', 'Mistral']) {
    await js(`[...document.querySelectorAll('.family-chip')].find((el) => el.innerText.trim() === ${JSON.stringify(family)}).click()`);
    await sleep(250);
    log(`  ${family}: ${(await cards()).join(' | ')}`);
  }
  if (original.some((name) => /Abliterated|Distill$/.test(name))) throw new Error('a modified model is in the original view');
  await js("[...document.querySelectorAll('.family-chip')].find((el) => el.innerText.trim() === 'All').click()");
  await js("document.querySelector('.edition-switch').scrollIntoView({ block: 'start' })");
  await sleep(400);
  await shot('library-original.png');

  await js("[...document.querySelectorAll('.edition-switch button')].find((el) => /Abliterated/.test(el.innerText)).click()");
  await sleep(500);
  const modified = await cards();
  log(`modified: ${modified.length} cards; families: ${(await chips()).join(', ')}`);
  log(`  badges: ${await js("[...new Set([...document.querySelectorAll('.modified-badge')].map((el) => el.innerText))].join(', ')")}`);
  if (!modified.length || modified.some((name) => !/Abliterated|Distill/.test(name))) throw new Error('an original model is in the modified view');
  await js("document.querySelector('.edition-switch').scrollIntoView({ block: 'start' })");
  await sleep(300);
  await shot('library-modified.png');

  // Back to the originals: a running download, then the same one paused.
  await js("[...document.querySelectorAll('.edition-switch button')].find((el) => /Original/.test(el.innerText)).click()");
  await sleep(300);
  const id = await js("(() => { const card = [...document.querySelectorAll('.catalog-card')].find((el) => /Qwen2.5 3B/.test(el.querySelector('h3').innerText)); card.scrollIntoView({ block: 'center' }); return 'qwen25-3b'; })()");
  page.send('models:progress', { id, status: 'downloading', percent: 37, received: 7e8, total: 1.9e9, speed: 12.5e6, model: { name: 'Qwen2.5 3B' } });
  await sleep(500);
  log(`downloading card: ${await js("document.querySelector('.catalog-progress-top').innerText.replace(/\\n+/g, ' | ')")}`);
  page.send('models:progress', { id, status: 'paused', percent: 37, received: 7e8, total: 1.9e9, speed: 0, model: { name: 'Qwen2.5 3B' } });
  await sleep(500);
  log(`paused card: ${await js("document.querySelector('.catalog-progress-top').innerText.replace(/\\n+/g, ' | ')")}`);
  await shot('library-paused.png');

  const errors = await js('window.__errors');
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  log('library views and download buttons: OK');
}

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
