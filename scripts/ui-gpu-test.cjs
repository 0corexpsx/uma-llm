// Memory of Uma's processes with the window drawn by the GPU or by the processor, in the real app
// (own data folder, hidden window). Saves a screenshot to check the window still draws correctly.
//   node_modules\electron\dist\electron.exe scripts\ui-gpu-test.cjs on|off
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const mode = process.argv.includes('off') ? 'off' : 'on';
const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', `ui-gpu-${mode}`, 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, loadModelAtStart: false, interfaceGpu: mode === 'on' }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, 'ui-gpu.log');
const log = (text) => fs.appendFileSync(logFile, `[GPU ${mode}] ${text}\n`);

/** Uma's processes by Chromium type, with their memory. */
function processes() {
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, WorkingSetSize, PrivatePageCount, CommandLine
$ids = @(${process.pid}); $found = $true
while ($found) { $found = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $found = $true } } }
$all | Where-Object { $ids -contains $_.ProcessId -and $_.Name -like 'electron*' } | ForEach-Object {
  $type = if ($_.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { 'main' }
  if ($_.CommandLine -match '--utility-sub-type=[a-z.]*\\.([A-Za-z]+)') { $type = $type + ':' + $matches[1] }
  '{0}|{1}|{2}' -f $type, [math]::Round($_.WorkingSetSize / 1MB), [math]::Round($_.PrivatePageCount / 1MB) }`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).toString()
    .split(/\r?\n/).filter(Boolean).map((line) => { const [type, ws, priv] = line.split('|'); return { type, ws: Number(ws), priv: Number(priv) }; });
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
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await page.executeJavaScript("Boolean(document.querySelector('.model-pill'))").catch(() => false)) break;
    await sleep(250);
  }
  await sleep(12000);
  try {
    // Graphics memory each process uses, from NVIDIA's own list (works when the driver reports it).
    const vram = execFileSync('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader'], { windowsHide: true }).toString().trim();
    const total = execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader'], { windowsHide: true }).toString().trim();
    log(`graphics memory in use on the whole PC: ${total}${vram ? `; compute apps: ${vram.replace(/\r?\n/g, ', ')}` : ''}`);
  } catch {}
  const status = app.getGPUFeatureStatus();
  log(`window drawn by: ${status.gpu_compositing}`);
  const list = processes();
  for (const item of list) log(`  ${item.type.padEnd(28)} ${String(item.ws).padStart(4)} MB in use, ${String(item.priv).padStart(4)} MB private`);
  log(`  total                        ${String(list.reduce((sum, item) => sum + item.ws, 0)).padStart(4)} MB in use, ${String(list.reduce((sum, item) => sum + item.priv, 0)).padStart(4)} MB private`);
  // Settings → Appearance, to see the switch and that the window draws normally.
  await page.executeJavaScript("document.querySelector('.rail-bottom .rail-item').click()");
  await sleep(1200);
  await page.executeJavaScript("document.getElementById('settings-appearance').scrollIntoView()");
  await sleep(600);
  fs.writeFileSync(path.join(shots, `gpu-${mode}.png`), (await page.capturePage()).toPNG());
}

require('../electron/main.cjs');
app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
