const path = require('node:path');
const fsp = require('node:fs/promises');
const { Store } = require('../electron/lib/store.cjs');
const { Workspace } = require('../electron/lib/workspace.cjs');
const { ModelManager } = require('../electron/lib/models.cjs');
const { RuntimeManager } = require('../electron/lib/runtime.cjs');
const { LlamaManager } = require('../electron/lib/llama.cjs');
const { ConversationStore } = require('../electron/lib/conversations.cjs');
const { ToolRunner } = require('../electron/lib/tools.cjs');
const { AgentRunner } = require('../electron/lib/agent.cjs');
const { ensureDir } = require('../electron/lib/util.cjs');

const root = path.join(__dirname, '..', '.testdata', 'e2e');
const data = path.join(root, 'data');
const workspaceRoot = path.join(root, 'workspace');

async function main() {
  await ensureDir(data);
  await ensureDir(path.join(data, 'models'));
  await ensureDir(path.join(data, 'runtime'));
  await ensureDir(path.join(data, 'downloads'));
  await ensureDir(path.join(data, 'logs'));
  await ensureDir(path.join(data, 'conversations'));
  await ensureDir(path.join(workspaceRoot, 'notes'));
  await fsp.writeFile(path.join(workspaceRoot, 'README.md'), '# Demo workspace\n\nA tiny folder for testing Uma.\n');
  await fsp.writeFile(path.join(workspaceRoot, 'notes', 'todo.md'), '- [ ] test the local agent\n- [ ] make coffee\n');
  await fsp.rm(path.join(workspaceRoot, 'hello-uma.md'), { force: true });

  const store = new Store(data);
  await store.init();
  await store.updateSettings({
    workspacePath: workspaceRoot,
    contextSize: 8192,
    gpuOffload: true,
    allowEdits: true,
    allowShell: false,
    allowDelete: false,
    temperature: 0.3,
  });

  const hardware = {
    cpu: 'Test CPU', cores: 8, ramGB: 16, gpu: 'NVIDIA GeForce RTX 2070', vramGB: 8, hasGpu: true, platform: 'win32', arch: 'x64',
  };

  const models = new ModelManager({
    store,
    modelsDir: path.join(data, 'models'),
    downloadsDir: path.join(data, 'downloads'),
    emit: (channel, payload) => {
      if (channel === 'models:progress') {
        process.stdout.write(`\rmodel ${payload.status} ${Math.round(payload.percent || 0)}%      `);
        if (payload.status === 'done') process.stdout.write('\n');
      }
    },
  });
  await models.init();

  const runtime = new RuntimeManager({
    store,
    runtimeDir: path.join(data, 'runtime'),
    downloadsDir: path.join(data, 'downloads'),
    hardware,
    emit: (channel, payload) => {
      if (channel === 'runtime:progress') {
        process.stdout.write(`\rengine ${payload.phase} ${Math.round(payload.percent || 0)}% ${payload.message || ''}      `);
        if (payload.phase === 'done' || payload.phase === 'error') process.stdout.write('\n');
      }
    },
  });

  let runtimeStatus = await runtime.status();
  if (!runtimeStatus.installed) {
    console.log('Installing Vulkan runtime...');
    runtimeStatus = await runtime.install('vulkan');
    console.log('Runtime:', runtimeStatus.version, runtimeStatus.backend, runtimeStatus.serverPath);
  }

  const modelId = process.env.UMA_TEST_MODEL_ID || 'qwen25-05b';
  let model = await models.getModel(modelId);
  if (!model) {
    console.log(`Downloading ${modelId}...`);
    await models.startDownload(modelId);
    model = await models.getModel(modelId);
  }
  if (!model) throw new Error(`Model ${modelId} was not installed.`);
  await store.updateSettings({ activeModelId: model.id });
  const active = await models.resolveActive();
  console.log('Active model:', active?.name, active?.size);

  const llama = new LlamaManager({
    store,
    runtime,
    logsDir: path.join(data, 'logs'),
    emit: (channel, payload) => {
      if (channel === 'server:status') console.log('server:', payload.state, payload.error || '');
    },
  });
  const current = store.getSettings();
  await store.updateSettings({ activeModelId: active.id });
  console.log('Loading model...');
  await llama.ensureServer(active);
  console.log('Model ready.');

  let buffer = '';
  for await (const event of llama.streamChat({
    messages: [
      { role: 'system', content: 'You are a concise assistant.' },
      { role: 'user', content: 'Reply with exactly: local model online' },
    ],
    maxTokens: 40,
  })) {
    if (event.type === 'text') buffer += event.text;
  }
  console.log('Direct reply:', JSON.stringify(buffer.trim()));

  const conversations = new ConversationStore(path.join(data, 'conversations'));
  await conversations.init();
  const conversation = await conversations.create();

  const workspace = new Workspace({ root: workspaceRoot, trash: async (target) => fsp.rm(target, { recursive: true, force: true }) });
  await workspace.init();
  const toolRunner = new ToolRunner({ workspace, store, onChanged: (p) => console.log('changed:', p) });
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const agent = new AgentRunner({
    store,
    workspace,
    models,
    llama,
    conversations,
    toolRunner,
    send: (channel, payload) => {
      if (channel !== 'chat:event') return;
      if (payload.type === 'tool-update') console.log('tool:', payload.patch.status, payload.patch.summary);
      if (payload.type === 'assistant-end') {
        console.log('\n--- final message ---\n' + payload.message.content);
        console.log('status:', payload.message.status, payload.message.error || '');
        console.log('blocks:', payload.message.blocks.map((b) => b.type + (b.name ? ':' + b.name : '')).join(', '));
        resolveDone(payload.message);
      }
      if (payload.type === 'assistant-start') console.log('assistant started');
    },
  });

  await agent.send(conversation.id, 'Use your write_file tool to create a file named hello-uma.md containing a short welcome message and three bullet points about what this workspace can be used for. Then read the file back and tell me what you wrote.');
  const final = await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Agent timed out')), 240000)),
  ]);

  const created = await fsp.readFile(path.join(workspaceRoot, 'hello-uma.md'), 'utf8').catch(() => null);
  console.log('\nhello-uma.md exists:', Boolean(created));
  if (created) console.log(created.slice(0, 500));

  await llama.stop();
  process.exit(final.status === 'done' && created ? 0 : 1);
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
