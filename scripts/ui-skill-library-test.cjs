// The skill library window in the real app (own data folder, hidden window): every skill shows as
// on, and switching one off keeps it from the model. Saves .shots/skill-library-on.png.
//   node_modules\electron\dist\electron.exe scripts\ui-skill-library-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-skill-library', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, loadModelAtStart: false }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';
const logFile = path.join(shots, 'ui-skill-library.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok, text) => { log(`${ok ? 'OK  ' : 'FAIL'} ${text}`); if (!ok) process.exitCode = 1; };

async function main() {
  require('../electron/main.cjs');
  await app.whenReady();
  let win;
  for (let i = 0; i < 200 && !win; i += 1) { await sleep(150); [win] = BrowserWindow.getAllWindows(); }
  const js = (code) => win.webContents.executeJavaScript(code, true);
  for (let i = 0; i < 200; i += 1) { if (await js("Boolean(document.querySelector('.rail'))")) break; await sleep(200); }
  await js("document.querySelector('.rail-bottom .rail-item').click(); true");
  await sleep(1500);
  await js("[...document.querySelectorAll('button')].find((b) => /Browse the library/.test(b.textContent)).click(); true");
  await sleep(2500);
  const rows = await js("[...document.querySelectorAll('.skill-library-row')].map((row) => ({ name: row.querySelector('.skill-library-name').firstChild.textContent, on: row.querySelector('[role=switch], input[type=checkbox], .toggle')?.getAttribute('aria-checked') ?? String(row.querySelector('input[type=checkbox]')?.checked) }))");
  check(rows.length > 0, `library rows shown: ${rows.length}`);
  check(rows.every((row) => row.on === 'true'), `every row is on (${rows.slice(0, 3).map((row) => `${row.name}=${row.on}`).join(', ')}…)`);
  const intro = await js("document.querySelector('.skill-library-modal .modal-copy').textContent");
  check(/skills are on/.test(intro), `the window says they are on: "${intro.slice(0, 60)}…"`);
  fs.writeFileSync(path.join(shots, 'skill-library-on.png'), (await win.webContents.capturePage()).toPNG());
}
main().catch((err) => { log(`UI TEST FAILED: ${err.stack}`); process.exitCode = 1; }).finally(() => app.exit(process.exitCode || 0));
