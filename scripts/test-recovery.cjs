// What happened on 2026-11-14: Windows stopped unexpectedly right after Uma saved, and settings.json
// and models.json read back as zeros. Uma then started with no settings and an empty model list,
// although the model files were still on the disk. This checks that Uma now gets them back.
//   node scripts/test-recovery.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../electron/lib/store.cjs');
const { ModelManager } = require('../electron/lib/models.cjs');

const root = path.join(__dirname, '..', '.testdata', 'recovery');
const modelsDir = path.join(root, 'models');
fs.rmSync(root, { recursive: true, force: true });

/** A tiny file that starts like a GGUF model. */
function gguf(file, size = 64) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = Buffer.alloc(size);
  data.write('GGUF', 0, 'ascii');
  fs.writeFileSync(file, data);
}

async function main() {
  const repoDir = path.join(modelsDir, 'hub', 'huihui-ai__Huihui-Qwen3.8-27B-abliterated-GGUF');
  gguf(path.join(repoDir, 'Huihui-Qwen3.8-27B-abliterated-UD-IQ3_XXS.gguf'), 4096);
  gguf(path.join(repoDir, 'mmproj-model-bf16.gguf'), 512);
  const splitDir = path.join(modelsDir, 'hub', 'unsloth__Big-Model-GGUF');
  gguf(path.join(splitDir, 'Big-Model-Q4_K_M-00001-of-00002.gguf'), 1000);
  gguf(path.join(splitDir, 'Big-Model-Q4_K_M-00002-of-00002.gguf'), 1000);
  const halfDir = path.join(modelsDir, 'hub', 'someone__Half-Done-GGUF');
  gguf(path.join(halfDir, 'Half-Done-Q8_0-00001-of-00003.gguf'));
  gguf(path.join(modelsDir, 'my-own-model.Q5_K_M.gguf'));
  gguf(path.join(modelsDir, 'vision', 'qwen38-27b-iq4', 'mmproj-F16.gguf'));
  fs.writeFileSync(path.join(modelsDir, 'downloading.gguf.part'), 'GGUF');
  fs.writeFileSync(path.join(modelsDir, 'not-a-model.gguf'), 'HTML error page');

  // 1. The crash: both files are zeros, and there is no good copy yet (an older Uma kept none).
  fs.writeFileSync(path.join(root, 'settings.json'), Buffer.alloc(3759));
  fs.writeFileSync(path.join(root, 'models.json'), Buffer.alloc(1219));
  const store = new Store(root);
  await store.init();
  const models = new ModelManager({ store, modelsDir, downloadsDir: path.join(root, 'downloads'), emit: () => {} });
  await models.init();
  const list = store.getInstalledModels();
  const names = list.map((entry) => entry.name).sort();
  assert.deepEqual(names, ['Big-Model Q4_K_M', 'Huihui-Qwen3.8-27B-abliterated UD-IQ3_XXS', 'my-own-model.Q5_K_M'], `models found again: ${names.join(', ')}`);
  const qwen = list.find((entry) => entry.name.startsWith('Huihui'));
  assert.equal(qwen.id, 'hub:huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF:Huihui-Qwen3.8-27B-abliterated-UD-IQ3_XXS.gguf', 'the same id as when it was downloaded');
  assert.equal(qwen.repo, 'huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF');
  assert.equal(qwen.quant, 'UD-IQ3_XXS');
  assert.equal(path.basename(qwen.mmproj?.path || ''), 'mmproj-model-bf16.gguf', 'its vision file is found again');
  const big = list.find((entry) => entry.name.startsWith('Big'));
  assert.equal(big.parts.length, 2, 'a split model is one model with both parts');
  assert.equal(big.size, 2000);
  assert.ok(store.getSettings().activeModelId, 'a model is selected again');
  assert.ok(fs.existsSync(path.join(root, 'settings.json.corrupt')) && fs.existsSync(path.join(root, 'models.json.corrupt')), 'the damaged files are kept');
  console.log(`after the crash, models found again on the disk: ${names.join(', ')}`);

  // 2. A normal start keeps a good copy; the next damaged file is replaced by it, settings included.
  await store.updateSettings({ language: 'it', workspacePath: 'D:\\Progetti', acceptedTermsVersion: '9.9.9' });
  const second = new Store(root);
  await second.init();
  assert.ok(fs.existsSync(path.join(root, 'settings.json.bak')), 'a good copy is kept');
  fs.writeFileSync(path.join(root, 'settings.json'), Buffer.alloc(2000));
  const third = new Store(root);
  await third.init();
  assert.equal(third.getSettings().language, 'it', 'settings come back from the good copy');
  assert.equal(third.getSettings().workspacePath, 'D:\\Progetti');

  // 3. Nothing is added twice on later starts.
  const again = new ModelManager({ store: third, modelsDir, downloadsDir: path.join(root, 'downloads'), emit: () => {} });
  await again.init();
  assert.equal(third.getInstalledModels().length, 3);

  // 4. A file is written to the disk before it replaces the old one.
  const util = require('../electron/lib/util.cjs');
  await util.writeJsonAtomic(path.join(root, 'check.json'), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'check.json'), 'utf8')), { ok: true });
  console.log('damaged settings restored from the last good copy, nothing added twice: OK');
  fs.rmSync(root, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
