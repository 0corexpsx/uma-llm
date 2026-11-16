// Closing Uma's window must end Uma, even after the mouse-and-keyboard notice (a hidden window)
// has been shown. Before 0.2.74 Uma kept running unseen, and starting it again crashed with
// "Object has been destroyed". Real app, own data folder.
//   node_modules\electron\dist\electron.exe scripts\ui-close-test.cjs   (exit code 0 = closed)
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-close', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, loadModelAtStart: false }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';
process.env.UMA_TEST_INPUT_BANNER = '1';
process.env.UMA_TEST_CLOSE = '1';

const logFile = path.join(shots, 'ui-close.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${new Date().toISOString().slice(11, 23)} ${text}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const uma = require('../electron/main.cjs');
  await app.whenReady();
  for (let attempt = 0; attempt < 200 && !uma.mainWindow(); attempt += 1) await sleep(150);
  await sleep(1500);
  uma.showInputBanner('Uma is using the mouse and keyboard');
  await sleep(800);
  log(`windows open: ${BrowserWindow.getAllWindows().length} (main window + the notice)`);
  app.on('will-quit', () => log('Uma is quitting: OK'));
  // Nothing may stop it from closing: if it is still running after 25 s, that is the bug.
  setTimeout(() => { log(`STILL RUNNING 25 s after the window was closed (${BrowserWindow.getAllWindows().length} windows left): FAIL`); app.exit(1); }, 25000).unref();
  log('closing the main window, as the user does');
  uma.mainWindow().close();
}

main().catch((err) => { log(`UI TEST FAILED: ${err.stack || err.message}`); app.exit(1); });
