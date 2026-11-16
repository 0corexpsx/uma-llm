const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..');
const data = path.join(root, '.testdata', 'fresh-ui', 'data');
const workspace = path.join(root, 'demo-workspace');

async function main() {
  await fs.rm(data, { recursive: true, force: true });
  for (const dir of [data, path.join(data, 'conversations'), path.join(data, 'models'), path.join(data, 'runtime'), path.join(data, 'downloads'), path.join(data, 'logs')]) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(path.join(data, 'models.json'), JSON.stringify({ installed: [] }, null, 2));
  await fs.writeFile(path.join(data, 'runtime.json'), JSON.stringify({}, null, 2));
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version,
    onboarded: false,
    workspacePath: workspace,
    activeModelId: '',
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
  console.log('Seeded fresh onboarding state');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
