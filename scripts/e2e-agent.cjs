// Real-model test of the agent loop, using the runtime and models already installed by the app.
// Works on a throwaway workspace in .testdata; it never touches your own folders or conversations.
//   node scripts/e2e-agent.cjs qwen3-8b bonsai-27b
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { Store } = require('../electron/lib/store.cjs');
const { Workspace } = require('../electron/lib/workspace.cjs');
const { LlamaManager } = require('../electron/lib/llama.cjs');
const { ConversationStore } = require('../electron/lib/conversations.cjs');
const { ToolRunner } = require('../electron/lib/tools.cjs');
const { AgentRunner } = require('../electron/lib/agent.cjs');
const { ensureDir, readJson } = require('../electron/lib/util.cjs');

const appData = process.env.UMA_APPDATA || path.join(process.env.APPDATA || os.homedir(), 'Uma LLM');
const root = path.join(__dirname, '..', '.testdata', 'e2e-agent');

async function seed(workspaceDir) {
  await fsp.rm(workspaceDir, { recursive: true, force: true });
  await ensureDir(path.join(workspaceDir, 'css'));
  await fsp.writeFile(path.join(workspaceDir, 'index.html'), '<!doctype html>\n<html>\n<head><title>Reviews</title><link rel="stylesheet" href="css/styles.css"></head>\n<body><h1>Reviews</h1><p>Five stars.</p></body>\n</html>\n');
  await fsp.writeFile(path.join(workspaceDir, 'css', 'styles.css'), 'body { color: black; }\n');
  await fsp.writeFile(path.join(workspaceDir, 'notes.txt'), 'TODO: the launch code word is MARIGOLD.\n');
}

async function main() {
  const modelIds = process.argv.slice(2);
  const installed = (await readJson(path.join(appData, 'models.json'), { installed: [] })).installed;
  const runtime = await readJson(path.join(appData, 'runtime.json'), {});
  const data = path.join(root, 'data');
  const workspaceDir = path.join(root, 'workspace');
  await ensureDir(path.join(data, 'logs'));

  const store = new Store(data);
  await store.init();
  await store.setRuntime(runtime);
  await store.updateSettings({
    workspacePath: workspaceDir, contextSize: 16384, allowEdits: true, allowShell: false, allowDelete: false, allowInternet: false, temperature: 0.3,
  });
  const llama = new LlamaManager({ store, runtime: { hardware: {} }, logsDir: path.join(data, 'logs') });

  const SCENARIOS = [
    { name: 'plain chat stays chat', text: 'Write a two line poem about rain.', check: ({ message }) => !tools(message).length && text(message).length > 10 },
    { name: 'inspects before answering', text: 'Analyze this project and tell me the code word in notes.txt.', check: ({ message }) => tools(message).length > 0 && /MARIGOLD/i.test(text(message)) },
    { name: 'saves instead of pasting', text: 'Rewrite css/styles.css as a professional stylesheet of at least 30 lines with a nav bar, cards, and hover effects.', check: async () => (await fsp.readFile(path.join(workspaceDir, 'css', 'styles.css'), 'utf8')).split('\n').length >= 15 },
    { name: 'continue does not stop', text: 'continue', sameConversation: true, check: ({ message }) => !/did not verify/.test(text(message)) && message.status === 'done' },
  ];

  const tools = (message) => message.blocks.filter((block) => block.type === 'tool');
  const text = (message) => message.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  let failed = 0;

  for (const modelId of modelIds) {
    const model = installed.find((entry) => entry.id === modelId);
    if (!model) throw new Error(`${modelId} is not installed.`);
    console.log(`\n===== ${model.name} =====`);
    await seed(workspaceDir);
    const workspace = new Workspace({ root: workspaceDir, trash: (target) => fsp.rm(target, { recursive: true, force: true }) });
    await workspace.init();
    const conversations = new ConversationStore(path.join(data, 'conversations'));
    await conversations.init();
    const toolRunner = new ToolRunner({ workspace, store, onChanged: () => {} });
    let conversation = null;

    for (const scenario of SCENARIOS) {
      if (!scenario.sameConversation || !conversation) conversation = await conversations.create();
      let done;
      const finished = new Promise((resolve) => { done = resolve; });
      const agent = new AgentRunner({
        store, workspace, conversations, toolRunner, llama,
        models: { resolveActive: async () => model },
        send: (_channel, payload) => { if (payload?.type === 'assistant-end') done(payload.message); },
      });
      const started = Date.now();
      await agent.send(conversation.id, scenario.text);
      const message = await Promise.race([
        finished,
        new Promise((resolve) => setTimeout(() => { agent.stop(); resolve(null); }, 420000)),
      ]);
      const seconds = Math.round((Date.now() - started) / 1000);
      if (!message) {
        failed += 1;
        console.log(`FAIL ${scenario.name} (timed out after ${seconds}s)`);
        continue;
      }
      const ok = await scenario.check({ message });
      if (!ok) failed += 1;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${scenario.name} (${seconds}s) status=${message.status} tools=[${tools(message).map((block) => `${block.name}:${block.status}`).join(', ')}]`);
      console.log(`     ${text(message).replace(/\s+/g, ' ').slice(0, 220)}${message.error ? ` ERROR: ${message.error.slice(0, 300)}` : ''}`);
    }
    await llama.stop({ silent: true });
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  console.log(failed ? `\n${failed} scenario(s) failed.` : '\nAll scenarios passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
