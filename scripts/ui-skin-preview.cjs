// Screenshots of a proposed look (a CSS file injected into a hidden test window, with its own data
// folder and a sample chat). Nothing in the app changes.
//   node_modules\electron\dist\electron.exe scripts\ui-skin-preview.cjs <skin.css> <skin-name> [light|dark]
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

// With no .css file: the look as built, on every screen (skin name "built").
const cssFile = process.argv.find((arg) => arg.endsWith('.css'));
const skin = cssFile ? process.argv[process.argv.indexOf(cssFile) + 1] : 'built';
const theme = process.argv.includes('dark') ? 'dark' : 'light';
const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', `ui-skin-${skin}`, 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(dataDir, 'conversations'), { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', theme, workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, loadModelAtStart: false, lastConversationId: 'c_demo', allowInternet: true }));
const now = Date.now();
const at = (minutes) => new Date(now - minutes * 60000).toISOString();
fs.writeFileSync(path.join(dataDir, 'conversations', 'c_demo.json'), JSON.stringify({
  id: 'c_demo', title: 'Tidy the notes folder', createdAt: at(30), updatedAt: at(2), preview: 'Tidy the notes',
  messages: [
    { id: 'm1', role: 'user', createdAt: at(4), content: 'Can you look at the notes folder and tell me what is in it?' },
    { id: 'm2', role: 'assistant', modelName: 'Qwen3.8 27B', createdAt: at(3), status: 'done',
      content: 'The notes folder has two files:\n\n- **welcome.md** — a short introduction to the workspace\n- **questions.md** — five open questions about the project\n\nWant me to merge them into one `README.md`?',
      blocks: [
        { type: 'tool', id: 't1', name: 'list_files', title: 'Listed notes', status: 'done', summary: '2 entries', args: {}, output: '', error: '' },
        { type: 'tool', id: 't2', name: 'read_file', title: 'Read notes/questions.md', status: 'done', summary: '42 lines', args: {}, output: '', error: '' },
        { type: 'text', text: 'The notes folder has two files:\n\n- **welcome.md** — a short introduction to the workspace\n- **questions.md** — five open questions about the project\n\nWant me to merge them into one `README.md`?' },
      ] },
    { id: 'm3', role: 'user', createdAt: at(2), content: 'Yes, merge them.' },
  ],
}));
for (const [id, title, minutes] of [['c_2', 'Fix the build error in main.cpp', 80], ['c_3', 'Compare with the GitHub project', 300], ['c_4', 'Plan the website redesign', 1500]]) {
  fs.writeFileSync(path.join(dataDir, 'conversations', `${id}.json`), JSON.stringify({ id, title, createdAt: at(minutes), updatedAt: at(minutes), preview: title, messages: [{ id: `${id}m`, role: 'user', createdAt: at(minutes), content: title }] }));
}
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  let window;
  for (let attempt = 0; attempt < 200 && !window; attempt += 1) {
    await sleep(150);
    [window] = BrowserWindow.getAllWindows();
  }
  if (!window) throw new Error('the app opened no window');
  window.setSize(1440, 900);
  const page = window.webContents;
  const js = (code) => page.executeJavaScript(code, true);
  const css = cssFile ? fs.readFileSync(cssFile, 'utf8') : '';
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await js("Boolean(document.querySelector('.model-pill'))").catch(() => false)) break;
    await sleep(250);
  }
  if (css) await js(`(() => { const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.appendChild(style); document.documentElement.dataset.skin = ${JSON.stringify(skin)}; })()`);
  await sleep(1500);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `skin-${skin}-${name}.png`), (await page.capturePage()).toPNG());
  await shot('chat');
  await js("document.querySelector('.model-pill').click()");
  await sleep(500);
  await shot('chat-menu');
  await js("document.querySelector('.model-pill').click()");
  await js("document.querySelector('.rail-bottom .rail-item').click()");
  await sleep(1200);
  await shot('settings');
  await js("document.querySelector('.rail-item[data-view=\"status\"]').click()");
  await sleep(4500);
  await shot('status');
  if (css) return;
  const go = async (view, wait, name) => {
    await js(`document.querySelector('.rail-item[data-view="${view}"]').click()`);
    await sleep(wait);
    await shot(name);
  };
  await go('models', 2500, 'models');
  await go('benchmark', 1500, 'benchmark');
  await js("document.querySelector('.rail-bottom .rail-item').click()");
  await sleep(1000);
  await js("document.getElementById('settings-appearance').scrollIntoView()");
  await sleep(600);
  await shot('settings-appearance');
  await go('chat', 800, 'chat-again');
  await js("document.querySelector('.folder-menu-wrap .context-chip').click()");
  await sleep(500);
  await shot('folder-menu');
}

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    fs.appendFileSync(path.join(shots, 'ui-skin.log'), `FAILED ${skin}: ${err.message}\n`);
    app.exit(1);
  });
