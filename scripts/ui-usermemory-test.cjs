// Opens Settings → Memory in the real app, imports a pasted list from another assistant, with its own
// data folder and a hidden window, and saves screenshots in .shots.
//   node_modules\electron\dist\electron.exe scripts\ui-memory-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-usermemory', 'data');
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
const log = (text) => fs.appendFileSync(path.join(shots, 'ui-usermemory.log'), `${text}\n`);
fs.rmSync(path.join(shots, 'ui-usermemory.log'), { force: true });

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
  await waitFor("Boolean(document.querySelector('#settings-user-memory .memory-toolbar'))", 'the Memory section');
  await js("[...document.querySelectorAll('#settings-user-memory button')].find((b) => b.textContent.includes('Import memory')).click()");
  await waitFor("Boolean(document.querySelector('.memory-paste'))", 'the import window');
  const pasted = 'Sure! Here is everything I remember about you:\n- Name: Marco\n- Works on Uma, a local LLM app\n- Prefers answers in Italian\n- Uses a laptop with an RTX 2070 as a helper PC';
  await js('(() => { const box = document.querySelector(".memory-paste"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ' + JSON.stringify(pasted) + '); box.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
  await sleep(300);
  await shot('memory-import.png');
  await js("[...document.querySelectorAll('.modal-footer button')].find((b) => b.textContent.includes('Read the list')).click()");
  await waitFor("document.querySelectorAll('.memory-preview-item').length > 0", 'the parsed list');
  log('parsed: ' + (await js("[...document.querySelectorAll('.memory-preview-item')].map((item) => item.innerText).join(' | ')")));
  await shot('memory-preview.png');
  await js("[...document.querySelectorAll('.modal-footer button')].find((b) => b.textContent.includes('Import')).click()");
  await waitFor("document.querySelectorAll('#settings-user-memory .chat-memory-item').length === 4", 'the imported facts');
  await js("document.querySelector('#settings-user-memory').scrollIntoView()");
  await sleep(600);
  log('memory: ' + (await js("document.querySelector('#settings-user-memory').innerText")).replace(/\n+/g, ' | ').slice(0, 900));
  await shot('memory-section.png');
  const errors = await js('window.__errors');
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  log('memory section and import: OK');
}

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
