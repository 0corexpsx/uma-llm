// Opens a chat that works in its own folder in the real app (folder menu, set-aside answer, Copy chat), with its own
// data folder and a hidden window, and saves screenshots in .shots.
//   node_modules\electron\dist\electron.exe scripts\ui-chatfolder-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-chatfolder', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace') }));
// A chat about a folder outside the workspace, whose reply has an answer set aside.
const engineDir = path.join(root, '.testdata', 'ui-chatfolder', 'GAME ENGINE NEW');
fs.mkdirSync(engineDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'conversations'), { recursive: true });
const now = new Date().toISOString();
fs.writeFileSync(path.join(dataDir, 'conversations', 'c_folder.json'), JSON.stringify({
  id: 'c_folder', title: 'Check the game engine', createdAt: now, updatedAt: now, preview: 'check the engine', folder: engineDir,
  messages: [
    { id: 'm_1', role: 'user', content: `check ${engineDir} how does it look?`, createdAt: now },
    { id: 'm_2', role: 'assistant', modelName: 'Mistral Small 3.2', createdAt: now, status: 'done', content: 'The engine has a src folder with main.cpp.', blocks: [
      { type: 'text', text: "I'm unable to access that path as it is outside of the workspace.", unchecked: true },
      { type: 'tool', id: 't_1', name: 'list_files', title: `Listed ${engineDir}`, status: 'done', summary: '7 entries', args: {}, output: '', error: '' },
      { type: 'text', text: 'The engine has a src folder with main.cpp.' },
    ] },
  ],
}));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => fs.appendFileSync(path.join(shots, 'ui-chatfolder.log'), `${text}\n`);
fs.rmSync(path.join(shots, 'ui-chatfolder.log'), { force: true });

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
  await waitFor("[...document.querySelectorAll('.thread-main')].some((el) => el.textContent.includes('Check the game engine'))", 'the chat in the list');
  await js("[...document.querySelectorAll('.thread-main')].find((el) => el.textContent.includes('Check the game engine')).click()");
  await waitFor("Boolean(document.querySelector('.message-text.is-unchecked'))", 'the set-aside answer');
  await js("document.querySelector('.folder-menu-wrap .context-chip').click()");
  await waitFor("Boolean(document.querySelector('.folder-dropdown'))", 'the folder menu');
  log('chip: ' + (await js("document.querySelector('.folder-menu-wrap .context-chip').innerText")).replace(/\n+/g, ' | '));
  log('menu: ' + (await js("document.querySelector('.folder-dropdown').innerText")).replace(/\n+/g, ' | '));
  log('eyebrow: ' + (await js("document.querySelector('.chat-title-block .eyebrow').innerText")));
  await sleep(400);
  await shot('chat-folder.png');
  await js("document.querySelector('.folder-menu-wrap .context-chip').click()");
  await js("document.querySelector('.chat-header-actions .icon-btn[title=\"Copy the whole chat\"]').click()");
  await sleep(500);

  log('copied: ' + String(await Promise.resolve(require('electron').clipboard.readText())).replace(/\n+/g, ' / ').slice(0, 400));
  const errors = await js('window.__errors');
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  log('chat folder menu, set-aside answer, copy chat: OK');
}

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
