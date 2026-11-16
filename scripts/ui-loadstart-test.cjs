// With a real engine and a real model: Uma loads the model as it opens, "Stop model and free memory"
// unloads it, "Load model" loads it again. Uses its own data folder and a hidden window.
//   set UMA_TEST_ENGINE=...\llama-server.exe  and  UMA_TEST_MODEL=...\model.gguf
//   node_modules\electron\dist\electron.exe scripts\ui-loadstart-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-loadstart', 'data');
const engine = process.env.UMA_TEST_ENGINE;
const modelFile = process.env.UMA_TEST_MODEL;
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({ version: process.env.UMA_TEST_ENGINE_BUILD || 'b12366', backend: 'cuda', serverPath: engine, installedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify({ installed: [
  { id: 'test:real', catalogId: '', name: 'Real test model', filename: path.basename(modelFile), path: modelFile, size: fs.statSync(modelFile).size, quant: 'Q4_K_M', addedAt: new Date().toISOString() },
] }));
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), activeModelId: 'test:real', semanticSearch: false, contextSize: 4096 }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, 'ui-loadstart.log');
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
fs.rmSync(logFile, { force: true });
const vram = () => {
  try { return `${execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { windowsHide: true }).toString().trim()} MiB of VRAM in use`; } catch { return 'VRAM unknown'; }
};
const engines = () => {
  try { return execFileSync('tasklist', ['/FI', 'IMAGENAME eq llama-server.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }).toString().split(/\r?\n/).filter((line) => line.includes('llama-server')).length; } catch { return -1; }
};

async function run() {
  const before = engines();
  let window;
  for (let attempt = 0; attempt < 200 && !window; attempt += 1) {
    await sleep(150);
    [window] = BrowserWindow.getAllWindows();
  }
  if (!window) throw new Error('the app opened no window');
  window.setSize(1500, 950);
  const page = window.webContents;
  const js = async (code) => {
    const result = await page.executeJavaScript(`(async () => { try { return { value: await (${code}) }; } catch (error) { return { error: String(error && error.message || error) }; } })()`, true);
    if (result.error) throw new Error(`${result.error} — in: ${code.slice(0, 90)}`);
    return result.value;
  };
  const waitFor = async (code, label, timeout = 30000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await js(code).catch(() => false)) return Date.now() - started;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  await waitFor("Boolean(document.querySelector('.model-pill'))", 'the chat', 40000);
  log(`at start: ${vram()}`);
  // Nothing is sent: the model must come up by itself.
  const took = await waitFor("Boolean(document.querySelector('.model-pill .model-dot.is-live'))", 'the model to load by itself', 180000);
  log(`model loaded by itself ${Math.round(took / 1000)} s after the window opened: ${vram()}, engines running: ${engines() - before}`);
  log('button: ' + (await js("document.querySelector('.model-power button').innerText.trim()")));
  await js("document.querySelector('.model-power button').click()");
  await waitFor("!document.querySelector('.model-pill .model-dot.is-live') && /Load model/.test(document.querySelector('.model-power button').innerText)", 'the model to stop', 60000);
  await sleep(2500);
  log(`after Stop: ${vram()}, engines running: ${engines() - before}; button: ${await js("document.querySelector('.model-power button').innerText.trim()")}`);
  await js("document.querySelector('.model-power button').click()");
  await waitFor("Boolean(document.querySelector('.model-pill .model-dot.is-live'))", 'the model to load again', 180000);
  log(`after Load: ${vram()}, engines running: ${engines() - before}`);
  await js("document.querySelector('.model-power button').click()");
  await waitFor("!document.querySelector('.model-pill .model-dot.is-live')", 'the model to stop', 60000);
  await sleep(1500);
  log('load at start, stop, load: OK');
}

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
