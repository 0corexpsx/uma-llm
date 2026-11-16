// Opens Settings → Skills in the real app, searches the skill library, installs a skill, and removes
// it again. It starts the app's own main process with its own data folder and a hidden window, and
// drives the page from inside Electron, so it needs no extra package.
//   node_modules\electron\dist\electron.exe scripts\ui-skills-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-skills', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
// English, so the texts below match whatever language this PC uses.
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace') }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (text) => fs.appendFileSync(path.join(shots, 'ui-skills.log'), `${text}\n`);
fs.rmSync(path.join(shots, 'ui-skills.log'), { force: true });

// Helpers that run inside the page.
const PAGE_HELPERS = `
  window.__errors = window.__errors || [];
  window.addEventListener('error', (event) => window.__errors.push(String(event.message)));
  window.__click = (selector, text) => {
    const items = [...document.querySelectorAll(selector)].filter((item) => !text || item.textContent.includes(text));
    if (!items.length) throw new Error('nothing to click: ' + selector + ' ' + (text || ''));
    items[0].click();
    return items.length;
  };
  window.__type = (selector, value) => {
    const input = document.querySelector(selector);
    if (!input) throw new Error('no input: ' + selector);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  window.__count = (selector) => document.querySelectorAll(selector).length;
  window.__text = (selector) => (document.querySelector(selector) || { innerText: '' }).innerText;
  true;
`;

async function run() {
  let window;
  for (let attempt = 0; attempt < 200 && !window; attempt += 1) {
    await sleep(150);
    [window] = BrowserWindow.getAllWindows();
  }
  if (!window) throw new Error('the app opened no window');
  const page = window.webContents;
  // Errors thrown in the page come back as text, so a failing step says which one and why.
  const js = async (code) => {
    const result = await page.executeJavaScript(`(async () => { try { return { value: await (${code}) }; } catch (error) { return { error: String(error && error.message || error) }; } })()`, true);
    if (result.error) throw new Error(`${result.error} — in: ${code.slice(0, 90)}`);
    return result.value;
  };
  const waitFor = async (code, label, timeout = 20000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await js(code).catch(() => false)) return;
      await sleep(150);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const shot = async (name) => fs.writeFileSync(path.join(shots, name), (await page.capturePage()).toPNG());
  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  await waitFor("Boolean(document.querySelector('.app'))", 'the app');
  await page.executeJavaScript(PAGE_HELPERS, true);
  await waitFor("Boolean(document.querySelector('.rail-bottom .rail-item'))", 'the navigation rail', 40000);
  await js("__click('.rail-bottom .rail-item')");
  await waitFor("Boolean(document.querySelector('#settings-skills .setting-row'))", 'the Skills section');
  await js("document.querySelector('#settings-skills').scrollIntoView()");
  await sleep(500);
  // The project search row in Settings → Workspace, once the background index is built.
  await waitFor("document.querySelector('.project-search-card') && !document.querySelector('.project-search-card').innerText.includes('Reading the workspace')", 'the project search status', 30000);
  log(`project search row: ${(await js("__text('.project-search-card')")).replace(/\n/g, ' | ').slice(0, 400)}`);
  await js("document.querySelector('.project-search-card').scrollIntoView()");
  await sleep(300);
  await shot('project-search.png');
  await js("document.querySelector('#settings-skills').scrollIntoView()");
  await sleep(300);
  const starters = await js("__count('#settings-skills .setting-row')");
  log(`installed skills shown: ${starters}`);
  assert(starters >= 20, `only ${starters} starter skills are listed`);
  await shot('skills-section.png');

  await js("__click('#settings-skills .runtime-actions button', 'Browse the library')");
  await waitFor("__count('.skill-library-row') > 0", 'the library list');
  await sleep(300);
  log(`library opened: ${await js("__text('.skill-library-count')")}; ${await js("__count('.skill-library-row')")} rows`);
  await js("__type('.skill-library-modal .skill-search-box input', 'docker compose')");
  await sleep(1000);
  const name = (await js("__text('.skill-library-row .skill-library-name')")).split('\n')[0].trim();
  log(`search "docker compose": ${await js("__text('.skill-library-count')")}; first result: ${name}`);
  await shot('skills-library.png');
  await js("__click('.skill-library-row .btn', 'Install')");
  await waitFor("Boolean(document.querySelector('.skill-library-row .skill-library-installed'))", 'the install to finish');
  log(`installed ${name}; on disk: ${fs.readdirSync(path.join(dataDir, 'skills', name)).join(', ')}`);
  await js("__click('.skill-library-modal .modal-footer .btn', 'Done')");
  await sleep(500);

  // The installed list has a filter box and the new skill, which can be removed again.
  await js(`__type('#settings-skills .skill-installed-filter input', ${JSON.stringify(name)})`);
  await sleep(400);
  const filtered = await js("__count('#settings-skills .setting-row')");
  assert(filtered === 1, `the filter shows ${filtered} skills instead of 1`);
  await shot('skills-filtered.png');
  await js("__click('#settings-skills .skill-controls button[title=\"Move this skill to the Recycle Bin\"]')");
  await sleep(1500);
  const still = fs.existsSync(path.join(dataDir, 'skills', name));
  log(`removed ${name}: ${still ? 'STILL ON DISK' : 'gone from the skills folder'}`);
  assert(!still, 'the skill was not removed');
  const errors = await js('window.__errors');
  assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  log('skills section and library: OK');
}

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
