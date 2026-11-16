const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..');
const data = path.join(root, '.testdata', 'onboard-ui', 'data');
const e2e = path.join(root, '.testdata', 'e2e', 'data');
const workspace = path.join(root, 'demo-workspace');

async function main() {
  for (const dir of [data, path.join(data, 'conversations'), path.join(data, 'models'), path.join(data, 'runtime'), path.join(data, 'downloads'), path.join(data, 'logs')]) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.copyFile(path.join(e2e, 'models.json'), path.join(data, 'models.json'));
  await fs.copyFile(path.join(e2e, 'runtime.json'), path.join(data, 'runtime.json'));
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version,
    onboarded: false,
    workspacePath: workspace,
    activeModelId: 'qwen3-4b',
    allowEdits: true,
    allowDelete: false,
    allowShell: false,
    contextSize: 8192,
    temperature: 0.3,
    topP: 0.9,
    gpuOffload: true,
    runtimeBackend: 'auto',
    lastConversationId: '',
  }, null, 2));
  console.log('Seeded onboarding UI state');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
