// A PC with several graphics cards, in the real app with stand-in cards (an RTX 3060 and two
// Tesla P40): the title bar shows each card, and the panel on the right draws one graph per card.
// With one card (`one`) the panel draws no graph. Saves a screenshot.
//   node_modules\electron\dist\electron.exe scripts\ui-gpucards-test.cjs [one]
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const single = process.argv.includes('one');
const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-gpucards', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), loadModelAtStart: false }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, 'ui-gpucards.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);

// The stand-in for nvidia-smi: three cards whose readings move, so the lines are not flat.
let tick = 0;
const hardware = require('../electron/lib/hardware.cjs');
hardware.nvidiaCards = async () => {
  tick += 1;
  const cards = [
    { name: 'NVIDIA GeForce RTX 3060', totalMB: 12288, usedMB: 9000 + (tick % 4) * 300, percent: [92, 64, 88, 71][tick % 4] },
    { name: 'Tesla P40', totalMB: 24576, usedMB: 15000 + tick * 200, percent: [35, 58, 22, 47][tick % 4] },
    { name: 'Tesla P40', totalMB: 24576, usedMB: 2000, percent: [0, 12, 5, 0][tick % 4] },
  ].map((card) => ({ ...card, freeMB: card.totalMB - card.usedMB }));
  return single ? cards.slice(0, 1) : cards;
};

async function run() {
  let window;
  for (let attempt = 0; attempt < 200 && !window; attempt += 1) {
    await sleep(150);
    [window] = BrowserWindow.getAllWindows();
  }
  if (!window) throw new Error('the app opened no window');
  // Wide enough for the panel on the right to be open from the start.
  window.setSize(1500, 950);
  const page = window.webContents;
  const ask = (code) => page.executeJavaScript(code, true).catch(() => null);
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await ask("Boolean(document.querySelector('.system-monitor'))")) break;
    await sleep(250);
  }
  if (!(await ask("Boolean(document.querySelector('.inspector'))"))) {
    await ask("[...document.querySelectorAll('button')].find((item) => /context|panel/i.test(item.getAttribute('aria-label') || item.title || ''))?.click()");
    await sleep(500);
  }
  if (!(await ask("Boolean(document.querySelector('.inspector'))"))) throw new Error('the panel on the right did not open');

  if (single) {
    await sleep(7000);
    const graphs = await ask("document.querySelectorAll('.gpu-card').length");
    const label = await ask("[...document.querySelectorAll('.monitor-label')].map((item) => item.textContent).join('|')");
    log(`one card: ${graphs} graphs, title bar ${label}`);
    if (graphs !== 0) throw new Error('one card should draw no graph');
    if (/×/.test(label || '')) throw new Error('one card should not be counted as several');
    return;
  }

  // A reading arrives every 5 seconds: wait for six, so there are lines to look at.
  let state = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(500);
    state = await ask(`(() => {
      const cards = [...document.querySelectorAll('.gpu-card')];
      return {
        names: cards.map((card) => card.querySelector('.gpu-card-head strong').textContent),
        values: cards.map((card) => card.querySelector('.gpu-card-values').textContent),
        points: cards.map((card) => (card.querySelector('polyline.is-gpu')?.getAttribute('points') || '').split(' ').filter(Boolean).length),
        monitor: [...document.querySelectorAll('.monitor-reading')].map((item) => item.textContent).join(' | '),
        title: [...document.querySelectorAll('.monitor-reading')].map((item) => item.title).find((text) => /Tesla P40/.test(text)) || '',
      };
    })()`);
    if (state?.points?.[0] >= 6) break;
  }
  log(`cards: ${JSON.stringify(state)}`);
  if (!state || state.names.length !== 3) throw new Error(`expected 3 graphs, found ${state?.names.length}`);
  if (state.names.join('|') !== '1 · RTX 3060|2 · Tesla P40|3 · Tesla P40') throw new Error(`card names: ${state.names.join('|')}`);
  if (!state.points.every((count) => count >= 4)) throw new Error(`lines too short: ${state.points}`);
  if (!/GPU \d+%/.test(state.values[0]) || !/VRAM \d+\.\d \/ 12\.0 GB/.test(state.values[0])) throw new Error(`reading of the first card: ${state.values[0]}`);
  if (!/GPU ×3/.test(state.monitor) || !/\d+ · \d+ · \d+%/.test(state.monitor)) throw new Error(`title bar: ${state.monitor}`);
  if (!/1\. NVIDIA GeForce RTX 3060: \d+% · /.test(state.title) || !/3\. Tesla P40/.test(state.title)) throw new Error(`title bar hint: ${state.title}`);
  if (!/60\.0 GB/.test(state.monitor)) throw new Error(`the cards' memory is not added up: ${state.monitor}`);

  // The pointer over a graph: a hairline, and the reading of that moment with how long ago it was.
  const box = await ask("(() => { const r = document.querySelector('.gpu-card-graph').getBoundingClientRect(); return { x: r.right - (r.width / 11) * 2, y: r.top + r.height / 2 }; })()");
  page.sendInputEvent({ type: 'mouseMove', x: Math.round(box.x), y: Math.round(box.y) });
  await sleep(400);
  const hover = await ask("({ hair: Boolean(document.querySelector('.gpu-card .gpu-crosshair')), when: document.querySelector('.gpu-card-when').textContent })");
  log(`hover: ${JSON.stringify(hover)}`);
  if (!hover?.hair || !/^\d+ s ago$/.test(hover.when)) throw new Error(`hover reading: ${JSON.stringify(hover)}`);
  fs.writeFileSync(path.join(shots, 'gpu-cards.png'), (await page.capturePage()).toPNG());

  // Nothing may stick out of the panel.
  const overflow = await ask("(() => { const panel = document.querySelector('.inspector').getBoundingClientRect(); return [...document.querySelectorAll('.gpu-cards, .gpu-card-graph, .gpu-card-values')].some((item) => item.getBoundingClientRect().right > panel.right + 0.5); })()");
  if (overflow) throw new Error('the graph is wider than the panel');

}

require('../electron/main.cjs');
app.whenReady().then(() => run()).then(() => app.exit(0)).catch((err) => {
  log(`UI TEST FAILED: ${err.message}`);
  app.exit(1);
});
