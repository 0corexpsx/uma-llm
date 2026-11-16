// Installs the CUDA engine if needed, then measures each installed GPU engine on real models.
//   node scripts/compare-engines.cjs qwen3-8b bonsai-27b
// Pass --no-install to measure only what is already installed.
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../electron/lib/store.cjs');
const { RuntimeManager } = require('../electron/lib/runtime.cjs');
const { LlamaManager } = require('../electron/lib/llama.cjs');
const { detectHardware } = require('../electron/lib/hardware.cjs');
const { ensureDir } = require('../electron/lib/util.cjs');

const appData = process.env.UMA_APPDATA || path.join(process.env.APPDATA || os.homedir(), 'Uma LLM');
const PROMPT = 'Write a detailed explanation of how a hash map works, including collisions and resizing.';

async function main() {
  const args = process.argv.slice(2);
  const modelIds = args.filter((value) => !value.startsWith('--'));
  const store = new Store(appData);
  await store.init();
  const hardware = await detectHardware();
  console.log(`GPU: ${hardware.gpu}, ${hardware.vramGB} GB, driver CUDA ${hardware.cudaVersion || 'unknown'}`);
  const logsDir = path.join(__dirname, '..', '.testdata', 'compare', 'logs');
  await ensureDir(logsDir);
  let lastPercent = -10;
  const runtime = new RuntimeManager({
    store,
    runtimeDir: path.join(appData, 'runtime'),
    downloadsDir: path.join(appData, 'downloads'),
    hardware,
    emit: (_channel, payload) => {
      if (payload.percent - lastPercent >= 10 || payload.phase !== 'downloading') {
        lastPercent = payload.percent;
        console.log(`  ${payload.phase} ${Math.round(payload.percent)}% ${payload.message || ''}`);
      }
    },
  });
  const previous = store.getRuntime().backend;
  if (!args.includes('--no-install') && !runtime.installs().cuda) await runtime.install('cuda');

  const installed = store.getInstalledModels();
  const llama = new LlamaManager({ store, runtime, logsDir });
  const results = [];
  for (const backend of ['vulkan', 'cuda']) {
    if (!runtime.installs()[backend]) continue;
    await runtime.use(backend);
    for (const modelId of modelIds) {
      const model = installed.find((entry) => entry.id === modelId);
      const row = { backend, model: modelId };
      try {
        const started = Date.now();
        await llama.ensureServer(model);
        row.loadSeconds = Math.round((Date.now() - started) / 100) / 10;
        await llama.complete({ messages: [{ role: 'user', content: 'Say hi.' }], maxTokens: 8 });
        const run = await llama.complete({ messages: [{ role: 'user', content: PROMPT }], maxTokens: 256, temperature: 0 });
        row.genTokensPerSec = Math.round(run.timings.predicted_per_second * 10) / 10;
        row.promptTokensPerSec = Math.round(run.timings.prompt_per_second);
        row.compute = llama.computeInfo().detail;
      } catch (err) {
        row.error = err.message.split('\n')[0].slice(0, 160);
      }
      await llama.stop({ silent: true });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      results.push(row);
      console.log(JSON.stringify(row));
    }
  }
  await runtime.use(args.includes('--keep-previous') && previous ? previous : (runtime.installs().cuda ? 'cuda' : previous));
  console.log(`Active engine: ${store.getRuntime().backend}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
