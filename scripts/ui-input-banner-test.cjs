// The notice shown while the AI uses the mouse and keyboard, and the Ctrl+Alt+Esc emergency stop,
// in the real app (own data folder). Saves a picture of the notice in .shots.
//   node_modules\electron\dist\electron.exe scripts\ui-input-banner-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-input-banner', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'it', workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, loadModelAtStart: false }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';
process.env.UMA_TEST_INPUT_BANNER = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, 'ui-input-banner.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);

async function run(main) {
  for (let attempt = 0; attempt < 200 && !BrowserWindow.getAllWindows().length; attempt += 1) await sleep(150);
  await sleep(1500);
  log(`Ctrl+Alt+Esc registered: ${main.globalShortcut.isRegistered(main.STOP_SHORTCUT)}`);
  main.showInputBanner('Uma sta usando mouse e tastiera — Ctrl+Alt+Esc o angolo in alto a sinistra per fermare');
  await sleep(1200);
  const banner = main.inputBannerWindow();
  if (!banner || !banner.isVisible()) throw new Error('the notice is not shown');
  log(`notice: visible ${banner.isVisible()}, on top ${banner.isAlwaysOnTop()}, can take focus ${banner.isFocusable()}, bounds ${JSON.stringify(banner.getBounds())}`);
  fs.writeFileSync(path.join(shots, 'input-banner.png'), (await banner.webContents.capturePage()).toPNG());
  main.stopInput();
  await sleep(800);
  log(`after the stop: ${(await banner.webContents.executeJavaScript('document.body.innerText')).trim()}`);
  await sleep(6500);
  log(`a few seconds later the notice is hidden: ${!banner.isVisible()}`);
  log('notice and emergency stop: OK');
}

const main = require('../electron/main.cjs');
app.whenReady().then(() => run(main))
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
