// "Optimize and benchmark" and what goes with it, in the real app:
// - the Benchmark screen has the button beside "Run benchmark", and a result that came from it
//   lists what was tried with what was kept (with `old`: a result as 0.2.91 and 0.2.92 saved it);
// - Settings has "Get ready while I type";
// - a model's settings can be searched ("Find a setting…"), and a model with a head of its own
//   for guessing ahead (MTP) has the switch for it.
// Saves screenshots.
//   node_modules\electron\dist\electron.exe scripts\ui-optimize-test.cjs [old]
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');
const { makeGguf } = require('./tiny-gguf.cjs');

const old = process.argv.includes('old');
const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-optimize', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), loadModelAtStart: false, activeModelId: 'm' }));
// Getting ready while the user types: what the screen asks of the app is recorded here instead of
// being done (the stand-in engine must never be started).
const warmed = [];
require('../electron/lib/agent.cjs').AgentRunner.prototype.warm = function warm(conversationId) {
  warmed.push(conversationId || null);
  return Promise.resolve(false);
};
// A stand-in model (a small but real GGUF file, with a head for guessing ahead) and a stand-in
// engine that is never started: the screens show results and settings only with both.
const standIn = path.join(dataDir, 'stand-in.gguf');
fs.writeFileSync(standIn, makeGguf({ architecture: 'qwen35', layers: 4, extra: { 'qwen35.nextn_predict_layers': 1 } }));
fs.writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify({ installed: [{ id: 'm', catalogId: '', name: 'Stand-in 27B', filename: 'stand-in.gguf', path: standIn, size: fs.statSync(standIn).size, sizeLabel: '30 GB', quant: 'Q8_0', imported: true, exists: true, addedAt: new Date().toISOString() }] }));
const engine = { version: 'b1', backend: 'cpu', serverPath: process.execPath, installedAt: new Date().toISOString() };
fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({ ...engine, installs: { cpu: engine } }));
// One stored run, as "Optimize and benchmark" leaves it.
const optimization = old ? {
  changed: true,
  chosen: '2× Tesla P40 at the same time',
  tried: [
    { label: 'Current settings', tokensPerSecond: 8.95, failed: false, chosen: false },
    { label: 'All cards, one after the other', tokensPerSecond: 6.64, failed: false, chosen: false },
    { label: 'RTX 3060 alone', tokensPerSecond: null, failed: true, chosen: false },
    { label: '2× Tesla P40 at the same time', tokensPerSecond: 12.54, failed: false, chosen: true },
  ],
} : {
  changed: true,
  kept: ['2× Tesla P40 at the same time', 'Context of 65,536 tokens'],
  tried: [
    { label: 'Current settings', write: 12.53, prose: 10.67, code: 14.39, read: 279, failed: false, kept: false },
    { label: 'All cards at the same time', write: 18.31, prose: 15.02, code: 21.6, read: 226, failed: false, kept: false },
    { label: 'RTX 3060 alone', write: null, prose: null, code: null, read: null, failed: true, kept: false },
    { label: '2× Tesla P40 at the same time', write: 23.47, prose: 19.37, code: 27.57, read: 254, failed: false, kept: true },
    { label: 'Without guessing ahead', write: 12.56, prose: 12.56, code: 12.56, read: 265, failed: false, kept: false },
    { label: 'Context of 65,536 tokens', write: 23.81, prose: 19.65, code: 27.96, read: 255, failed: false, kept: true },
  ],
};
fs.writeFileSync(path.join(dataDir, 'benchmarks.json'), JSON.stringify([{
  id: 'bench_test',
  createdAt: new Date().toISOString(),
  model: { id: 'm', name: 'Stand-in 27B', quant: 'Q8_0', size: 30 * 1024 ** 3 },
  device: { mode: 'GPU', backend: 'cuda', gpuName: '2× Tesla P40', offloadedLayers: 66, totalLayers: 66, gpuUtilAvg: 80, gpuUtilPeak: 95, vramUsedPeakMB: 31000 },
  speed: { tokensPerSecond: 19.57, promptTokensPerSecond: 60, firstTokenMs: 400, generationTokens: 128, promptTokens: 60, totalMs: 11000, loadMs: 20000, warmupMs: 900, maxTokens: 128, contextSize: 65536 },
  memory: { processPeakMB: 2100, processAvgMB: 2000, cpuAvgPercent: 4, cpuPeakPercent: 6, coresUsedAvg: 1.1, systemPeakGB: 12, systemTotalGB: 40, systemBeforeGB: 11 },
  samples: [],
  optimization,
}]));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, `ui-optimize${old ? '-old' : ''}.log`);
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);

async function run() {
  let window;
  for (let attempt = 0; attempt < 200 && !window; attempt += 1) {
    await sleep(150);
    [window] = BrowserWindow.getAllWindows();
  }
  if (!window) throw new Error('the app opened no window');
  window.setSize(1500, 950);
  const page = window.webContents;
  const ask = (code) => page.executeJavaScript(code, true).catch(() => null);
  const waitFor = async (code, what, tries = 60) => {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (await ask(code)) return;
      await sleep(250);
    }
    throw new Error(`${what} did not appear`);
  };
  await waitFor("Boolean(document.querySelector('.system-monitor'))", 'the app', 160);

  // The Benchmark screen.
  await waitFor("Boolean(document.querySelector('.rail-item[data-view=\"benchmark\"]'))", 'the way to the Benchmark screen');
  await ask("document.querySelector('.rail-item[data-view=\"benchmark\"]').click()");
  await waitFor("Boolean(document.querySelector('.benchmark-view .bench-optimization'))", 'the result of an optimizing run');
  await sleep(400);
  const state = await ask(`(() => {
    const view = document.querySelector('.benchmark-view');
    const buttons = [...view.querySelectorAll('button')].map((button) => ({ text: button.textContent.trim(), disabled: button.disabled }));
    const card = view.querySelector('.bench-optimization');
    return {
      optimize: buttons.filter((button) => button.text === 'Optimize and benchmark'),
      run: buttons.filter((button) => button.text === 'Run benchmark').length,
      note: card.querySelector('p').textContent,
      rows: [...card.querySelectorAll('.bench-kv')].map((row) => [row.querySelector('span').textContent.trim(), row.querySelector('strong').textContent.trim(), row.classList.contains('is-chosen'), row.title || '']),
      overflow: card.getBoundingClientRect().right > view.getBoundingClientRect().right + 0.5,
    };
  })()`);
  log(JSON.stringify(state));
  if (!state) throw new Error('the Benchmark screen could not be read');
  if (state.optimize.length < 2) throw new Error(`"Optimize and benchmark" buttons: ${state.optimize.length}`);
  if (state.optimize.some((button) => button.disabled)) throw new Error('with a model and an engine the button must be on');
  if (!state.run) throw new Error('"Run benchmark" is gone');
  if (state.overflow) throw new Error('the list is wider than the screen');
  const row = (label) => state.rows.find((item) => item[0] === label) || [];
  if (old) {
    if (!/^Kept: 2× Tesla P40 at the same time\. Saved in this model/.test(state.note)) throw new Error(`the note of an older result: ${state.note}`);
    if (state.rows.length !== 4 || row('2× Tesla P40 at the same time').slice(1, 3).join('|') !== '12.5 tok/s|true') throw new Error(`rows of an older result: ${JSON.stringify(state.rows)}`);
    if (row('RTX 3060 alone')[1] !== 'did not load' || row('Current settings')[2]) throw new Error(`rows of an older result: ${JSON.stringify(state.rows)}`);
    return;
  }
  if (!/^Kept: 2× Tesla P40 at the same time · Context of 65,536 tokens\. Saved in this model/.test(state.note)) throw new Error(`the note: ${state.note}`);
  if (state.rows.length !== 6) throw new Error(`rows: ${JSON.stringify(state.rows)}`);
  if (row('2× Tesla P40 at the same time').slice(1, 3).join('|') !== '23.5 tok/s · reads 254|true') throw new Error(`the kept row: ${row('2× Tesla P40 at the same time').join('|')}`);
  if (row('2× Tesla P40 at the same time')[3] !== 'Prose 19.4 tok/s · code 27.6 tok/s') throw new Error(`the kept row's hint: ${row('2× Tesla P40 at the same time')[3]}`);
  if (row('Context of 65,536 tokens')[2] !== true || row('Without guessing ahead')[2] !== false) throw new Error(`what is marked as kept: ${JSON.stringify(state.rows)}`);
  if (row('RTX 3060 alone')[1] !== 'did not load') throw new Error(`a step that did not load: ${row('RTX 3060 alone').join('|')}`);
  await ask("document.querySelector('.bench-optimization').scrollIntoView({ block: 'center' })");
  await sleep(300);
  fs.writeFileSync(path.join(shots, 'optimize.png'), (await page.capturePage()).toPNG());

  // The first character of a message asks the app to get the model ready, once for that message.
  const write = (text) => ask(`(() => { const box = document.querySelector('.composer textarea, textarea'); if (!box) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(text)}); box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await ask("document.querySelector('.rail-item[data-view=\"chat\"]').click()");
  await waitFor("Boolean(document.querySelector('textarea'))", 'the message box');
  if (warmed.length) throw new Error('nothing is got ready before a message is begun');
  await write('h');
  await sleep(500);
  await write('hello there');
  await sleep(500);
  log(`asked to get ready: ${JSON.stringify(warmed)}`);
  if (warmed.length !== 1) throw new Error(`one message asks once to get ready, not ${warmed.length} times`);
  await write('');
  await sleep(300);
  await write('again');
  await sleep(500);
  if (warmed.length !== 2) throw new Error(`a new message asks again: ${warmed.length}`);
  await write('');

  // Settings: the switch for it is on by default, and turned off, a message asks for nothing.
  await ask("(document.querySelector('.rail-item[data-view=\"settings\"]') || document.querySelector('.rail-bottom .rail-item')).click()");
  await waitFor("Boolean(document.querySelector('[role=switch][aria-label=\"Get ready while I type\"]'))", 'the "Get ready while I type" switch');
  const ready = () => ask("document.querySelector('[role=switch][aria-label=\"Get ready while I type\"]').getAttribute('aria-checked')");
  if ((await ready()) !== 'true') throw new Error(`"Get ready while I type" is on unless turned off: ${await ready()}`);
  await ask("document.querySelector('[role=switch][aria-label=\"Get ready while I type\"]').click()");
  await waitFor("document.querySelector('[role=switch][aria-label=\"Get ready while I type\"]').getAttribute('aria-checked') === 'false'", 'the switch turned off');
  await ask("document.querySelector('.rail-item[data-view=\"chat\"]').click()");
  await waitFor("Boolean(document.querySelector('textarea'))", 'the message box');
  await write('hello');
  await sleep(600);
  if (warmed.length !== 2) throw new Error(`with the switch off nothing is got ready: ${warmed.length}`);
  await write('');

  // A model's settings: the switch for its own head (this stand-in has one), and the search box.
  await ask("document.querySelector('.rail-item[data-view=\"models\"]').click()");
  await waitFor("Boolean(document.querySelector('button[aria-label=\"Settings for Stand-in 27B\"]'))", "the model's settings button");
  await ask("document.querySelector('button[aria-label=\"Settings for Stand-in 27B\"]').click()");
  await waitFor("Boolean(document.querySelector('.mset-body .mset-search'))", "the model's settings");
  const labels = "[...document.querySelectorAll('.mset-body .field-label')].map((item) => item.textContent.trim())";
  const all = await ask(labels);
  log(`settings: ${JSON.stringify(all)}`);
  if (!all.includes('Guess ahead with the model’s own head (MTP)') || !all.includes('Guess repeated text (n-gram)')) throw new Error(`the guessing switches: ${JSON.stringify(all)}`);
  if (all.includes('Graphics cards used')) throw new Error('a PC whose engine lists no cards has no cards to choose');
  const type = (text) => ask(`(() => { const input = document.querySelector('.mset-search'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await type('guess');
  await sleep(300);
  const found = await ask(labels);
  const hidden = await ask("getComputedStyle(document.querySelector('.mset-body h4')).display");
  log(`found for "guess": ${JSON.stringify(found)}, headings ${hidden}`);
  // The three settings about guessing: the two switches, and the draft model, whose explanation says "guesses".
  if (found.join('|') !== 'Guess ahead with the model’s own head (MTP)|Guess repeated text (n-gram)|Draft model') throw new Error(`searching for "guess" shows: ${JSON.stringify(found)}`);
  if (hidden !== 'none') throw new Error('the headings stay while searching');
  fs.writeFileSync(path.join(shots, 'settings-search.png'), (await page.capturePage()).toPNG());
  await type('context');
  await sleep(300);
  const context = await ask(labels);
  if (!context.includes('Context Length')) throw new Error(`searching for "context" shows: ${JSON.stringify(context)}`);
  await type('');
  await sleep(300);
  if ((await ask(labels)).length !== all.length) throw new Error('an empty search box shows every setting again');
}

require('../electron/main.cjs');
app.whenReady().then(() => run()).then(() => app.exit(0)).catch((err) => {
  log(`UI TEST FAILED: ${err.message}`);
  console.error(`UI TEST FAILED: ${err.message}`);
  app.exit(1);
});
