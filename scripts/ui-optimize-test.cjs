// The Benchmark screen in the real app: "Optimize and benchmark" is there beside "Run benchmark",
// and a result that came from it lists what was tried, with the one that was kept. Saves a screenshot.
//   node_modules\electron\dist\electron.exe scripts\ui-optimize-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-optimize', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), loadModelAtStart: false, activeModelId: 'm' }));
// A stand-in model and engine (files that exist, never started): the screen shows results only with both.
const standIn = path.join(dataDir, 'stand-in.gguf');
fs.writeFileSync(standIn, 'not a model');
fs.writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify({ installed: [{ id: 'm', catalogId: '', name: 'Stand-in 27B', filename: 'stand-in.gguf', path: standIn, size: 11, sizeLabel: '30 GB', quant: 'Q8_0', imported: true, exists: true, addedAt: new Date().toISOString() }] }));
const engine = { version: 'b1', backend: 'cpu', serverPath: process.execPath, installedAt: new Date().toISOString() };
fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({ ...engine, installs: { cpu: engine } }));
// One stored run, as "Optimize and benchmark" leaves it.
fs.writeFileSync(path.join(dataDir, 'benchmarks.json'), JSON.stringify([{
  id: 'bench_test',
  createdAt: new Date().toISOString(),
  model: { id: 'm', name: 'Stand-in 27B', quant: 'Q8_0', size: 30 * 1024 ** 3 },
  device: { mode: 'GPU', backend: 'cuda', gpuName: '2× Tesla P40', offloadedLayers: 66, totalLayers: 66, gpuUtilAvg: 80, gpuUtilPeak: 95, vramUsedPeakMB: 31000 },
  speed: { tokensPerSecond: 12.55, promptTokensPerSecond: 60, firstTokenMs: 400, generationTokens: 128, promptTokens: 60, totalMs: 11000, loadMs: 20000, warmupMs: 900, maxTokens: 128, contextSize: 20480 },
  memory: { processPeakMB: 2100, processAvgMB: 2000, cpuAvgPercent: 4, cpuPeakPercent: 6, coresUsedAvg: 1.1, systemPeakGB: 12, systemTotalGB: 40, systemBeforeGB: 11 },
  samples: [],
  optimization: {
    changed: true,
    chosen: '2× Tesla P40 at the same time',
    tried: [
      { label: 'Current settings', tokensPerSecond: 8.95, failed: false, chosen: false },
      { label: 'All cards, one after the other', tokensPerSecond: 6.64, failed: false, chosen: false },
      { label: 'RTX 3060 alone', tokensPerSecond: null, failed: true, chosen: false },
      { label: '2× Tesla P40 at the same time', tokensPerSecond: 12.54, failed: false, chosen: true },
    ],
  },
}]));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, 'ui-optimize.log');
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
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await ask("Boolean(document.querySelector('.system-monitor'))")) break;
    await sleep(250);
  }
  // Open the Benchmark screen from the side bar.
  const opened = await ask("(() => { const item = [...document.querySelectorAll('button, a')].find((el) => /benchmark/i.test(`${el.getAttribute('aria-label') || ''} ${el.title || ''} ${el.textContent || ''}`)); if (item) item.click(); return Boolean(item); })()");
  if (!opened) throw new Error('no way to the Benchmark screen was found');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await ask("Boolean(document.querySelector('.benchmark-view'))")) break;
    await sleep(250);
  }
  await sleep(500);
  const state = await ask(`(() => {
    const view = document.querySelector('.benchmark-view');
    if (!view) return null;
    const buttons = [...view.querySelectorAll('button')].map((button) => ({ text: button.textContent.trim(), disabled: button.disabled }));
    const card = view.querySelector('.bench-optimization');
    return {
      optimize: buttons.filter((button) => button.text === 'Optimize and benchmark'),
      run: buttons.filter((button) => button.text === 'Run benchmark').length,
      note: card?.querySelector('p')?.textContent || '',
      rows: [...(card?.querySelectorAll('.bench-kv') || [])].map((row) => [row.querySelector('span').textContent.trim(), row.querySelector('strong').textContent.trim(), row.classList.contains('is-chosen')]),
      overflow: card ? card.getBoundingClientRect().right > view.getBoundingClientRect().right + 0.5 : false,
    };
  })()`);
  log(JSON.stringify(state));
  if (!state) throw new Error('the Benchmark screen did not open');
  if (state.optimize.length < 2) throw new Error(`"Optimize and benchmark" buttons: ${state.optimize.length}`);
  if (state.optimize.some((button) => button.disabled)) throw new Error('with a model and an engine the button must be on');
  if (!state.run) throw new Error('"Run benchmark" is gone');
  if (!/Fastest: 2× Tesla P40 at the same time\. It is saved/.test(state.note)) throw new Error(`the note: ${state.note}`);
  if (state.rows.length !== 4) throw new Error(`rows: ${JSON.stringify(state.rows)}`);
  if (state.rows[3].join('|') !== '2× Tesla P40 at the same time|12.5 tok/s|true') throw new Error(`the kept row: ${state.rows[3].join('|')}`);
  if (state.rows[2][1] !== 'did not load' || state.rows[0][2]) throw new Error(`rows: ${JSON.stringify(state.rows)}`);
  if (state.overflow) throw new Error('the list is wider than the screen');
  await ask("document.querySelector('.bench-optimization').scrollIntoView({ block: 'center' })");
  await sleep(300);
  fs.writeFileSync(path.join(shots, 'optimize.png'), (await page.capturePage()).toPNG());
}

require('../electron/main.cjs');
app.whenReady().then(() => run()).then(() => app.exit(0)).catch((err) => {
  log(`UI TEST FAILED: ${err.message}`);
  console.error(`UI TEST FAILED: ${err.message}`);
  app.exit(1);
});
