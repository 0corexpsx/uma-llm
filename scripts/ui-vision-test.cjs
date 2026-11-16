// "Download vision file" in the real app (own data folder, hidden window), for models whose
// repository has no vision file. Each model is only its file header (the first 24 MB, which hold the
// names and sizes), so nothing big is downloaded; the vision download that starts is cancelled at once.
//   node_modules\electron\dist\electron.exe scripts\ui-vision-test.cjs     (needs internet)
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-vision', 'data');
const cacheDir = path.join(root, '.testdata', 'ui-vision-headers');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';

const logFile = path.join(shots, 'ui-vision.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MODELS = [
  {
    id: 'test:qwen38-abliterated-novision',
    name: 'Qwen3.8 27B abliterated (a copy without a vision file)',
    url: 'https://huggingface.co/mradermacher/Huihui-Qwen3.8-27B-abliterated-GGUF/resolve/main/Huihui-Qwen3.8-27B-abliterated.Q4_K_M.gguf',
    repo: 'test/a-repository-without-vision',
  },
  {
    id: 'test:qwen3-14b-abliterated',
    name: 'Huihui Qwen3 14B abliterated (text-only)',
    url: 'https://huggingface.co/mradermacher/Huihui-Qwen3-14B-abliterated-v2-GGUF/resolve/main/Huihui-Qwen3-14B-abliterated-v2.Q2_K.gguf',
    repo: 'mradermacher/Huihui-Qwen3-14B-abliterated-v2-GGUF',
  },
];

/** The first 24 MB of a model: its header, without the weights. Kept between runs. */
async function header(model) {
  const file = path.join(cacheDir, `${model.id.replace(/[^\w.-]/g, '_')}.gguf`);
  if (!fs.existsSync(file)) {
    const response = await fetch(model.url, { headers: { Range: 'bytes=0-25165823' } });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${model.url}`);
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  const target = path.join(dataDir, 'models', path.basename(file));
  fs.copyFileSync(file, target);
  return target;
}

async function run() {
  let window;
  for (let attempt = 0; attempt < 200 && !window; attempt += 1) {
    await sleep(150);
    [window] = BrowserWindow.getAllWindows();
  }
  const page = window.webContents;
  const js = async (code) => {
    const result = await page.executeJavaScript(`(async () => { try { return { value: await (${code}) }; } catch (error) { return { error: String(error && error.message || error) }; } })()`, true);
    return result;
  };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await js("Boolean(document.querySelector('.rail'))")).value) break;
    await sleep(200);
  }
  for (const model of MODELS) {
    const started = Date.now();
    const result = await js(`window.uma.downloadVision(${JSON.stringify(model.id)})`);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.error) {
      log(`${model.name}: ${result.error} (${seconds} s)`);
    } else {
      log(`${model.name}: found in ${result.value.repo} (${result.value.match}), ${(result.value.size / 1e6).toFixed(0)} MB, in ${seconds} s`);
      await sleep(1500);
      await js(`window.uma.cancelDownload(${JSON.stringify(`${model.id}:vision`)})`);
    }
  }
}

async function main() {
  const installed = [];
  for (const model of MODELS) {
    const file = await header(model);
    installed.push({ id: model.id, catalogId: '', name: model.name, filename: path.basename(file), path: file, size: fs.statSync(file).size, repo: model.repo, addedAt: new Date().toISOString() });
  }
  fs.writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify({ installed }));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), semanticSearch: false, loadModelAtStart: false, activeModelId: MODELS[0].id }));
  require('../electron/main.cjs');
  await app.whenReady();
  await run();
}

main()
  .then(() => app.exit(0))
  .catch((err) => {
    log(`UI TEST FAILED: ${err.message}`);
    app.exit(1);
  });
