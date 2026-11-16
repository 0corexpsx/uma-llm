// Opens Settings → Chat memory and Models → Qwen3.8 → All versions in the real app, with its own
// data folder and a hidden window, and saves screenshots in .shots.
//   node_modules\electron\dist\electron.exe scripts\ui-memory-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-memory', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(dataDir, 'chat-memory'), { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace') }));
// One saved chat memory, so the list has a row.
fs.writeFileSync(path.join(dataDir, 'chat-memory', 'chat-c_test.bin'), 'state');
fs.writeFileSync(path.join(dataDir, 'chat-memory', 'index.json'), JSON.stringify({ chats: { c_test: { file: 'chat-c_test.bin', key: 'k', tokens: 3276, bytes: 999260084, savedAt: new Date().toISOString() } } }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => fs.appendFileSync(path.join(shots, 'ui-memory.log'), `${text}\n`);
fs.rmSync(path.join(shots, 'ui-memory.log'), { force: true });

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
  await waitFor("Boolean(document.querySelector('.app'))", 'the app');
  await js("(window.__errors = [], window.addEventListener('error', (e) => window.__errors.push(String(e.message))), true)");
  await waitFor("Boolean(document.querySelector('.rail-bottom .rail-item'))", 'the navigation rail', 40000);
  await js("document.querySelector('.rail-bottom .rail-item').click()");
  await waitFor("Boolean(document.querySelector('#settings-memory .chat-memory-item'))", 'the Chat memory list');
  await js("document.querySelector('#settings-memory').scrollIntoView()");
  await sleep(600);
  log(`chat memory: ${(await js("document.querySelector('#settings-memory').innerText")).replace(/\n+/g, ' | ').slice(0, 900)}`);
  await shot('chat-memory.png');

  await js("[...document.querySelectorAll('.rail-item')].find((item) => item.textContent.includes('Models')).click()");
  await waitFor("[...document.querySelectorAll('.catalog-card')].some((card) => card.innerText.includes('Qwen3.8 Flash Next'))", 'the Qwen3.8 cards');
  const cards = await js("[...document.querySelectorAll('.catalog-card')].filter((card) => card.innerText.includes('Qwen3.8')).map((card) => card.innerText.replace(/\\n+/g, ' | ').slice(0, 260))");
  for (const card of cards) log(`card: ${card}`);
  await js("[...document.querySelectorAll('.catalog-card')].find((card) => card.innerText.includes('Qwen3.8 27B')).scrollIntoView()");
  await sleep(400);
  await shot('qwen-cards.png');
  await js("[...[...document.querySelectorAll('.catalog-card')].find((card) => card.innerText.includes('Qwen3.8 Flash Next')).querySelectorAll('button')].find((b) => b.textContent.includes('Choose version')).click()");
  await waitFor("document.body.innerText.includes('UD-Q4_K_XL')", 'the version list', 40000);
  await sleep(800);
  log(`picker: ${(await js("(document.querySelector('.modal') || document.body).innerText")).replace(/\n+/g, ' | ').slice(0, 900)}`);
  await shot('qwen-versions.png');
  const errors = await js('window.__errors');
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  log('chat memory settings and Qwen3.8 versions: OK');
}

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
