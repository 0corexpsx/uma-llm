// Checks the model menu in the chat header and the Server status screen in the real app, with its
// own data folder and a hidden window, and saves screenshots in .shots.
//   node_modules\electron\dist\electron.exe scripts\ui-status-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-status', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true });
fs.mkdirSync(shots, { recursive: true });
// Many models, as on a PC with every Qwen3.8 version: the menu must still be usable.
const count = Number(process.env.UI_STATUS_MODELS || 14);
const installed = [];
for (let index = 0; index < count; index += 1) {
  const file = path.join(dataDir, 'models', `test-model-${index}.gguf`);
  fs.writeFileSync(file, 'GGUF');
  installed.push({ id: `test:${index}`, catalogId: '', name: `Test model ${index} with a long descriptive name Q${index}`, filename: path.basename(file), path: file, size: 4, quant: `Q${index}`, addedAt: new Date().toISOString() });
}
fs.writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify({ installed }));
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version,
  language: 'en', workspacePath: path.join(root, 'demo-workspace'), activeModelId: 'test:0', loadModelAtStart: false, semanticSearch: false,
  network: { helpers: [
    { id: 'h_1', host: '127.0.0.1', port: 59981, label: 'Laptop', enabled: true },
    { id: 'h_2', host: '127.0.0.1', port: 59982, label: 'Old tower', enabled: true },
  ] },
}));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, 'ui-status.log');
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
fs.rmSync(logFile, { force: true });

async function run() {
  let window;
  for (let attempt = 0; attempt < 200 && !window; attempt += 1) {
    await sleep(150);
    [window] = BrowserWindow.getAllWindows();
  }
  if (!window) throw new Error('the app opened no window');
  window.setSize(Number(process.env.UI_STATUS_WIDTH || 1400), Number(process.env.UI_STATUS_HEIGHT || 760));
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
  // A real mouse click at a point, the way the user's click arrives.
  const click = async (x, y) => {
    page.sendInputEvent({ type: 'mouseMove', x, y });
    page.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    page.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(350);
  };
  await waitFor("Boolean(document.querySelector('.app'))", 'the app');
  await js("(window.__errors = [], window.addEventListener('error', (e) => window.__errors.push(String(e.message))), true)");
  await waitFor("Boolean(document.querySelector('.model-pill'))", 'the model menu button', 40000);

  // 1. The model menu: every entry can be reached and clicked.
  const pill = await js("(() => { const r = document.querySelector('.model-pill').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
  await click(pill.x, pill.y);
  await waitFor("Boolean(document.querySelector('.model-dropdown'))", 'the model menu');
  await shot('status-model-menu.png');
  const menu = await js(`(() => {
    const box = document.querySelector('.model-dropdown').getBoundingClientRect();
    const items = [...document.querySelectorAll('.model-dropdown .dropdown-item')];
    return { bottom: Math.round(box.bottom), window: window.innerHeight, items: items.length };
  })()`);
  log(`model menu: ${menu.items} entries, bottom at ${menu.bottom} of ${menu.window}`);
  if (menu.bottom > menu.window) throw new Error(`the model menu runs off the window (${menu.bottom} > ${menu.window})`);
  // The last model in the list: scroll to it, then click where it is.
  const target = await js(`(() => {
    const items = [...document.querySelectorAll('.model-dropdown .dropdown-item')];
    const item = items[items.length - 2];
    item.scrollIntoView({ block: 'nearest' });
    const r = item.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const top = document.elementFromPoint(x, y);
    return { x, y, name: item.querySelector('.dropdown-item-main span').textContent, reachable: item.contains(top), top: top ? top.className : '' };
  })()`);
  if (!target.reachable) throw new Error(`"${target.name}" is covered by .${target.top}`);
  await click(target.x, target.y);
  await waitFor(`document.querySelector('.model-pill').textContent.includes(${JSON.stringify(target.name)})`, `the menu to show ${target.name}`, 8000);
  log(`picked another model with a mouse click: ${target.name}`);

  if (process.env.UI_STATUS_ONLY_MENU) return;

  // 2. The Server status screen.
  await js("document.querySelector('.rail-item[data-view=\"status\"]').click()");
  await waitFor("document.querySelectorAll('.status-row').length >= 3", 'this PC and two helpers in the list', 20000);
  await sleep(6500);
  log('status rows: ' + (await js("[...document.querySelectorAll('.status-row')].map((row) => row.innerText.replace(/\\n+/g, ' | ')).join('\\n             ')")));
  log('lights: ' + (await js("[...document.querySelectorAll('.status-row .status-light')].map((el) => el.className.replace('status-light', '').trim() || 'none').join(', ')")));
  await shot('status-page.png');
  await js("document.documentElement.dataset.theme = 'light'");
  await sleep(300);
  await shot('status-page-light.png');
  await js("document.documentElement.dataset.theme = 'dark'");

  // 3. The model card on the right of the chat: load and stop buttons.
  await js("document.querySelector('.rail-item[data-view=\"chat\"]').click()");
  await waitFor("Boolean(document.querySelector('.model-power'))", 'the load / stop buttons');
  log('model buttons: ' + (await js("[...document.querySelectorAll('.model-power button')].map((el) => el.innerText.trim() + (el.disabled ? ' (off)' : '')).join(' | ')")));
  await shot('status-chat.png');

  const errors = await js('window.__errors');
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  log('model menu, server status, model buttons: OK');
}

// "Laptop" is a pretend helper that answers the way a shared Uma does; "Old tower" is switched off.
require('node:net').createServer((socket) => {
  socket.on('error', () => {});
  socket.once('data', () => socket.end(`${JSON.stringify({
    uma: 1, host: 'LAPTOP-I9', threads: 16, engine: 'b12318', devices: [],
    stats: {
      cpu: 37, ramUsed: 11.2 * 1024 ** 3, ramTotal: 16 * 1024 ** 3, gpu: { percent: 92, used: 7.4 * 1024 ** 3, total: 8 * 1024 ** 3 },
      internet: true, internetDrops: 0, received: 14.6 * 1024 ** 3, sent: 310 * 1024 ** 2, receiveRate: 3.2 * 1024 ** 2, sendRate: 2.9 * 1024 ** 2,
      clients: 1, phase: 'computing', crashes: 0, warnings: 0, lastWarning: null, sharedSince: new Date().toISOString(), version: '0.2.46',
    },
  })}\n`));
}).listen(59981, '127.0.0.1');

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
