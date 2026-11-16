const path = require('node:path');
const fsp = require('node:fs/promises');
const assert = require('node:assert');
const { Store } = require('../electron/lib/store.cjs');
const { Workspace } = require('../electron/lib/workspace.cjs');
const { ToolRunner } = require('../electron/lib/tools.cjs');
const { ConversationStore } = require('../electron/lib/conversations.cjs');
const { AgentRunner } = require('../electron/lib/agent.cjs');
const { ensureDir } = require('../electron/lib/util.cjs');

const root = path.join(__dirname, '..', '.testdata', 'security');

async function main() {
  await fsp.rm(root, { recursive: true, force: true });
  const workspaceDir = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await ensureDir(path.join(workspaceDir, 'notes'));
  await ensureDir(outside);
  await fsp.writeFile(path.join(workspaceDir, 'README.md'), '# Safe workspace\n');
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'do not touch\n');

  const store = new Store(path.join(root, 'data'));
  await store.init();
  await store.updateSettings({ allowEdits: true, allowDelete: false, workspacePath: workspaceDir });

  const workspace = new Workspace({
    root: workspaceDir,
    trash: async (target) => fsp.rm(target, { recursive: true, force: true }),
  });
  await workspace.init();

  await assert.rejects(() => workspace.resolve('../outside/secret.txt'));
  await assert.rejects(() => workspace.resolve('..\\outside\\secret.txt'));
  await assert.rejects(() => workspace.resolve(path.join(outside, 'secret.txt')));
  console.log('path scoping: OK');

  let symlinkTested = false;
  try {
    await fsp.symlink(outside, path.join(workspaceDir, 'escape-link'), 'junction');
    await assert.rejects(() => workspace.resolve('escape-link/secret.txt'));
    symlinkTested = true;
    console.log('symlink escape: OK');
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
  }
  if (!symlinkTested) console.log('symlink escape: skipped (no symlink privilege)');

  const tools = new ToolRunner({ workspace, store, onChanged: () => {} });
  let result = await tools.run('write_file', { path: 'notes/ok.md', content: 'hello' });
  assert.equal(result.ok, true, result.output);
  assert.equal(await fsp.readFile(path.join(workspaceDir, 'notes/ok.md'), 'utf8'), 'hello');

  result = await tools.run('write_file', { path: '../outside/secret.txt', content: 'pwned' });
  assert.equal(result.ok, false);
  assert.match(result.output, /outside/i);

  result = await tools.run('delete_file', { path: 'notes/ok.md' });
  assert.equal(result.ok, false);
  assert.match(result.output, /Deleting is turned off/i);

  await store.updateSettings({ allowEdits: false });
  result = await tools.run('write_file', { path: 'notes/blocked.md', content: 'no' });
  assert.equal(result.ok, false);
  assert.match(result.output, /editing is turned off/i);
  console.log('tool permissions: OK');

  await store.updateSettings({ allowEdits: true });
  const conversations = new ConversationStore(path.join(root, 'data', 'conversations'));
  await conversations.init();
  const conversation = await conversations.create();

  let call = 0;
  const fakeLlama = {
    async ensureServer() {},
    async *streamChat() {
      call += 1;
      if (call === 1) {
        yield { type: 'text', text: 'I will write that file.\n\n```tool\n{"name":"write_file","arguments":{"path":"agent-made.md","content":"Made by the agent.\\n"}}\n```' };
      } else {
        yield { type: 'text', text: 'Done — `agent-made.md` is in the workspace.' };
      }
    },
  };

  let ended;
  const finished = new Promise((resolve) => { ended = resolve; });
  const agent = new AgentRunner({
    store,
    workspace,
    models: { resolveActive: async () => ({ id: 'mock', name: 'Mock', family: 'Test' }) },
    llama: fakeLlama,
    conversations,
    toolRunner: tools,
    send: (channel, payload) => {
      if (payload?.type === 'assistant-end') ended(payload.message);
    },
  });

  await agent.send(conversation.id, 'Create agent-made.md.');
  const message = await finished;
  assert.equal(message.status, 'done');
  assert.equal(await fsp.readFile(path.join(workspaceDir, 'agent-made.md'), 'utf8'), 'Made by the agent.\n');
  assert.ok(message.blocks.some((block) => block.type === 'tool' && block.status === 'done'));
  assert.ok(message.blocks.some((block) => block.type === 'text' && /Done/.test(block.text)));
  console.log('agent tool loop: OK');

  // Malformed tool calls must surface an error, never display raw JSON as an answer.
  const conversation2 = await conversations.create();
  let ended2;
  const finished2 = new Promise((resolve) => { ended2 = resolve; });
  const badAgent = new AgentRunner({
    store,
    workspace,
    models: { resolveActive: async () => ({ id: 'mock', name: 'Mock', family: 'Test' }) },
    llama: {
      async ensureServer() {},
      async *streamChat() {
        yield { type: 'text', text: '```tool\n{"name":"write_file","arguments":{"path":"x",' };
      },
    },
    conversations,
    toolRunner: tools,
    send: (channel, payload) => {
      if (payload?.type === 'assistant-end') ended2(payload.message);
    },
  });
  await badAgent.send(conversation2.id, 'Do the thing.');
  const bad = await finished2;
  assert.equal(bad.status, 'error');
  assert.match(bad.error, /did not finish/i);
  console.log('malformed tool call handling: OK');

  console.log('\nAll security and agent tests passed.');
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
