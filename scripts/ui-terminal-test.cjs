// Turning on "Allow terminal commands" in the real Settings screen (own data folder, hidden window,
// any dialog answered by the test): from then on a command runs without a question, the row "Ask
// before each command" shows it off, and turning that row on brings the question back.
//   node_modules\electron\dist\electron.exe scripts\ui-terminal-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-terminal', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), loadModelAtStart: false, semanticSearch: false }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';
process.env.UMA_TEST_CONFIRM = '1';

const logFile = path.join(shots, 'ui-terminal.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (ok, text) => { log(`${ok ? 'OK  ' : 'FAIL'} ${text}`); if (!ok) process.exitCode = 1; };
const saved = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));

async function main() {
  const uma = require('../electron/main.cjs');
  await app.whenReady();
  for (let attempt = 0; attempt < 200 && !uma.mainWindow(); attempt += 1) await sleep(150);
  const asked = [];
  let answer = { response: 1, checkboxChecked: false };
  uma.setDialog(async (_window, options) => { asked.push(options.title); return answer; });
  const page = uma.mainWindow().webContents;
  uma.mainWindow().setSize(1400, 950);
  const js = (code) => page.executeJavaScript(`(async () => (${code}))()`, true);
  const waitFor = async (code, label, timeout = 30000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await js(code).catch(() => false)) return true;
      await sleep(250);
    }
    check(false, `timed out waiting for ${label}`);
    return false;
  };
  const toggle = (label) => `document.querySelector('#settings-agent button[role=switch][aria-label="${label}"]')`;

  await waitFor("Boolean(document.querySelector('.rail-bottom .rail-item'))", 'the navigation rail', 40000);
  await js("document.querySelector('.rail-bottom .rail-item').click()");
  await waitFor(`Boolean(${toggle('Allow terminal commands')})`, 'the Permissions section');
  check(await js(`${toggle('Allow terminal commands')}.getAttribute('aria-checked')`) === 'false', 'the terminal starts off');
  check(await js(`${toggle('Ask before each command')} === null`), 'and the row about asking is not shown yet');
  check(/without asking each time/.test(await js("document.querySelector('#settings-agent').innerText")), 'the terminal row says that commands will run without asking');

  // The switch.
  await js(`${toggle('Allow terminal commands')}.click()`);
  await waitFor(`${toggle('Allow terminal commands')}.getAttribute('aria-checked') === 'true' && Boolean(${toggle('Ask before each command')})`, 'the terminal on');
  check(saved().allowShell === true && saved().askBeforeCommands === false, 'saved: terminal on, no question for each command');
  check(await js(`${toggle('Ask before each command')}.getAttribute('aria-checked')`) === 'false', 'the row "Ask before each command" shows off');
  check(await uma.confirmAction('run_command', 'dir') === true && asked.length === 0, 'a command runs with no dialog');
  check(await uma.confirmAction('install', 'winget install git') === true && asked.length === 0, 'so does an install command');
  check(await uma.confirmAction('file:write_file', 'notes.md') === false && asked.length === 1, 'a file change still asks');
  await js(`${toggle('Ask before each command')}.scrollIntoView({ block: 'center' })`);
  await sleep(500);
  fs.writeFileSync(path.join(shots, 'terminal-on.png'), (await page.capturePage()).toPNG());

  // Whoever wants to approve each command turns the question on.
  await js(`${toggle('Ask before each command')}.click()`);
  await waitFor(`${toggle('Ask before each command')}.getAttribute('aria-checked') === 'true'`, 'the question on');
  check(saved().askBeforeCommands === true, 'saved: ask before each command');
  check(await uma.confirmAction('run_command', 'dir') === false && asked.length === 2, 'now a command asks, and "No" stops it');
  log(process.exitCode ? 'terminal switch: FAILED' : 'terminal switch: OK');
}

main().then(() => app.exit(process.exitCode || 0)).catch((err) => {
  log(`UI TEST FAILED: ${err.message}`);
  app.exit(1);
});
