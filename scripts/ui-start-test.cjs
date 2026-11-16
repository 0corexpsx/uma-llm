// The start window in the real app (own data folder, hidden windows): Uma in her carrot shirt, the
// donation text in the chosen language, Ko-fi, the ADA QR code and address, the support email, and
// Continue opening Uma's main window (which stays hidden until then). Saves screenshots in .shots.
//   node_modules\electron\dist\electron.exe scripts\ui-start-test.cjs [en|it|ja|...]
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const language = ['en', 'it', 'es', 'ja', 'zh-CN', 'zh-TW'].find((code) => process.argv.includes(code)) || 'it';
const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', `ui-start-${language}`, 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
// "terms": a first start, so the licence window comes first, then the start window, then Uma.
const withTerms = process.argv.includes('terms');
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ ...(withTerms ? {} : { acceptedTermsVersion: require('../package.json').version }), language, workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, loadModelAtStart: false }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';
process.env.UMA_TEST_START_SCREEN = '1';

const ADA = 'addr1qy6m2qmylpmex6jyyvl93ptc9v7lwy2zgqjepvfunxn69uxrha4fzu8e85nxrz6zvkpyz7lypd4dv2ng9vdf37pakx5qnk5apg';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, 'ui-start.log');
const log = (text) => fs.appendFileSync(logFile, `[${language}] ${text}\n`);

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
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  return { js, waitFor };
}

async function windowWith(hashTest, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = BrowserWindow.getAllWindows().find((win) => hashTest(win.webContents.getURL()));
    if (found) return found;
    await sleep(150);
  }
  throw new Error(`no ${label}`);
}

async function run() {
  if (withTerms) {
    const terms = await windowWith((url) => url.endsWith('#terms'), 'licence window');
    const termsPage = helpers(terms.webContents);
    await termsPage.waitFor("Boolean(document.querySelector('.terms-text')) && !document.querySelector('.terms-foot .btn-primary').disabled", 'the licence');
    await termsPage.js("document.querySelector('.terms-foot .btn-primary').click()");
    log('licence accepted');
  }
  const start = await windowWith((url) => url.endsWith('#start'), 'start window');
  const { js, waitFor } = helpers(start.webContents);
  await waitFor("Boolean(document.querySelector('.start-view .uma-portrait')) && document.querySelector('.start-qr').naturalWidth > 0", 'Uma and the QR code');
  await sleep(900);
  const [width, height] = start.getContentSize();
  log(`start window: ${width}×${height}`);
  log(`text: ${await js("document.querySelector('.start-lead').innerText")}`);
  log(`buttons: ${await js("[...document.querySelectorAll('.start-view .btn, .start-view .start-link')].map((el) => el.innerText.trim()).join(' | ')")}`);
  const address = await js("document.querySelector('.start-ada-address').innerText.trim()");
  if (address !== ADA) throw new Error(`the address shown is ${address}`);
  log(`ADA address shown in full and correct; QR ${await js("document.querySelector('.start-qr').naturalWidth")} px`);
  log(`support: ${await js("document.querySelector('.start-support').innerText")}`);
  // Does everything fit in the window without scrolling?
  const overflow = await js('document.documentElement.scrollHeight - window.innerHeight');
  log(`fits without scrolling: ${overflow <= 0} (${overflow} px over)`);
  fs.writeFileSync(path.join(shots, `start-window-${language}.png`), (await start.webContents.capturePage()).toPNG());

  const main = await windowWith((url) => !url.includes('#'), 'main window');
  await helpers(main.webContents).waitFor("Boolean(document.querySelector('.rail'))", 'Uma behind the start window', 40000);
  if (main.isVisible()) throw new Error('the main window is shown before Continue');
  log('main window loaded and waiting, hidden');
  await js("document.querySelector('.start-continue').click()");
  for (let attempt = 0; attempt < 50 && !main.isVisible(); attempt += 1) await sleep(100);
  if (!main.isVisible()) throw new Error('the main window did not appear after Continue');
  for (let attempt = 0; attempt < 50 && !start.isDestroyed(); attempt += 1) await sleep(100);
  if (!start.isDestroyed()) throw new Error('the start window stayed open');
  log('Continue: start window closed, Uma shown: OK');
}

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
