// Memory checks in the real app with a real engine and model (own data folder, hidden window):
// - no PowerShell process stays running for the network speed;
// - the Benchmark screen runs, and leaving it unloads the model the benchmark loaded;
// - the memory of Uma's processes at each step.
//   set UMA_TEST_ENGINE=...\llama-server.exe  and  UMA_TEST_MODEL=...\model.gguf
//   node_modules\electron\dist\electron.exe scripts\ui-ram-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-ram', 'data');
const engine = process.env.UMA_TEST_ENGINE;
const modelFile = process.env.UMA_TEST_MODEL;
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'runtime.json'), JSON.stringify({ version: 'b12366', backend: 'cuda', serverPath: engine, installedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify({ installed: [
  { id: 'test:real', catalogId: '', name: 'Real test model', filename: path.basename(modelFile), path: modelFile, size: fs.statSync(modelFile).size, quant: 'Q4_K_M', addedAt: new Date().toISOString() },
] }));
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), activeModelId: 'test:real', semanticSearch: false, contextSize: 4096, loadModelAtStart: false }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, 'ui-ram.log');
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
fs.rmSync(logFile, { force: true });

/** This app's processes (Electron's own and the programs it started), with their memory. */
function processes() {
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize, CommandLine
$ids = @(${process.pid}); $found = $true
while ($found) { $found = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $found = $true } } }
$all | Where-Object { $ids -contains $_.ProcessId -and -not ($_.CommandLine -like '*Get-CimInstance*') } | ForEach-Object { '{0}|{1}' -f $_.Name, [math]::Round($_.WorkingSetSize / 1MB) }`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).toString()
    .split(/\r?\n/).filter(Boolean).map((line) => { const [name, mb] = line.split('|'); return { name, mb: Number(mb) }; });
}
function report(label) {
  const list = processes();
  const sum = (filter) => list.filter(filter).reduce((total, item) => total + item.mb, 0);
  log(`${label}: Uma ${sum((item) => /electron/i.test(item.name))} MB, engine ${sum((item) => /llama/i.test(item.name))} MB, PowerShell ${list.filter((item) => /powershell/i.test(item.name)).length} running (${sum((item) => /powershell/i.test(item.name))} MB), other: ${list.filter((item) => !/electron|llama|powershell|conhost/i.test(item.name)).map((item) => item.name).join(', ') || 'none'}`);
  return list;
}

async function run() {
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
      if (await js(code).catch(() => false)) return;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  await waitFor("Boolean(document.querySelector('.model-pill'))", 'the chat', 40000);
  await sleep(12000); // two rounds of title bar readings
  const speed = await js("document.querySelector('.system-monitor .monitor-reading .monitor-value')?.innerText || ''");
  log(`network reading in the title bar: ${speed}`);
  report('idle, chat open');

  await js("document.querySelector('.rail-item[data-view=\"benchmark\"]').click()");
  await waitFor("[...document.querySelectorAll('button')].some((el) => /Run benchmark/.test(el.innerText) && !el.disabled)", 'the Benchmark screen');
  await js("[...document.querySelectorAll('button')].find((el) => /Run benchmark/.test(el.innerText) && !el.disabled).click()");
  await waitFor("[...document.querySelectorAll('button')].some((el) => /Cancel benchmark/.test(el.innerText))", 'the benchmark to start', 20000);
  await waitFor("![...document.querySelectorAll('button')].some((el) => /Cancel benchmark/.test(el.innerText))", 'the benchmark to finish', 240000);
  await sleep(1500);
  const score = await js("document.querySelector('.bench-side-latest strong')?.innerText || ''");
  log(`benchmark finished: ${score.replace(/\n+/g, ' ')}`);
  report('after the benchmark, still on its screen');

  await js("document.querySelector('.rail-item[data-view=\"chat\"]').click()");
  await waitFor("!document.querySelector('.model-pill .model-dot.is-live')", 'the model to unload after leaving the Benchmark screen', 60000);
  await sleep(2500);
  const after = report('after leaving the Benchmark screen');
  if (after.some((item) => /llama/i.test(item.name))) throw new Error('the engine is still running');
  if (after.some((item) => /powershell/i.test(item.name))) throw new Error('a PowerShell process is still running');
  log('benchmark released, no resident PowerShell: OK');
}

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
