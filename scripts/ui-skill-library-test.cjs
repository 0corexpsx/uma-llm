// The skill library window in the real app (own data folder, hidden window): how many skills the
// model can be given, and the ones that need a connector of another assistant, which are listed
// with a mark and never given to it. Saves .shots/skill-library.png and skill-library-connector.png.
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
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, onboarded: true }));
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
  for (let i = 0; i < 200 && !win; i += 1) { await sleep(150); win = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes('#')); }
  const js = async (code) => {
    const result = await win.webContents.executeJavaScript(`(async () => { try { return { value: await (${code}) }; } catch (error) { return { error: String(error && error.message || error) }; } })()`, true);
    if (result.error) throw new Error(`${result.error} — in: ${code.slice(0, 90)}`);
    return result.value;
  };
  const waitFor = async (code, label, timeout = 40000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await js(code).catch(() => false)) return;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const number = (text) => Number(String(text).replace(/[^\d]/g, ''));

  await waitFor("Boolean(document.querySelector('.rail-bottom .rail-item'))", 'the navigation rail');
  await js("document.querySelector('.rail-bottom .rail-item').click()");
  await waitFor("Boolean(document.querySelector('#settings-skills'))", 'the Skills section');
  await waitFor("/Advance Skills Pack/.test(document.querySelector('#settings-skills').innerText)", 'the library row');
  const row = await js("[...document.querySelectorAll('#settings-skills .setting-row, #settings-skills .settings-card')].map((el) => el.innerText).find((text) => /Advance Skills Pack/.test(text))");
  log(`Settings row: ${row.replace(/\s+/g, ' ').slice(0, 200)}`);
  const total = number(/\(([\d.,\s]+) skills\)/.exec(row)?.[1]);
  const enabled = number(/([\d.,\s]+) skills are always enabled/.exec(row)?.[1]);
  check(total > 1000, `the library holds ${total} skills`);
  check(enabled > 0 && enabled < total, `fewer are given to the model than the library holds: ${enabled} of ${total}`);

  await js("[...document.querySelectorAll('button')].find((b) => /Browse the library/.test(b.textContent)).click()");
  await waitFor("document.querySelectorAll('.skill-library-row').length > 0", 'the library list');
  const intro = await js("document.querySelector('.skill-library-modal .modal-copy').textContent");
  log(`Library window: ${intro}`);
  const usable = number(/All ([\d.,\s]+) skills/.exec(intro)?.[1]);
  const linked = number(/([\d.,\s]+) more work only through a connector/.exec(intro)?.[1]);
  check(linked > 0 && usable + linked === total, `usable ${usable} + needing a connector ${linked} = ${total}`);
  fs.writeFileSync(path.join(shots, 'skill-library.png'), (await win.webContents.capturePage()).toPNG());

  // The filter shows only those, each with its mark; they can still be installed, to read or adapt.
  await js("(() => { const select = document.querySelector('.skill-library-search select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(select, 'connector'); select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  await waitFor(`/of ${linked.toLocaleString('en-US')}|of ${linked}/.test(document.querySelector('.skill-library-count').textContent.replace(/[.,\\s]/g, '').replace('of', 'of '))`, 'the filtered list').catch(() => {});
  await sleep(600);
  const rows = await js("[...document.querySelectorAll('.skill-library-row')].map((item) => ({ name: item.querySelector('.skill-library-name').firstChild.textContent, marked: /Needs a connector/.test(item.querySelector('.skill-library-name').textContent), install: Boolean(item.querySelector('.skill-library-actions button')) }))");
  check(rows.length > 0 && rows.every((item) => item.marked), `every row of the filter is marked "Needs a connector" (${rows.length} shown: ${rows.slice(0, 3).map((item) => item.name).join(', ')}…)`);
  check(rows.every((item) => item.install), 'each can still be installed');
  const count = await js("document.querySelector('.skill-library-count').textContent");
  check(number(/of ([\d.,\s]+)/.exec(count)?.[1]) === linked, `the filter counts ${linked}: "${count}"`);
  fs.writeFileSync(path.join(shots, 'skill-library-connector.png'), (await win.webContents.capturePage()).toPNG());
}
main().catch((err) => { log(`UI TEST FAILED: ${err.stack}`); process.exitCode = 1; }).finally(() => app.exit(process.exitCode || 0));
