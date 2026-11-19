// Agent-loop and tool regression tests. Uses a scripted fake model, so no GPU or download is needed.
const path = require('node:path');
const fsp = require('node:fs/promises');
const assert = require('node:assert');
const { Store } = require('../electron/lib/store.cjs');
const { Workspace } = require('../electron/lib/workspace.cjs');
const { ToolRunner, translateChains, adaptForPowerShell } = require('../electron/lib/tools.cjs');
const { ConversationStore } = require('../electron/lib/conversations.cjs');
const { AgentRunner, classifyTask, maxOutputTokens, isReadOnlyCommand } = require('../electron/lib/agent.cjs');
const { extractToolCall, hasToolAttempt, StreamFilter, toolCallSchema, stripThink } = require('../electron/lib/toolcall.cjs');
const { UndoLog } = require('../electron/lib/undo.cjs');
const { SkillStore, parseSkill } = require('../electron/lib/skills.cjs');
const http = require('node:http');
const zlib = require('node:zlib');
const { AttachmentStore } = require('../electron/lib/attachments.cjs');
const { SystemStats } = require('../electron/lib/systemStats.cjs');
const { readModelInfo, fileSource, urlSource } = require('../electron/lib/gguf.cjs');
const { estimateMemory } = require('../electron/lib/memory.cjs');
const { DEFAULTS, sanitizeModelSettings, buildServerArgs, parseExtraArgs } = require('../electron/lib/modelSettings.cjs');
const { ModelManager } = require('../electron/lib/models.cjs');
const { LlamaManager } = require('../electron/lib/llama.cjs');
const { searchModels, repoVariants } = require('../electron/lib/huggingface.cjs');
const { RuntimeManager, cudaBuildsFor } = require('../electron/lib/runtime.cjs');
const { isPrivateIp } = require('../electron/lib/web.cjs');
const { ensureDir } = require('../electron/lib/util.cjs');
const net = require('node:net');
const { NetworkManager, parseDevices, isPrivateIPv4, cleanHost } = require('../electron/lib/network.cjs');
const i18n = require('../electron/lib/i18n.cjs');
const { planPlacement, placementArgs, parseDeviceList } = require('../electron/lib/placement.cjs');

const root = path.join(__dirname, '..', '.testdata', 'agent');
const workspaceDir = path.join(root, 'workspace');
const CODE_DUMP = `Here is the stylesheet:\n\n\`\`\`css\n${Array.from({ length: 20 }, (_, i) => `.rule-${i} { color: red; }`).join('\n')}\n\`\`\``;

let store;
let workspace;
let tools;
let conversations;

/** Runs one message through the real AgentRunner. `script` is one reply per model call. */
async function chat(script, text, { conversation, toolRunner = tools, finish, model = null } = {}) {
  const convo = conversation || await conversations.create();
  const calls = [];
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const agent = new AgentRunner({
    store,
    workspace,
    models: { resolveActive: async () => (model || { id: 'mock', name: 'Mock', family: 'Test' }) },
    conversations,
    toolRunner,
    llama: {
      async ensureServer() {},
      async *streamChat(request) {
        calls.push(request);
        const reply = typeof script === 'function' ? script(request, calls.length - 1) : script[Math.min(calls.length - 1, script.length - 1)];
        yield { type: 'text', text: reply };
        if (finish?.[calls.length - 1]) yield { type: 'finish', reason: finish[calls.length - 1] };
      },
    },
    send: (_channel, payload) => {
      if (payload?.type === 'assistant-end') done(payload.message);
    },
  });
  await agent.send(convo.id, text);
  const message = await finished;
  return { message, calls, conversation: convo };
}

const toolBlocks = (message) => message.blocks.filter((block) => block.type === 'tool');
const allText = (message) => message.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');

function testParser() {
  const shapes = [
    ['fenced', '```tool\n{"name":"read_file","arguments":{"path":"a.md"}}\n```'],
    ['qwen tag', '<tool_call>\n{"name":"read_file","arguments":{"path":"a.md"}}\n</tool_call>'],
    ['bare json', '{"name":"read_file","arguments":{"path":"a.md"}}'],
    ['json fence', '```json\n{"name":"read_file","arguments":{"path":"a.md"}}\n```'],
    ['docs form', 'read_file {"path":"a.md"}'],
    ['flat args', '{"tool":"read_file","path":"a.md"}'],
    ['single key', '{"read_file":{"path":"a.md"}}'],
    ['nested function', '{"function":{"name":"read_file","arguments":"{\\"path\\":\\"a.md\\"}"}}'],
    ['mistral', '[TOOL_CALLS] [{"name":"read_file","arguments":{"path":"a.md"}}]'],
    ['llama python tag', '<|python_tag|>{"name":"read_file","arguments":{"path":"a.md"}}'],
    ['function tag', '<function=read_file>{"path":"a.md"}</function>'],
    ['after a think block', '<think>{"name":"delete_file","arguments":{"path":"x"}}</think>{"name":"read_file","arguments":{"path":"a.md"}}'],
  ];
  for (const [label, text] of shapes) {
    const call = extractToolCall(text);
    assert.ok(call, `${label} was not parsed`);
    assert.equal(call.name, 'read_file', label);
    assert.deepEqual(call.args, { path: 'a.md' }, label);
  }

  assert.equal(stripThink('Lisbon, 1987. </think> Lisbon, 1987.'), 'Lisbon, 1987.', 'a thinking block with only its end is removed');
  assert.equal(stripThink('<think>plan</think>Answer'), 'Answer');
  assert.equal(stripThink('No thinking here.'), 'No thinking here.');

  const fenced = extractToolCall('```tool\n{"name":"write_file","arguments":{"path":"r.md","content":"# T\\n```js\\nx()\\n```\\n"}}\n```');
  assert.match(fenced.args.content, /```js/, 'a code fence inside content must not end the call');

  const rawNewlines = extractToolCall('```tool\n{"name":"write_file","arguments":{"path":"C:\\dir\\a.css","content":"a {\n  color: red;\n}"}}\n```');
  assert.equal(rawNewlines.args.path, 'C:\\dir\\a.css');
  assert.equal(rawNewlines.args.content, 'a {\n  color: red;\n}');

  // The exact broken calls Bonsai 27B wrote in a real session.
  const realFailures = [
    ['```tool\n{"name":"run_command","arguments":{"command\\":\\"winget list --query \\"Visual Studio Community\\""}}\n```', 'winget list --query "Visual Studio Community"'],
    ['Let me check:\n\n```tool\n{"name":"run_command","arguments":{"command\\":\\"where /v /r \\"*.exe\\" 2>nul | findstr /i \\"vscode\\""}}\n```', 'where /v /r "*.exe" 2>nul | findstr /i "vscode"'],
    ['```tool\n{"name":"run_command","arguments":{"command":"dir /b C:\\\\Program Files\\\\Microsoft Visual Studio 2022*" 2>nul || echo "No VS install found in Program Files" && dir /b C:\\\\Program Files (x86)\\\\Microsoft Visual Studio 2022*" 2>nul || echo "No VS install found in Program Files (x86)""}}\n```', 'dir /b C:\\Program Files\\Microsoft Visual Studio 2022*" 2>nul || echo "No VS install found in Program Files" && dir /b C:\\Program Files (x86)\\Microsoft Visual Studio 2022*" 2>nul || echo "No VS install found in Program Files (x86)"'],
    ['```tool\n{"name":"run_command","arguments":{"command":"dir /b C:\\\\Program Files\\\\Microsoft Visual Studio 2022*" 2>nul || echo "Not found" && dir /b C:\\\\Program Files (x86)\\\\Microsoft Visual Studio 2022*" 2>nul || echo "Not found"}}\n```', null],
  ];
  for (const [text, expected] of realFailures) {
    const call = extractToolCall(text);
    assert.ok(call, `real failure not repaired: ${text.slice(0, 80)}`);
    assert.equal(call.name, 'run_command');
    if (expected) assert.equal(call.args.command, expected);
  }
  const unquoted = extractToolCall('```tool\n{"name":"write_file","arguments":{"path":"a.css","content":"a { font: "Inter"; }"}}\n```');
  assert.equal(unquoted.args.content, 'a { font: "Inter"; }');
  const cutOff = '```tool\n{"name":"write_file","arguments":{"path":"a.css","content":"a { b: c; } d { e: "f"; }';
  assert.equal(extractToolCall(cutOff, { complete: false }), null, 'a truncated file must never be saved');
  assert.equal(extractToolCall(cutOff), null);

  // Windows paths in JSON: \b \t \n \f parse as control characters unless Uma restores them.
  assert.equal(extractToolCall('{"name":"run_command","arguments":{"command":".\\build\\Debug\\MyApp.exe"}}').args.command, '.\\build\\Debug\\MyApp.exe');
  assert.equal(extractToolCall('{"name":"run_command","arguments":{"command":"C:\\tools\\new\\run.exe"}}').args.command, 'C:\\tools\\new\\run.exe');
  assert.equal(extractToolCall('{"name":"read_file","arguments":{"path":"C:\\new\\table\\file.txt"}}').args.path, 'C:\\new\\table\\file.txt');
  assert.equal(extractToolCall('{"name":"move_file","arguments":{"from":"a\\file.txt","to":"b\\new.txt"}}').args.to, 'b\\new.txt');
  assert.equal(extractToolCall('{"name":"run_command","arguments":{"command":"echo one\\necho two"}}').args.command, 'echo one\necho two', 'a real multi-line command stays');
  assert.equal(extractToolCall('{"name":"write_file","arguments":{"path":"a.txt","content":"x\\ty\\nz"}}').args.content, 'x\ty\nz', 'file content keeps its tabs and newlines');

  assert.equal(extractToolCall('Use the {"name":"read_file"} tool.'), null);
  assert.equal(extractToolCall('```js\n{"name":"read_file","arguments":{"path":"a"}}\n```'), null, 'calls inside other code blocks are examples');
  assert.equal(extractToolCall('{"name":"uma","version":"1.0.0"}'), null, 'ordinary JSON is not a call');
  assert.equal(hasToolAttempt('```tool\n{"name":"write_file","arguments":{"path":"x",'), true);
  assert.equal(hasToolAttempt('{"name":"write_file","arguments":{"path":"x",'), true);
  assert.equal(hasToolAttempt('{"name":"uma","version":"1.0.0"}'), false);

  const shown = [];
  const reasoned = [];
  const filter = new StreamFilter((text) => shown.push(text), (text) => reasoned.push(text));
  for (const piece of ['<thi', 'nk>plan</th', 'ink>Hello ', 'there\n{"name":', '"read_file"}']) filter.push(piece);
  filter.flush();
  assert.equal(shown.join(''), 'Hello there');
  assert.equal(reasoned.join(''), 'plan');
  filter.release();
  assert.equal(shown.join(''), 'Hello there\n{"name":"read_file"}', 'soft matches are released when no call was found');

  const schema = toolCallSchema(['read_file', 'write_file']);
  assert.equal(schema.anyOf[1].properties.name.const, 'write_file');
  console.log('tool call parsing: OK');
}

function testClassifier() {
  for (const text of [
    'make me a poem about autumn', 'add these numbers: 2 and 3', 'can you review my idea for a birthday party', 'write a limerick',
    'how do I fix a python error?', 'what is a css class?', 'hello', 'Testing',
    'if i give you the folder of visual studios can you make a proejct for me? in C++',
    'can you make a C++ project?', 'are you able to fix bugs in code?', 'what if I want you to build an app?',
  ]) {
    assert.equal(classifyTask(text).agentic, false, `chat treated as a workspace task: ${text}`);
  }
  for (const text of [
    'fix the bug in App.jsx', 'make the website look professional', 'review this project', 'update the readme',
    'how do I fix the crash in my code?', 'rebuild css/styles.css',
    'can you fix the bug in App.jsx?', 'can you review this project?', 'please create a C++ project with CMake',
    'could you make the website look better.', 'compile my C++ project', 'restyle the css in my site',
    'what is this project?', 'what does this code do?', 'commit my changes', 'organize this folder',
  ]) {
    assert.equal(classifyTask(text).agentic, true, `task not recognised: ${text}`);
  }
  assert.equal(classifyTask('fix the bug in App.jsx').wantsEdit, true);
  assert.equal(classifyTask('review this project').wantsEdit, false);
  assert.equal(classifyTask('continue', { priorTask: 'write a limerick' }).agentic, false, 'continue inherits a chat task');
  assert.equal(classifyTask('continue', { priorTask: 'make the website look professional' }).wantsEdit, true, 'continue inherits an edit task');
  assert.equal(classifyTask('fix it', { priorUsedTools: true }).agentic, true);
  assert.equal(maxOutputTokens(8192), 2048);
  assert.equal(maxOutputTokens(32768), 8192);
  console.log('task classification: OK');
}

async function testAgentLoop() {
  // Ordinary chat is answered as-is, with no tool pressure and no warning.
  let run = await chat(['Roses are red.'], 'make me a poem');
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].responseSchema, undefined);
  assert.equal(allText(run.message), 'Roses are red.');

  // The reported bug: prose with no tools now gets forced into a real inspection, not discarded.
  run = await chat([
    'Your project looks like a React app with src/fake.js.',
    '{"name":"list_files","arguments":{"path":"."}}',
    'The workspace holds only README.md and notes.',
  ], 'review this project');
  assert.ok(run.calls[1].responseSchema, 'second round must be grammar-constrained');
  assert.equal(toolBlocks(run.message)[0].name, 'list_files');
  assert.doesNotMatch(allText(run.message), /Not verified|did not verify/);

  // A model that ignores everything keeps its text, clearly marked, first.
  run = await chat(['I think it has a database layer.'], 'review this project');
  assert.equal(run.message.status, 'done');
  assert.equal(run.message.blocks[0].type, 'text');
  assert.match(run.message.blocks[0].text, /^⚠ Not verified/);
  assert.match(allText(run.message), /database layer/, 'the answer must not be discarded');
  assert.ok(run.calls.length <= 6, `gave up after ${run.calls.length} calls`);

  // The exact session from the logs: read files, paste CSS in chat, then "continue".
  run = await chat([
    '```tool\n{"name":"read_file","arguments":{"path":"README.md"}}\n```',
    CODE_DUMP,
    '{"name":"write_file","arguments":{"path":"site.css","content":".a { color: red; }\\n"}}',
    'Saved site.css.',
  ], 'make the website css look professional');
  assert.deepEqual(run.calls[2].responseSchema.anyOf.map((option) => option.properties.name.const), ['write_file', 'append_file', 'replace_in_file']);
  assert.equal(await fsp.readFile(path.join(workspaceDir, 'site.css'), 'utf8'), '.a { color: red; }\n');
  const followUp = await chat([
    '{"name":"read_file","arguments":{"path":"site.css"}}',
    'Everything is saved.',
  ], 'continue', { conversation: run.conversation });
  assert.ok(followUp.calls[0].responseSchema, '"continue" on a workspace task starts with a forced tool call');
  const sent = followUp.calls[0].messages;
  assert.match(sent[sent.length - 1].content, /make the website css look professional/, 'continue must restate the task');
  assert.match(sent.map((item) => item.content).join('\n'), /Tools Uma ran/, 'earlier tool use must be visible in history');

  // A call cut off by the token limit gets a split instruction, not the same request again.
  run = await chat([
    '```tool\n{"name":"write_file","arguments":{"path":"x.css","content":"aaaa',
    '{"name":"write_file","arguments":{"path":"x.css","content":"part one\\n"}}',
    'Done.',
  ], 'create x.css', { finish: { 0: 'length' } });
  assert.match(run.calls[1].messages[run.calls[1].messages.length - 1].content, /cut off.*first part/s);

  // Reading, writing, then reading the same file again is verification, not a duplicate.
  run = await chat([
    '{"name":"read_file","arguments":{"path":"README.md"}}',
    '{"name":"write_file","arguments":{"path":"README.md","content":"# New\\n"}}',
    '{"name":"read_file","arguments":{"path":"README.md"}}',
    'Verified.',
  ], 'update the readme');
  assert.deepEqual(toolBlocks(run.message).map((block) => block.status), ['done', 'done', 'done']);

  // A model stuck on one call is told to answer, then stopped, instead of burning every step.
  run = await chat(['{"name":"file_info","arguments":{"path":"README.md"}}'], 'review this project');
  assert.equal(run.calls.length, 6, 'one real call, four blocked repeats, one closing summary request');
  assert.match(run.calls[3].messages[run.calls[3].messages.length - 1].content, /out of tool steps/);
  assert.match(allText(run.message), /kept repeating the same tool calls/);

  // The exact loop from a real session: two read-only commands, alternating, each exiting cleanly.
  await store.updateSettings({ allowShell: true });
  const loopA = '{"name":"run_command","arguments":{"command":"Get-ChildItem . -Recurse -Depth 2 2>&1 | Select-Object -First 50 Name"}}';
  const loopB = '{"name":"run_command","arguments":{"command":"Get-ChildItem .\\\\missing 2>&1 | Select-Object -First 30 Name"}}';
  const ranCommands = [];
  const counting = new ToolRunner({ workspace, store, onChanged: () => {} });
  const realRun = counting.run.bind(counting);
  counting.run = (name, args, options) => { ranCommands.push(args.command); return realRun(name, args, options); };
  run = await chat((request, n) => (
    request.messages[request.messages.length - 1].content.includes('Stop using tools')
      ? 'I listed the folder but could not find what I was looking for.'
      : n % 2 ? loopB : loopA
  ), 'if i give you the folder of visual studios can you make a proejct for me? in C++', { toolRunner: counting });
  assert.ok(run.calls.length <= 8, `looped for ${run.calls.length} rounds`);
  assert.equal(ranCommands.length, 2, 'each read-only command runs only once');
  assert.match(allText(run.message), /could not find what I was looking for/, 'the run must end with an answer');
  assert.match(allText(run.message), /kept repeating/);

  // A summary request answered with yet another tool call is ignored, and nothing runs.
  ranCommands.length = 0;
  run = await chat([loopA], 'list this folder', { toolRunner: counting });
  assert.equal(ranCommands.length, 1);
  assert.doesNotMatch(allText(run.message), /"name"/);

  // A build may run again, but a fourth identical run with no edit between is a loop.
  ranCommands.length = 0;
  run = await chat(['{"name":"run_command","arguments":{"command":"Write-Host building"}}'], 'build this project', { toolRunner: counting });
  assert.equal(ranCommands.length, 3);
  await store.updateSettings({ allowShell: false });

  for (const command of [
    'Get-ChildItem "C:\\Program Files" -Recurse 2>&1 | Select-Object -First 5 Name', 'where.exe devenv 2>nul', 'Test-Path a; Get-Content b',
    'winget list', 'cmake --version', 'dir && type a.txt',
  ]) assert.equal(isReadOnlyCommand(command), true, command);
  for (const command of [
    'cmake --build .', 'Get-ChildItem | Remove-Item', 'echo x > file.txt', 'mkdir build', 'winget install git', 'dir; del a.txt', 'npm test',
  ]) assert.equal(isReadOnlyCommand(command), false, command);

  // Four broken calls across a long task must not end it: only failures in a row count.
  const unreadable = '```tool\n{"name":"read_file",';
  const readme = (n) => `{"name":"file_info","arguments":{"path":"README.md","n":${n}}}`;
  run = await chat([
    unreadable, readme(1), unreadable, readme(2), unreadable, readme(3), unreadable, readme(4), 'All done.',
  ], 'review this project');
  assert.equal(run.message.status, 'done', run.message.error);
  assert.equal(toolBlocks(run.message).length, 4);
  // Failures in a row still stop, with an error that names the real problem.
  run = await chat([unreadable], 'review this project');
  assert.equal(run.message.status, 'error');
  assert.match(run.message.error, /could not read/);
  assert.doesNotMatch(run.message.error, /hit the length limit/);
  run = await chat([unreadable], 'review this project', { finish: { 0: 'length', 1: 'length', 2: 'length', 3: 'length' } });
  assert.match(run.message.error, /reply limit/);

  // A question about what is possible gets its answer, with no tool hunt.
  run = await chat(['Yes. What kind of project do you want?'], 'if i give you the folder of visual studios can you make a proejct for me? in C++');
  assert.equal(run.calls.length, 1);
  assert.equal(toolBlocks(run.message).length, 0);
  assert.equal(allText(run.message), 'Yes. What kind of project do you want?');

  // A model that names its next step and stops is told to take it.
  run = await chat([
    '{"name":"write_file","arguments":{"path":"step.txt","content":"x"}}',
    'The build failed because it is not configured. We need to configure CMake first. Let\'s do that.',
    '{"name":"file_info","arguments":{"path":"step.txt"}}',
    'Configured and finished.',
  ], 'create step.txt');
  assert.ok(run.calls[2].responseSchema, 'an announced step must be forced');
  assert.equal(toolBlocks(run.message).length, 2);
  // A normal sign-off is left alone.
  run = await chat([
    '{"name":"write_file","arguments":{"path":"step2.txt","content":"x"}}',
    'Saved step2.txt. Let me know if you need anything else.',
  ], 'create step2.txt');
  assert.equal(run.calls.length, 2);

  // Saying no ends the pressure: the model is not nagged into trying again.
  const denying = new ToolRunner({ workspace, store, onChanged: () => {}, confirmAction: async () => false });
  run = await chat([
    '{"name":"write_file","arguments":{"path":"no.md","content":"x"}}',
    'Understood, I will not write it.',
  ], 'create no.md', { toolRunner: denying });
  assert.equal(run.calls.length, 2);

  console.log('agent loop: OK');
}

async function testHistory() {
  const conversation = await conversations.create();
  const longReply = 'x'.repeat(4000);
  conversation.messages.push(
    { id: 'a', role: 'user', content: 'FIRST question' },
    { id: 'b', role: 'assistant', content: longReply },
    { id: 'c', role: 'user', content: 'second question' },
    { id: 'd', role: 'assistant', content: '⚠ I stopped because the model did not verify its work.\nReal text.' },
  );
  const run = await chat(['Sure.'], 'third question', { conversation });
  const sent = run.calls[0].messages;
  assert.equal(sent.filter((item) => item.content === 'third question').length, 1, 'the new message must be sent once');
  for (let index = 1; index < sent.length; index += 1) {
    assert.notEqual(sent[index].role, sent[index - 1].role, 'roles must alternate for strict chat templates');
  }
  assert.doesNotMatch(sent.map((item) => item.content).join('\n'), /did not verify/, 'warnings must not reach the model');

  const agent = new AgentRunner({ store, workspace, models: {}, conversations, toolRunner: tools, send: () => {} });
  const tight = agent.buildHistory({ messages: conversation.messages }, 'none', 'none', 500);
  assert.equal(tight[tight.length - 1].content, 'Sure.', 'a tight budget must keep the newest messages');
  // A tight budget keeps the oldest messages only as a short record, not in full.
  assert.match(tight[0].content, /^\[Earlier in this chat[^\]]*\n1\. The user: "FIRST question"/, 'the oldest messages stay as a short record');
  assert.ok(tight.map((item) => item.content).join('\n').length < 1500, 'and the history stays small');

  // "cosa ricordi di questa chat?": the whole record goes with the question.
  const { chatRecap } = require('../electron/lib/agent.cjs');
  const recap = chatRecap([
    { role: 'user', content: 'open google and search for genesyslabs' },
    { role: 'assistant', content: 'Genesys Labs is a software studio in Mussomeli.', blocks: [{ type: 'tool', status: 'done', title: 'Ran Start-Process brave "https://www.google.com/search?q=genesyslabs"' }] },
    { role: 'user', content: 'find their email' },
    { role: 'assistant', content: 'They have no email address, only a contact form.' },
  ], 2000);
  assert.match(recap, /^1\. The user: "open google and search for genesyslabs"\n {3}Uma \(Ran Start-Process brave[^)]*\): Genesys Labs is a software studio in Mussomeli\.\n2\. The user: "find their email"/);
  const remembered = await chat(['We searched for Genesys Labs, a software studio in Mussomeli.'], 'cosa ricordi di questa chat?', { conversation });
  const askedWith = remembered.calls[0].messages.at(-1).content;
  assert.match(askedWith, /The record of this chat so far[\s\S]*1\. The user: "FIRST question"/, 'the question carries the record of the whole chat');

  const messages = [
    { role: 'system', content: 's'.repeat(1000) },
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old reply' },
    { role: 'user', content: 'CURRENT TASK' },
    ...Array.from({ length: 8 }, (_, i) => [
      { role: 'assistant', content: `call ${i}` },
      { role: 'user', content: `<tool_result name="read_file" ok="true">\n${'r'.repeat(3000)}\n</tool_result>` },
    ]).flat(),
  ];
  const fitted = agent.fitMessages(messages, 9000, 3);
  assert.ok(fitted.reduce((sum, item) => sum + item.content.length, 0) <= 9500);
  assert.ok(fitted.some((item) => item.content.includes('CURRENT TASK')), 'the current request must survive trimming');
  assert.equal(fitted[fitted.length - 1].content.includes('r'.repeat(2000)), true, 'the newest result stays whole');
  assert.equal(messages.length, 20, 'fitting must not mutate the transcript');
  console.log('history and context fitting: OK');
}

async function testTools() {
  const big = path.join(workspaceDir, 'big.log');
  await fsp.writeFile(big, 'keep me\n'.repeat(400000));
  const sizeBefore = (await fsp.stat(big)).size;
  let result = await tools.run('append_file', { path: 'big.log', content: 'new line\n' });
  assert.equal(result.ok, true, result.output);
  assert.equal((await fsp.stat(big)).size, sizeBefore + 9, 'append must never overwrite a file over 2 MB');

  await fsp.writeFile(path.join(workspaceDir, 'code.txt'), 'old');
  result = await tools.run('replace_in_file', { path: 'code.txt', find: 'old', replace: "$& $1 $' cost" });
  assert.equal(result.ok, true, result.output);
  assert.equal(await fsp.readFile(path.join(workspaceDir, 'code.txt'), 'utf8'), "$& $1 $' cost");

  await fsp.writeFile(path.join(workspaceDir, 'win.txt'), 'one\r\ntwo\r\nthree\r\n');
  result = await tools.run('replace_in_file', { path: 'win.txt', find: 'one\ntwo', replace: 'ONE\nTWO' });
  assert.equal(result.ok, true, result.output);
  assert.equal(await fsp.readFile(path.join(workspaceDir, 'win.txt'), 'utf8'), 'ONE\r\nTWO\r\nthree\r\n');

  await fsp.writeFile(path.join(workspaceDir, 'twice.txt'), 'a a');
  result = await tools.run('replace_in_file', { path: 'twice.txt', find: 'a', replace: 'b' });
  assert.match(result.output, /1 other match/);

  let asked = 0;
  await store.updateSettings({ allowEdits: false });
  const asking = new ToolRunner({ workspace, store, onChanged: () => {}, confirmAction: async () => { asked += 1; return true; } });
  result = await asking.run('write_file', { path: 'nope.md', content: 'x' });
  assert.equal(result.ok, false);
  assert.equal(asked, 0, 'do not ask for approval of an action that is switched off');
  await store.updateSettings({ allowEdits: true });

  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1} ${'y'.repeat(100)}`).join('\n');
  await fsp.writeFile(path.join(workspaceDir, 'long.txt'), lines);
  const range = await workspace.readFileRange('long.txt', { maxChars: 2200 });
  assert.ok(range.content.length <= 2200);
  assert.ok(range.truncated);
  assert.match(range.content.split('\n').pop(), new RegExp(`^line ${range.nextLine - 1} `), 'nextLine must follow the last line returned');

  await fsp.writeFile(path.join(workspaceDir, 'UMA.md'), 'Always use tabs.');
  const notesPrompt = await workspace.summaryForPrompt();
  assert.match(notesPrompt, /Project notes from UMA\.md[\s\S]*Always use tabs/);
  await fsp.rm(path.join(workspaceDir, 'UMA.md'));

  await fsp.mkdir(path.join(workspaceDir, 'realdir'), { recursive: true });
  assert.equal(await workspace.exists('realdir'), true);
  console.log('file tools: OK');
}

async function testCommandFolder() {
  await store.updateSettings({ allowShell: true });
  await fsp.mkdir(path.join(workspaceDir, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(workspaceDir, 'sub', 'marker.txt'), 'x');
  let result = await tools.run('run_command', { command: 'Test-Path marker.txt', cwd: 'sub' });
  assert.match(result.output, /True/, 'cwd must be honoured inside the workspace');
  result = await tools.run('run_command', { command: 'Get-Location', cwd: '..' });
  assert.equal(result.ok, false);
  assert.match(result.output, /outside/, 'cwd must not leave the workspace');
  result = await tools.run('run_command', { command: 'Get-Location', cwd: 'no-such-folder' });
  assert.match(result.output, /does not exist/);
  assert.equal(translateChains('a && b'), 'a; if ($?) { b }');
  assert.equal(translateChains('a && b && c'), 'a; if ($?) { b; if ($?) { c } }');
  assert.equal(translateChains('a || b'), 'a; if (-not $?) { b }');
  assert.equal(translateChains('echo "x && y"'), 'echo "x && y"', 'quoted text stays untouched');
  assert.equal(translateChains('plain'), 'plain');
  assert.equal(adaptForPowerShell('where devenv.exe'), 'where.exe devenv.exe');
  assert.equal(adaptForPowerShell('Get-Process | where { $_.CPU }'), 'Get-Process | where { $_.CPU }', 'a real Where-Object stays');
  assert.equal(adaptForPowerShell('rm -rf build'), 'rm -rf build', 'deletes are never made to work by translation');
  if (process.platform === 'win32') {
    result = await tools.run('run_command', { command: 'mkdir -p made/deep && mkdir -p made/deep && Test-Path made/deep', cwd: 'sub' });
    assert.match(result.output.replace(/^\$.*$/m, ''), /True/, 'mkdir -p must work twice');
    result = await tools.run('run_command', { command: 'where cmd.exe' });
    assert.match(result.output, /System32/i, 'where must find programs, not filter objects');
  }
  if (process.platform === 'win32') {
    result = await tools.run('run_command', { command: 'Write-Output one && Write-Output two', cwd: 'sub' });
    assert.equal(result.ok, true, result.output);
    assert.match(result.output, /one\s+two/);
    result = await tools.run('run_command', { command: 'cmd /c exit 1 && Write-Output skipped', cwd: 'sub' });
    assert.doesNotMatch(result.output.replace(/^\$.*$/m, ''), /skipped/, '&& must not run the second part after a failure');
    result = await tools.run('run_command', { command: 'cmd /c exit 1 || Write-Output recovered', cwd: 'sub' });
    assert.match(result.output.replace(/^\$.*$/m, ''), /recovered/);
  }
  await store.updateSettings({ allowShell: false });
  console.log('command working folder and chaining: OK');
}

async function testEnvironment() {
  const result = await tools.run('check_environment', {});
  assert.equal(result.ok, true);
  assert.match(result.output, /cmake:/);
  assert.match(result.output, /visual studio:/);
  console.log(`environment check: OK\n  ${result.output.split('\n').filter((line) => /^(cmake|dotnet|visual studio):/.test(line)).join('\n  ')}`);
}

async function testUndo() {
  const undoLog = new UndoLog({ dir: path.join(root, 'data', 'undo'), trash: (target) => fsp.rm(target, { force: true }) });
  const undoing = new ToolRunner({ workspace, store, onChanged: () => {}, undoLog });
  const file = path.join(workspaceDir, 'undo-me.txt');

  await fsp.writeFile(file, 'original');
  let result = await undoing.run('write_file', { path: 'undo-me.txt', content: 'overwritten' });
  await undoLog.restore(result.data.undoId);
  assert.equal(await fsp.readFile(file, 'utf8'), 'original');
  await assert.rejects(() => undoLog.restore(result.data.undoId), /no longer/);

  result = await undoing.run('write_file', { path: 'brand-new.txt', content: 'x' });
  await undoLog.restore(result.data.undoId);
  await assert.rejects(() => fsp.stat(path.join(workspaceDir, 'brand-new.txt')));

  result = await undoing.run('move_file', { from: 'undo-me.txt', to: 'moved/undo-me.txt' });
  await undoLog.restore(result.data.undoId);
  assert.equal(await fsp.readFile(file, 'utf8'), 'original');

  await assert.rejects(() => undoLog.restore('../../secret'), /Invalid/);
  console.log('undo: OK');
}

async function testEngines() {
  assert.deepEqual(cudaBuildsFor('13.4'), ['13.4', '12.4']);
  assert.deepEqual(cudaBuildsFor('12.8'), ['12.4']);
  assert.deepEqual(cudaBuildsFor('11.8'), []);
  assert.deepEqual(cudaBuildsFor(''), ['13.5', '13.4', '12.4']);
  assert.deepEqual(cudaBuildsFor('13.5'), ['13.5', '13.4', '12.4'], 'newer releases publish 13.5 and 12.4');

  const dir = path.join(root, 'engines');
  const server = (name) => path.join(dir, name, 'llama-server.exe');
  for (const name of ['vulkan', 'cuda']) {
    await ensureDir(path.join(dir, name));
    await fsp.writeFile(server(name), '');
  }
  const engineStore = new Store(path.join(dir, 'data'));
  await engineStore.init();
  // A settings file from before side-by-side engines only knows about the active one.
  await engineStore.setRuntime({ version: 'b1', backend: 'vulkan', serverPath: server('vulkan') });
  const nvidia = { hasGpu: true, nvidia: true, cudaVersion: '13.4' };
  const runtime = new RuntimeManager({ store: engineStore, runtimeDir: dir, downloadsDir: dir, hardware: nvidia });
  let status = await runtime.status();
  assert.equal(status.backends.find((item) => item.id === 'vulkan').active, true);
  assert.equal(status.backends.find((item) => item.id === 'cuda').installed, false);
  await assert.rejects(() => runtime.use('cuda'), /not installed/);

  const vulkan = { version: 'b1', backend: 'vulkan', serverPath: server('vulkan') };
  const cuda = { version: 'b2', backend: 'cuda', cudaBuild: '13.4', serverPath: server('cuda') };
  await engineStore.setRuntime({ ...cuda, installs: { vulkan, cuda } });
  await runtime.use('vulkan');
  assert.equal(engineStore.getRuntime().serverPath, server('vulkan'));
  assert.equal(Object.keys(engineStore.getRuntime().installs).length, 2, 'switching keeps both engines');
  await runtime.use('cuda');
  assert.equal(engineStore.getRuntime().backend, 'cuda');
  status = await runtime.status();
  assert.deepEqual(status.backends.filter((item) => item.installed).map((item) => item.id), ['cuda', 'vulkan']);

  const amd = new RuntimeManager({ store: engineStore, runtimeDir: dir, downloadsDir: dir, hardware: { hasGpu: true, nvidia: false } });
  assert.match(amd.cudaProblem(), /NVIDIA/);
  assert.equal(amd.backendFor('auto'), 'vulkan');
  await assert.rejects(() => amd.install('cuda'), /NVIDIA/);
  const oldDriver = new RuntimeManager({ store: engineStore, runtimeDir: dir, downloadsDir: dir, hardware: { hasGpu: true, nvidia: true, cudaVersion: '11.8' } });
  assert.match(oldDriver.cudaProblem(), /Update the driver/);
  // Linux uses the ubuntu-* builds (they run on Debian too), with the same CPU, Vulkan, and CUDA choices.
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const linux = new RuntimeManager({ store, runtimeDir: root, downloadsDir: root, hardware: { hasGpu: true, nvidia: false } });
    assert.equal(linux.assetFor('b1', 'cpu').name, `llama-b1-bin-ubuntu-${arch}.tar.gz`);
    assert.equal(linux.assetFor('b1', 'vulkan').name, `llama-b1-bin-ubuntu-vulkan-${arch}.tar.gz`);
    assert.equal(linux.assetFor('b1', 'cuda', '13.5').name, `llama-b1-bin-ubuntu-cuda-13.5-${arch}.tar.gz`);
    assert.equal(linux.backendFor('auto'), 'vulkan', 'a non-NVIDIA GPU gets Vulkan');
    assert.equal((await linux.status()).backends.length, 3, 'Linux offers the engine choice');
    // Linux CUDA builds need the system's CUDA libraries; without them Uma suggests Vulkan.
    const noLibs = new RuntimeManager({ store, runtimeDir: root, downloadsDir: root, hardware: { hasGpu: true, nvidia: true, cudaVersion: '13.4', cudaLibs: [] } });
    assert.match(noLibs.cudaProblem(), /sudo apt install libcudart\d+ libcublas\d+/);
    assert.equal(noLibs.backendFor('auto'), 'vulkan');
    assert.deepEqual(cudaBuildsFor('13.4', ['12']), cudaBuildsFor('13.4').filter((build) => build.startsWith('12.')));
    const withLibs = new RuntimeManager({ store, runtimeDir: root, downloadsDir: root, hardware: { hasGpu: true, nvidia: true, cudaVersion: '13.4', cudaLibs: ['12', '13'] } });
    assert.equal(withLibs.backendFor('auto'), 'cuda');

    // When Uma picked CUDA itself and it cannot see the GPU, it installs Vulkan instead of nothing.
    const tried = [];
    withLibs.installBuild = async (backend, build) => {
      tried.push(build ? `${backend} ${build}` : backend);
      if (backend === 'cuda') throw Object.assign(new Error('no device'), { code: 'NO_CUDA_DEVICE' });
    };
    await withLibs.install('auto');
    assert.deepEqual(tried, [...cudaBuildsFor('13.4', ['12', '13']).map((build) => `cuda ${build}`), 'vulkan']);
    tried.length = 0;
    await assert.rejects(withLibs.install('cuda'), /no device/, 'choosing CUDA yourself still reports the problem');
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  }
  // Macs: Apple silicon always gets the official Metal engine, even when an Intel copy of Uma runs
  // under Rosetta; an Intel Mac gets the official CPU engine and can build a Metal one itself.
  const macStore = (runtimeState) => ({ getRuntime: () => runtimeState, setRuntime: async () => {} });
  const appleUnderRosetta = new RuntimeManager({ store: macStore({}), runtimeDir: root, downloadsDir: root, hardware: { appleSilicon: true }, platform: 'darwin' });
  assert.equal(appleUnderRosetta.assetFor('b12131', 'metal').name, 'llama-b12131-bin-macos-arm64.tar.gz');
  assert.equal(appleUnderRosetta.backendFor('auto'), 'metal');
  assert.deepEqual((await appleUnderRosetta.status()).backends, [], 'nothing to choose on Apple silicon');
  const oldIntelInstall = { version: 'b12131', backend: 'metal', serverPath: path.join(root, 'nope', 'llama-server') };
  const intelMac = new RuntimeManager({ store: macStore({ ...oldIntelInstall, installs: { metal: oldIntelInstall } }), runtimeDir: root, downloadsDir: root, hardware: { appleSilicon: false, hasGpu: true }, platform: 'darwin' });
  assert.equal(intelMac.assetFor('b12131', 'cpu').name, 'llama-b12131-bin-macos-x64.tar.gz');
  assert.equal(intelMac.backendFor('auto'), 'cpu', 'the official Intel Mac engine has no Metal');
  assert.equal(intelMac.backendFor('metal'), 'metal');
  assert.equal(intelMac.activeBackend(), 'cpu', 'an engine older Uma recorded as "metal" is the CPU one, so updates do not start a build');
  const intelStatus = await intelMac.status();
  assert.deepEqual(intelStatus.backends.map((item) => [item.id, item.build]), [['cpu', false], ['metal', true]]);
  assert.equal(intelStatus.backend, 'cpu');
  assert.ok(intelMac.installs().cpu && !intelMac.installs().metal);
  // Without Apple's tools (as on this Windows test PC) the build stops with what to install.
  await assert.rejects(intelMac.install('metal'), /Command Line Tools|CMake/);
  console.log('engine choice: OK');
}

async function testSkills() {
  const dir = path.join(root, 'skills-test');
  const globalDir = path.join(dir, 'global');
  const projectRoot = path.join(dir, 'project');
  const skillStore = new Store(path.join(dir, 'data'));
  await skillStore.init();
  const skills = new SkillStore({
    globalDir, bundledDir: path.join(__dirname, '..', 'electron', 'skills'), store: skillStore,
  });
  const write = async (base, name, text) => {
    await ensureDir(path.join(base, name));
    await fsp.writeFile(path.join(base, name, 'SKILL.md'), text);
  };

  // Every starter skill must work, stay small enough for an 8k context, and name only real tools.
  await skills.seed();
  const starters = await skills.list();
  assert.ok(starters.length >= 32, `only ${starters.length} starter skills`);
  const realTools = /\b(list_files|read_file|file_info|write_file|append_file|replace_in_file|create_folder|move_file|delete_file|search_files|run_command|check_environment|web_search|fetch_url|load_skill|read_skill_file|look_at_screen|look_at_page)\b/;
  let promptChars = 0;
  for (const skill of starters) {
    assert.equal(skill.error, '', `${skill.name}: ${skill.error}`);
    assert.ok(skill.body.length <= 2000, `${skill.name} is too long for a small context: ${skill.body.length}`);
    assert.ok(skill.description.length <= 165, `${skill.name}'s description is too long: ${skill.description.length}`);
    assert.match(skill.body, realTools, `${skill.name} names no tool`);
    for (const word of skill.body.match(/\b[a-z]+_(?:file|files|folder|command|environment|search|url|skill)\b/g) || []) {
      assert.match(word, realTools, `${skill.name} names a tool that does not exist: ${word}`);
    }
    assert.doesNotMatch(skill.body, /&&|\brm -rf\b|\bcd \S/, `${skill.name} teaches a command that fails in PowerShell`);
    promptChars += skill.name.length + skill.description.length + 4;
  }
  assert.ok(promptChars <= 4600, `the skill list would leave no room for the user's own skills: ${promptChars} chars`);

  // A deleted starter stays deleted, even when a later version seeds again.
  await fsp.rm(path.join(globalDir, 'website-restyle'), { recursive: true });
  await skills.seed();
  assert.equal((await skills.list()).some((item) => item.name === 'website-restyle'), false);

  // A later version's new skill reaches someone who already seeded, without touching their edits.
  const upgradeDir = path.join(dir, 'upgrade');
  const upgradeBundle = path.join(upgradeDir, 'bundle');
  const upgradeGlobal = path.join(upgradeDir, 'global');
  const upgradeStore = new Store(path.join(upgradeDir, 'data'));
  await upgradeStore.init();
  await upgradeStore.updateSettings({ skillsSeeded: true });
  await write(upgradeBundle, 'website-restyle', '---\ndescription: shipped\n---\nShipped.');
  await write(upgradeBundle, 'brand-new', '---\ndescription: new\n---\nNew.');
  const upgrade = new SkillStore({ globalDir: upgradeGlobal, bundledDir: upgradeBundle, store: upgradeStore });
  await upgrade.seed();
  assert.deepEqual((await upgrade.list()).map((item) => item.name), ['brand-new'], 'an old install gets new skills, not ones it may have deleted');
  await write(upgradeGlobal, 'brand-new', '---\ndescription: edited by me\n---\nMine.');
  await upgrade.seed();
  assert.equal((await upgrade.list())[0].description, 'edited by me', 'seeding never overwrites an edit');

  // A skill that needs internet access is listed, but not offered to the model while that is off:
  // there is nothing it could do. One that needs the terminal is still offered, marked as working
  // in part: it writes the files, and the model is told to give the commands instead of running them.
  const gated = new SkillStore({ globalDir: path.join(dir, 'gated'), store: skillStore });
  await write(path.join(dir, 'gated'), 'needs-terminal', '---\ndescription: d\nrequires: terminal\n---\nBody.');
  await write(path.join(dir, 'gated'), 'needs-web', '---\ndescription: d\nrequires: internet\n---\nBody.');
  await write(path.join(dir, 'gated'), 'needs-both', '---\ndescription: d\nrequires: [terminal, internet]\n---\nBody.');
  await skillStore.updateSettings({ allowShell: false, allowInternet: false });
  const gatedList = Object.fromEntries((await gated.list()).map((skill) => [skill.name, [skill.needs, skill.partial]]));
  assert.deepEqual(gatedList, { 'needs-both': ['Terminal access', false], 'needs-terminal': ['Terminal access', true], 'needs-web': ['Internet access', false] });
  assert.deepEqual((await gated.enabled()).map((skill) => skill.name), ['needs-terminal']);
  const gatedTools = new ToolRunner({ workspace, store: skillStore, onChanged: () => {}, skills: gated });
  const inPart = await gatedTools.run('load_skill', { name: 'needs-terminal' });
  assert.match(inPart.output, /Terminal access is off, so no command can be run[\s\S]*tell the user the exact command[\s\S]*Body\./);
  assert.equal((await gatedTools.run('load_skill', { name: 'needs-web' })).ok, false);
  await skillStore.updateSettings({ allowShell: true });
  assert.deepEqual((await gated.enabled()).map((skill) => [skill.name, skill.partial]), [['needs-terminal', false]]);
  assert.doesNotMatch((await gatedTools.run('load_skill', { name: 'needs-terminal' })).output, /no command can be run/);
  await skillStore.updateSettings({ allowShell: false });

  await fsp.rm(globalDir, { recursive: true });
  await write(globalDir, 'cpp-cmake-project', '---\ndescription: Shared version\n---\nShared.');

  // A project skill replaces a shared one of the same name, and CRLF files parse.
  const projectSkills = path.join(projectRoot, '.uma', 'skills');
  await write(projectSkills, 'cpp-cmake-project', '---\r\nname: cpp-cmake-project\r\ndescription: "Project version"\r\n---\r\n\r\nProject steps.\r\n');
  await write(globalDir, 'no-header', 'Just text.');
  await write(globalDir, 'no-description', '---\nname: x\n---\nBody');
  await write(globalDir, 'Bad Name', '---\ndescription: d\n---\nBody');
  await write(globalDir, 'good', '---\ndescription: A good skill\n---\nGood steps.');
  let listed = await skills.list(projectRoot);
  assert.equal(listed.find((item) => item.name === 'cpp-cmake-project').description, 'Project version');
  assert.equal(listed.some((item) => item.name === 'Bad Name'), false, 'unsafe folder names are ignored');
  assert.match(listed.find((item) => item.name === 'no-header').error, /header/);
  assert.match(listed.find((item) => item.name === 'no-description').error, /description/);
  assert.deepEqual((await skills.enabled(projectRoot)).map((item) => item.name), ['cpp-cmake-project', 'good'], 'broken skills are not offered');

  // A symlinked skill cannot read a file from elsewhere on the PC.
  const outside = path.join(dir, 'outside');
  await write(outside, 'secret', '---\ndescription: secret\n---\nSECRET');
  let linked = false;
  try {
    await fsp.symlink(path.join(outside, 'secret'), path.join(projectSkills, 'linked'), 'junction');
    linked = true;
  } catch {}
  if (linked) assert.equal((await skills.list(projectRoot)).some((item) => item.name === 'linked'), false);

  // Disabled skills disappear from the model's view and cannot be loaded.
  await skillStore.updateSettings({ disabledSkills: ['good'] });
  assert.equal((await skills.enabled(projectRoot)).some((item) => item.name === 'good'), false);
  await assert.rejects(() => skills.load('good', projectRoot), /no skill called/);
  await assert.rejects(() => skills.load('../../outside/secret', projectRoot), /no skill called/);
  await skillStore.updateSettings({ disabledSkills: [] });

  const created = await skills.create({ name: 'My-New-Skill', description: 'Do a thing', scope: 'project', root: projectRoot });
  assert.equal(created.name, 'my-new-skill');
  assert.equal(parseSkill(await fsp.readFile(created.path, 'utf8')).description, 'Do a thing');
  await assert.rejects(() => skills.create({ name: 'my-new-skill', description: 'x', scope: 'project', root: projectRoot }), /already exists/);
  await assert.rejects(() => skills.create({ name: '../evil', description: 'x' }), /lowercase/);

  // Through the agent.
  await fsp.mkdir(path.join(workspaceDir, '.uma', 'skills', 'release-notes'), { recursive: true });
  await fsp.writeFile(path.join(workspaceDir, '.uma', 'skills', 'release-notes', 'SKILL.md'), '---\ndescription: Write release notes\n---\nStep one: read CHANGELOG.');
  const skillTools = new ToolRunner({ workspace, store, onChanged: () => {}, skills: new SkillStore({ globalDir: path.join(dir, 'none'), store }) });

  let run = await chat([
    '{"skill":"release-notes"}',
    '{"name":"write_file","arguments":{"path":"notes.md","content":"v2\\n"}}',
    'Done, following the skill.',
  ], 'document what changed in this project for version 2', { toolRunner: skillTools });
  assert.match(run.calls[0].messages[0].content, /release-notes: Write release notes/, 'the prompt lists the skill');
  assert.doesNotMatch(run.calls[0].messages.map((item) => item.content).join('\n'), /Step one/, 'the body costs no context until it is chosen');
  assert.deepEqual(run.calls[0].responseSchema.properties.skill.enum, ['release-notes', 'none'], 'the choice is limited to real skills');
  assert.equal(run.calls[0].maxTokens, 40);
  assert.match(run.calls[1].messages.map((item) => item.content).join('\n'), /Step one: read CHANGELOG/);
  assert.doesNotMatch(run.calls[1].messages.map((item) => item.content).join('\n'), /Before starting/, 'the question does not linger');
  assert.equal(toolBlocks(run.message)[0].title, 'Loaded skill release-notes');

  // A request that names the skill word for word loads it at once: no question, one reply less.
  run = await chat([
    '{"name":"write_file","arguments":{"path":"notes0.md","content":"v2\\n"}}',
    'Done, following the skill.',
  ], 'write the release notes for this project', { toolRunner: skillTools });
  assert.equal(run.calls[0].responseSchema, undefined, 'the model is not asked which skill fits');
  assert.match(run.calls[0].messages.at(-1).content, /Step one: read CHANGELOG/);
  assert.deepEqual(toolBlocks(run.message).map((block) => block.name), ['load_skill', 'write_file']);

  // The model can still load one later itself, and "none" or garbage from the chooser is harmless.
  run = await chat([
    '{"skill":"none"}',
    '{"name":"load_skill","arguments":{"name":"release-notes"}}',
    '{"name":"write_file","arguments":{"path":"notes2.md","content":"v2\\n"}}',
    'Done.',
  ], 'document what changed in this project for version 2', { toolRunner: skillTools });
  assert.deepEqual(toolBlocks(run.message).map((block) => block.name), ['load_skill', 'write_file']);
  run = await chat([
    'not json',
    '{"name":"write_file","arguments":{"path":"notes3.md","content":"v2\\n"}}',
    'Done.',
  ], 'document what changed in this project for version 2', { toolRunner: skillTools });
  assert.equal(run.message.status, 'done');
  assert.deepEqual(toolBlocks(run.message).map((block) => block.name), ['write_file']);
  // Looking something up can only choose a web skill, even if the request names a project tool.
  await fsp.mkdir(path.join(workspaceDir, '.uma', 'skills', 'look-things-up'), { recursive: true });
  await fsp.writeFile(path.join(workspaceDir, '.uma', 'skills', 'look-things-up', 'SKILL.md'), '---\ndescription: Search the web\nrequires: internet\n---\nUse web_search.');
  await store.updateSettings({ allowInternet: true });
  run = await chat(['{"skill":"look-things-up"}', 'It is a build tool.'], 'search the web for what the CMake project is', { toolRunner: skillTools });
  assert.deepEqual(run.calls[0].responseSchema.properties.skill.enum, ['look-things-up', 'none']);
  await store.updateSettings({ allowInternet: false });
  await fsp.rm(path.join(workspaceDir, '.uma', 'skills', 'look-things-up'), { recursive: true });

  // Ordinary chat never pays for the extra question.
  run = await chat(['Roses are red.'], 'make me a poem', { toolRunner: skillTools });
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].responseSchema, undefined);

  run = await chat(['Following it now.'], '/release-notes do them for version 2', { toolRunner: skillTools });
  const sent = run.calls[0].messages[run.calls[0].messages.length - 1].content;
  assert.match(sent, /^do them for version 2/, 'the shortcut is removed from the request');
  assert.match(sent, /Step one: read CHANGELOG/, 'a slash command loads the skill directly');
  assert.equal(toolBlocks(run.message)[0].name, 'load_skill');

  run = await chat(['Sure.'], '/not-a-skill hello', { toolRunner: skillTools });
  assert.match(run.calls[0].messages[run.calls[0].messages.length - 1].content, /^\/not-a-skill hello/, 'unknown names stay as typed');
  assert.equal(toolBlocks(run.message).length, 0);

  run = await chat(['No skills here.'], 'hello');
  assert.doesNotMatch(run.calls[0].messages[0].content, /## Skills/, 'no skills means no extra prompt text');

  // Forced rounds can name only real skills, and a loaded skill survives trimming.
  run = await chat(['{"skill":"none"}', 'I guess it is fine.', '{"name":"list_files","arguments":{"path":"."}}', 'Reviewed.'], 'review this project', { toolRunner: skillTools });
  const options = run.calls[2].responseSchema.anyOf;
  const skillOption = options.find((option) => option.properties.name.const === 'load_skill');
  assert.deepEqual(skillOption.properties.arguments.properties.name.enum, ['release-notes']);

  const agent = new AgentRunner({ store, workspace, models: {}, conversations, toolRunner: skillTools, send: () => {} });
  const fitted = agent.fitMessages([
    { role: 'system', content: 's' },
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'a' },
    { role: 'user', keep: true, content: `<tool_result name="load_skill" ok="true">\n${'SKILL'.repeat(400)}\n</tool_result>` },
    ...Array.from({ length: 6 }, (_, i) => [
      { role: 'assistant', content: `call ${i}` },
      { role: 'user', content: `<tool_result name="read_file" ok="true">\n${'r'.repeat(3000)}\n</tool_result>` },
    ]).flat(),
  ], 7000, 1);
  assert.ok(fitted.some((item) => item.content.includes('SKILL'.repeat(400))), 'a loaded skill must not be trimmed away');

  await fsp.rm(path.join(workspaceDir, '.uma'), { recursive: true });
  console.log('skills: OK');
}

/** Builds a small but real GGUF file, so parsing and downloads can be tested without a model. */
function makeGguf({ architecture = 'qwen3', layers = 2, embd = 64, extra = {} }) {
  const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
  const str = (value) => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
  const kvs = {
    'general.architecture': architecture,
    'general.name': 'Test Model',
    [`${architecture}.block_count`]: layers,
    [`${architecture}.context_length`]: 4096,
    [`${architecture}.embedding_length`]: embd,
    [`${architecture}.attention.head_count`]: 4,
    [`${architecture}.attention.head_count_kv`]: 2,
    ...extra,
  };
  const entries = Object.entries(kvs).map(([key, value]) => Buffer.concat([
    str(key),
    typeof value === 'string' ? Buffer.concat([u32(8), str(value)]) : Buffer.concat([u32(4), u32(value)]),
  ]));
  // A long string array stands in for the tokenizer, which the reader must step over.
  entries.push(Buffer.concat([str('tokenizer.ggml.tokens'), u32(9), u32(8), u64(2000), ...Array.from({ length: 2000 }, (_, i) => str(`tok${i}`))]));
  const tensors = [['token_embd.weight', 100], ...Array.from({ length: layers }, (_, i) => [`blk.${i}.attn.weight`, 1000]), ['output.weight', 200]];
  let offset = 0;
  const infos = tensors.map(([name, size]) => {
    const info = Buffer.concat([str(name), u32(1), u64(size), u32(0), u64(offset)]);
    offset += size;
    return info;
  });
  const head = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(tensors.length), u64(entries.length), ...entries, ...infos]);
  const padded = Math.ceil(head.length / 32) * 32;
  return Buffer.concat([head, Buffer.alloc(padded - head.length), Buffer.alloc(offset, 7)]);
}

async function testModelFeatures() {
  // Reading a header, from disk and over HTTP range requests.
  const dir = path.join(root, 'models-test');
  await ensureDir(dir);
  const file = makeGguf({ layers: 8, embd: 256, extra: { 'qwen3.attention.key_length': 64, 'qwen3.attention.value_length': 64 } });
  const filePath = path.join(dir, 'tiny.gguf');
  await fsp.writeFile(filePath, file);
  let info = await readModelInfo([{ source: fileSource(filePath), size: file.length }]);
  assert.equal(info.architecture, 'qwen3');
  assert.equal(info.nLayer, 8);
  assert.equal(info.contextLength, 4096);
  assert.equal(info.keyLength, 64);
  assert.deepEqual(info.layerBytes, Array(8).fill(1000));
  assert.equal(info.inputBytes, 100);
  assert.equal(info.otherBytes, 200);
  await fsp.writeFile(path.join(dir, 'bad.gguf'), 'not a model at all');
  await assert.rejects(() => readModelInfo([{ source: fileSource(path.join(dir, 'bad.gguf')), size: 18 }]), /not a valid GGUF/);

  const requested = [];
  const server = http.createServer((request, response) => {
    requested.push(request.url);
    const name = decodeURIComponent(request.url.split('/').pop());
    const body = served[name];
    if (!body) { response.writeHead(404); response.end(); return; }
    const range = request.headers.range?.match(/bytes=(\d+)-(\d+)?/);
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(body.length - 1, Number(range[2] ?? body.length - 1));
      response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${body.length}` });
      response.end(body.subarray(start, end + 1));
    } else {
      response.writeHead(200, { 'Content-Length': body.length });
      response.end(body);
    }
  });
  const partOne = makeGguf({ layers: 4, embd: 128 });
  const partTwo = makeGguf({ layers: 4, embd: 128 });
  const served = { 'tiny.gguf': file, 'split-00001-of-00002.gguf': partOne, 'split-00002-of-00002.gguf': partTwo };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    info = await readModelInfo([{ source: urlSource(`${base}/tiny.gguf`), size: file.length }]);
    assert.equal(info.nLayer, 8, 'a remote header reads the same as a local one');

    // A split model downloads into its own folder as one entry, and removes as one.
    const modelStore = new Store(path.join(dir, 'data'));
    await modelStore.init();
    const modelsDir = path.join(dir, 'models');
    const manager = new ModelManager({ store: modelStore, modelsDir, downloadsDir: dir });
    await manager.init();
    const id = 'hub:owner/repo:split';
    const entry = await manager.startDownload(id, {
      name: 'Split Q4', url: `${base}/split-00001-of-00002.gguf`, filename: 'split-00001-of-00002.gguf', sizeBytes: partOne.length + partTwo.length, repo: 'owner/repo', quant: 'Q4', folder: 'owner__repo',
      files: [
        { url: `${base}/split-00001-of-00002.gguf`, filename: 'split-00001-of-00002.gguf', size: partOne.length },
        { url: `${base}/split-00002-of-00002.gguf`, filename: 'split-00002-of-00002.gguf', size: partTwo.length },
      ],
    });
    assert.equal(entry.id, id);
    assert.equal(entry.size, partOne.length + partTwo.length);
    assert.equal(entry.parts.length, 2);
    assert.deepEqual((await manager.modelInfo(id)).layerBytes, Array(4).fill(2000), 'block sizes add up across parts');
    await manager.remove(id);
    assert.deepEqual(modelStore.getInstalledModels(), []);
    assert.equal(await fsp.stat(entry.path).catch(() => null), null);

    await assert.rejects(async () => manager.startDownload('hub:x:y', { name: 'x', url: `${base}/a.gguf`, filename: 'a.gguf', folder: 'x', files: [{ url: `${base}/a.gguf`, filename: '..\\..\\evil.gguf', size: 1 }] }), /unsafe/);
    await assert.rejects(async () => manager.startDownload('hub:x:z', { name: 'x', url: `${base}/a.gguf`, filename: 'a.gguf', folder: '..\\..\\out', files: [{ url: `${base}/a.gguf`, filename: 'a.gguf', size: 1 }] }), /unsafe/);
    const huge = manager.startDownload('hub:x:huge', { name: 'x', url: `${base}/tiny.gguf`, filename: 'tiny.gguf', folder: 'huge', files: [{ url: `${base}/tiny.gguf`, filename: 'tiny.gguf', size: 2 ** 52 }] });
    await assert.rejects(() => huge, /Not enough disk space/);
  } finally {
    server.close();
  }

  // The estimate, checked against what llama.cpp reported loading Qwen3 8B on an RTX 2070.
  const qwen = {
    nLayer: 36, nEmbd: 4096, nHead: 32, nHeadKv: 8, keyLength: 128, valueLength: 128, attentionLayers: 36,
    layerBytes: Array(36).fill((5027783488 - 350060544 - 510521344) / 36), inputBytes: 350060544, otherBytes: 510521344, totalBytes: 5027783488, contextLength: 40960,
  };
  const mib = (bytes) => bytes / 1048576;
  const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${Math.round(actual)} vs ${expected}`);
  const hardware = { vramGB: 8, ramGB: 32 };
  const at = (settings) => estimateMemory(qwen, { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', gpuLayers: 999, ...settings }, hardware);
  near(mib(at({ contextSize: 8192 }).kvBytes), 612, 1, 'KV at 8k');
  near(mib(at({ contextSize: 32768 }).kvBytes), 2448, 1, 'KV at 32k');
  near(mib(at({ contextSize: 16384, cacheTypeK: 'f16', cacheTypeV: 'f16' }).kvBytes), 2304, 1, 'KV f16');
  near(mib(at({ contextSize: 16384, cacheTypeK: 'q4_0', cacheTypeV: 'q4_0' }).kvBytes), 648, 1, 'KV q4_0');
  near(mib(at({ contextSize: 8192 }).gpuBytes), 5179, 80, 'GPU total at 8k');
  near(mib(at({ contextSize: 32768 }).gpuBytes), 7103, 80, 'GPU total at 32k');
  near(mib(at({ contextSize: 16384, gpuLayers: 20 }).gpuBytes), 3404, 80, 'GPU total, partly offloaded');
  assert.equal(at({ contextSize: 8192 }).fit, 'good');
  assert.equal(at({ contextSize: 32768 }).fit, 'good');
  assert.equal(at({ contextSize: 65536 }).fit, 'too-big');
  assert.equal(at({ contextSize: 16384, gpuLayers: 20 }).fit, 'partial');
  assert.equal(at({ contextSize: 16384, gpuLayers: 0 }).fit, 'cpu');
  assert.ok(at({ contextSize: 65536 }).suggestedLayers < 37, 'a smaller offload is suggested when it does not fit');
  const hybrid = { ...qwen, attentionLayers: 9 };
  assert.ok(estimateMemory(hybrid, { contextSize: 32768, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' }, hardware).kvBytes < at({ contextSize: 32768 }).kvBytes / 3, 'only layers with attention use the cache');

  // Settings: per-model values win, bad ones are refused, and Uma keeps its own flags.
  assert.deepEqual(sanitizeModelSettings({ contextSize: '8192', flashAttn: 'on', nonsense: 1, extraArgs: '' }), { contextSize: 8192, flashAttn: 'on' });
  assert.throws(() => sanitizeModelSettings({ cacheTypeK: 'q9' }), /cacheTypeK/);
  assert.throws(() => sanitizeModelSettings({ contextSize: 12.5 }), /whole number/);
  assert.throws(() => sanitizeModelSettings({ gpuLayers: -1 }), /gpuLayers/);
  for (const bad of ['--host 0.0.0.0', '--port=80', '--api-key x', '-m C:\\other.gguf', '--log-file x']) {
    assert.throws(() => sanitizeModelSettings({ extraArgs: bad }), /Uma manages/, bad);
  }
  assert.deepEqual(parseExtraArgs('--threads-http 4 --alias "my model"'), ['--threads-http', '4', '--alias', 'my model']);
  const args = buildServerArgs('m.gguf', { contextSize: 70000, gpuLayers: 26, threads: 6, cacheTypeK: 'f16', cacheTypeV: 'q4_0', flashAttn: 'on', kvUnified: true, reasoningBudget: 0, extraArgs: '--threads-http 4' }, 'cuda');
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag('-c'), '70000');
  assert.equal(flag('-ngl'), '26');
  assert.equal(flag('-ctk'), 'f16');
  assert.equal(flag('-ctv'), 'q4_0');
  assert.equal(flag('-fa'), 'on');
  assert.equal(flag('--reasoning-budget'), '0');
  assert.ok(args.includes('--kv-unified') && args.includes('--threads-http'));
  assert.equal(buildServerArgs('m.gguf', { gpuLayers: 26 }, 'cpu')[buildServerArgs('m.gguf', { gpuLayers: 26 }, 'cpu').indexOf('-ngl') + 1], '0', 'the CPU engine loads nothing on a GPU');
  assert.equal(buildServerArgs('m.gguf', {}, 'cuda').includes('--kv-unified'), false);
  const defaults = buildServerArgs('m.gguf', {}, 'cuda');
  assert.equal(defaults[defaults.indexOf('-ngl') + 1], 'auto', 'by default the engine fits layers to free VRAM');
  const allArgs = buildServerArgs('m.gguf', {}, 'cuda', { allLayers: true });
  assert.equal(allArgs[allArgs.indexOf('-ngl') + 1], 'all');
  assert.equal(allArgs.includes('--fit-target'), false);
  const pinned = buildServerArgs('m.gguf', { gpuLayers: 12 }, 'cuda', { allLayers: true });
  assert.equal(pinned[pinned.indexOf('-ngl') + 1], '12', 'a number the user set always wins');

  // Loading all layers depends on the VRAM free at that moment.
  const fitting = new LlamaManager({ store, logsDir: dir, modelInfo: async () => qwen, freeVram: async () => 7742 * 1048576 });
  assert.equal(await fitting.allLayersFit({ id: 'q' }, { contextSize: 32768, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' }), true, 'what fits loads fully');
  assert.equal(await fitting.allLayersFit({ id: 'q' }, { contextSize: 65536, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' }), false, 'what does not is left to the engine');
  assert.equal(await fitting.allLayersFit({ id: 'q' }, { contextSize: 8192, gpuLayers: 5 }), false, 'a manual setting is never overridden');
  const busyGpu = new LlamaManager({ store, logsDir: dir, modelInfo: async () => qwen, freeVram: async () => 2000 * 1048576 });
  assert.equal(await busyGpu.allLayersFit({ id: 'q' }, { contextSize: 8192, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' }), false, 'another app using the GPU counts');
  const noReading = new LlamaManager({ store, logsDir: dir, modelInfo: async () => qwen, freeVram: async () => 0 });
  assert.equal(await noReading.allLayersFit({ id: 'q' }, { contextSize: 8192 }), false, 'without a reading, the engine decides');
  assert.equal(sanitizeModelSettings({ ...DEFAULTS, threads: 0, contextSize: 8192 }).contextSize, 8192, 'the default values themselves must validate');
  assert.equal(sanitizeModelSettings({ reasoningBudgetMessage: 'Please --host wrap up' }).reasoningBudgetMessage, 'Please --host wrap up', 'free text is not parsed as flags');

  // Automatic offload: fits everything when it can, and falls back to fewer layers when it cannot.
  const autoFits = estimateMemory(qwen, { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', contextSize: 8192 }, hardware);
  assert.equal(autoFits.gpuLayers, 37);
  assert.equal(autoFits.autoLayers, true);
  const autoPartial = estimateMemory(qwen, { cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', contextSize: 65536 }, hardware);
  assert.ok(autoPartial.gpuLayers < 37 && autoPartial.gpuLayers > 0, `auto chose ${autoPartial.gpuLayers}`);
  assert.equal(autoPartial.fit, 'partial');

  const overrideStore = new Store(path.join(dir, 'override-data'));
  await overrideStore.init();
  await overrideStore.updateSettings({ contextSize: 8192, temperature: 0.3 });
  await overrideStore.setModelOverrides('a', { contextSize: 70000 });
  assert.equal(overrideStore.getEffectiveSettings('a').contextSize, 70000);
  assert.equal(overrideStore.getEffectiveSettings('a').temperature, 0.3, 'unset values fall back to the general settings');
  assert.equal(overrideStore.getEffectiveSettings('b').contextSize, 8192);
  await overrideStore.setModelOverrides('a', {});
  assert.equal(overrideStore.getEffectiveSettings('a').contextSize, 8192, 'reset removes the override');

  // The agent sizes its budgets and sampling from the model's own settings.
  await store.updateSettings({ modelOverrides: { mock: { contextSize: 4096, topK: 7, repeatPenalty: 1.2, seed: 42 } } });
  const run = await chat(['Hi.'], 'hello');
  assert.deepEqual(run.calls[0].sampling, { top_k: 7, repeat_penalty: 1.2, seed: 42 });
  assert.equal(run.calls[0].maxTokens, 1024, 'the reply budget follows the model context, not the general one');
  await store.updateSettings({ modelOverrides: {} });

  // Hugging Face result handling, without the network.
  const realFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('?blobs=true') ? {
      gated: false,
      siblings: [
        { rfilename: 'Model-UD-Q4_K_M.gguf', size: 100 },
        { rfilename: 'BF16/Model-BF16-00001-of-00002.gguf', size: 70 },
        { rfilename: 'BF16/Model-BF16-00002-of-00002.gguf', size: 30 },
        { rfilename: 'mmproj-F16.gguf', size: 5 },
        { rfilename: 'imatrix_unsloth.gguf', size: 5 },
        { rfilename: 'MTP/mtp-Model-Q4_0.gguf', size: 5 },
        { rfilename: 'README.md', size: 1 },
      ],
    } : [
      { id: 'a/text-GGUF', downloads: 5, pipeline_tag: 'text-generation' },
      { id: 'a/image-GGUF', downloads: 9, pipeline_tag: 'text-to-image' },
      { id: 'a/unknown-GGUF', downloads: 1 },
    ]),
  });
  try {
    assert.deepEqual((await searchModels({ query: 'x' })).map((item) => item.id), ['a/text-GGUF', 'a/unknown-GGUF'], 'image models are left out');
    const detail = await repoVariants('owner/repo');
    assert.deepEqual(detail.variants.map((item) => [item.quant, item.sizeBytes, item.files.length]).sort(), [['BF16', 100, 2], ['UD-Q4_K_M', 100, 1]]);
    assert.match(detail.variants.find((item) => item.quant === 'BF16').files[0].url, /resolve\/main\/BF16\/Model-BF16-00001/);
    await assert.rejects(() => repoVariants('../../etc'), /valid/);
  } finally {
    global.fetch = realFetch;
  }
  console.log('model search, settings, and memory estimate: OK');
}

/** A minimal single-file zip, enough to stand in for a real .docx. */
function makeZip(name, content) {
  const data = zlib.deflateRawSync(Buffer.from(content));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(30 + name.length + data.length, 16);
  return Buffer.concat([local, Buffer.from(name), data, central, Buffer.from(name), end]);
}

/** A real one-page PDF with a text layer, built by hand so the test needs no fixture file. */
function makePdf(text) {
  const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const at = out.length;
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function testAttachments() {
  const dir = path.join(root, 'attachments-test');
  const attachments = new AttachmentStore({ dir });
  const add = (name, bytes, kind = 'document') => attachments.add({ name, kind, bytes });

  let item = await add('notes.txt', Buffer.from('The code word is MARIGOLD.'));
  assert.equal(item.kind, 'document');
  assert.match(await attachments.text(item.id), /MARIGOLD/);
  item = await add('utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hello wide text', 'utf16le')]));
  assert.equal(await attachments.text(item.id), 'Hello wide text', 'Windows UTF-16 text files read correctly');
  item = await add('report.docx', makeZip('word/document.xml', '<w:document><w:p><w:r><w:t>Budget &amp; plan</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:document>'));
  assert.equal(await attachments.text(item.id), 'Budget & plan\nSecond line');
  item = await add('paper.pdf', makePdf('The launch code is ZEBRA'));
  assert.match(await attachments.text(item.id), /\[Page 1\]\s+The launch code is ZEBRA/);
  assert.equal(item.pages, 1);

  await assert.rejects(() => add('old.doc', Buffer.from('x')), /\.docx or PDF/);
  await assert.rejects(() => add('sheet.xlsx', Buffer.from('x')), /\.csv/);
  await assert.rejects(() => add('app.exe', Buffer.from([77, 90, 0, 0, 3, 0, 0, 0])), /cannot read/);
  await assert.rejects(() => add('empty.txt', Buffer.alloc(0)), /empty/);
  await assert.rejects(() => add('fake.pdf', Buffer.from('not a pdf')), /could not read/i);
  await assert.rejects(() => add('fake.docx', Buffer.from('not a zip at all, sorry about that friend')), /damaged/);
  await assert.rejects(() => attachments.add({ name: 'x.png', kind: 'image', bytes: Buffer.from('nope') }), /could not be read as an image/);
  await assert.rejects(() => attachments.text('../../secret'), /Invalid/);
  const traversal = await add('..\\..\\evil.txt', Buffer.from('x'));
  assert.equal(traversal.name.includes('..'), false, 'a file name cannot climb out of the folder');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);
  const image = await attachments.add({ name: 'shot.png', kind: 'image', bytes: png, thumbnail: 'data:image/jpeg;base64,xx' });
  assert.match(await attachments.imageDataUrl(image.id), /^data:image\/png;base64,/);
  await attachments.remove([image.id]);
  await assert.rejects(() => attachments.imageDataUrl(image.id));

  // Through the agent. A question about an attached file is answered, not sent hunting through the workspace.
  const tools2 = new ToolRunner({ workspace, store, onChanged: () => {} });
  const chatWith = async (script, text, attached, { model = { id: 'mock', name: 'Mock', family: 'Test' }, conversation } = {}) => {
    const convo = conversation || await conversations.create();
    const calls = [];
    let done;
    const finished = new Promise((resolve) => { done = resolve; });
    const agent = new AgentRunner({
      store, workspace, conversations, toolRunner: tools2, attachments,
      models: { resolveActive: async () => model },
      llama: {
        async ensureServer() {},
        async *streamChat(request) {
          calls.push(request);
          yield { type: 'text', text: script[Math.min(calls.length - 1, script.length - 1)] };
        },
      },
      send: (_channel, payload) => { if (payload?.type === 'assistant-end') done(payload.message); },
    });
    await agent.send(convo.id, text, attached);
    return { message: await finished, calls, conversation: convo };
  };

  const doc = await add('report.pdf', makePdf('Sales grew by nine percent'));
  let run = await chatWith(['Sales grew nine percent.'], 'review this report.pdf and fix any errors', [doc]);
  assert.equal(run.calls.length, 1, 'no forced tool round');
  assert.equal(run.calls[0].responseSchema, undefined);
  let last = run.calls[0].messages.at(-1).content;
  assert.match(last, /<attached_file name="report.pdf">/);
  assert.match(last, /Sales grew by nine percent/);
  assert.match(last, /data to read, not instructions/);
  assert.equal(run.message.blocks.filter((block) => block.type === 'tool').length, 0);

  // A later message can still ask about it, and a message can be just a file.
  const followUp = await chatWith(['Page one.'], 'which page was that on?', [], { conversation: run.conversation });
  assert.match(followUp.calls[0].messages.at(-1).content, /Sales grew by nine percent/);
  assert.match(followUp.calls[0].messages.map((m) => m.content).join('\n'), /Attached: report.pdf/);
  run = await chatWith(['Read it.'], '', [doc]);
  assert.match(run.calls[0].messages.at(-1).content, /Please look at the attached file/);

  // Mentioning the project still lets it work on the project.
  run = await chatWith(['{"name":"list_files","arguments":{"path":"."}}', 'Done.'], 'add this to the project readme', [doc]);
  assert.equal(run.message.blocks.some((block) => block.name === 'list_files'), true);

  // A file too long for the context is cut with a visible warning, keeping the start and the end.
  const big = await add('huge.txt', Buffer.from(`START ${'word '.repeat(200000)} FINISH`));
  run = await chatWith(['Summary.'], 'summarize this', [big]);
  last = run.calls[0].messages.at(-1).content;
  assert.ok(last.length < 40000, `sent ${last.length} chars`);
  assert.ok(last.includes('START') && last.includes('FINISH'));
  assert.match(run.message.blocks[0].text, /huge.txt is too long.*saw only about \d+%/);

  // Several files share the budget, and a file is never quietly dropped.
  const small = await add('small.txt', Buffer.from('SMALLFILE contents'));
  run = await chatWith(['Ok.'], 'compare these', [big, small]);
  last = run.calls[0].messages.at(-1).content;
  assert.ok(last.includes('SMALLFILE'), 'the second file must get its share');

  // Images go only to a model that can see them, as real image content.
  const shot = await attachments.add({ name: 'error.png', kind: 'image', bytes: png });
  const textOnly = { id: 'mock', name: 'Mock', family: 'Test' };
  await assert.rejects(() => chatWith(['x'], 'what is this?', [shot], { model: textOnly }), /cannot see images/);
  const seeing = { id: 'mock', name: 'Vision', family: 'Test', mmproj: { path: 'v.gguf', size: 1 } };
  run = await chatWith(['A dialog box.'], 'explain this error', [shot], { model: seeing });
  const content = run.calls[0].messages.at(-1).content;
  assert.ok(Array.isArray(content), 'an image is sent as multipart content');
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /explain this error/);
  assert.equal(content[1].type, 'image_url');
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(run.calls.length, 1, 'no tool hunt for a screenshot question');
  const later = await chatWith(['Sure.'], 'thanks', [], { model: seeing, conversation: run.conversation });
  assert.equal(typeof later.calls[0].messages.at(-1).content, 'string', 'an old image is not sent again');

  // Vision on the command line, in the estimate, and as part of a download.
  assert.equal((args => args[args.indexOf('--mmproj') + 1])(buildServerArgs('m.gguf', {}, 'cuda', { mmproj: 'v.gguf' })), 'v.gguf');
  assert.equal(buildServerArgs('m.gguf', {}, 'cuda').includes('--mmproj'), false);
  const base = { nLayer: 4, nEmbd: 64, nHead: 4, nHeadKv: 4, keyLength: 16, valueLength: 16, attentionLayers: 4, layerBytes: [10, 10, 10, 10], inputBytes: 1, otherBytes: 1, totalBytes: 42, contextLength: 4096 };
  const plain = estimateMemory(base, { contextSize: 1024, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', gpuLayers: 999 }, {});
  const withVision = estimateMemory({ ...base, mmprojBytes: 1000 }, { contextSize: 1024, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', gpuLayers: 999 }, {});
  assert.equal(withVision.gpuBytes - plain.gpuBytes, 1000);

  // The request right after an image must not reuse the prompt cache; others should.
  const bodies = [];
  const llamaFetch = global.fetch;
  global.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) } };
  };
  try {
    const manager = new LlamaManager({ store, logsDir: dir });
    manager.state = 'ready';
    manager.port = 1;
    const go = async (content) => { for await (const _event of manager.streamChat({ messages: [{ role: 'user', content }] })); };
    await go('first');
    await go([{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:' } }]);
    await go('after the image');
    await go('later');
    clearTimeout(manager.idleTimer);
    assert.deepEqual(bodies.map((body) => body.cache_prompt), [true, true, false, true]);
  } finally {
    global.fetch = llamaFetch;
  }

  // Usage readings.
  let gpuCalls = 0;
  const stats = new SystemStats({ queryGpu: async () => { gpuCalls += 1; return null; } });
  const reading = await stats.sample();
  assert.ok(reading.cpuPercent >= 0 && reading.cpuPercent <= 100);
  assert.ok(reading.ramUsedBytes > 0 && reading.ramUsedBytes <= reading.ramTotalBytes);
  assert.equal(reading.gpu, null);
  await stats.sample();
  await stats.sample();
  await stats.sample();
  await stats.sample();
  assert.equal(gpuCalls, 3, 'with no NVIDIA GPU it stops trying');
  const real = await new SystemStats().sample();
  if (real.gpu) assert.ok(real.gpu.usedBytes <= real.gpu.totalBytes && real.gpu.percent >= 0);
  console.log('attachments, vision, and usage readings: OK');
}

async function testMisc() {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '10.1.1.1', '192.168.0.2', '169.254.169.254', 'fe80::1', 'fec0::1', '224.0.0.1']) {
    assert.equal(isPrivateIp(address), true, address);
  }
  for (const address of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPrivateIp(address), false, address);

  const conversation = await conversations.create();
  await conversations.remove(conversation.id);
  await conversations.save(conversation);
  assert.equal((await conversations.list()).some((item) => item.id === conversation.id), false, 'a deleted conversation must stay deleted');

  const brokenDir = path.join(root, 'broken');
  await ensureDir(brokenDir);
  await fsp.writeFile(path.join(brokenDir, 'settings.json'), '{ not json');
  const broken = new Store(brokenDir);
  await broken.init();
  assert.equal(broken.getSettings().contextSize, 8192, 'a damaged settings file must not stop startup');

  await Promise.all(Array.from({ length: 8 }, (_, i) => store.updateSettings({ temperature: 0.1 + i / 100 })));
  console.log('web guard, deletion, damaged and concurrent settings: OK');
}

async function testNetwork() {
  // llama-server --list-devices output, as printed for a CUDA PC with one helper.
  const listing = 'Available devices:\n  CUDA0: NVIDIA GeForce RTX 2070 (8191 MiB, 7154 MiB free)\n  RPC0: 192.168.1.20:50052 (12288 MiB, 11020 MiB free)\n';
  assert.deepEqual(parseDevices(listing), [{ id: 'RPC0', name: '192.168.1.20:50052', totalMB: 12288, freeMB: 11020 }]);
  assert.ok(isPrivateIPv4('192.168.1.20') && isPrivateIPv4('10.0.0.5') && isPrivateIPv4('172.20.1.1'));
  assert.ok(!isPrivateIPv4('8.8.8.8') && !isPrivateIPv4('172.32.0.1'));
  assert.equal(cleanHost(' 192.168.1.20 '), '192.168.1.20');
  assert.throws(() => cleanHost('http://192.168.1.20'), /IP address/);
  assert.throws(() => cleanHost('-rf'), /IP address/);
  assert.throws(() => parseExtraArgs('--rpc 192.168.1.20:50052'), /Uma manages it/, 'helpers are set in Settings, not as an extra flag');

  // Helpers that do not answer are left out of the launch instead of stopping llama.cpp.
  // It reads what arrives, like a real server, so it notices when the other side closes.
  const listener = net.createServer((socket) => { socket.on('error', () => {}); socket.resume(); socket.end(); });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const openPort = listener.address().port;
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));

  const savedRuntime = store.getRuntime();
  await store.setRuntime({});
  const network = new NetworkManager({ store, emit: () => {}, cacheDir: path.join(root, 'rpc-cache') });
  await store.updateSettings({ network: { share: false, shareAddress: '', sharePort: 50052, helpers: [], helpersMode: 'auto' } });
  let status = await network.addHelper({ host: '127.0.0.1', port: openPort, label: 'Desk PC' });
  assert.equal(status.helpers[0].lastTest.ok, false);
  assert.match(status.helpers[0].lastTest.error, /engine/, 'testing needs the engine installed');
  await assert.rejects(network.addHelper({ host: '127.0.0.1', port: openPort }), /already/);
  status = await network.addHelper({ host: '127.0.0.1', port: closedPort });
  assert.match(status.helpers[1].lastTest.error, /Nothing answered/);

  assert.deepEqual(await network.helpersForLaunch({ fitsHere: true }), { servers: [], skipped: [], details: [] }, 'auto mode leaves helpers out when the model fits');
  const launch = await network.helpersForLaunch({ fitsHere: false });
  assert.deepEqual(launch.servers, [`127.0.0.1:${openPort}`]);
  assert.deepEqual(launch.skipped, [`127.0.0.1:${closedPort}`]);
  await network.setMode('always');
  assert.equal((await network.helpersForLaunch({ fitsHere: true })).servers.length, 1);
  const keyBefore = network.launchKey();
  await network.updateHelper(status.helpers[0].id, { enabled: false });
  assert.notEqual(network.launchKey(), keyBefore, 'turning a helper off reloads the model');
  assert.deepEqual((await network.helpersForLaunch({ fitsHere: false })).servers, []);
  await network.setMode('off');
  await network.updateHelper(status.helpers[0].id, { enabled: true });
  assert.deepEqual(await network.helpersForLaunch({ fitsHere: false }), { servers: [], skipped: [], details: [] });
  await assert.rejects(network.setMode('sometimes'), /Unknown/);
  await network.removeHelper(status.helpers[1].id);
  assert.equal(network.settings().helpers.length, 1);

  // Free memory from the last good test counts in the estimate, and only while helpers are on.
  await network.setMode('auto');
  await store.updateSettings({ network: { ...network.settings(), helpers: network.settings().helpers.map((item) => ({ ...item, lastTest: { ok: true, devices: [{ id: 'RPC0', name: 'x', totalMB: 12288, freeMB: 6144 }] } })) } });
  assert.equal(network.helperFreeGB(), 6);
  const GiB = 1024 ** 3;
  const big = { nLayer: 10, nEmbd: 64, nHead: 4, nHeadKv: 4, keyLength: 16, valueLength: 16, attentionLayers: 10, layerBytes: Array(10).fill(GiB), inputBytes: GiB / 4, otherBytes: GiB / 2, totalBytes: 10.75 * GiB, contextLength: 4096 };
  const alone = estimateMemory(big, { contextSize: 1024, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', gpuLayers: 999 }, { vramGB: 8, ramGB: 64 });
  assert.equal(alone.fit, 'too-big');
  const pooled = estimateMemory(big, { contextSize: 1024, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', gpuLayers: 999 }, { vramGB: 8, ramGB: 64, helperGB: network.helperFreeGB() });
  assert.equal(pooled.fit, 'good');
  assert.match(pooled.message, /helper PCs/);
  await network.setMode('off');
  assert.equal(network.helperFreeGB(), 0);

  // The title bar counts helpers that answer, and ones the loaded model uses without probing them.
  await network.setMode('auto');
  let presence = await network.presence();
  assert.deepEqual([presence.configured, presence.online.length, presence.online[0].name], [1, 1, 'Desk PC']);
  await network.updateHelper(network.settings().helpers[0].id, { enabled: false });
  presence = await network.presence();
  assert.deepEqual([presence.configured, presence.online.length], [0, 0]);
  await network.addHelper({ host: '127.0.0.1', port: closedPort });
  assert.equal((await network.presence()).online.length, 0, 'a helper that does not answer is not connected');
  assert.equal((await network.presence([`127.0.0.1:${closedPort}`])).online[0].inUse, true);

  // The relay in front of the shared engine: reachability checks stay out of the log, real use is logged and counted.
  // A connection reset when the main PC leaves is normal; the fake engine ignores it like the real one.
  const engine = net.createServer((socket) => socket.on('error', () => {}).on('data', (data) => socket.write(data.subarray(0, 16))));
  await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve));
  const relayNet = new NetworkManager({ store, emit: () => {}, cacheDir: path.join(root, 'rpc-cache') });
  const front = net.createServer((socket) => relayNet.relay(socket, engine.address().port));
  await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
  const frontPort = front.address().port;
  const check = net.connect(frontPort, '127.0.0.1');
  await new Promise((resolve) => check.once('connect', resolve));
  check.destroy();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(relayNet.activity.length, 0, 'a connect-and-leave check is not logged');
  const mainPc = net.connect(frontPort, '127.0.0.1');
  mainPc.on('error', () => {});
  await new Promise((resolve) => mainPc.once('connect', resolve));
  let echoed = 0;
  mainPc.on('data', (data) => { echoed += data.length; });
  mainPc.write(Buffer.alloc(9 * 1024 * 1024, 1));
  for (let i = 0; i < 50 && !relayNet.activity.some((entry) => entry.kind === 'connect'); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(relayNet.activity.at(-1).text, /127\.0\.0\.1 connected/);
  assert.equal(relayNet.status().sharing.clients.length, 1);
  assert.ok(echoed > 0, 'replies from the engine reach the main PC');
  const fullyReceived = () => [...relayNet.sessions.values()].some((item) => item.received >= 9 * 1024 * 1024);
  for (let i = 0; i < 50 && !fullyReceived(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  mainPc.destroy();
  for (let i = 0; i < 50 && !relayNet.activity.some((entry) => entry.kind === 'disconnect'); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(relayNet.activity.at(-1).text, /disconnected after .* Received 9\.0 MB/);
  assert.equal(relayNet.share.totals.sessions, 1);
  assert.equal(relayNet.status().sharing.clients.length, 0);
  await new Promise((resolve) => front.close(resolve));
  await new Promise((resolve) => engine.close(resolve));

  // Network speed: bytes per second between two readings; a counter reset gives no reading.
  const readings = [{ rx: 1000, tx: 500 }, { rx: 1000 + 2 * 1048576, tx: 500 + 4096 }, { rx: 10, tx: 10 }];
  const speedStats = new SystemStats({ queryGpu: async () => null, network: { read: async () => readings.shift() } });
  assert.equal((await speedStats.sample()).net, null, 'the first reading has nothing to compare with');
  speedStats.previousNet.at -= 2000;
  const { net: speed } = await speedStats.sample();
  // Within 2%: the sample itself takes a moment, more so on a busy PC.
  assert.ok(Math.abs(speed.rxBps - 1048576) < 21000 && Math.abs(speed.txBps - 2048) < 41, JSON.stringify(speed));
  assert.equal((await speedStats.sample()).net, null);

  await store.updateSettings({ network: { share: false, shareAddress: '', sharePort: 50052, helpers: [], helpersMode: 'auto' } });
  await store.setRuntime(savedRuntime);
  await new Promise((resolve) => listener.close(resolve));
  console.log('helper PCs on the network: OK');
}

function testPlacement() {
  // This PC: an 8 GB GPU. One helper: a 12 GB GPU and 32 GB of RAM, offered RAM first.
  const devices = parseDeviceList([
    'Available devices:',
    '  CUDA0: NVIDIA GeForce RTX 2070 (8191 MiB, 7154 MiB free)',
    '  RPC0: 192.168.1.20:50052 (32768 MiB, 20000 MiB free)',
    '  RPC1: 192.168.1.20:50052 (12288 MiB, 11020 MiB free)',
  ].join('\n'));
  const helpers = [{ address: '192.168.1.20:50052', label: 'Desk PC', info: { devices: [{ kind: 'cpu', reserveMB: 6554 }, { kind: 'gpu' }] } }];

  // Fits on the GPUs: shared in proportion to free memory, so the 12 GB helper takes the larger part.
  const balanced = planPlacement({ devices, helpers, needMB: 13000 });
  assert.equal(balanced.mode, 'balanced');
  assert.deepEqual(balanced.devices.map((device) => device.name), ['RPC1', 'CUDA0'], 'helper RAM is left out when the GPUs are enough');
  const [helperGpu, ownGpu] = balanced.devices;
  assert.ok(helperGpu.wantMB > ownGpu.wantMB * 1.4, `helper ${helperGpu.wantMB} MiB vs this PC ${ownGpu.wantMB} MiB`);
  assert.ok(helperGpu.wantMB + ownGpu.wantMB >= 13000, 'together they hold the whole model');
  assert.deepEqual(placementArgs(balanced), ['-dev', 'RPC1,CUDA0', '-ts', '61,39', '--fit-target', '512']);
  // A small model still uses both GPUs: proportions, not margins, so work buffers cannot push it to the CPU.
  assert.equal(planPlacement({ devices, helpers, needMB: 400 }).mode, 'balanced');
  // Close to the limit there is no room for fixed proportions, so the GPUs are filled instead.
  assert.equal(planPlacement({ devices, helpers, needMB: 15500 }).mode, 'fill');

  // Too big for the GPUs: both GPUs filled, then the helper's RAM (keeping its reserve), and the
  // device order makes llama.cpp fill the GPUs before the RAM.
  const fill = planPlacement({ devices, helpers, needMB: 30000 });
  assert.equal(fill.mode, 'fill');
  assert.deepEqual(placementArgs(fill), ['-dev', 'RPC0,RPC1,CUDA0', '--fit-target', '6554,512,512']);

  // An older helper that does not describe its devices is taken as GPUs only.
  const legacy = planPlacement({ devices, helpers: [{ address: '192.168.1.20:50052', info: null }], needMB: 30000 });
  assert.deepEqual(legacy.devices.map((device) => [device.name, device.kind]), [['RPC0', 'gpu'], ['RPC1', 'gpu'], ['CUDA0', 'gpu']]);

  // This PC without a GPU still offloads to a helper's GPU.
  const cpuOnly = planPlacement({ devices: devices.filter((device) => device.name !== 'CUDA0'), helpers, needMB: 9000 });
  assert.equal(cpuOnly.mode, 'fill', 'with one GPU there is nothing to balance');
  assert.deepEqual(cpuOnly.devices.map((device) => device.name), ['RPC0', 'RPC1'], 'helper RAM first in the list, so its GPU fills first');
  assert.ok(buildServerArgs('m.gguf', {}, 'cpu', { placement: placementArgs(cpuOnly) }).join(' ').includes('-ngl auto -t'));
  const cpuArgs = buildServerArgs('m.gguf', {}, 'cpu');
  assert.equal(cpuArgs[cpuArgs.indexOf('-ngl') + 1], '0', 'without helpers a CPU engine offloads nothing');
  // A helper at full power keeps a small reserve, and the main PC respects it.
  const lean = planPlacement({ devices, helpers: [{ ...helpers[0], info: { devices: [{ kind: 'cpu', reserveMB: 1536 }, { kind: 'gpu' }] } }], needMB: 30000 });
  assert.equal(lean.devices[0].targetMB, 1536);
  console.log('helper placement: OK');
}

async function testHelperCache() {
  const { pruneCache, keepFreeFor } = require('../electron/lib/helperCache.cjs');
  const GB = 1024 ** 3;
  // The laptop on 2026-11-09: 237 GB disk, 13 GB free, 19.7 GB of cached model parts.
  const parts = Array.from({ length: 20 }, (_, i) => ({ file: `part${i}`, size: GB, used: 1000 + i }));
  const removed = [];
  const result = await pruneCache('cache', { space: { free: 13 * GB, total: 237 * GB }, parts: parts.map((part) => ({ ...part })), remove: async (file) => { removed.push(file); } });
  assert.ok(Math.abs(keepFreeFor(237 * GB) - 23.7 * GB) < 1, '10% of the disk, at least 10 GB');
  assert.equal(keepFreeFor(50 * GB), 10 * GB);
  assert.equal(result.removed, 11, 'just enough parts to reach 23.7 GB free');
  assert.deepEqual(removed.slice(0, 3), ['part0', 'part1', 'part2'], 'least recently used first');
  assert.ok(result.enoughSpace && result.freeBytes >= result.keepFreeBytes);
  // Enough space: nothing is touched.
  const roomy = await pruneCache('cache', { space: { free: 100 * GB, total: 237 * GB }, parts: parts.map((part) => ({ ...part })), remove: async () => assert.fail('nothing to remove') });
  assert.equal(roomy.removed, 0);
  // Even an empty cache is not enough: the helper then runs without it.
  const full = await pruneCache('cache', { space: { free: 2 * GB, total: 237 * GB }, parts: [{ file: 'a', size: GB, used: 1 }], remove: async () => {} });
  assert.equal(full.enoughSpace, false);
  // A real folder: files are listed at any depth and removed oldest first.
  const dir = path.join(root, 'helper-cache-test', 'rpc');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'old'), Buffer.alloc(1024));
  await fsp.writeFile(path.join(dir, 'new'), Buffer.alloc(1024));
  const past = new Date(Date.now() - 86400000);
  await fsp.utimes(path.join(dir, 'old'), past, past);
  const real = await pruneCache(path.dirname(dir), { space: { free: 0, total: 1024 ** 2 } });
  assert.equal(real.removed, 2);
  assert.deepEqual(await fsp.readdir(dir), []);
  console.log('helper cache tidying: OK');
}

function testCacheFixes() {
  const { cacheTypeFixes } = require('../electron/lib/modelSettings.cjs');
  // Qwen3.8-Flash-Next (qwen4exp) with -ctk iq4_nl stopped a helper's CUDA engine at
  // getrows.cu:203 GGML_ASSERT(ne00 % QK_K == 0): its indexer cache rows are read with get_rows.
  const indexed = { architecture: 'qwen4exp', indexerHeads: 4 };
  const plain = { architecture: 'qwen3', indexerHeads: 0 };
  // K and V change together: CUDA flash attention has no kernel for q4_0 keys with iq4_nl values
  // (0.2.12 changed only K, and the helper then stopped at fattn.cu:798 "fatal error").
  const fixed = cacheTypeFixes({ cacheTypeK: 'iq4_nl', cacheTypeV: 'iq4_nl' }, indexed);
  assert.deepEqual([fixed.settings.cacheTypeK, fixed.settings.cacheTypeV], ['q4_0', 'q4_0']);
  assert.equal(fixed.changed, 'iq4_nl>q4_0');
  assert.ok(buildServerArgs('m.gguf', fixed.settings, 'cuda').join(' ').includes('-ctk q4_0 -ctv q4_0'));
  // With helper PCs, any model: llama.cpp cannot check that a helper's GPU supports the cache type.
  const withHelpers = cacheTypeFixes({ cacheTypeK: 'q8_0', cacheTypeV: 'iq4_nl' }, plain, { helpers: true });
  assert.deepEqual([withHelpers.settings.cacheTypeK, withHelpers.settings.cacheTypeV], ['q8_0', 'q4_0']);
  assert.match(withHelpers.notes[0], /helper PCs/);
  // This PC alone with an ordinary model: llama.cpp checks its own GPU, so the choice stays.
  assert.equal(cacheTypeFixes({ cacheTypeK: 'iq4_nl', cacheTypeV: 'iq4_nl' }, plain).changed, '');
  assert.equal(cacheTypeFixes({ cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' }, indexed, { helpers: true }).changed, '', 'supported types are left alone');
  assert.equal(cacheTypeFixes({ cacheTypeK: 'iq4_nl' }, null).notes.length, 0, 'unknown model details change nothing');
  console.log('cache type fixes: OK');
}

async function testHelperRecovery() {
  const { NetworkManager, helperInfo } = require('../electron/lib/network.cjs');
  const { LlamaManager } = require('../electron/lib/llama.cjs');
  const fakeStore = (runtime, settings = {}) => ({
    runtime,
    settings: { network: settings },
    getRuntime() { return this.runtime; },
    getSettings() { return this.settings; },
    async updateSettings(patch) { this.settings = { ...this.settings, ...patch }; },
  });

  // Engine builds: a helper installs a newer build a main PC asks about, never an older one.
  const installs = [];
  const helperStore = fakeStore({ version: 'b12001', backend: 'cuda' });
  const helper = new NetworkManager({
    store: helperStore,
    runtime: { installing: false, install: async (backend, { tag }) => { installs.push([backend, tag]); helperStore.runtime = { ...helperStore.runtime, version: tag }; } },
  });
  helper.share.state = 'on';
  let restarted = 0;
  helper.startSharing = async () => { restarted += 1; };
  helper.matchEngine('b11978', '192.168.1.10');
  helper.matchEngine('b12001', '192.168.1.10');
  assert.equal(installs.length, 0, 'same or older build: nothing to install');
  helper.matchEngine('b12102', '192.168.1.10');
  helper.matchEngine('b12102', '192.168.1.10');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(installs, [['cuda', 'b12102']], 'installs once, the same kind of engine');
  assert.equal(restarted, 1, 'sharing restarts on the new build');
  assert.match(helper.activity.map((entry) => entry.text).join('\n'), /runs llama\.cpp b12102 and this PC runs b12001/);

  // The main PC leaves out a helper on another build, saying which side updates.
  const main = new NetworkManager({ store: fakeStore({ version: 'b12102' }) });
  assert.equal(main.engineMismatch({ engine: 'b12102' }, 'Laptop'), '');
  assert.equal(main.engineMismatch({ devices: [] }, 'Laptop'), '', 'an older Uma does not say its build');
  assert.match(main.engineMismatch({ engine: 'b12001' }, 'Laptop'), /Laptop is installing b12102/);
  assert.match(main.engineMismatch({ engine: 'b12200' }, 'Laptop'), /update the engine on this PC/);
  // The helper's log tells loading model parts (much in, almost nothing out) from computing.
  const { isLoading } = require('../electron/lib/network.cjs');
  const MB = 1024 * 1024;
  assert.equal(isLoading({ receiveRate: 21 * MB, sendRate: 20 * MB }), false, 'reading a long prompt is computing (seen live at 17-21 MB/s each way)');
  assert.equal(isLoading({ receiveRate: 80 * MB, sendRate: 0.1 * MB }), true);
  assert.equal(isLoading({ receiveRate: 0.3 * MB, sendRate: 0 }), false, 'a single token step is not a load');
  // With its engine manager, the main PC catches up with a newer helper by itself, once.
  const mainInstalls = [];
  const mainStore = fakeStore({ version: 'b12102', backend: 'cuda' });
  const catchingUp = new NetworkManager({
    store: mainStore,
    runtime: { installing: false, install: async (backend, { tag }) => { mainInstalls.push([backend, tag]); mainStore.runtime = { ...mainStore.runtime, version: tag }; } },
  });
  assert.match(catchingUp.engineMismatch({ engine: 'b12131' }, 'laptop'), /this PC is installing b12131 now/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(mainInstalls, [['cuda', 'b12131']]);
  assert.equal(catchingUp.engineMismatch({ engine: 'b12131' }, 'laptop'), '', 'same build afterwards');
  assert.equal(catchingUp.upgradeEngine('b12102'), false, 'never an older build');

  // Over the network: the main PC's build travels with the info request, and the helper answers its own.
  const relayStore = fakeStore({ version: 'b12001' });
  const relayNet = new NetworkManager({ store: relayStore });
  const asked = [];
  relayNet.matchEngine = (tag, address) => asked.push([tag, address]);
  const front = net.createServer((socket) => relayNet.relay(socket, 1));
  await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
  const answer = await helperInfo('127.0.0.1', front.address().port, 2500, { engine: 'b12102' });
  assert.equal(answer.engine, 'b12001');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(asked, [['b12102', '127.0.0.1']]);
  const plain = await helperInfo('127.0.0.1', front.address().port);
  assert.equal(plain.engine, 'b12001', 'the old one-line request still works');
  await new Promise((resolve) => front.close(resolve));

  // A load that fails because a helper stopped is loaded on this PC alone, so the model still works.
  const attempts = [];
  const fake = {
    helpers: { servers: [], details: [], skipped: [] },
    placement: null,
    logs: [],
    log(line) { this.logs.push(line); },
    async startServer(_model, _runtime, _key, attempt) {
      attempts.push(attempt);
      if (attempt.helpers === false) {
        this.helpers = { servers: [], details: [], skipped: ['Laptop'] };
        return 'ready alone';
      }
      this.helpers = { servers: ['192.168.137.50:50052'], details: [{ label: 'Laptop' }], skipped: [] };
      this.placement = { mode: 'balanced' };
      this.logs = ['D:/a/llama.cpp/llama.cpp/ggml/src/ggml-rpc/ggml-rpc.cpp:433: Remote RPC server crashed or returned malformed response'];
      throw Object.assign(new Error('stopped while loading'), { code: 'SERVER_FAILED' });
    },
  };
  assert.equal(await LlamaManager.prototype.startWithHelpers.call(fake, {}, {}, ''), 'ready alone');
  assert.deepEqual(attempts, [{}, { helpers: false }], 'a stopped helper is not tried again');
  // A balanced plan that does not fit is retried as a fill plan first.
  attempts.length = 0;
  fake.startServer = async function (_m, _r, _k, attempt) {
    attempts.push(attempt);
    this.helpers = { servers: ['192.168.137.50:50052'], details: [{ label: 'Laptop' }], skipped: [] };
    this.placement = attempt.plan === 'fill' ? { mode: 'fill' } : { mode: 'balanced' };
    this.logs = ['cudaMalloc failed: out of memory'];
    if (attempt.plan === 'fill') return 'ready with helpers';
    throw Object.assign(new Error('stopped while loading'), { code: 'SERVER_FAILED' });
  };
  assert.equal(await LlamaManager.prototype.startWithHelpers.call(fake, {}, {}, ''), 'ready with helpers');
  assert.deepEqual(attempts, [{}, { plan: 'fill' }]);
  // Other errors are not hidden.
  fake.startServer = async () => { throw Object.assign(new Error('model missing'), { code: 'MODEL_MISSING' }); };
  await assert.rejects(LlamaManager.prototype.startWithHelpers.call(fake, {}, {}, ''), /model missing/);

  // The helper engine stopping does not end sharing: it starts again, and only gives up (closing the
  // port) after it keeps stopping. Node with llama.cpp's arguments stands in for an engine that stops at once.
  const address = require('node:os').networkInterfaces();
  const lan = Object.values(address).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(entry.address));
  if (lan) {
    const crashStore = fakeStore({ version: 'b12001', serverPath: path.join(root, 'missing', 'llama-server.exe') }, { fullPower: false });
    const crashy = new NetworkManager({ store: crashStore, cacheDir: path.join(root, 'rpc-cache-crash'), logsDir: path.join(root, 'logs-crash') });
    await fsp.mkdir(path.join(root, 'logs-crash'), { recursive: true });
    crashy.rpcServerPath = async () => process.execPath;
    // A free port picked by the system can fall in a range Windows reserves (Hyper-V, WSL), which
    // Uma rightly refuses: then another one is tried.
    // It also happens for every port while a network card is changing address: then this check
    // cannot run on this PC right now, and is skipped rather than failed.
    let started = false;
    for (let attempt = 0; attempt < 8 && !started; attempt += 1) {
      const probeServer = net.createServer();
      await new Promise((resolve) => probeServer.listen(0, lan.address, resolve));
      const port = probeServer.address().port;
      await new Promise((resolve) => probeServer.close(resolve));
      try {
        await crashy.startSharing({ address: lan.address, port });
        started = true;
      } catch (err) {
        if (!/does not allow port/.test(err.message)) throw err;
      }
    }
    if (!started) console.log("  (helper restart check skipped: this PC's network card accepts no port right now)");
    if (started) {
    for (let i = 0; i < 200 && crashy.share.state !== 'error'; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const texts = crashy.activity.map((entry) => entry.text);
    assert.ok(texts.filter((text) => /Starting it again/.test(text)).length === 3, texts.join('\n'));
    assert.equal(crashy.share.state, 'error');
    assert.match(crashy.share.error, /stopped 4 times/);
    assert.equal(crashy.proxy, null, 'the port is closed once it gives up');
    assert.match(await fsp.readFile(path.join(root, 'logs-crash', 'helper.log'), 'utf8'), /Starting it again/, 'the log is kept in a file');
    await crashy.stopSharing({ quiet: true, remember: false });
    }
  }
  console.log('helper recovery and engine versions: OK');
}

function testHelperPower() {
  const { helperBudget, ClockWatch } = require('../electron/lib/helperPower.cjs');
  // Full power: every thread, and 3-6 GB of RAM kept free (the helper engine itself needs about 2 GB
  // beyond the layers; with 1.5 GB a 16 GB laptop ran out and its engine stopped).
  assert.deepEqual(helperBudget({ fullPower: true, cpus: 16, ramMB: 16384 }), { threads: 16, reserveMB: 3072 });
  assert.deepEqual(helperBudget({ fullPower: true, cpus: 16, ramMB: 32768 }), { threads: 16, reserveMB: 3932 });
  assert.deepEqual(helperBudget({ fullPower: true, cpus: 32, ramMB: 131072 }), { threads: 32, reserveMB: 6144 });
  // Off: half the threads and a larger reserve, so the PC stays usable.
  assert.deepEqual(helperBudget({ fullPower: false, cpus: 16, ramMB: 16384 }), { threads: 8, reserveMB: 5120 });
  assert.deepEqual(helperBudget({ fullPower: false, cpus: 4, ramMB: 32768 }), { threads: 4, reserveMB: 8192 });

  // The laptop measured on 2026-11-09: 4.0 GHz idle, 0.8 GHz while computing for the main PC.
  const events = [];
  const watch = new ClockWatch({ onSlow: (event) => events.push(['slow', event.mhz]), onRecovered: (event) => events.push(['ok', event.mhz]) });
  let now = 1000000;
  watch.check(4000, 5, now);
  for (let i = 0; i < 2; i++) watch.check(800, 50, (now += 5000));
  assert.equal(events.length, 0, 'one or two slow readings are not enough');
  watch.check(800, 50, (now += 5000));
  assert.deepEqual(events, [['slow', 800]]);
  for (let i = 0; i < 5; i++) watch.check(800, 50, (now += 5000));
  assert.equal(events.length, 1, 'the warning is not repeated every few seconds');
  watch.check(3200, 60, (now += 5000));
  watch.check(800, 60, (now += 5000));
  assert.equal(events.length, 1, 'one fast reading between slow ones is not a recovery');
  for (let i = 0; i < 3; i++) watch.check(3200, 60, (now += 5000));
  assert.deepEqual(events[1], ['ok', 3200]);
  // An idle CPU at a low clock is just saving power.
  const idle = new ClockWatch({ onSlow: () => assert.fail('idle is not slow') });
  idle.check(4000, 2, now);
  for (let i = 0; i < 5; i++) idle.check(800, 3, (now += 5000));
  // A healthy all-core clock under load is not reported.
  const healthy = new ClockWatch({ onSlow: () => assert.fail('3.1 GHz under load is fine') });
  healthy.check(4500, 2, now);
  for (let i = 0; i < 5; i++) healthy.check(3100, 90, (now += 5000));
  console.log('helper full power: OK');
}

function testLanguages() {
  // First run follows the system; the installer records a Windows language ID.
  assert.equal(i18n.systemLanguage(['it-IT', 'en-US']), 'it');
  assert.equal(i18n.systemLanguage(['zh-Hant-TW']), 'zh-TW');
  assert.equal(i18n.systemLanguage(['zh-HK']), 'zh-TW');
  assert.equal(i18n.systemLanguage(['zh-CN']), 'zh-CN');
  assert.equal(i18n.systemLanguage(['es-MX']), 'es');
  assert.equal(i18n.systemLanguage(['ja']), 'ja');
  assert.equal(i18n.systemLanguage(['fr-FR', 'de-DE']), 'en', 'unsupported languages fall back to English');
  assert.deepEqual([1040, 3082, 1041, 2052, 1028, 1033].map(i18n.fromWindowsLanguageId), ['it', 'es', 'ja', 'zh-CN', 'zh-TW', 'en']);
  assert.equal(i18n.fromWindowsLanguageId('9999'), '');
  // Placeholders are filled, untranslated text falls back to English, and English stays the default.
  assert.equal(i18n.translate('it', 'Port {0} is already in use on this PC. Choose another port.', [50052]), "La porta 50052 è già in uso su questo PC. Scegli un'altra porta.");
  assert.equal(i18n.translate('ja', 'Not a key in any locale {0}', ['x']), 'Not a key in any locale x');
  i18n.setLanguage('xx');
  assert.equal(i18n.getLanguage(), 'en');
  assert.equal(i18n.t('Model not found.'), 'Model not found.');
  console.log('languages: OK');
}

/**
 * A folder named in a message (the user's report: "check F:\...\GAME ENGINE NEW") becomes the
 * chat's folder; an answer written before any file was read is set aside; follow-ups stay on it.
 */
async function testChatFolder() {
  const { namedFolder } = require('../electron/lib/agent.cjs');
  const engine = path.join(root, 'Game Development', 'GAME ENGINE NEW');
  await ensureDir(path.join(engine, 'src'));
  await fsp.writeFile(path.join(engine, 'src', 'main.cpp'), 'int main() { return 0; }\n');
  // A path with spaces followed by more words, a file inside it, one inside the workspace, one that does not exist.
  assert.equal(await namedFolder(`check ${engine} how does it look?`, workspaceDir), engine);
  assert.equal(await namedFolder(`${engine} check the code of the game engine`, workspaceDir), engine);
  assert.equal(await namedFolder(`look at ${path.join(engine, 'src', 'main.cpp')}, please`, workspaceDir), path.join(engine, 'src'));
  assert.equal(await namedFolder(`read ${path.join(workspaceDir, 'README.md')}`, workspaceDir), '');
  assert.equal(await namedFolder(`check ${path.join(root, 'nothing here')}`, workspaceDir), '');
  assert.equal(await namedFolder('hello, how are you?', workspaceDir), '');

  await store.updateSettings({ allowSystemAccess: true });
  const fullTools = new ToolRunner({ workspace, store, onChanged: () => {} });
  const first = await chat([
    "I'm unable to access that path as it is outside of the workspace. Here is the workspace instead: README.md.",
    `\`\`\`tool\n{"name":"list_files","arguments":{"path":${JSON.stringify(engine)}}}\n\`\`\``,
    'The engine has a src folder with main.cpp.',
  ], `check ${engine} how does it look?`, { toolRunner: fullTools });
  const request = first.calls[0].messages.at(-1).content;
  assert.ok(request.startsWith(`[This chat works in the folder ${engine}.`), 'the model is told which folder the chat is about');
  assert.equal((await conversations.get(first.conversation.id)).folder, engine);
  const draft = first.message.blocks.find((block) => block.type === 'text' && block.text.includes('unable to access'));
  assert.ok(draft?.unchecked, 'the answer written before looking is marked');
  assert.ok(!first.message.content.includes('unable to access'), 'and is not kept as the answer');
  assert.ok(first.message.content.includes('main.cpp'));

  // A follow-up without a path stays on that folder, and the history has no "I cannot access it".
  const second = await chat(['The code is in src/main.cpp.'], 'check my engine code', { conversation: first.conversation, toolRunner: fullTools });
  const messages = second.calls[0].messages;
  assert.ok(messages.at(-1).content.startsWith(`[This chat works in the folder ${engine}.`));
  assert.ok(!messages.some((message) => message.role === 'assistant' && message.content.includes('unable to access')));

  // Without full PC access the model is told to say so, not to describe the workspace.
  await store.updateSettings({ allowSystemAccess: false });
  const third = await chat(['Full PC access is off.'], 'and the renderer?', { conversation: first.conversation });
  assert.match(third.calls[0].messages.at(-1).content, /full PC access is off, so your tools cannot open it/);
  console.log('chat folder named in a message, unchecked first answers: OK');
}

/**
 * The user's report: a model answered "I moved the call… Now let me rebuild… The build succeeded"
 * without running a single tool, again and again, copying its earlier replies.
 */
async function testClaimedChanges() {
  await fsp.writeFile(path.join(workspaceDir, 'gui.cpp'), 'void onCreate() {\n  refreshProcessList();\n  createListView();\n}\n');
  const fake = "I see the issue. refreshProcessList() is called before the ListView is created. Let me fix this by moving the call.\n\nNow let me rebuild to test the fix:\n\nThe build succeeded. I moved the call to after the ListView is created.";
  // A chat that already worked on files, then a bug report with no file name in it.
  const setup = await chat([`\`\`\`tool\n{"name":"read_file","arguments":{"path":"gui.cpp"}}\n\`\`\``, 'It creates the list view.'], 'read gui.cpp');
  const result = await chat([
    fake,
    `\`\`\`tool\n{"name":"replace_in_file","arguments":{"path":"gui.cpp","find":"  refreshProcessList();\\n  createListView();","replace":"  createListView();\\n  refreshProcessList();"}}\n\`\`\``,
    'Moved refreshProcessList() after createListView() in gui.cpp.',
  ], "i still can't see the process in the process list", { conversation: setup.conversation });
  assert.match(await fsp.readFile(path.join(workspaceDir, 'gui.cpp'), 'utf8'), /createListView\(\);\n {2}refreshProcessList\(\);/, 'the change was really made');
  const claimed = result.message.blocks.find((block) => block.type === 'text' && block.text.includes('The build succeeded'));
  assert.equal(claimed?.unchecked, 'claimed', 'the description of changes that did not happen is set aside');
  assert.ok(!result.message.content.includes('The build succeeded'));
  assert.match(result.calls[1].messages.at(-1).content, /Nothing was changed: no tool ran/);

  // A model that keeps only describing: the user is told nothing changed.
  const stubborn = await chat([fake], "i still can't see the process in the process list", { conversation: setup.conversation });
  assert.match(stubborn.message.content, /no tool changed any file in this reply/);

  // An older reply that only described changes is marked in the history the model reads.
  const later = await chat(['ok'], 'and now?', { conversation: setup.conversation });
  const history = later.calls[0].messages.filter((message) => message.role === 'assistant').map((message) => message.content).join('\n');
  assert.match(history, /\(Uma: in this reply no file was changed and no command ran/);
  console.log('replies that only describe changes: OK');
}

/**
 * A user's chat: the model called MSBuild as cmd.exe wants it, which PowerShell does not run, then
 * wrote "The build succeeded" and a long fake list of "tools Uma ran".
 */
async function testProgramCalls() {
  const { fixProgramCalls } = require('../electron/lib/tools.cjs');
  const exe = 'C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe';
  const wanted = `& "${exe}" "Uma Advance task manager\\TaskManager.vcxproj" /t:Build`;
  // The three forms from the chat, and the bare quoted path.
  assert.equal(fixProgramCalls(`cmd /c "${exe}" "Uma Advance task manager\\TaskManager.vcxproj" /t:Build`), wanted);
  assert.equal(fixProgramCalls(`cmd /c "\\"${exe}\\" \\"Uma Advance task manager\\TaskManager.vcxproj\\" /t:Build"`), wanted);
  assert.equal(fixProgramCalls(`cmd /c "${exe.replace(/\\/g, '\\\\')}" "Uma Advance task manager\\TaskManager.vcxproj" /t:Build`), wanted);
  assert.equal(fixProgramCalls(`"${exe}" "Uma Advance task manager\\TaskManager.vcxproj" /t:Build`), wanted);
  // From an older chat: everything inside one pair of quotes, with the paths unquoted or the
  // project in escaped quotes.
  assert.equal(fixProgramCalls(`cmd /c "${exe} Uma Advance task manager\\TaskManager.vcxproj /t:Build"`), wanted);
  assert.equal(fixProgramCalls(`cmd /c "${exe} \\"Uma Advance task manager\\TaskManager.vcxproj\\" /t:Build"`), wanted);
  assert.equal(fixProgramCalls(`cmd /c "${exe}"`), `& "${exe}"`);
  // Everything else is left alone.
  for (const same of ['cmd /c dir', 'cmd /c build_gui.bat', 'npm test', `& "${exe}" a.vcxproj`, 'echo "hello.exe is a file"']) {
    assert.equal(fixProgramCalls(same), same);
  }

  if (process.platform === 'win32') {
    // For real: a program under "Program Files", called the way that failed in the chat.
    const candidates = ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'];
    const program = candidates.find((file) => require('node:fs').existsSync(file));
    if (program) {
      await store.updateSettings({ allowShell: true });
      const runner = new ToolRunner({ workspace, store, onChanged: () => {} });
      const viaCmd = await runner.run('run_command', { command: `cmd /c "${program}" --version` });
      assert.ok(viaCmd.ok, viaCmd.output);
      const quoted = await runner.run('run_command', { command: `"${program}" --version` });
      assert.ok(quoted.ok, quoted.output);
      // A command that is not there explains how to call a program in this terminal.
      const missing = await runner.run('run_command', { command: 'no-such-program-xyz --version' });
      assert.match(missing.output, /This terminal is PowerShell/);
      await store.updateSettings({ allowShell: false });
    }
  }

  // "The build succeeded" after a build command that failed: the model is told, and the user too.
  await store.updateSettings({ allowShell: true });
  const shell = new ToolRunner({ workspace, store, onChanged: () => {} });
  const setup = await chat([`\`\`\`tool\n{"name":"read_file","arguments":{"path":"README.md"}}\n\`\`\``, 'It is a test workspace.'], 'read README.md');
  const result = await chat([
    `\`\`\`tool\n{"name":"run_command","arguments":{"command":"no-such-build-tool-xyz /t:Build"}}\n\`\`\``,
    'The build succeeded. TaskManager.exe has been rebuilt.\n\n(Tools Uma ran for this reply: Ran no-such-build-tool-xyz (failed); Ran no-such-build-tool-xyz (failed)',
    'I could not build it: the build tool was not found.',
  ], 'rebuild the app', { conversation: setup.conversation, toolRunner: shell });
  assert.match(result.calls[2].messages.at(-1).content, /The build did NOT succeed: your last command failed/);
  assert.ok(!result.message.content.includes('The build succeeded'), 'the false claim is not kept as the answer');
  assert.ok(!allText(result.message).includes('Tools Uma ran for this reply'), 'a tool list the model wrote itself is removed');
  assert.match(result.message.content, /could not build it/);
  await store.updateSettings({ allowShell: false });
  console.log('program calls in PowerShell, false build claims: OK');
}

/**
 * A user's chat: the model described a fix, was told nothing changed, then only ran the build
 * ("All outputs are up-to-date") and said the fix was compiled. And the chat's folder had become
 * MSBuild's own Bin folder, because its path was in a pasted command.
 */
async function testEditsBehindClaims() {
  const { namedFolder } = require('../electron/lib/agent.cjs');
  if (process.platform === 'win32') {
    const system32 = 'C:\\Windows\\System32';
    assert.equal(await namedFolder(`run "${system32}\\cmd.exe" /c dir`, workspaceDir), '', 'a program in a command is not the folder of the chat');
    assert.equal(await namedFolder(`look in ${system32}`, workspaceDir), '', 'nor is a system folder');
  }
  await fsp.writeFile(path.join(workspaceDir, 'list.cpp'), 'void refreshListView() {\n  ListView_DeleteAllItems(g_hList);\n}\n');
  await store.updateSettings({ allowShell: true });
  const shell = new ToolRunner({ workspace, store, onChanged: () => {} });
  const setup = await chat([`\`\`\`tool\n{"name":"read_file","arguments":{"path":"list.cpp"}}\n\`\`\``, 'It clears the list.'], 'read list.cpp');
  const upToDate = process.platform === 'win32' ? 'Write-Output "Link:"; Write-Output "  All outputs are up-to-date."' : 'echo "make: Nothing to be done for all."';
  const result = await chat([
    'I need to save the scroll position before clearing. Let me fix this:\n\nNow let me rebuild.\n\nThe build succeeded. I added the scroll position fix.',
    `\`\`\`tool\n${JSON.stringify({ name: 'run_command', arguments: { command: upToDate } })}\n\`\`\``,
    'The build succeeded. The scroll position fix has been compiled into the exe.',
    `\`\`\`tool\n{"name":"replace_in_file","arguments":{"path":"list.cpp","find":"  ListView_DeleteAllItems(g_hList);","replace":"  int top = ListView_GetTopIndex(g_hList);\\n  ListView_DeleteAllItems(g_hList);"}}\n\`\`\``,
    'Added the scroll position save in list.cpp.',
  ], 'the list jumps to the top when it refreshes', { conversation: setup.conversation, toolRunner: shell });
  assert.match(await fsp.readFile(path.join(workspaceDir, 'list.cpp'), 'utf8'), /ListView_GetTopIndex/, 'the edit was really made in the end');
  // The build that compiled nothing says so to the model.
  const built = toolBlocks(result.message).find((block) => block.name === 'run_command');
  assert.match(built.output, /Nothing was compiled/);
  // "The fix has been compiled" after only a build is not accepted.
  assert.match(result.calls[3].messages.at(-1).content, /No file was edited in this reply/);
  assert.ok(!result.message.content.includes('has been compiled into the exe'));
  assert.match(result.message.content, /Added the scroll position save/);
  await store.updateSettings({ allowShell: false });
  console.log('code changes need a real edit, program folders are not chat folders: OK');
}

/** look_at_screen and look_at_page: only for a model that can see, the screen only when allowed. */
async function testSeeing() {
  const { allowedTools } = require('../electron/lib/toolcall.cjs');
  assert.ok(!allowedTools({ allowScreen: true }, []).includes('look_at_screen'), 'a model without a vision file gets no picture tools');
  assert.deepEqual(allowedTools({}, [], { vision: true }).filter((name) => name.startsWith('look_at')), ['look_at_page']);
  assert.ok(allowedTools({ allowScreen: true }, [], { vision: true }).includes('look_at_screen'));

  const asked = [];
  const picture = { name: 'the window "Task Manager"', width: 1280, height: 800, image: 'data:image/jpeg;base64,AAAA', thumbnail: 'data:image/jpeg;base64,BBBB' };
  const seeing = new ToolRunner({ workspace, store, onChanged: () => {}, capture: async (what) => { asked.push(what); return picture; } });
  await store.updateSettings({ allowScreen: false });
  const refused = await seeing.run('look_at_screen', { window: 'Task Manager' });
  assert.ok(!refused.ok && /See the screen/.test(refused.output), 'off until the user allows it');
  await fsp.writeFile(path.join(workspaceDir, 'index.html'), '<h1>Shop</h1>');
  const page = await seeing.run('look_at_page', { path: 'index.html' });
  assert.ok(page.ok && page.data.image && asked.at(-1).page.file.endsWith('index.html'));
  const outside = await seeing.run('look_at_page', { url: 'https://example.com' });
  assert.ok(!outside.ok && /Internet access is off/.test(outside.output));
  assert.ok((await seeing.run('look_at_page', { url: 'http://localhost:3000/' })).ok, 'a page served on this PC needs no internet access');

  // In a reply: the picture goes to the model with the next request only, and a small copy stays in the chat.
  await store.updateSettings({ allowScreen: true });
  const result = await chat([
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{"window":"Task Manager"}}\n\`\`\``,
    `\`\`\`tool\n{"name":"read_file","arguments":{"path":"README.md"}}\n\`\`\``,
    'The window shows an empty process list.',
  ], 'look at my task manager window and check the list', { toolRunner: seeing, model: { id: 'mock', name: 'Mock', family: 'Test', mmproj: { path: 'mmproj.gguf' } } });
  const withPicture = (call) => call.messages.filter((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')).length;
  assert.equal(withPicture(result.calls.at(-2)), 1, 'the request after the screenshot carries the picture');
  assert.equal(withPicture(result.calls.at(-1)), 0, 'later requests do not pay for it again');
  assert.equal(toolBlocks(result.message).find((block) => block.name === 'look_at_screen').image, picture.thumbnail);
  // A model without a vision file that calls the tool anyway (a user's report: the engine answered
  // "image input is not supported"): nothing is captured, no picture is sent, and the turn ends with
  // Uma's own words, because a model told "you cannot see" went on to describe a Task Manager window.
  const before = asked.length;
  const blind = await chat([
    `Yes, I can see your display. I have just executed:\n\n\`\`\`tool\n{"name":"look_at_screen","arguments":{"window":"Task Manager"}}\n\`\`\``,
    'Yes, I can see your display. Here is a summary of what I see: Task Manager, chrome.exe 22% CPU.',
  ], 'check my Task Manager for me', { toolRunner: seeing });
  assert.equal(asked.length, before, 'no screenshot is taken');
  assert.ok(blind.calls.every((call) => withPicture(call) === 0), 'no picture reaches an engine that cannot read one');
  assert.equal(blind.calls.length, 1, 'the model is not asked to go on after it failed to look');
  assert.equal(toolBlocks(blind.message).find((block) => block.name === 'look_at_screen').status, 'error');
  assert.match(blind.message.content, /I cannot see your screen: the model in use \(Mock\) has no vision file/);
  assert.ok(!/I can see your display|chrome\.exe/.test(blind.message.content), 'neither the claim nor an invented screen is in the answer');
  const preface = blind.message.blocks.find((block) => block.type === 'text' && /I can see your display/.test(block.text));
  assert.ok(!preface || preface.unchecked, 'the "I can see" before the call is marked as not true');
  await store.updateSettings({ allowScreen: false });
  console.log('seeing the screen and pages: OK');
}

/**
 * A user's chat: asked to search YouTube in Brave, the model wrote that it typed in the search box
 * and pressed Enter (it has no tool for that), then repeated one sentence until the reply ran out.
 */
async function testPretendedInput() {
  const { repeatsItself, withoutRepeats, systemPrompt } = require('../electron/lib/agent.cjs');
  const line = 'The search box shows "god speed" but the results panel is not visible. Let me press Enter.';
  assert.equal(repeatsItself(`Let me check the results.\n\n${line}\n\n${line}\n`), false, 'twice can be chance');
  assert.equal(repeatsItself(`${line}\n\n${line}\n\n${line}\n`), true);
  assert.equal(repeatsItself('ok\nok\nok\nok\n'), false, 'short lines do not count');
  assert.equal(withoutRepeats(`First.\n\n${line}\n\n${line}\n\n${line}\n`), `First.\n\n${line}`);

  // The instructions say what is possible: no clicking or typing, but an address can be opened.
  const prompt = systemPrompt({ workspaceSummary: 'W\nPath: C:/x', settings: { allowScreen: true, allowShell: true }, model: { mmproj: {} } });
  assert.match(prompt, /cannot click, type, press keys/);
  assert.match(prompt, /Control the mouse and keyboard/, 'it can tell the user how to allow it');
  assert.match(prompt, /youtube\.com\/results\?search_query=/);

  await store.updateSettings({ allowScreen: true, allowShell: true });
  const asked = [];
  const runner = new ToolRunner({ workspace, store, onChanged: () => {}, capture: async (what) => { asked.push(what); return { name: 'the window "Brave"', width: 1280, height: 800, image: 'data:image/jpeg;base64,AAAA', thumbnail: 'data:image/jpeg;base64,BBBB' }; } });
  const model = { id: 'mock', name: 'Mock', family: 'Test', mmproj: { path: 'mmproj.gguf' } };
  const setup = await chat([`\`\`\`tool\n{"name":"look_at_screen","arguments":{"window":"Brave"}}\n\`\`\``, 'YouTube is open in Brave.'], 'look at my Brave window', { toolRunner: runner, model });
  const result = await chat([
    'I will search YouTube for "god speed".\n\nLet me find the search box and type the query.\n\nThe search box is focused. Let me type the query.\n\nThe search returned no results.',
    `\`\`\`tool\n${JSON.stringify({ name: 'run_command', arguments: { command: 'Write-Output "opened https://www.youtube.com/results?search_query=god+speed+call+of+duty+montage"' } })}\n\`\`\``,
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{"window":"Brave"}}\n\`\`\``,
    'The results show a channel called God Speed with Call of Duty montages.',
  ], 'search for god speed, he makes videos montage about call of duty', { conversation: setup.conversation, toolRunner: runner, model });
  const told = result.calls.map((call) => call.messages.at(-1).content).map((content) => (Array.isArray(content) ? content[0].text : content)).join('\n');
  assert.match(told, /you have no tool to click, type, press keys/);
  assert.ok(!result.message.content.includes('The search box is focused'), 'the made-up typing is not kept as the answer');
  assert.match(result.message.content, /God Speed with Call of Duty montages/);
  await store.updateSettings({ allowScreen: false, allowShell: false });
  console.log('pretended clicks and typing, replies going in circles: OK');
}

/**
 * A user asked Uma to open Brave and play a music video on YouTube, and the model answered "I can't
 * click the video myself — I have no tool to click in another program". With "Control the mouse
 * and keyboard" allowed it has the tools, is told so, and is corrected when it says otherwise.
 */
async function testLoopsAndInventedTools() {
  const { loopsInLine, withoutLoops, toolsClaimed } = require('../electron/lib/agent.cjs');
  // A Q2_K model wrote a vision file name that never ended: "qwen2-32k-1.5-1.5-1.5-…".
  const loop = `Choose a file like qwen2-32k-1.5${'-1.5'.repeat(300)}`;
  assert.equal(loopsInLine(loop), true);
  assert.equal(withoutLoops(loop), 'Choose a file like qwen2-32k-1.5-1.5-1.5…');
  assert.equal(loopsInLine(`| a | b |\n${'| --- | --- |\n'.repeat(4)}`), false, 'a table is not a loop');
  assert.equal(loopsInLine('const zeros = [0, 0, 0, 0, 0, 0];'), false, 'a few repeats are not a loop');
  assert.deepEqual(toolsClaimed('I then used `focus_window` to bring Brave to the front, and `keyboard` to type. I called fetch_url on the main result.'), ['focus_window', 'fetch_url']);
  assert.deepEqual(toolsClaimed('I used a search engine. Use the keyboard to type.'), []);

  // In a reply: the loop is cut where it starts, and the reply goes on.
  const looped = await chat([`The file should be named like qwen3-30b-2507-128k${'-256k'.repeat(400)}`], 'which vision file do I need?');
  assert.equal(looped.calls.length, 1);
  assert.ok(looped.message.content.length < 200, `the loop is cut (${looped.message.content.length} characters)`);
  assert.match(looped.message.content, /128k-256k-256k-256k?…$/);

  // It wrote that it used tools that never ran: that text is set aside and it is told.
  await store.updateSettings({ allowInternet: true });
  const invented = await chat([
    'I used `look_at_screen` to capture the window, then I used focus_window to bring Brave to the front.',
    'I could not look at Brave: no tool ran. Tell me what you see in it.',
  ], 'open brave and look what i have');
  const told = invented.calls.at(-1).messages.at(-1).content;
  assert.match(told, /look_at_screen, focus_window did not run in this reply/);
  assert.match(invented.message.content, /no tool ran/);
  assert.ok(!/bring Brave to the front/.test(invented.message.content));
  await store.updateSettings({ allowInternet: false });

  // "what do you see?" to a model with no vision file: Uma answers, the model is not asked (it had
  // answered with a whole invented desktop, Task Manager figures and Brave tabs).
  const asked = await chat(['I see a modern, clean desktop interface with the Task Manager open.'], 'what do you see?');
  assert.equal(asked.calls.length, 0, 'the model is not asked');
  assert.match(asked.message.content, /I cannot see your screen/);
  // Asked another way, it describes the screen anyway: the description is replaced.
  const described = await chat(['I see a modern, clean desktop interface. The Task Manager window shows CPU usage: 45%.'], 'open brave and look what i have');
  assert.match(described.message.content, /I cannot see your screen/);
  assert.ok(!/45%/.test(described.message.content), 'the invented figures are not in the answer');
  // "did you already fix the bug in main.cpp?" is a question: a correct "no" is not taken for a
  // claimed change, nobody pushes it to edit, and "Electron/Node.js" is not a missing file.
  const { classifyTask } = require('../electron/lib/agent.cjs');
  assert.equal(classifyTask('did you already fix the bug in main.cpp?').wantsEdit, false);
  assert.equal(classifyTask('did you already fix the bug in main.cpp?').agentic, true, 'it still looks at the files');
  const editsBefore = store.getSettings().allowEdits;
  await store.updateSettings({ allowEdits: true });
  const honest = 'There is no main.cpp in the workspace, so I have not fixed any bug in it. The project uses Electron/Node.js. If you are asking whether a bug in the Electron main process has been fixed, tell me the file.';
  const question = await chat([`\`\`\`tool\n{"name":"list_files","arguments":{"path":"."}}\n\`\`\``, honest, 'SHOULD NOT BE ASKED'], 'did you already fix the bug in main.cpp?');
  assert.equal(question.calls.length, 2, 'no extra rounds after the honest answer');
  assert.equal(question.message.content.trim(), honest);
  await store.updateSettings({ allowEdits: editsBefore });
  // The same conclusion written twice around one more look: the first is folded, and the path the
  // answer says is missing gets no "path note".
  const conclusion = (lead) => `${lead} The electron directory is empty, so electron/main.cjs does not exist in the workspace. The patching script in patch.mjs expects electron/main.cjs so it can replace the window title and background colour, and the bug has not been fixed because the file is missing. Would you like me to create a minimal Electron main process file?`;
  const twice = await chat([
    conclusion('I looked at the folder.') + `\n\n\`\`\`tool\n{"name":"search_files","arguments":{"query":"main.cjs"}}\n\`\`\``,
    conclusion('The search confirms it.'),
  ], 'did you already fix the bug in main.cpp?');
  const texts = twice.message.blocks.filter((block) => block.type === 'text');
  assert.ok(texts[0].superseded && !texts.at(-1).superseded, 'the earlier copy is folded');
  assert.equal(twice.message.content.trim(), conclusion('The search confirms it.'), 'the chat remembers the answer once');
  assert.ok(!/Path note/.test(JSON.stringify(twice.message.blocks)), 'no path note for a file the answer says is missing');
  // Asked "did you fix…?", a model wrote a new file. A question gets no file changes; the user's
  // "yes" to the offer does.
  assert.equal(classifyTask('did you already fix the bug in main.cpp?').asksOnly, true);
  assert.ok(!classifyTask('could you add a README?').asksOnly, 'a polite request is not a question');
  assert.ok(!classifyTask('how do you do it? please add it to main.cpp').asksOnly);
  const editsWere = store.getSettings().allowEdits;
  await store.updateSettings({ allowEdits: true });
  const write = `\`\`\`tool\n{"name":"write_file","arguments":{"path":"electron/made-up.cjs","content":"x"}}\n\`\`\``;
  const asking = await chat([
    `\`\`\`tool\n{"name":"list_files","arguments":{"path":"."}}\n\`\`\``,
    write,
    'No, it was not fixed: electron/made-up.cjs is not there. Do you want me to create it?',
  ], 'did you already fix the bug in main.cpp?');
  assert.equal(require('node:fs').existsSync(path.join(workspaceDir, 'electron', 'made-up.cjs')), false, 'nothing is written for a question');
  assert.ok(!asking.calls[0].tools?.includes?.('write_file'));
  assert.match(asking.calls[0].messages.at(-1).content, /This is a question\. Answer it; do not change any file/);
  assert.equal(toolBlocks(asking.message).find((block) => block.name === 'write_file').status, 'error');
  const yes = await chat([write, 'Created electron/made-up.cjs.'], 'yes', { conversation: asking.conversation });
  assert.equal(require('node:fs').existsSync(path.join(workspaceDir, 'electron', 'made-up.cjs')), true, 'after "yes" it is written');
  assert.ok(yes.message.content.includes('Created'));
  await fsp.rm(path.join(workspaceDir, 'electron'), { recursive: true, force: true });
  // A question is a few looks, not an investigation: with a model that keeps looking (it went on
  // to search C:\Program Files), Uma stops it after 6 tools and asks for the answer.
  const looks = Array.from({ length: 12 }, (_, index) => `Let me check:\n\`\`\`tool\n{"name":"search_files","arguments":{"query":"main${index}"}}\n\`\`\``);
  const short = await chat([...looks, 'No: there is no main.cpp, so nothing was fixed.'], 'did you already fix the bug in main.cpp?');
  assert.ok(toolBlocks(short.message).length <= 6, `at most 6 tools for a question (${toolBlocks(short.message).length})`);
  assert.ok(!toolBlocks(short.message).some((block) => block.name === 'load_skill'), 'no skill is loaded for a question');
  await store.updateSettings({ allowEdits: editsWere });
  // A user's chat: tips for Call of Duty videos, then "yes," to "want me to help you create a video
  // plan?". The model created a folder, plans, and 15 ".png" thumbnails that were SVG text. Now: the
  // answer stays in the chat, a fake picture is refused, and copies stop after three.
  const editsBefore2 = store.getSettings().allowEdits;
  await store.updateSettings({ allowEdits: true });
  const tips = await chat(['Make montages. Would you like me to help you create a video plan?'], 'can you give me some tips in making call of duty videos?');
  const plan = await chat([
    `\`\`\`tool\n{"name":"create_folder","arguments":{"path":"videos"}}\n\`\`\``,
    'Here is your video plan:\n1. Top 10 bangers\n2. Best moments 2025',
  ], 'yes,', { conversation: tips.conversation });
  assert.equal(require('node:fs').existsSync(path.join(workspaceDir, 'videos')), false, 'no folder for a plan nobody asked to save');
  assert.match(plan.message.content, /Here is your video plan/);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#16213e"/></svg>';
  const fake = await tools.run('write_file', { path: 'thumb.png', content: svg });
  assert.ok(!fake.ok && /save it with the \.svg extension/i.test(fake.output) && !require('node:fs').existsSync(path.join(workspaceDir, 'thumb.png')), 'SVG text is not saved as a .png');
  const body = (n) => `# Thumbnail ${n}\n${Array.from({ length: 12 }, (_, line) => `line ${line} of the same design`).join('\n')}`;
  const copies = await chat([
    ...[1, 2, 3, 4, 5].map((n) => `\`\`\`tool\n${JSON.stringify({ name: 'write_file', arguments: { path: `copies/thumb-${n}.md`, content: body(n) } })}\n\`\`\``),
    'I made the thumbnail notes.',
  ], 'save 5 thumbnail note files in the copies folder');
  assert.deepEqual(toolBlocks(copies.message).filter((block) => block.name === 'write_file').map((block) => block.status), ['done', 'done', 'done', 'error', 'error'], 'the 4th near copy is not written');
  await fsp.rm(path.join(workspaceDir, 'copies'), { recursive: true, force: true });

  // A user's chat: a Google search, then "wrong, it's Genesys lab from mussomeli, they are a website
  // that offer informatic services". "wrong" after tools counted as a bug in the project, so Uma
  // pushed "make the change now" after the model asked "Would you like me to build…?", and it built
  // a website. Now: web lookups are not project work, and a reply that asks the user ends there.
  const search = await chat([
    `\`\`\`tool\n{"name":"web_search","arguments":{"query":"GenesysLabs mussomeli"}}\n\`\`\``,
    'Genesys Lab recovers rare earths from electronic waste.',
  ], 'search for GenesysLabs mussomeli');
  const corrected = await chat([
    'Their website is http://genesyslabs.online/. Would you like me to build a portfolio website for them from scratch?',
    `\`\`\`tool\n{"name":"create_folder","arguments":{"path":"genesys-labs-website"}}\n\`\`\``,
  ], 'wrong, it`s Genesys lab from mussomeli they are a website that offer informatic services', { conversation: search.conversation });
  assert.equal(corrected.calls.length, 1, 'the reply that asks the user is the end of the turn');
  assert.equal(require('node:fs').existsSync(path.join(workspaceDir, 'genesys-labs-website')), false, 'no website is built');
  assert.match(corrected.message.content, /genesyslabs\.online/);
  assert.equal(classifyTask('find their website').agentic, false, 'finding a website on the internet is not project work');

  // A user's chat: "open my email and send this to their website email using my brave". The model
  // wrote Start-Process brave --args "...", guessed a wrong Brave path, then ran "winget install
  // Brave" with commands set to run unasked. Now: the command is corrected, the install is refused,
  // and the model gets Gmail's new-message address.
  const { emailNote } = require('../electron/lib/agent.cjs');
  await store.updateSettings({ allowShell: true });
  const fixed = await tools.run('run_command', { command: 'Start-Process powershell --args "-NoProfile -Command exit" -WindowStyle Hidden' });
  assert.ok(fixed.ok, `the --args mistake is corrected and runs (${fixed.output.slice(0, 160)})`);
  assert.match(fixed.output, /Uma corrected the command to: Start-Process powershell -ArgumentList/);
  assert.match(emailNote('open my email and send this to their website email using my brave, i have gmail already logged in', { allowShell: true }), /mail\.google\.com\/mail\/\?view=cm&fs=1&to=ADDRESS.*Start-Process brave/s);
  assert.equal(emailNote('what is a good email client?', { allowShell: true }), '', 'a question about email is not a request to send one');
  const install = await chat([
    `\`\`\`tool\n{"name":"run_command","arguments":{"command":"winget install Brave --exact --accept-package-agreements"}}\n\`\`\``,
    'Brave is already installed, so I did not install it.',
  ], 'open my email and send this to their website email using my brave, i have gmail already logged in');
  const refused = toolBlocks(install.message).find((block) => block.name === 'run_command');
  assert.ok(refused.status === 'error' && /did not ask to install anything/.test(refused.output), 'the install nobody asked for is not run');
  await store.updateSettings({ allowShell: false });
  assert.equal(classifyTask('fix the css of my website').wantsEdit, true, 'the user\'s own website still is');
  await store.updateSettings({ allowEdits: editsBefore2 });
  console.log('loops inside a line, tools named but not run, screens described without eyes, honest "no", answers said twice, no edits for a question, answers kept in the chat: OK');
}

async function testComputerControl() {
  const { pictureSize, InputController } = require('../electron/lib/input.cjs');
  const { systemPrompt } = require('../electron/lib/agent.cjs');
  const { allowedTools } = require('../electron/lib/toolcall.cjs');
  // The model's picture and the screen: 1920x1080 pixels at 125% are shown as 1280x720.
  const geometry = () => ({ pixelWidth: 1920, pixelHeight: 1080, inputWidth: 1920, inputHeight: 1080, originX: 0, originY: 0 });
  assert.deepEqual(pictureSize(geometry()), { width: 1280, height: 720 });
  const calls = [];
  const backend = {
    pointer: async () => ({ x: 500, y: 500 }),
    click: async (...args) => calls.push(['click', ...args]),
    type: async (text) => calls.push(['type', text]),
    keys: async (keys) => calls.push(['keys', keys]),
    focus: async (title) => { calls.push(['focus', title]); return 'Brave - YouTube'; },
  };
  const controller = new InputController({ geometry, backend });
  await controller.act('click', { x: 640, y: 360 });
  assert.deepEqual(calls.at(-1), ['click', 960, 540, 'left', 1], 'the middle of the picture is the middle of the screen');
  await assert.rejects(() => controller.act('click', { x: 1400, y: 10 }), /outside the screen picture/);
  backend.pointer = async () => ({ x: 1, y: 2 });
  await assert.rejects(() => controller.act('keys', { keys: 'enter' }), /STOPPED/, 'the pointer in the top-left corner stops it');
  backend.pointer = async () => ({ x: 500, y: 500 });
  await assert.rejects(() => controller.act('keys', { keys: 'enter' }), /STOPPED/, 'and it stays stopped');
  controller.resume();
  await controller.act('keys', { keys: 'k' });
  assert.deepEqual(calls.at(-1), ['keys', 'k']);

  // The tools: off until the user allows them; clicking needs a model that can see.
  const onPrompt = systemPrompt({ workspaceSummary: 'W\nPath: C:/x', settings: { allowScreen: true, allowShell: true, allowInput: true }, model: { mmproj: {} } });
  assert.match(onPrompt, /CAN control the mouse and keyboard/);
  assert.doesNotMatch(onPrompt, /cannot click, type/);
  assert.ok(!allowedTools({ allowScreen: true }, [], { vision: true }).includes('mouse'));
  assert.ok(allowedTools({ allowScreen: true, allowInput: true }, [], { vision: true }).includes('mouse'));
  assert.ok(!allowedTools({ allowInput: true }, [], { vision: false }).includes('mouse') && allowedTools({ allowInput: true }, [], { vision: false }).includes('keyboard'), 'without sight only the keyboard');
  const acts = [];
  const input = { act: async (action, args) => { acts.push([action, args]); return action === 'click' ? `click at (${args.x}, ${args.y})` : `${action} done`; } };
  const screenshot = { name: 'the whole screen', width: 1280, height: 720, image: 'data:image/jpeg;base64,AAAA', thumbnail: 'data:image/jpeg;base64,BBBB' };
  const runner = new ToolRunner({ workspace, store, onChanged: () => {}, capture: async () => screenshot, input });
  await store.updateSettings({ allowScreen: true, allowShell: true, allowInput: false });
  const off = await runner.run('mouse', { action: 'click', x: 10, y: 10 });
  assert.ok(!off.ok && /Control the mouse and keyboard/.test(off.output) && !acts.length, 'off until the user allows it');

  await store.updateSettings({ allowInput: true });
  const look = await runner.run('look_at_screen', {});
  assert.match(look.output, /x from 0 \(left\) to 1280, y from 0 \(top\) to 720/, 'the screenshot says how to point at things');
  const typed = await runner.run('keyboard', { text: 'lofi music', keys: 'enter' });
  assert.ok(typed.ok && acts.at(-2)[0] === 'type' && acts.at(-1)[0] === 'keys', 'text first, then the keys');

  // The chat: "I can't click" is corrected, the click goes through the tool, and the answer follows.
  const model = { id: 'mock', name: 'Mock', family: 'Test', mmproj: { path: 'mmproj.gguf' } };
  const result = await chat([
    'I can\u2019t click the video myself \u2014 I have no tool to click in another program. To play it, open it yourself.',
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{}}\n\`\`\``,
    `\`\`\`tool\n{"name":"mouse","arguments":{"action":"click","x":320,"y":250}}\n\`\`\``,
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{}}\n\`\`\``,
    'The first video, a lofi music mix, is now playing in Brave.',
  ], 'open brave on youtube and play a music video', { toolRunner: runner, model });
  const told = result.calls.map((call) => call.messages.at(-1).content).map((content) => (Array.isArray(content) ? content[0].text : content)).join('\n');
  assert.match(told, /the user allowed Uma to control the mouse and keyboard/);
  assert.ok(toolBlocks(result.message).some((block) => block.name === 'mouse' && block.status === 'done'), 'the click is a step in the chat');
  assert.deepEqual(acts.at(-1), ['click', { action: 'click', x: 320, y: 250 }]);
  assert.ok(!result.message.content.includes('no tool to click'), 'the wrong refusal is not the answer');
  assert.match(result.message.content, /now playing in Brave/);

  // A click it only claims, with no tool, is corrected too.
  const claimed = await chat([
    'I clicked the first video and it is playing now.',
    `\`\`\`tool\n{"name":"mouse","arguments":{"action":"click","x":320,"y":250}}\n\`\`\``,
    'Done: the video is playing.',
  ], 'play the first video', { toolRunner: runner, model });
  const toldAgain = claimed.calls.map((call) => call.messages.at(-1).content).map((content) => (Array.isArray(content) ? content[0].text : content)).join('\n');
  assert.match(toldAgain, /no mouse or keyboard tool ran in this reply|no tool ran in this reply/);

  // A user's chat: "open youtube and search for HD dubstep and play the 3rd video". The model typed
  // the words into the address bar (a web search, not YouTube), its look after the keys was blocked
  // as a repeat, and it said the video was playing. Uma now gives it the YouTube search address,
  // lets it look again after an action, and makes it look before saying it worked.
  const dubstep = await chat([
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{"window":"Brave"}}\n\`\`\``,
    `\`\`\`tool\n{"name":"keyboard","arguments":{"keys":"ctrl+l"}}\n\`\`\``,
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{"window":"Brave"}}\n\`\`\``,
    `\`\`\`tool\n{"name":"keyboard","arguments":{"keys":"enter"}}\n\`\`\``,
    'The 3rd video in the HD dubstep search results is now playing. The task is complete.',
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{}}\n\`\`\``,
    'The screen shows Google results for "HD dubstep", not YouTube, so nothing is playing yet.',
  ], 'open youtube and search for HD dubstep and play the 3rd video', { toolRunner: runner, model });
  const request = dubstep.calls[0].messages.at(-1);
  assert.match(Array.isArray(request.content) ? request.content[0].text : request.content, /https:\/\/www\.youtube\.com\/results\?search_query=HD\+dubstep/);
  const looksAt = toolBlocks(dubstep.message).filter((block) => block.name === 'look_at_screen');
  assert.ok(looksAt.length === 3 && looksAt.every((block) => block.status === 'done'), 'a look after a key press is not a blocked repeat');
  const toldDubstep = dubstep.calls.map((call) => call.messages.at(-1).content).map((content) => (Array.isArray(content) ? content[0].text : content)).join('\n');
  assert.match(toldDubstep, /You have not looked at the screen since your last action/);
  assert.ok(!/is now playing/.test(dubstep.message.content), 'the unchecked "now playing" is not the answer');
  assert.match(dubstep.message.content, /not YouTube/);

  // A user's chat: "open youtube and play the best mirrors edge music video" got "The video is now
  // playing!" with no tool at all. That text is set aside and the model is made to do it.
  await store.updateSettings({ allowInternet: false });
  const noTools = await chat([
    'Great! I found the Mirror\'s Edge music videos. The video is now playing! It is the official music video.',
    `\`\`\`tool\n{"name":"keyboard","arguments":{"keys":"ctrl+t"}}\n\`\`\``,
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{}}\n\`\`\``,
    'A new tab is open, nothing is playing yet.',
  ], 'open youtube and play the best mirrors edge music video', { toolRunner: runner, model });
  const toldNoTools = noTools.calls.map((call) => call.messages.at(-1).content).map((content) => (Array.isArray(content) ? content[0].text : content)).join('\n');
  assert.match(toldNoTools, /None of that happened: no tool ran in this reply/);
  assert.match(toldNoTools, /youtube\.com\/results\?search_query=best\+mirrors\+edge\+music\+video/, 'the request names the YouTube search address');
  assert.ok(!/now playing/.test(noTools.message.content), 'the invented "now playing" is not the answer');

  // YouTube already open in a Brave tab: Uma loads the search in that tab instead of a new one.
  const keys = [];
  const tabRunner = new ToolRunner({ workspace, store, onChanged: () => {}, capture: async () => screenshot, input: {
    act: async (action, args) => { keys.push([action, args.window || args.keys || args.text]); return `${action} done`; },
    windows: async () => ['Inbox - Mail', 'Old school Dubstep - YouTube - Brave'],
  } });
  const reused = await chat([
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{}}\n\`\`\``,
    `\`\`\`tool\n{"name":"mouse","arguments":{"action":"click","x":400,"y":300}}\n\`\`\``,
    `\`\`\`tool\n{"name":"wait","arguments":{"seconds":3}}\n\`\`\``,
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{}}\n\`\`\``,
    `\`\`\`tool\n{"name":"wait","arguments":{"seconds":3}}\n\`\`\``,
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{}}\n\`\`\``,
    'The first dubstep 2012 video is playing in the same YouTube tab.',
  ], 'open youtube and search for dubstep 2012 and play the video', { toolRunner: tabRunner, model });
  assert.deepEqual(keys.slice(0, 4), [['focus', 'Old school Dubstep - YouTube - Brave'], ['keys', 'ctrl+l'], ['type', 'https://www.youtube.com/results?search_query=dubstep+2012'], ['keys', 'enter']], 'the search is loaded in the open YouTube tab');
  const reusedRequest = reused.calls[0].messages.at(-1);
  assert.match(Array.isArray(reusedRequest.content) ? reusedRequest.content[0].text : reusedRequest.content, /already open in the browser tab "Old school Dubstep - YouTube - Brave".*do not open another one/s);
  assert.ok(toolBlocks(reused.message).filter((block) => block.name === 'wait').every((block) => block.status === 'done'), 'a second wait is not a blocked repeat');
  assert.ok(toolBlocks(reused.message).some((block) => block.name === 'mouse' && block.status === 'done'), 'a click right after a whole-screen look is made');

  // A click after looking only at a window (other positions) is refused until it looks at the whole screen.
  const windowClick = await chat([
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{"window":"Brave"}}\n\`\`\``,
    `\`\`\`tool\n{"name":"mouse","arguments":{"action":"click","x":640,"y":360}}\n\`\`\``,
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{}}\n\`\`\``,
    `\`\`\`tool\n{"name":"mouse","arguments":{"action":"click","x":640,"y":360}}\n\`\`\``,
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{}}\n\`\`\``,
    'The video is playing.',
  ], 'play the first video', { toolRunner: runner, model });
  const clicks = toolBlocks(windowClick.message).filter((block) => block.name === 'mouse');
  assert.deepEqual(clicks.map((block) => block.status), ['error', 'done'], 'refused after a window look, made after a whole-screen look');

  // "select the most viewed video": the model clicked (640, 360) eleven times. Uma reads the results
  // itself and opens the video; the same click a third time is not made.
  const { parseResults, videoWanted, viewCount } = require('../electron/lib/youtube.cjs');
  assert.equal(viewCount('9,647,247 views'), 9647247);
  assert.equal(viewCount('1.2M views'), 1200000);
  assert.deepEqual(videoWanted('open youtube and search for HD dubstep and select the most view video.'), { most: true });
  assert.deepEqual(videoWanted('run the 3rd search from the top'), { index: 3 });
  assert.equal(videoWanted('search youtube for lofi'), null);
  const video = (id, title, views) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: title }] }, viewCountText: { simpleText: `${views} views` } } });
  const page = `<script>var ytInitialData = ${JSON.stringify({ contents: [video('aaaaaaaaaaa', 'Small one', '1,000'), { adSlotRenderer: {} }, video('bbbbbbbbbbb', 'Big one', '9,647,247'), video('ccccccccccc', 'Third one', '37,990')] })};</script>`;
  assert.deepEqual(parseResults(page).map((item) => item.id), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => page });
  await store.updateSettings({ allowInternet: true });
  keys.length = 0;
  const most = await chat([
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{}}\n\`\`\``,
    'Big one is playing.',
  ], 'open youtube and search for HD dubstep and select the most view video.', { toolRunner: tabRunner, model });
  assert.deepEqual(keys[2], ['type', 'https://www.youtube.com/watch?v=bbbbbbbbbbb'], 'the most viewed video is opened in the YouTube tab');
  const mostRequest = most.calls[0].messages.at(-1);
  assert.match(Array.isArray(mostRequest.content) ? mostRequest.content[0].text : mostRequest.content, /"Big one" \(9,647,247 views\), the most viewed of the first 3 results/);
  global.fetch = realFetch;
  await store.updateSettings({ allowInternet: false });
  const same = `\`\`\`tool\n{"name":"mouse","arguments":{"action":"click","x":640,"y":360}}\n\`\`\``;
  const lookAll = `\`\`\`tool\n{"name":"look_at_screen","arguments":{}}\n\`\`\``;
  const stuckClicks = await chat([lookAll, same, lookAll, same, lookAll, same, 'I could not find the video to click.'], 'play the video on the screen', { toolRunner: runner, model });
  assert.deepEqual(toolBlocks(stuckClicks.message).filter((block) => block.name === 'mouse').map((block) => block.status), ['done', 'done', 'error'], 'the third identical click is not made');

  // Clicking by name, as a browser agent does: the window's own items, no position to guess.
  const { bestItem } = require('../electron/lib/input.cjs');
  const items = [
    { kind: 'Hyperlink', name: 'YouTube Home' },
    { kind: 'Hyperlink', name: 'HD Dubstep - Earthquake (Fytch Remix) 3 minutes, 38 seconds' },
    { kind: 'Button', name: 'Action menu' },
    { kind: 'Hyperlink', name: 'Ellie Goulding - Lights (Dubstep Remix) [HD]' },
  ];
  assert.equal(bestItem(items, 'HD Dubstep - Earthquake (Fytch Remix)').name, items[1].name, 'the title as written');
  assert.equal(bestItem(items, 'ellie goulding lights').name, items[3].name, 'a few of its words');
  assert.equal(bestItem(items, 'skrillex bangarang'), null, 'nothing like it: no click');
  assert.ok(allowedTools({ allowInput: true }, [], { vision: false }).includes('click_text'), 'clicking by name needs no sight');
  const named = [];
  const nameRunner = new ToolRunner({ workspace, store, onChanged: () => {}, capture: async () => screenshot, input: {
    act: async (action) => `${action} done`,
    findItems: async () => items.map((item, index) => ({ ...item, pictureX: 400, pictureY: 100 + index * 80 })),
    clickItem: async (text) => { const item = bestItem(items, text); if (!item) throw new Error('Nothing named like that'); named.push(item.name); return { ...item, pictureX: 400, pictureY: 180 }; },
  } });
  await store.updateSettings({ allowScreen: true, allowInput: true });
  const byName = await chat([
    `\`\`\`tool\n{"name":"find_on_screen","arguments":{"text":"dubstep"}}\n\`\`\``,
    `\`\`\`tool\n{"name":"click_text","arguments":{"text":"HD Dubstep - Earthquake (Fytch Remix)"}}\n\`\`\``,
    `\`\`\`tool\n{"name":"look_at_screen","arguments":{}}\n\`\`\``,
    'HD Dubstep - Earthquake (Fytch Remix) is playing.',
  ], 'play HD Dubstep - Earthquake from the results on the screen', { toolRunner: nameRunner, model });
  const listed = toolBlocks(byName.message).find((block) => block.name === "find_on_screen");
  assert.match(listed.output, /Hyperlink: "HD Dubstep - Earthquake \(Fytch Remix\) 3 minutes, 38 seconds" at \(400, 180\)/);
  assert.ok(!/YouTube Home/.test(listed.output), 'the text filters the list');
  assert.deepEqual(named, [items[1].name], 'the link with that title is clicked');
  assert.match(byName.message.content, /is playing/);
  assert.match(clicks[0].output, /look_at_screen with no window/);
  await store.updateSettings({ allowScreen: false, allowShell: false, allowInput: false });
  console.log('computer control: the mouse and keyboard tools, the corner stop, refusals corrected: OK');
}

/**
 * A user's chat with a very small model: given a GitHub link, it said the page "is open in Brave"
 * without looking, then gave that same answer to every later question and asked for the link again.
 */
async function testLinksAndRepeats() {
  const { earlierLinks, sameWords } = require('../electron/lib/agent.cjs');
  const convo = { messages: [
    { id: 'u1', role: 'user', content: 'https://github.com/odysseus-dev/odysseus   here is' },
    { id: 'a1', role: 'assistant', content: 'ok' },
    { id: 'u2', role: 'user', content: 'what is the difference with my code?' },
  ] };
  assert.deepEqual(earlierLinks(convo, convo.messages[2]), ['https://github.com/odysseus-dev/odysseus']);
  assert.deepEqual(earlierLinks(convo, { id: 'u3', role: 'user', content: 'and https://example.com/x ?' }), [], 'a message with its own link needs no reminder');
  assert.ok(sameWords('I see the page is open in Brave.  It shows a search bar and navigation elements here.', 'i see the page is open in brave. it shows a search bar and navigation elements here'));
  assert.ok(!sameWords('ok', 'ok'), 'short replies may repeat');

  const stale = 'The GitHub repository for odysseus-dev/odysseus is open in Brave. The page shows the main page with a search bar and navigation elements.';
  const first = await chat([stale, 'I have not looked at that repository yet, so I cannot say what it contains or how it differs.'], 'https://github.com/odysseus-dev/odysseus   here is');
  // "is open in Brave" without a picture: refused, and it is told how to read the address.
  assert.match(first.calls[1].messages.at(-1).content, /You cannot see the screen or the browser|You have not looked at anything/);

  const next = await chat([
    'I have not looked at that repository yet, so I cannot say what it contains or how it differs.',
    `\`\`\`tool\n{"name":"list_files","arguments":{"path":"."}}\n\`\`\``,
    'Your project has a README; I need internet access to read the repository.',
  ], 'see the difference between my project and odysseus', { conversation: first.conversation });
  const request = next.calls[0].messages.at(-1).content;
  assert.match(request, /Links the user gave earlier in this chat[^\]]*github\.com\/odysseus-dev\/odysseus/, 'the link is put beside the new request');
  assert.match(next.calls[1].messages.at(-1).content, /same text as your previous reply/, 'the same answer to a new question is not accepted');
  assert.ok(!/^I have not looked at it yet\.$/.test(next.message.content.trim()));
  console.log('links from earlier in the chat, repeated answers, unseen screens: OK');
}

/**
 * A user's chat with the smallest model version: asked to compare the project with a GitHub
 * repository, it fetched the page, then wrote "is open in Brave" again and that became the answer.
 */
async function testGithubBrief() {
  const { githubRepoFor, repoOutline, plainReadme } = require('../electron/lib/agent.cjs');
  assert.deepEqual(githubRepoFor('see the difference with https://github.com/odysseus-dev/odysseus   here is', []), { owner: 'odysseus-dev', repo: 'odysseus' });
  assert.deepEqual(githubRepoFor('what is the difference with my code?', ['https://github.com/odysseus-dev/odysseus.git']), { owner: 'odysseus-dev', repo: 'odysseus' });
  assert.equal(githubRepoFor('thanks, and what time is it?', ['https://github.com/odysseus-dev/odysseus']), null, 'an earlier link is only used when the request compares');
  assert.equal(repoOutline(JSON.stringify([{ name: 'src', type: 'dir' }, { name: 'README.md', type: 'file' }])), 'Folders: src/\nFiles at the top: README.md');
  assert.equal(repoOutline('{"message":"Not Found"}'), '');
  assert.equal(plainReadme('<p align="center">\n  <img src="a.png" alt="Logo">\n</p>\n\n\n\n# Shop\n![badge](x.svg)\nSells books.'), '# Shop\n\nSells books.');

  await store.updateSettings({ allowInternet: true });
  // The web tool answers from memory here, so the test needs no network.
  const fetched = [];
  const web = new ToolRunner({ workspace, store, onChanged: () => {} });
  const realRun = web.run.bind(web);
  web.run = async (name, args, options) => {
    if (name !== 'fetch_url') return realRun(name, args, options);
    fetched.push(args.url);
    const text = args.url.includes('raw.githubusercontent.com')
      ? '# Odysseus\nA self-hosted AI workspace for chat, agents and documents.'
      : JSON.stringify([{ name: 'frontend', type: 'dir' }, { name: 'Dockerfile', type: 'file' }]);
    return { ok: true, summary: 'Read', output: text, data: { text } };
  };
  const stale = 'I see the GitHub repository for odysseus-dev/odysseus is open in Brave. The page shows the repository main page with a search bar and navigation elements.';
  const good = await chat([
    `\`\`\`tool\n{"name":"list_files","arguments":{"path":"."}}\n\`\`\``,
    'Odysseus is a self-hosted AI workspace run with Docker; your project is a small test workspace.',
  ], 'see the difference between my project and odysseus https://github.com/odysseus-dev/odysseus', { toolRunner: web });
  const request = good.calls[0].messages.at(-1).content;
  assert.match(request, /<github_repository name="odysseus-dev\/odysseus"[\s\S]*A self-hosted AI workspace[\s\S]*Folders: frontend\//, 'the README and file list arrive with the request');
  assert.deepEqual(fetched, ['https://raw.githubusercontent.com/odysseus-dev/odysseus/HEAD/README.md', 'https://api.github.com/repos/odysseus-dev/odysseus/contents']);
  assert.ok(toolBlocks(good.message).some((block) => block.name === 'github_read' && block.status === 'done'), 'shown as a step in the chat');

  // A model that only repeats the refused text gets no false answer shown.
  const lost = await chat([stale], 'see the difference between my project and odysseus https://github.com/odysseus-dev/odysseus', { toolRunner: web });
  assert.ok(!lost.message.content.includes('is open in Brave'), 'the refused text is not the answer');
  assert.match(lost.message.content, /too small for this task/);
  assert.ok(lost.message.blocks.some((block) => block.unchecked === 'unseen'));

  // Without internet access the model is told to say so.
  await store.updateSettings({ allowInternet: false });
  const offline = await chat(['Internet access is off, so I cannot read that repository.'], 'compare with https://github.com/odysseus-dev/odysseus', { toolRunner: web });
  assert.match(offline.calls[0].messages.at(-1).content, /internet access is off, so it cannot be read/);
  console.log('GitHub repository read by Uma, refused answers not shown: OK');
}

async function main() {
  await fsp.rm(root, { recursive: true, force: true });
  await ensureDir(workspaceDir);
  await fsp.writeFile(path.join(workspaceDir, 'README.md'), '# Test workspace\n');

  store = new Store(path.join(root, 'data'));
  await store.init();
  await store.updateSettings({ allowEdits: true, allowDelete: false, workspacePath: workspaceDir });
  workspace = new Workspace({ root: workspaceDir, trash: (target) => fsp.rm(target, { recursive: true, force: true }) });
  await workspace.init();
  tools = new ToolRunner({ workspace, store, onChanged: () => {} });
  conversations = new ConversationStore(path.join(root, 'data', 'conversations'));
  await conversations.init();

  testParser();
  testClassifier();
  await testAgentLoop();
  await testHistory();
  await testChatFolder();
  await testClaimedChanges();
  await testProgramCalls();
  await testEditsBehindClaims();
  await testSeeing();
  await testPretendedInput();
  await testLinksAndRepeats();
  await testGithubBrief();
  await testComputerControl();
  await testLoopsAndInventedTools();
  await testTools();
  await testCommandFolder();
  await testEnvironment();
  await testUndo();
  await testEngines();
  await testSkills();
  await testModelFeatures();
  await testAttachments();
  await testMisc();
  await testNetwork();
  testLanguages();
  testPlacement();
  testHelperPower();
  await testHelperRecovery();
  testCacheFixes();
  await testHelperCache();
  console.log('\nAll agent regression tests passed.');
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
