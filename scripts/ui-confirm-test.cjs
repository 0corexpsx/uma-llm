// "Don't ask again" in the terminal-command dialog, in the real app (own data folder, hidden window,
// the dialog answered by the test): after it, every command and install runs without a question, it
// is remembered in settings.json, and Settings → "Ask before each command" brings the question back.
//   node_modules\electron\dist\electron.exe scripts\ui-confirm-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-confirm', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, loadModelAtStart: false, allowShell: true }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';
process.env.UMA_TEST_CONFIRM = '1';

const logFile = path.join(shots, 'ui-confirm.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok, text) => { log(`${ok ? 'OK  ' : 'FAIL'} ${text}`); if (!ok) process.exitCode = 1; };

async function main() {
  const uma = require('../electron/main.cjs');
  await app.whenReady();
  for (let attempt = 0; attempt < 200 && !uma.mainWindow(); attempt += 1) await sleep(150);
  const asked = [];
  let answer = { response: 0, checkboxChecked: false };
  uma.setDialog(async (_window, options) => { asked.push(options); return answer; });

  check(await uma.confirmAction('run_command', 'dir') === true && asked.length === 1, 'first command: asked, Yes');
  check(/Don't ask again: run every terminal command/.test(asked[0].checkboxLabel), `the command dialog offers "Don't ask again" ("${asked[0].checkboxLabel.slice(0, 60)}…")`);
  answer = { response: 0, checkboxChecked: true };
  check(await uma.confirmAction('run_command', 'dir /s') === true && asked.length === 2, 'Yes with "Don\'t ask again" ticked');
  check(uma.store().getSettings().askBeforeCommands === false, 'remembered in the settings');
  check(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).askBeforeCommands === false, 'and written to settings.json, so it survives a restart');
  check(await uma.confirmAction('run_command', 'Get-Process') === true && asked.length === 2, 'next command runs without asking');
  check(await uma.confirmAction('install', 'winget install git') === true && asked.length === 2, 'installs too, without asking');
  answer = { response: 1, checkboxChecked: false };
  check(await uma.confirmAction('file:write_file', 'notes.md') === false && asked.length === 3, 'file changes still ask (not part of this choice)');

  // Settings → "Ask before each command" on again.
  const page = uma.mainWindow().webContents;
  await page.executeJavaScript("window.uma.updateSettings({ askBeforeCommands: true })", true);
  answer = { response: 1, checkboxChecked: false };
  check(await uma.confirmAction('run_command', 'dir') === false && asked.length === 4, 'with the question back on, a command asks again');

  // A picture of the Settings row.
  answer = { response: 0, checkboxChecked: true };
  await uma.confirmAction('run_command', 'dir');
  const window = BrowserWindow.fromWebContents(page);
  await page.executeJavaScript("document.querySelector('[data-view=settings], .rail-bottom .rail-item')?.click(); true", true);
  await sleep(1200);
  await page.executeJavaScript("[...document.querySelectorAll('*')].find((node) => node.childElementCount === 0 && node.textContent.trim() === 'Ask before each command')?.scrollIntoView({ block: 'center' }); true", true);
  await sleep(500);
  fs.writeFileSync(path.join(shots, 'confirm-settings.png'), (await window.webContents.capturePage()).toPNG());
}

main()
  .catch((err) => { log(`UI TEST FAILED: ${err.stack || err.message}`); process.exitCode = 1; })
  .finally(() => app.exit(process.exitCode || 0));
