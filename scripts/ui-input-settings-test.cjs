// Settings → Permissions in the real app: the "Control the mouse and keyboard" switch asks first,
// and turns on only after the box is ticked. Screenshots in .shots.
//   node_modules\electron\dist\electron.exe scripts\ui-input-settings-test.cjs [lang]
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const language = ['en', 'it', 'es', 'ja', 'zh-CN', 'zh-TW'].find((code) => process.argv.includes(code)) || 'en';
const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-input-settings', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language, workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, loadModelAtStart: false }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, 'ui-input-settings.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `[${language}] ${text}\n`);

async function run() {
  let window;
  for (let attempt = 0; attempt < 200 && !window; attempt += 1) {
    await sleep(150);
    [window] = BrowserWindow.getAllWindows();
  }
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
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const settingsFile = path.join(dataDir, 'settings.json');
  const saved = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).allowInput;
  await waitFor("Boolean(document.querySelector('.rail-bottom .rail-item'))", 'the app', 40000);
  await js("document.querySelector('.rail-bottom .rail-item').click()");
  await waitFor("Boolean(document.querySelector('#settings-agent'))", 'Settings');
  const row = "[...document.querySelectorAll('.setting-row')].find((el) => el.querySelector('[aria-label]') && el.querySelector('.toggle[aria-label]') && /mouse|tastiera|ratón|マウス|鼠标|滑鼠/i.test(el.innerText))";
  await waitFor(`Boolean(${row})`, 'the mouse and keyboard row');
  await js(`(${row}).scrollIntoView({ block: 'center' })`);
  await sleep(400);
  log(`row: ${(await js(`(${row}).innerText`)).replace(/\n+/g, ' | ').slice(0, 220)}`);
  await js(`(${row}).querySelector('.toggle').click()`);
  await waitFor("Boolean(document.querySelector('.pc-access-modal'))", 'the warning');
  await sleep(400);
  log(`warning: ${(await js("document.querySelector('.pc-access-modal').innerText")).replace(/\n+/g, ' | ').slice(0, 260)}…`);
  const disabled = await js("[...document.querySelectorAll('.pc-access-modal .btn-danger')].at(-1).disabled");
  log(`confirm button disabled until the box is ticked: ${disabled}`);
  fs.writeFileSync(path.join(shots, `input-warning-${language}.png`), (await page.capturePage()).toPNG());
  if (saved()) throw new Error('it was turned on before confirming');
  await js("document.querySelector('.pc-access-modal .pc-consent input').click()");
  await js("[...document.querySelectorAll('.pc-access-modal .btn-danger')].at(-1).click()");
  await waitFor("!document.querySelector('.pc-access-modal')", 'the warning to close');
  await sleep(500);
  log(`after confirming: allowInput saved as ${saved()}`);
  if (saved() !== true) throw new Error('not turned on after confirming');
  await js(`(${row}).querySelector('.toggle').click()`);
  await sleep(600);
  log(`switched off again: allowInput saved as ${saved()}`);
  log('mouse and keyboard switch: OK');
}

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
