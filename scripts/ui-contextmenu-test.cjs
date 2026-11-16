// The right-click menu in the real app (own data folder, hidden window): which items it shows, and
// that Paste in the message box and Copy of selected chat text really work (they are the same
// actions the menu items run).
//   node_modules\electron\dist\electron.exe scripts\ui-contextmenu-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, clipboard } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-contextmenu', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, loadModelAtStart: false }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';
process.env.UMA_TEST_CONTEXT_MENU = '1';

const logFile = path.join(shots, 'ui-contextmenu.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok, text) => { log(`${ok ? 'OK  ' : 'FAIL'} ${text}`); if (!ok) process.exitCode = 1; };

async function main() {
  const { contextMenuFor } = require('../electron/main.cjs');
  await app.whenReady();
  let window;
  for (let attempt = 0; attempt < 200 && !window; attempt += 1) {
    await sleep(150);
    [window] = BrowserWindow.getAllWindows();
  }
  const page = window.webContents;
  const js = (code) => page.executeJavaScript(code, true);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await js("Boolean(document.querySelector('textarea'))")) break;
    await sleep(200);
  }

  const labels = (params) => contextMenuFor(params).filter((item) => item.label).map((item) => `${item.label}${item.enabled === false ? ' (off)' : ''}`).join(', ');
  check(labels({ isEditable: true, selectionText: '', editFlags: { canPaste: true, canSelectAll: true } }) === 'Cut (off), Copy (off), Paste, Select all', 'message box, nothing selected: Paste and Select all');
  check(labels({ isEditable: true, selectionText: 'hi', editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } }) === 'Cut, Copy, Paste, Select all', 'message box with a selection: all four');
  check(labels({ isEditable: false, selectionText: 'The notes folder has two files', editFlags: { canCopy: true } }) === 'Copy', 'selected chat text: Copy');
  check(contextMenuFor({ isEditable: false, selectionText: '', editFlags: {} }).length === 0, 'nothing selected outside a field: no menu');
  check(page.listenerCount('context-menu') > 0, 'the window listens for right clicks');

  // Paste into the message box, as the menu's Paste does.
  clipboard.writeText('pasted with the right click');
  await js("(() => { const box = document.querySelector('textarea'); box.focus(); box.select(); return true; })()");
  page.paste();
  await sleep(400);
  const typed = await js("document.querySelector('textarea').value");
  check(typed === 'pasted with the right click', `Paste fills the message box ("${typed}")`);

  // Copy selected text from the page, as the menu's Copy does.
  clipboard.writeText('');
  await js("(() => { const box = document.querySelector('textarea'); box.blur(); const el = [...document.querySelectorAll('h1, h2, p')].find((node) => node.textContent.trim().length > 4); const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); return el.textContent.trim(); })()");
  page.copy();
  await sleep(300);
  const copied = String(await clipboard.readText()).trim();
  check(copied.length > 4, `Copy puts the selected text on the clipboard ("${copied.slice(0, 40)}")`);
}

main()
  .catch((err) => { log(`UI TEST FAILED: ${err.stack || err.message}`); process.exitCode = 1; })
  .finally(() => app.exit(process.exitCode || 0));
