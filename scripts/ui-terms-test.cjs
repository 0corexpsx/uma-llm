// The licence window in the real app, with its own data folder and hidden windows.
//   node_modules\electron\dist\electron.exe scripts\ui-terms-test.cjs <step>
// Steps, run in this order (each is a separate start of Uma on the same data):
//   decline  — first start: the licence window shows; Decline closes Uma, nothing is saved
//   accept   — first start again: Accept opens Uma and saves this version
//   again    — same version: no licence window, Uma opens directly
//   update   — the accepted version is older: the window asks again and says Uma was updated
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const step = process.argv.find((arg) => ['decline', 'accept', 'again', 'update'].includes(arg)) || 'decline';
const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-terms', 'data');
const settingsFile = path.join(dataDir, 'settings.json');
fs.mkdirSync(shots, { recursive: true });
if (step === 'decline') {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ language: process.env.UI_TERMS_LANGUAGE || 'en', workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, loadModelAtStart: false }));
}
if (step === 'update') {
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, acceptedTermsVersion: '0.2.40' }));
}
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, 'ui-terms.log');
const log = (text) => fs.appendFileSync(logFile, `[${step}] ${text}\n`);
if (step === 'decline') fs.rmSync(logFile, { force: true });
const saved = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).acceptedTermsVersion || '(none)';

async function firstWindow() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [window] = BrowserWindow.getAllWindows();
    if (window) return window;
    await sleep(150);
  }
  throw new Error('no window opened');
}

function helpers(page) {
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
  return { js, waitFor };
}

async function run() {
  const window = await firstWindow();
  const page = window.webContents;
  const { js, waitFor } = helpers(page);
  if (step === 'again') {
    await waitFor("Boolean(document.querySelector('.app .model-pill, .app .rail'))", 'Uma itself', 40000);
    log(`opened directly, no licence window (windows: ${BrowserWindow.getAllWindows().length}); saved version ${saved()}`);
    return;
  }
  await waitFor("Boolean(document.querySelector('.terms-view .terms-text')) && document.querySelector('.terms-text').innerText.includes('GNU GENERAL PUBLIC LICENSE')", 'the licence window');
  log(`window title: ${window.getTitle()}`);
  log(`heading: ${await js("document.querySelector('.terms-head').innerText.replace(/\\n+/g, ' | ')")}`);
  log(`buttons: ${await js("[...document.querySelectorAll('.terms-foot button.btn')].map((el) => el.innerText.trim()).join(' | ')")}`);
  log(`mentions the Genesys Labs skill library: ${await js("document.querySelector('.terms-text').innerText.includes('assembled by Genesys Labs')")}`);
  window.setSize(780, 720);
  await sleep(300);
  fs.writeFileSync(path.join(shots, `terms-${step}.png`), (await page.capturePage()).toPNG());
  if (step === 'decline') {
    app.once('will-quit', () => log(`Uma is closing; saved version ${saved()}`));
    await js("[...document.querySelectorAll('.terms-foot button.btn')].find((el) => /Decline/.test(el.innerText)).click()");
    await sleep(8000);
    throw new Error('Uma did not close after Decline');
  }
  await js("[...document.querySelectorAll('.terms-foot button.btn')].find((el) => /Accept/.test(el.innerText)).click()");
  // The main window opens, then the licence window goes.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 1 && windows[0] !== window) break;
    await sleep(200);
  }
  const [main] = BrowserWindow.getAllWindows();
  if (!main || main === window) throw new Error('the main window did not replace the licence window');
  await helpers(main.webContents).waitFor("Boolean(document.querySelector('.app .rail'))", 'Uma itself', 40000);
  log(`accepted: Uma opened, licence window closed; saved version ${saved()}`);
}

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
