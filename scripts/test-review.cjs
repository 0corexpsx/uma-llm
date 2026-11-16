// Tests for the 0.2.14 review: the fixes for data loss and slow paths, Claude-format skills with
// their library, and the rule that keeps layers in the main PC's RAM before a helper's.
// Run with: node scripts/test-review.cjs (part of npm test). No model or GPU is needed.
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const assert = require('node:assert');
const { Store } = require('../electron/lib/store.cjs');
const { Workspace } = require('../electron/lib/workspace.cjs');
const { ToolRunner, replaceInLegacyText } = require('../electron/lib/tools.cjs');
const { ConversationStore } = require('../electron/lib/conversations.cjs');
const { AgentRunner } = require('../electron/lib/agent.cjs');
const { SkillStore, parseSkill, rankSkills, isStrongMatch } = require('../electron/lib/skills.cjs');
const { SkillLibrary } = require('../electron/lib/skillLibrary.cjs');
const { allowedTools, toolCallSchema, extractToolCall } = require('../electron/lib/toolcall.cjs');
const { planPlacement, placementArgs, parseDeviceList } = require('../electron/lib/placement.cjs');
const { downloadFile, ensureDir } = require('../electron/lib/util.cjs');

const root = path.join(__dirname, '..', '.testdata', 'review');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UNKNOWN = String.fromCharCode(0xFFFD);

async function testLegacyEncoding() {
  const dir = path.join(root, 'encoding');
  await ensureDir(dir);
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  await store.updateSettings({ allowEdits: true });
  const workspace = new Workspace({ root: dir, trash: (target) => fsp.rm(target, { recursive: true, force: true }) });
  await workspace.init();
  const tools = new ToolRunner({ workspace, store, onChanged: () => {} });

  // A Windows-1252 source file: "café", "naïve" and a euro sign are single bytes that are not UTF-8.
  const original = Buffer.concat([
    Buffer.from('// caf'), Buffer.from([0xE9]), Buffer.from(' na'), Buffer.from([0xEF]), Buffer.from('ve '), Buffer.from([0x80]),
    Buffer.from('\r\nint speed = 1;\r\nint other = 1;\r\n// fin'), Buffer.from([0xE9]), Buffer.from('\r\n'),
  ]);
  await fsp.writeFile(path.join(dir, 'old.c'), original);
  const read = await workspace.readFile('old.c');
  assert.equal(read.encoding, 'latin1');

  // An ordinary edit leaves every other byte alone (0.2.13 turned each accent into three wrong bytes).
  let result = await tools.run('replace_in_file', { path: 'old.c', find: 'int speed = 1;', replace: 'int speed = 2;' });
  assert.equal(result.ok, true, result.output);
  let after = await fsp.readFile(path.join(dir, 'old.c'));
  assert.equal(after.length, original.length);
  assert.deepEqual(after, Buffer.from(original.toString('latin1').replace('speed = 1', 'speed = 2'), 'latin1'));

  // The model copies a line from read_file, where each such byte shows as U+FFFD: it still matches,
  // and the bytes it stands for are put back.
  result = await tools.run('replace_in_file', { path: 'old.c', find: `// fin${UNKNOWN}`, replace: `// the end, fin${UNKNOWN}` });
  assert.equal(result.ok, true, result.output);
  after = await fsp.readFile(path.join(dir, 'old.c'));
  assert.ok(after.includes(Buffer.concat([Buffer.from('// the end, fin'), Buffer.from([0xE9])])));
  assert.ok(after.includes(Buffer.concat([Buffer.from('// caf'), Buffer.from([0xE9])])), 'the first line kept its bytes');

  // New text with an accent is stored in the file's own encoding; a character it cannot hold is refused.
  result = await tools.run('replace_in_file', { path: 'old.c', find: 'int other = 1;', replace: 'int other = 1; // déjà — ok' });
  assert.equal(result.ok, true, result.output);
  after = await fsp.readFile(path.join(dir, 'old.c'));
  assert.ok(after.includes(Buffer.from([0x64, 0xE9, 0x6A, 0xE0, 0x20, 0x97])), 'e-acute, a-grave and the dash are single Windows-1252 bytes');
  result = await tools.run('replace_in_file', { path: 'old.c', find: 'int speed', replace: 'int 中 speed' });
  assert.equal(result.ok, false);
  assert.match(result.output, /not UTF-8/);
  assert.equal(replaceInLegacyText('abc', 'x', 'y', false).count, 0);
  assert.equal(replaceInLegacyText('a.b a.b', 'a.b', 'c', true).next, 'c c', 'find is plain text, not a pattern');

  // A real UTF-8 file is untouched by all this.
  await fsp.writeFile(path.join(dir, 'new.c'), '// café\nint x = 1;\n', 'utf8');
  assert.equal((await workspace.readFile('new.c')).encoding, 'utf8');
  result = await tools.run('replace_in_file', { path: 'new.c', find: 'café', replace: 'cafés' });
  assert.equal(result.ok, true);
  assert.equal(await fsp.readFile(path.join(dir, 'new.c'), 'utf8'), '// cafés\nint x = 1;\n');
  console.log('older file encodings survive an edit: OK');
}

async function testWorkspaceStats() {
  const dir = path.join(root, 'stats');
  await ensureDir(path.join(dir, 'sub'));
  for (let index = 0; index < 150; index += 1) await fsp.writeFile(path.join(dir, index % 2 ? 'sub' : '.', `f${index}.txt`), 'x'.repeat(10));
  const workspace = new Workspace({ root: dir, trash: (target) => fsp.rm(target, { force: true }) });
  await workspace.init();
  let walks = 0;
  const measure = workspace.measure.bind(workspace);
  workspace.measure = async () => { walks += 1; return measure(); };

  const first = await workspace.stats();
  assert.deepEqual([first.files, first.folders, first.bytes], [150, 1, 1500]);
  await workspace.stats();
  await workspace.summaryForPrompt();
  assert.equal(walks, 1, 'the folder is walked once, not for every message');
  // Two askers at the same moment share one walk.
  workspace.invalidateStats();
  await Promise.all([workspace.stats(), workspace.stats()]);
  assert.equal(walks, 2);
  // Uma's own change is seen at once.
  await workspace.writeFile('new.txt', 'hello');
  assert.equal((await workspace.stats()).files, 151);
  await workspace.deleteFile('new.txt');
  assert.equal((await workspace.stats()).files, 150);
  // A command may change anything, so it also drops the count.
  const store = new Store(path.join(dir, '..', 'stats-data'));
  await store.init();
  await store.updateSettings({ allowShell: true });
  const tools = new ToolRunner({ workspace, store, onChanged: () => {} });
  const before = walks;
  await tools.run('run_command', { command: 'echo hi' });
  await workspace.stats();
  assert.equal(walks, before + 1);
  console.log('workspace counts are cached and stay correct: OK');
}

async function testConversationIndex() {
  const dir = path.join(root, 'conversations');
  await fsp.rm(dir, { recursive: true, force: true });
  const first = new ConversationStore(dir);
  await first.init();
  const a = await first.create({ title: 'Alpha' });
  a.messages.push({ id: 'm1', role: 'user', content: 'hello there' });
  await first.save(a);
  const b = await first.create({ title: 'Beta' });
  // Saved compactly: one line, still valid JSON.
  const raw = await fsp.readFile(path.join(dir, `${a.id}.json`), 'utf8');
  assert.equal(raw.includes('\n'), false);
  assert.equal(JSON.parse(raw).messages[0].content, 'hello there');

  // A new session reads the files once; after that the list costs no disk reads at all.
  const second = new ConversationStore(dir);
  await second.init();
  let list = await second.list();
  assert.deepEqual(list.map((item) => item.title).sort(), ['Alpha', 'Beta']);
  assert.equal(list.find((item) => item.id === a.id).preview, 'hello there');
  assert.equal(list.find((item) => item.id === a.id).messageCount, 1);
  const readdir = fsp.readdir;
  let scans = 0;
  fsp.readdir = (...args) => { scans += 1; return readdir(...args); };
  try {
    const loaded = await second.get(b.id);
    await second.rename(b.id, 'Beta renamed');
    await sleep(5);
    loaded.messages.push({ id: 'm2', role: 'user', content: 'newest' });
    await second.save(loaded);
    const c = await second.create({ title: 'Gamma' });
    await second.remove(a.id);
    list = await second.list();
    assert.deepEqual(list.map((item) => item.title).sort(), ['Beta renamed', 'Gamma']);
    assert.equal(list.find((item) => item.id === b.id).messageCount, 1);
    assert.ok(list.find((item) => item.id === c.id));
    assert.equal(scans, 0, 'the folder is not read again');
  } finally {
    fsp.readdir = readdir;
  }
  // A reply that was still being written when Uma closed shows as stopped, not as working forever.
  const stale = await first.create({ title: 'Cut off' });
  stale.messages.push({ id: 'u1', role: 'user', content: 'hello' }, { id: 'a1', role: 'assistant', content: '', status: 'streaming', blocks: [] });
  await first.save(stale);
  const reopened = new ConversationStore(dir);
  await reopened.init();
  const cutOff = (await reopened.get(stale.id)).messages[1];
  assert.deepEqual([cutOff.status, cutOff.interrupted], ['stopped', true]);
  assert.equal((await first.get(stale.id)).messages[1].status, 'streaming', 'a reply running now, in memory, is left alone');
  await first.remove(stale.id);
  // A save that lands while the first scan is still running is not lost.
  const third = new ConversationStore(dir);
  await third.init();
  const pending = third.list();
  const d = await third.create({ title: 'Delta' });
  assert.ok((await pending).some((item) => item.id === d.id) || (await third.list()).some((item) => item.id === d.id));
  assert.ok((await third.list()).some((item) => item.title === 'Delta'));
  console.log('the chat list is kept in memory: OK');
}

async function testDownloadStall() {
  // A server that sends a little and then goes quiet, like a dropped connection.
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Length': 1000000 });
    response.write(Buffer.alloc(1000, 1));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const target = path.join(root, 'download', 'model.bin');
  await fsp.rm(path.dirname(target), { recursive: true, force: true });
  const started = Date.now();
  await assert.rejects(
    downloadFile(`http://127.0.0.1:${server.address().port}/file`, target, { stallMs: 400 }),
    /stopped receiving data/,
  );
  assert.ok(Date.now() - started < 5000, 'it gives up soon after the data stops');
  assert.equal((await fsp.stat(`${target}.part`)).size, 1000, 'what arrived is kept, so trying again resumes');
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  console.log('a stalled download ends with a message: OK');
}

async function testStreamBatching() {
  const sent = [];
  const agent = new AgentRunner({ send: (_channel, payload) => sent.push(payload) });
  for (const delta of ['Hel', 'lo', ' wor', 'ld']) agent.emit({ type: 'text-delta', messageId: 'm', index: 0, delta });
  assert.equal(sent.length, 0, 'tokens are gathered first');
  // Another block, or any other event, sends what was gathered before it, in order.
  agent.emit({ type: 'reasoning-delta', messageId: 'm', index: 1, delta: 'hm' });
  agent.emit({ type: 'tool-update', messageId: 'm', index: 2, patch: {} });
  assert.deepEqual(sent.map((item) => [item.type, item.delta]), [['text-delta', 'Hello world'], ['reasoning-delta', 'hm'], ['tool-update', undefined]]);
  agent.emit({ type: 'text-delta', messageId: 'm', index: 3, delta: 'tail' });
  await sleep(120);
  assert.equal(sent.at(-1).delta, 'tail', 'the last piece is sent by the timer');
  console.log('streamed text is sent in batches: OK');
}

async function testSkillFormat() {
  // The header shapes found in Claude-format skills.
  const folded = parseSkill('---\nname: x\ndescription: >\n  Build dashboards\n  from CSV files.\n  Use when asked for charts.\ntags:\n  - data\n  - Charts\nrisk: critical\nmetadata:\n  author: someone\n  version: "1.0"\nallowed-tools: Read, Bash\n---\nBody');
  assert.equal(folded.description, 'Build dashboards from CSV files. Use when asked for charts.');
  assert.deepEqual(folded.meta.tags, ['data', 'charts']);
  assert.equal(folded.meta.risk, 'critical');
  const inline = parseSkill('---\ndescription: "Quoted: with a colon"\ntags: [a, "b c"]\nrequires: terminal, internet\n---\nBody');
  assert.equal(inline.description, 'Quoted: with a colon');
  assert.deepEqual(inline.meta.tags, ['a', 'b c']);
  assert.deepEqual(inline.requires, ['terminal', 'internet']);
  const continued = parseSkill('---\ndescription: First line\n  continues here.\n---\nBody');
  assert.equal(continued.description, 'First line continues here.');
  const long = parseSkill(`---\ndescription: ${'word '.repeat(100)}\n---\nBody`);
  assert.ok(long.description.length <= 240 && long.description.endsWith('…'), 'a long description is cut at a word');
  assert.match(parseSkill('---\nname: x\nmetadata:\n  description: nested does not count\n---\nBody').error, /description/);

  // A skill with more files: they are listed on load and read one at a time, inside its folder only.
  const dir = path.join(root, 'skills');
  await fsp.rm(dir, { recursive: true, force: true });
  const globalDir = path.join(dir, 'global');
  const skillDir = path.join(globalDir, 'pdf-forms');
  await ensureDir(path.join(skillDir, 'references'));
  await ensureDir(path.join(skillDir, 'scripts'));
  await fsp.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: pdf-forms\ndescription: Fill in PDF forms. Use when the user has a PDF form.\n---\n\n# PDF forms\n\n1. Use the Read tool on references/fields.md.\n2. Run scripts/fill.py with Bash.\n');
  await fsp.writeFile(path.join(skillDir, 'references', 'fields.md'), Array.from({ length: 50 }, (_, index) => `field ${index + 1}`).join('\n'));
  await fsp.writeFile(path.join(skillDir, 'scripts', 'fill.py'), 'print("filled")\n');
  await fsp.writeFile(path.join(dir, 'secret.txt'), 'TOP SECRET');
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  const removed = [];
  const skills = new SkillStore({ globalDir, store, trash: async (target) => { removed.push(target); await fsp.rm(target, { recursive: true, force: true }); } });
  const workspaceDir = path.join(dir, 'workspace');
  await ensureDir(workspaceDir);
  const workspace = new Workspace({ root: workspaceDir, trash: () => {} });
  await workspace.init();
  const tools = new ToolRunner({ workspace, store, onChanged: () => {}, skills });

  const loaded = await tools.run('load_skill', { name: 'pdf-forms' });
  assert.equal(loaded.ok, true, loaded.output);
  assert.match(loaded.output, /written for another assistant/, 'a skill that names other tools gets the mapping to Uma\'s');
  assert.match(loaded.output, /This skill has 2 more files/);
  assert.match(loaded.output, /- references\/fields\.md/);
  assert.match(loaded.output, /- scripts\/fill\.py/);
  assert.ok(loaded.output.includes(skillDir), 'the folder is given, so a script can be run by its full path');
  assert.equal(extractToolCall('{"name":"read_skill_file","arguments":{"name":"pdf-forms","path":"references/fields.md"}}').name, 'read_skill_file');

  let read = await tools.run('read_skill_file', { name: 'pdf-forms', path: 'references/fields.md', start_line: 10, max_lines: 3 });
  assert.equal(read.ok, true, read.output);
  assert.match(read.output, /^field 10\nfield 11\nfield 12\n/);
  assert.match(read.output, /start_line=13/);
  read = await tools.run('read_skill_file', { name: 'pdf-forms', path: 'SKILL.md' });
  assert.match(read.output, /# PDF forms/);
  for (const escape of ['../../secret.txt', path.join(dir, 'secret.txt'), '..\\..\\secret.txt']) {
    read = await tools.run('read_skill_file', { name: 'pdf-forms', path: escape });
    assert.equal(read.ok, false, `read ${escape}`);
    assert.doesNotMatch(read.output, /TOP SECRET/);
  }
  assert.equal((await tools.run('read_skill_file', { name: 'no-such-skill', path: 'SKILL.md' })).ok, false);

  // Uma's own skills name its tools, so they get no mapping note, and no file list.
  await ensureDir(path.join(globalDir, 'native'));
  await fsp.writeFile(path.join(globalDir, 'native', 'SKILL.md'), '---\ndescription: Native skill\n---\nCall read_file first.');
  const native = await tools.run('load_skill', { name: 'native' });
  assert.doesNotMatch(native.output, /another assistant|more file/);

  // The forced-call grammar knows the new tool whenever skills exist.
  assert.ok(allowedTools({}, ['native']).includes('read_skill_file'));
  assert.equal(allowedTools({}, []).includes('read_skill_file'), false);
  assert.ok(JSON.stringify(toolCallSchema(['read_skill_file'], ['native'])).includes('start_line'));

  // Removing goes through the Recycle Bin, only for shared skills, and never follows a strange name.
  await skills.remove('native');
  assert.equal(removed.length, 1);
  assert.equal((await skills.list()).some((skill) => skill.name === 'native'), false);
  await assert.rejects(skills.remove('../global'), /no longer exists/);
  await assert.rejects(skills.remove('not-there'), /shared folder/);
  console.log('Claude-format skills with extra files: OK');
}

function makeSkills(count) {
  const topics = ['docker', 'kubernetes', 'email', 'invoice', 'spreadsheet', 'animation', 'payment', 'calendar', 'translation', 'audio'];
  return Array.from({ length: count }, (_, index) => ({
    name: `${topics[index % topics.length]}-helper-${index}`,
    description: `Work with ${topics[index % topics.length]} things, number ${index}.`,
    meta: { tags: [], category: '' },
  }));
}

async function testSkillRanking() {
  const skills = [
    { name: 'cold-email', description: 'Write a cold outreach email to a prospect. Use for sales emails.', meta: { tags: ['sales'], category: 'marketing' } },
    { name: 'unit-testing', description: 'Write and fix unit tests for a function or module.', meta: { tags: ['testing'], category: 'development' } },
    { name: 'docker-expert', description: 'Containers, images and compose files.', meta: { tags: ['devops'], category: '' } },
    ...makeSkills(200),
  ];
  let ranked = rankSkills(skills, 'write a cold email to a potential customer', 5);
  assert.equal(ranked[0].skill.name, 'cold-email');
  assert.equal(isStrongMatch(ranked[0]), true);
  ranked = rankSkills(skills, 'fix the failing unit tests', 5);
  assert.equal(ranked[0].skill.name, 'unit-testing', 'plural and verb endings still match');
  assert.equal(rankSkills(skills, 'use the docker expert skill', 3)[0].skill.name, 'docker-expert');
  // Ordinary chat matches nothing strongly, so it never pays for the extra question.
  for (const chat of ['tell me a joke', 'thanks, that works', 'what is the capital of France?', 'make me a poem']) {
    assert.equal(isStrongMatch(rankSkills(skills, chat, 5)[0]), false, chat);
  }
  assert.deepEqual(rankSkills([], 'anything', 5), []);
  assert.deepEqual(rankSkills(skills, '', 5), []);

  // Through the agent with a library installed: the prompt no longer lists skills, the question
  // names only the matches, and the chosen skill is loaded.
  const dir = path.join(root, 'ranking');
  await fsp.rm(dir, { recursive: true, force: true });
  const globalDir = path.join(dir, 'global');
  for (const skill of skills.slice(0, 80)) {
    await ensureDir(path.join(globalDir, skill.name));
    await fsp.writeFile(path.join(globalDir, skill.name, 'SKILL.md'), `---\ndescription: ${skill.description}\n---\nSteps for ${skill.name}.`);
  }
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  await store.updateSettings({ allowEdits: true });
  const workspaceDir = path.join(dir, 'workspace');
  await ensureDir(workspaceDir);
  await fsp.writeFile(path.join(workspaceDir, 'README.md'), '# demo\n');
  const workspace = new Workspace({ root: workspaceDir, trash: () => {} });
  await workspace.init();
  const tools = new ToolRunner({ workspace, store, onChanged: () => {}, skills: new SkillStore({ globalDir, store }) });
  const conversations = new ConversationStore(path.join(dir, 'conversations'));
  await conversations.init();
  const chat = async (script, text) => {
    const conversation = await conversations.create();
    const calls = [];
    let done;
    const finished = new Promise((resolve) => { done = resolve; });
    const agent = new AgentRunner({
      store,
      workspace,
      models: { resolveActive: async () => ({ id: 'mock', name: 'Mock', family: 'Test' }) },
      conversations,
      toolRunner: tools,
      llama: {
        async ensureServer() {},
        async *streamChat(request) {
          calls.push(request);
          yield { type: 'text', text: script[Math.min(calls.length - 1, script.length - 1)] };
        },
      },
      send: (_channel, payload) => { if (payload?.type === 'assistant-end') done(payload.message); },
    });
    await agent.send(conversation.id, text);
    return { message: await finished, calls };
  };

  let run = await chat(['{"skill":"cold-email"}', 'Here is the email.'], 'write a cold email to a potential customer');
  const system = run.calls[0].messages[0].content;
  assert.match(system, /80 skills are installed/);
  assert.doesNotMatch(system, /- docker-expert:/, 'the prompt does not list a library');
  assert.ok(system.length < 12000, `the prompt stays small: ${system.length}`);
  const question = run.calls[0].messages.at(-1).content;
  assert.match(question, /- cold-email: Write a cold outreach email/);
  const offered = run.calls[0].responseSchema.properties.skill.enum;
  assert.ok(offered.includes('cold-email') && offered.includes('none') && offered.length <= 9, `only the matches are offered: ${offered}`);
  assert.match(run.calls[1].messages.at(-1).content, /Steps for cold-email/);
  assert.equal(run.message.blocks.find((block) => block.type === 'tool').title, 'Loaded skill cold-email');
  // The system prompt is the same for a different request, so the model's cache is reused.
  const other = await chat(['Roses are red.'], 'make me a poem');
  assert.equal(other.calls.length, 1, 'ordinary chat asks nothing extra');
  assert.equal(other.calls[0].messages[0].content, system);
  // "/name" still works for any installed skill, and an unknown name suggests close ones.
  run = await chat(['Done.'], '/docker-expert set it up');
  assert.match(run.calls[0].messages.at(-1).content, /Steps for docker-expert/);
  const missing = await tools.run('load_skill', { name: 'docker' });
  assert.match(missing.output, /Closest skills: .*docker/);
  assert.ok(missing.output.length < 600, 'not the whole library');
  console.log('skills are matched to the request when many are installed: OK');
}

async function testSkillLibrary() {
  // A small library in the built layout: index.json and skills/<name>/...
  const dir = path.join(root, 'library');
  await fsp.rm(dir, { recursive: true, force: true });
  const libraryDir = path.join(dir, 'lib');
  const entries = [
    { name: 'docker-compose', description: 'Write docker compose files for local development.', risk: 'safe', tags: ['devops'], files: [{ path: 'references/ports.md', size: 5 }] },
    { name: 'stripe-refunds', description: 'Issue refunds through the Stripe API.', risk: 'critical', tags: ['payments'], files: [] },
    { name: 'haiku', description: 'Write a haiku about anything.', risk: 'unknown', tags: [], files: [] },
    { name: 'evil', description: 'Tries to write outside its folder.', risk: 'unknown', tags: [], files: [{ path: '../../escaped.txt', size: 1 }] },
  ];
  for (const entry of entries) {
    await ensureDir(path.join(libraryDir, 'skills', entry.name, 'references'));
    await fsp.writeFile(path.join(libraryDir, 'skills', entry.name, 'SKILL.md'), `---\nname: ${entry.name}\ndescription: ${entry.description}\nrisk: ${entry.risk}\n---\nSteps.`);
  }
  await fsp.writeFile(path.join(libraryDir, 'skills', 'docker-compose', 'references', 'ports.md'), 'ports');
  await fsp.writeFile(path.join(libraryDir, 'index.json'), JSON.stringify({ version: 1, skills: entries }));
  const library = new SkillLibrary({ dir: libraryDir });

  let page = await library.search({});
  assert.equal(page.librarySize, 4);
  assert.deepEqual(page.items.map((item) => item.name), ['docker-compose', 'stripe-refunds', 'haiku', 'evil'], 'without a query, the order of the index');
  page = await library.search({ query: 'docker' }, new Set(['docker-compose']));
  assert.equal(page.items[0].name, 'docker-compose');
  assert.equal(page.items[0].installed, true);
  assert.equal((await library.search({ query: 'refund' })).items[0].name, 'stripe-refunds');
  assert.equal((await library.search({ query: 'strip' })).items[0].name, 'stripe-refunds', 'part of a name is enough');
  assert.deepEqual((await library.search({ risk: 'critical' })).items.map((item) => item.name), ['stripe-refunds']);
  assert.equal((await library.search({ query: 'zzzz' })).total, 0);
  assert.equal((await library.search({ limit: 2, offset: 2 })).items.length, 2);

  // Installing copies the whole skill, and the model can then use it like any other.
  const globalDir = path.join(dir, 'global');
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  const skills = new SkillStore({ globalDir, store });
  assert.deepEqual(await skills.list(), []);
  await library.install('docker-compose', globalDir);
  skills.invalidate();
  const installed = await skills.list();
  assert.deepEqual(installed.map((skill) => [skill.name, skill.meta.risk]), [['docker-compose', 'safe']]);
  assert.equal(await fsp.readFile(path.join(globalDir, 'docker-compose', 'references', 'ports.md'), 'utf8'), 'ports');
  await assert.rejects(library.install('docker-compose', globalDir), /already installed/);
  await assert.rejects(library.install('nope', globalDir), /not in the library/);
  // A damaged index cannot make an install write outside the skill's own folder.
  await library.install('evil', globalDir);
  assert.equal(fs.existsSync(path.join(dir, 'escaped.txt')), false);
  assert.equal(fs.existsSync(path.join(globalDir, 'evil', 'SKILL.md')), true);
  // An app built without a library just has an empty one.
  assert.equal((await new SkillLibrary({ dir: path.join(dir, 'missing') }).search({})).librarySize, 0);

  // The real library, when it has been built: every entry is installable as indexed.
  const built = path.join(__dirname, '..', 'build', 'skill-library');
  if (fs.existsSync(path.join(built, 'index.json'))) {
    const real = new SkillLibrary({ dir: built });
    const all = await real.search({ limit: 100 });
    assert.ok(all.librarySize > 1000, `only ${all.librarySize} skills in the built library`);
    const index = JSON.parse(await fsp.readFile(path.join(built, 'index.json'), 'utf8')).skills;
    assert.ok(index.some((skill) => skill.risk === 'offensive'), 'offensive skills are included since 0.2.84');
    assert.equal(index.some((skill) => /-official$|^claude-api$/.test(skill.name)), false, 'skills whose licence forbids passing them on are not shipped');
    let checked = 0;
    for (const skill of index) {
      assert.equal(parseSkill(await fsp.readFile(path.join(built, 'skills', skill.name, 'SKILL.md'), 'utf8')).error, undefined, skill.name);
      for (const file of skill.files) assert.ok(fs.existsSync(path.join(built, 'skills', skill.name, file.path)), `${skill.name}/${file.path}`);
      checked += 1;
    }
    const target = path.join(dir, 'real-install');
    const withFiles = index.find((skill) => skill.files.length >= 3);
    await real.install(withFiles.name, target);
    assert.equal((await fsp.readdir(path.join(target, withFiles.name), { recursive: true })).filter((name) => !fs.statSync(path.join(target, withFiles.name, name)).isDirectory()).length, withFiles.files.length + 1);
    console.log(`the built library is consistent: ${checked} skills checked`);
  }
  console.log('skill library search and install: OK');
}

function testMainRamFirst() {
  // The measured setup: a laptop helper (8 GB GPU, 11 GB of RAM free) for a 58 GB model.
  const devices = parseDeviceList([
    '  CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB, 23000 MiB free)',
    '  RPC0: 192.168.137.50:50052 (16259 MiB, 11000 MiB free)',
    '  RPC1: 192.168.137.50:50052 (8191 MiB, 7154 MiB free)',
  ].join('\n'));
  const helpers = [{ address: '192.168.137.50:50052', label: 'Laptop', info: { devices: [{ kind: 'cpu', reserveMB: 3072 }, { kind: 'gpu' }] } }];
  const needMB = 58000;

  // The main PC has room for what the GPUs cannot hold: the helper lends its GPU only, so no token
  // waits for the helper's CPU.
  let plan = planPlacement({ devices, helpers, needMB, mainFreeRamMB: 60000 });
  assert.deepEqual(placementArgs(plan), ['-dev', 'RPC1,CUDA0', '--fit-target', '512,512']);
  assert.equal(plan.ramHereMB, plan.leftoverMB);
  // Not quite enough room here: the helper's RAM takes only the difference.
  plan = planPlacement({ devices, helpers, needMB, mainFreeRamMB: 30000 });
  const helperRam = plan.devices.find((device) => device.name === 'RPC0');
  assert.equal(helperRam.wantMB, plan.leftoverMB - (30000 - 4096));
  assert.equal(helperRam.targetMB, 11000 - helperRam.wantMB, 'the margin leaves exactly that share for the model');
  assert.deepEqual(plan.devices.map((device) => device.name), ['RPC0', 'RPC1', 'CUDA0']);
  // Little RAM here: the helper's RAM is used in full, down to its own reserve.
  plan = planPlacement({ devices, helpers, needMB, mainFreeRamMB: 8000 });
  assert.deepEqual(placementArgs(plan), ['-dev', 'RPC0,RPC1,CUDA0', '--fit-target', '3072,512,512']);
  // Unknown free RAM or model size: as before.
  assert.deepEqual(placementArgs(planPlacement({ devices, helpers, needMB })), ['-dev', 'RPC0,RPC1,CUDA0', '--fit-target', '3072,512,512']);
  assert.deepEqual(placementArgs(planPlacement({ devices, helpers, needMB: 0, mainFreeRamMB: 60000 })), ['-dev', 'RPC0,RPC1,CUDA0', '--fit-target', '3072,512,512']);
  // A model that fits on the GPUs is still balanced, and a retry can force the fill plan with its size known.
  assert.equal(planPlacement({ devices, helpers, needMB: 12000, mainFreeRamMB: 60000 }).mode, 'balanced');
  plan = planPlacement({ devices, helpers, needMB: 12000, mainFreeRamMB: 60000, forceFill: true });
  assert.deepEqual([plan.mode, placementArgs(plan).join(' ')], ['fill', '-dev RPC1,CUDA0 --fit-target 512,512']);
  // No GPU anywhere: the helper's RAM is all there is to plan with.
  plan = planPlacement({ devices: devices.filter((device) => device.name === 'RPC0'), helpers: [{ ...helpers[0], info: { devices: [{ kind: 'cpu', reserveMB: 3072 }] } }], needMB, mainFreeRamMB: 60000 });
  assert.deepEqual(plan.devices.map((device) => device.name), ['RPC0']);
  console.log('layers stay in the main PC\'s RAM before a helper\'s: OK');
}

async function testSpeedReadings() {
  // The engine reports its own timings with the last piece of each reply; they are added up over
  // every model call of one answer and saved with the message, for the speed line under it.
  const dir = path.join(root, 'speed');
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  await store.updateSettings({ allowEdits: true });
  const workspaceDir = path.join(dir, 'workspace');
  await ensureDir(workspaceDir);
  await fsp.writeFile(path.join(workspaceDir, 'notes.md'), 'hello\n');
  const workspace = new Workspace({ root: workspaceDir, trash: () => {} });
  await workspace.init();
  const conversations = new ConversationStore(path.join(dir, 'conversations'));
  await conversations.init();
  const conversation = await conversations.create();
  const replies = [
    { text: '{"name":"read_file","arguments":{"path":"notes.md"}}', timings: { cache_n: 0, prompt_n: 3000, prompt_ms: 60000, predicted_n: 20, predicted_ms: 10000 } },
    { text: 'It says hello.', timings: { cache_n: 3000, prompt_n: 200, prompt_ms: 4000, predicted_n: 5, predicted_ms: 2500 } },
  ];
  let calls = 0;
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const agent = new AgentRunner({
    store,
    workspace,
    models: { resolveActive: async () => ({ id: 'mock', name: 'Mock', family: 'Test' }) },
    conversations,
    toolRunner: new ToolRunner({ workspace, store, onChanged: () => {} }),
    llama: {
      async ensureServer() {},
      async *streamChat() {
        const reply = replies[Math.min(calls, replies.length - 1)];
        calls += 1;
        yield { type: 'text', text: reply.text };
        yield { type: 'timings', timings: reply.timings };
        yield { type: 'finish', reason: 'stop' };
      },
    },
    send: (_channel, payload) => { if (payload?.type === 'assistant-end') done(payload.message); },
  });
  await agent.send(conversation.id, 'read the file notes.md and tell me what it says');
  const message = await finished;
  assert.equal(message.status, 'done');
  assert.deepEqual(
    [message.stats.calls, message.stats.promptTokens, message.stats.promptMs, message.stats.cachedTokens, message.stats.outputTokens, message.stats.outputMs],
    [2, 3200, 64000, 3000, 25, 12500],
  );
  assert.ok(message.stats.firstTokenMs >= 0 && message.stats.totalMs >= message.stats.firstTokenMs);
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'conversations', `${conversation.id}.json`), 'utf8'));
  assert.equal(saved.messages.at(-1).stats.promptTokens, 3200, 'the readings are kept with the conversation');
  console.log('speed readings per reply: OK');
}

async function testHelperBusyShare() {
  // The helper's relay knows when it is working on a request and when it is waiting for the main
  // PC to send the next one. Here the stand-in engine takes 120 ms per request and the main PC
  // waits 360 ms between requests, so the helper works about a quarter of the time.
  const net = require('node:net');
  const { NetworkManager } = require('../electron/lib/network.cjs');
  const engine = net.createServer((socket) => socket.on('error', () => {}).on('data', () => setTimeout(() => socket.write(Buffer.alloc(64)), 120)));
  await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve));
  const settings = { network: {} };
  const manager = new NetworkManager({ store: { getRuntime: () => ({ version: 'b1' }), getSettings: () => settings, updateSettings: async (patch) => Object.assign(settings, patch) } });
  const front = net.createServer((socket) => manager.relay(socket, engine.address().port));
  await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
  const main = net.connect(front.address().port, '127.0.0.1');
  main.on('error', () => {});
  await new Promise((resolve) => main.once('connect', resolve));
  for (let round = 0; round < 5; round += 1) {
    const reply = new Promise((resolve) => main.once('data', resolve));
    main.write(Buffer.alloc(256, 1));
    await reply;
    await sleep(360);
  }
  const session = [...manager.sessions.values()][0];
  const share = session.busyMs / (session.busyMs + session.waitMs);
  assert.ok(session.busyMs >= 500 && session.busyMs < 1200, `worked ${session.busyMs} ms`);
  assert.ok(session.waitMs >= 1200 && session.waitMs < 2600, `waited ${session.waitMs} ms`);
  assert.ok(share > 0.15 && share < 0.4, `share ${share.toFixed(2)}`);
  // The 5-second report turns that into a percentage for the Shared screen.
  session.announced = true;
  session.last = { ...session.last, at: Date.now() - 2000, busyMs: session.busyMs - 500, waitMs: session.waitMs - 1500, received: 0, sent: 0 };
  manager.monitor();
  assert.ok(session.busyPercent >= 20 && session.busyPercent <= 30, `reported ${session.busyPercent}%`);
  assert.match(manager.activity.at(-1).text, /This PC worked 2\d% of that time and waited for the main PC the rest/);
  main.destroy();
  await sleep(50);
  await new Promise((resolve) => front.close(resolve));
  await new Promise((resolve) => engine.close(resolve));

  // The switch between the two splits is saved, and changing it reloads the model.
  const before = manager.launchKey();
  assert.equal(manager.settings().helperRamFirst, false, 'this PC\'s RAM first by default');
  await manager.setHelperRamFirst(true);
  assert.equal(manager.settings().helperRamFirst, true);
  assert.notEqual(manager.launchKey(), before);
  console.log('the helper reports how much of the time it works: OK');
}

async function testMainPcReports() {
  // The main PC tells a helper what it loaded and how fast a reply was; the helper shows it in its
  // log. The text arrives from another PC, so control characters are removed and it is cut short.
  const net = require('node:net');
  const { NetworkManager } = require('../electron/lib/network.cjs');
  const { LlamaManager } = require('../electron/lib/llama.cjs');
  const fakeStore = (version) => ({ getRuntime: () => ({ version }), getSettings: () => ({ network: {} }), updateSettings: async () => {} });
  const helper = new NetworkManager({ store: fakeStore('b12102') });
  const front = net.createServer((socket) => helper.relay(socket, 1));
  await new Promise((resolve) => front.listen(0, '127.0.0.1', resolve));
  const address = `127.0.0.1:${front.address().port}`;
  const main = new NetworkManager({ store: fakeStore('b12102') });

  main.reportToHelpers([address], { kind: 'loaded', model: 'Big Model Q4', summary: '58.4 GB model; context 40960; this PC has 21.0 GB of RAM free of 63.9 GB after loading' });
  await sleep(300);
  assert.match(helper.activity.at(-1).text, /^The main PC 127\.0\.0\.1 loaded Big Model Q4\. 58\.4 GB model; context 40960; this PC has 21\.0 GB of RAM free/);
  await sleep(1100);
  main.reportToHelpers([address], { kind: 'reply', summary: `read 3200 tokens at 50.0 tok/s\u0007\nwrote 25 tokens at 2.0 tok/s ${'x'.repeat(2000)}` });
  await sleep(300);
  const reply = helper.activity.at(-1).text;
  assert.match(reply, /^The main PC 127\.0\.0\.1 finished a reply: read 3200 tokens at 50\.0 tok\/s wrote 25 tokens/);
  assert.ok(reply.length < 700 && !/[\u0000-\u001f]/.test(reply), 'cleaned and cut');
  // Reports in a burst, unknown kinds and empty ones add nothing.
  const count = helper.activity.length;
  main.reportToHelpers([address], { kind: 'reply', summary: 'too soon after the last one' });
  await sleep(1300);
  main.reportToHelpers([address], { kind: 'other', summary: 'x' });
  main.reportToHelpers([address], { kind: 'reply', summary: '' });
  await sleep(300);
  assert.equal(helper.activity.length, count);
  await new Promise((resolve) => front.close(resolve));

  // What the main PC writes after a load with helpers, and sends to them.
  const sent = [];
  const logs = [];
  const fake = {
    helpers: { servers: ['192.168.137.50:50052'] },
    placement: { mode: 'fill', ramHereMB: 28000, devices: [{ remote: true, label: 'Laptop', kind: 'gpu', wantMB: 6600 }, { remote: false, kind: 'gpu', wantMB: 23000 }] },
    compute: { offloadedLayers: 30, totalLayers: 49 },
    freeRam: () => 21 * 1024 ** 3,
    log: (line) => logs.push(line),
    network: { reportToHelpers: (servers, report) => sent.push([servers, report]) },
  };
  LlamaManager.prototype.reportLoad.call(fake, { name: 'Big Model Q4', parts: [{ size: 30 * 1024 ** 3 }, { size: 28 * 1024 ** 3 }] }, { contextSize: 40960, threads: 28, loadMode: 'auto' }, 212000);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][0], ['192.168.137.50:50052']);
  assert.equal(sent[0][1].kind, 'loaded');
  assert.match(sent[0][1].summary, /^58\.0 GB model; context 40960; 28 threads of \d+; loading mode auto; this PC has 21\.0 GB of RAM free of [\d.]+ GB after loading; loaded in 212 s; split \(fill\): Laptop GPU up to 6\.4 GB, main PC GPU up to 22\.5 GB; about 27\.3 GB stays in the main PC's RAM for its CPU; 30 of 49 layers on GPUs$/);
  assert.match(logs[0], /^\[uma\] loaded with helpers: 58\.0 GB model/);
  // Without helpers there is nobody to tell.
  LlamaManager.prototype.reportLoad.call({ ...fake, helpers: { servers: [] } }, { name: 'x' }, {}, 1000);
  assert.equal(sent.length, 1);
  console.log('the main PC reports its load and speed to helpers: OK');
}

async function testDraftModel() {
  const { draftCompatibility, draftArgs, sanitizeModelSettings } = require('../electron/lib/modelSettings.cjs');
  const { LlamaManager } = require('../electron/lib/llama.cjs');
  // The vocabularies measured from the real files: Qwen3.8-Flash-Next, Qwen3.5-0.8B, an older Qwen3.
  const flash = { tokenizer: { model: 'gpt2', pre: 'qwen35', size: 248320, eos: 248046, bos: 248044, addBos: false } };
  const small = { tokenizer: { model: 'gpt2', pre: 'qwen35', size: 248320, eos: 248046, bos: null, addBos: false } };
  const older = { tokenizer: { model: 'gpt2', pre: 'qwen2', size: 151936, eos: 151645, bos: null, addBos: false } };
  assert.equal(draftCompatibility(flash, small), '');
  assert.match(draftCompatibility(flash, older), /different tokenizer/);
  assert.match(draftCompatibility(flash, { tokenizer: { ...small.tokenizer, size: 248000 } }), /vocabulary size/);
  assert.match(draftCompatibility(flash, { tokenizer: { ...small.tokenizer, eos: 1 } }), /end token/);
  assert.match(draftCompatibility(flash, null), /unknown/);
  assert.deepEqual(draftArgs({ path: 'd.gguf', tokens: 6, device: 'RPC1' }), ['--spec-type', 'draft-simple', '-md', 'd.gguf', '--spec-draft-n-max', '6', '--spec-draft-p-min', '0.75', '-ngld', 'all', '-ctkd', 'q8_0', '-ctvd', 'q8_0', '-devd', 'RPC1']);
  assert.equal(draftArgs({ path: 'd.gguf' }).includes('-devd'), false, 'without a helper the draft follows the main model');
  assert.deepEqual(sanitizeModelSettings({ draftModelId: 'hub:ggml-org/Qwen3.5-0.8B-GGUF:Q8_0', draftTokens: 6 }), { draftModelId: 'hub:ggml-org/Qwen3.5-0.8B-GGUF:Q8_0', draftTokens: 6 });
  assert.throws(() => sanitizeModelSettings({ draftTokens: 40 }), /draftTokens/);

  // The plan puts the draft on the helper's GPU and keeps that much free of the big model.
  const devices = parseDeviceList([
    '  CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB, 23000 MiB free)',
    '  RPC0: 192.168.137.50:50052 (16259 MiB, 11000 MiB free)',
    '  RPC1: 192.168.137.50:50052 (8191 MiB, 7154 MiB free)',
  ].join('\n'));
  const helpers = [{ address: '192.168.137.50:50052', label: 'Laptop', info: { devices: [{ kind: 'cpu', reserveMB: 3072 }, { kind: 'gpu' }] } }];
  let plan = planPlacement({ devices, helpers, needMB: 58000, mainFreeRamMB: 30000, draftMB: 1500 });
  assert.equal(plan.draftDevice, 'RPC1');
  assert.equal(plan.devices.find((device) => device.name === 'RPC1').targetMB, 512 + 1500);
  assert.equal(plan.devices.find((device) => device.name === 'CUDA0').targetMB, 512);
  plan = planPlacement({ devices, helpers, needMB: 12000, mainFreeRamMB: 30000, draftMB: 1500 });
  assert.deepEqual([plan.mode, placementArgs(plan).at(-1)], ['balanced', '2012,512'], 'balanced plans give each GPU its own margin');
  assert.equal(planPlacement({ devices, helpers, needMB: 58000, mainFreeRamMB: 30000, draftMB: 30000 }).draftDevice, '', 'a draft that fits nowhere follows the main model');
  assert.equal(placementArgs(planPlacement({ devices, helpers, needMB: 12000, mainFreeRamMB: 30000 })).at(-1), '512', 'without a draft, as before');

  // Choosing the draft: missing or mismatched drafts are left out with a reason.
  const logs = [];
  const fake = {
    getModel: async (id) => ({ small: { id: 'small', name: 'Qwen3.5 0.8B', path: __filename }, old: { id: 'old', name: 'Old Qwen', path: __filename }, gone: { id: 'gone', name: 'Gone', path: path.join(root, 'missing.gguf') } })[id] || null,
    modelInfo: async (id) => ({ small: { ...small, architecture: 'qwen35', nLayer: 24, nEmbd: 1024, nHead: 8, nHeadKv: 2, keyLength: 256, valueLength: 256, attentionLayers: 6, layerBytes: Array(24).fill(30 * 1024 ** 2), inputBytes: 250 * 1024 ** 2, otherBytes: 0, totalBytes: 830 * 1024 ** 2 }, old: older })[id],
    log: (line) => logs.push(line),
  };
  const chosen = await LlamaManager.prototype.draftFor.call(fake, { id: 'big', name: 'Flash' }, { draftModelId: 'small', draftTokens: 5, contextSize: 40960 }, flash);
  assert.equal(chosen.name, 'Qwen3.5 0.8B');
  assert.equal(chosen.tokens, 5);
  assert.ok(chosen.memoryMB > 830 && chosen.memoryMB < 3000, `about ${chosen.memoryMB} MiB`);
  assert.equal(await LlamaManager.prototype.draftFor.call(fake, { id: 'big', name: 'Flash' }, { draftModelId: 'old' }, flash), null);
  assert.match(logs.at(-1), /Old Qwen cannot draft for Flash: different tokenizer/);
  assert.equal(await LlamaManager.prototype.draftFor.call(fake, { id: 'big', name: 'Flash' }, { draftModelId: 'gone' }, flash), null);
  assert.match(logs.at(-1), /no longer installed/);
  assert.equal(await LlamaManager.prototype.draftFor.call(fake, { id: 'big', name: 'Flash' }, {}, flash), null, 'off by default');

  // A load that fails with a draft is tried again without it, once, and not again for the same settings.
  const manager = new LlamaManager({ store: { getRuntime: () => ({ serverPath: process.execPath, backend: 'cuda' }), getEffectiveSettings: () => ({}), getSettings: () => ({}) }, logsDir: root });
  const attempts = [];
  manager.startWithHelpers = async () => {
    attempts.push(manager.draftFailedKey ? 'without draft' : 'with draft');
    if (!manager.draftFailedKey) {
      manager.draft = { name: 'Qwen3.5 0.8B' };
      throw Object.assign(new Error('stopped while loading'), { code: 'SERVER_FAILED' });
    }
    manager.draft = null;
    return 'ready';
  };
  assert.equal(await manager.ensureServer({ id: 'big', name: 'Flash', path: __filename }), 'ready');
  assert.deepEqual(attempts, ['with draft', 'without draft']);
  assert.match(manager.logs.join('\n'), /failed with the draft model Qwen3\.5 0\.8B; loading again without it/);
  console.log('draft model choice, placement and fallback: OK');
}

async function testProjectSearch() {
  const { ProjectIndex, selectPassages, terms, chunkLines } = require('../electron/lib/rag.cjs');
  // Identifiers are split, endings are removed, and common words are left out (English and Italian).
  assert.deepEqual(terms('getUserName'), ['getusername', 'get', 'user', 'name']);
  assert.ok(terms('the loading of the user profiles').includes('profil'));
  assert.deepEqual(terms('il della per'), []);
  const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n');
  const chunks = chunkLines(lines);
  assert.equal(chunks[0].start, 1);
  assert.equal(chunks.at(-1).end, 100);
  assert.ok(chunks.every((chunk, index) => index === 0 || chunk.start < chunks[index - 1].end + 1), 'passages overlap, so nothing falls between two');

  // A small project.
  const dir = path.join(root, 'rag');
  await ensureDir(path.join(dir, 'src', 'auth'));
  await ensureDir(path.join(dir, 'node_modules', 'lib'));
  await fsp.writeFile(path.join(dir, 'src', 'auth', 'login.js'), `${'// helpers\n'.repeat(60)}export function checkPassword(user, password) {\n  return hashPassword(password) === user.passwordHash;\n}\n`);
  await fsp.writeFile(path.join(dir, 'src', 'cart.js'), 'export function addToCart(cart, item) {\n  cart.items.push(item);\n  return cart.total + item.price;\n}\n');
  await fsp.writeFile(path.join(dir, 'README.md'), '# Shop\nA small online shop with a cart and user accounts.\n');
  await fsp.writeFile(path.join(dir, 'node_modules', 'lib', 'password.js'), 'function checkPassword() {}\n');
  await fsp.writeFile(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  const index = new ProjectIndex({ root: dir });
  const stats = await index.refresh();
  assert.equal(stats.files, 3, 'node_modules and images are not indexed');
  let found = await index.search('where do we check the user password at login?');
  assert.equal(found[0].file, 'src/auth/login.js');
  assert.ok(found[0].start > 1, 'the passage with the function, not the start of the file');
  assert.match(found[0].text, /checkPassword/);
  assert.ok(!found.some((item) => item.file.includes('node_modules')));
  assert.deepEqual(await index.search('tell me a joke'), [], 'nothing in the project is about it');
  // Questions about the chat itself are not about the project, even when a file shares a word.
  const { isClearMatch } = require('../electron/lib/rag.cjs');
  await fsp.writeFile(path.join(dir, 'LICENSE.txt'), 'Permission is granted to talk about this software before and after use, right now.\n');
  await fsp.writeFile(path.join(dir, 'src', 'notes.md'), 'We will talk about the chat widget later.\n');
  index.invalidate();
  const chatQuestion = 'what did we talk right now in the before chat?';
  assert.equal(isClearMatch(await index.search(chatQuestion), chatQuestion), false);
  assert.equal((await index.search('permission granted software')).some((item) => item.file === 'LICENSE.txt'), false, 'licences are not indexed');
  assert.equal(isClearMatch(await index.search('check password login'), 'check password login'), true);
  await fsp.rm(path.join(dir, 'src', 'notes.md'));
  await fsp.rm(path.join(dir, 'LICENSE.txt'));

  // Changes: a new file, an edit and a deletion are seen after invalidate().
  await fsp.writeFile(path.join(dir, 'src', 'shipping.js'), 'export function shippingCost(weightKg) {\n  return weightKg * 4.5;\n}\n');
  await fsp.writeFile(path.join(dir, 'src', 'cart.js'), 'export function emptyBasket(basket) {\n  basket.items = [];\n}\n');
  await fsp.rm(path.join(dir, 'README.md'));
  index.invalidate();
  assert.equal((await index.search('shipping cost weight'))[0].file, 'src/shipping.js');
  assert.equal((await index.search('empty basket items'))[0].file, 'src/cart.js');
  assert.equal((await index.search('add to cart price total')).some((item) => item.file === 'src/cart.js' && /addToCart/.test(item.text)), false, 'the old text is gone');
  assert.equal(index.stats.files, 3);
  // Without invalidate(), a request does not read the folder again for a while.
  const readdir = fsp.readdir;
  let scans = 0;
  fsp.readdir = (...args) => { scans += 1; return readdir(...args); };
  try {
    await index.search('shipping');
    await index.search('basket');
    assert.equal(scans, 0);
  } finally {
    fsp.readdir = readdir;
  }

  // A long document: its start, then the pages that match the question, within the budget.
  const pages = Array.from({ length: 300 }, (_, page) => `[Page ${page + 1}]\n${page === 211 ? 'The heating element pinout: blue wire is positive, red wire is negative, both 18 AWG.' : `General maintenance notes for section ${page + 1}. Clean the filter and check the fan.`}\n${'Routine text about the machine. '.repeat(8)}`).join('\n');
  const picked = selectPassages(`Service manual for the X200 oven\n${pages}`, 'what is the pinout of the heating element?', 4000);
  assert.equal(picked.matched, true);
  assert.ok(picked.text.length <= 4000, `${picked.text.length} characters`);
  assert.match(picked.text, /^Service manual for the X200 oven/);
  assert.match(picked.text, /\[Page 212\][^\n]*\n[\s\S]*blue wire is positive/);
  assert.equal(selectPassages(pages, 'zzz qqq', 4000).text, null, 'no match: the caller keeps the start and the end');
  assert.equal(selectPassages('short', 'anything', 4000).text, 'short');

  // Through the agent: a task about the workspace gets the passages at the end of its message, as
  // a step in the chat; ordinary chat gets nothing, and the instructions stay the same for both.
  const store = new Store(path.join(root, 'rag-data'));
  await store.init();
  const workspace = new Workspace({ root: dir, trash: () => {} });
  await workspace.init();
  const conversations = new ConversationStore(path.join(root, 'rag-conversations'));
  await conversations.init();
  const calls = [];
  let done;
  const agent = new AgentRunner({
    store,
    workspace,
    models: { resolveActive: async () => ({ id: 'mock', name: 'Mock', family: 'Test' }) },
    conversations,
    toolRunner: new ToolRunner({ workspace, store, onChanged: () => {} }),
    llama: { generation: 1, async ensureServer() {}, async *streamChat(request) { calls.push(request); yield { type: 'text', text: request.messages.at(-1).content.includes('<project_excerpts') ? '{"name":"read_file","arguments":{"path":"src/auth/login.js"}}' : 'Done.' }; } },
    projectIndex: index,
    send: (_channel, payload) => { if (payload?.type === 'assistant-end') done(payload.message); },
  });
  const say = async (text) => {
    const conversation = await conversations.create();
    const finished = new Promise((resolve) => { done = resolve; });
    calls.length = 0;
    await agent.send(conversation.id, text);
    return finished;
  };
  let message = await say('fix the password check in the login code');
  const first = calls[0].messages;
  assert.match(first.at(-1).content, /fix the password check in the login code\n\n<project_excerpts[^>]*>\n--- src\/auth\/login\.js:\d+-\d+ ---\n[\s\S]*checkPassword[\s\S]*<\/project_excerpts>$/);
  const step = message.blocks.find((block) => block.name === 'project_search');
  assert.match(step.title, /^Found \d+ relevant passages? in the workspace$/);
  assert.match(step.output, /src\/auth\/login\.js:\d+-\d+/);
  message = await say('tell me a joke');
  assert.doesNotMatch(calls[0].messages.at(-1).content, /project_excerpts/);
  assert.equal(message.blocks.some((block) => block.name === 'project_search'), false);
  assert.equal(calls[0].messages[0].content, first[0].content, 'the instructions are the same, so the model reuses what it read');
  // Switched off in Settings: nothing is added.
  await store.updateSettings({ projectSearch: false });
  await say('fix the password check in the login code');
  assert.doesNotMatch(calls[0].messages.at(-1).content, /project_excerpts/);
  await store.updateSettings({ projectSearch: true });
  console.log('project search (RAG) for the workspace and long documents: OK');
}

/** How many characters two prompts share from the start: what the engine does not read again. */
function sharedPrefix(a, b) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

async function testPromptStaysReusable() {
  const dir = path.join(root, 'prompt-cache');
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  await store.updateSettings({ allowEdits: true });
  const workspaceDir = path.join(dir, 'workspace');
  await ensureDir(path.join(workspaceDir, 'src'));
  for (const name of ['README.md', 'src/app.js', 'src/util.js']) await fsp.writeFile(path.join(workspaceDir, name), 'x\n');
  const workspace = new Workspace({ root: workspaceDir, trash: (target) => fsp.rm(target, { force: true }) });
  await workspace.init();
  const conversations = new ConversationStore(path.join(dir, 'conversations'));
  await conversations.init();
  const conversation = await conversations.create();
  const calls = [];
  const llama = {
    generation: 1,
    async ensureServer() {},
    async *streamChat(request) {
      calls.push(request);
      yield { type: 'text', text: 'Done.' };
    },
  };
  let done;
  const agent = new AgentRunner({
    store,
    workspace,
    models: { resolveActive: async () => ({ id: 'mock', name: 'Mock', family: 'Test' }) },
    conversations,
    toolRunner: new ToolRunner({ workspace, store, onChanged: () => {} }),
    llama,
    send: (_channel, payload) => { if (payload?.type === 'assistant-end') done(); },
  });
  const say = async (text) => {
    const finished = new Promise((resolve) => { done = resolve; });
    await agent.send(conversation.id, text);
    await finished;
    return calls.at(-1).messages;
  };
  const system = (messages) => messages[0].content;
  const last = (messages) => messages.at(-1).content;

  const first = await say('tell me a joke');
  assert.match(system(first), /File index \(3\): README\.md, src\/app\.js, src\/util\.js/);
  assert.doesNotMatch(last(first), /Files changed/);

  // The agent's usual work: a file is created and another edited. The instructions the model has
  // already read stay byte for byte the same, and the new message says what changed.
  await workspace.writeFile('src/new-feature.js', 'export const x = 1;\n');
  await workspace.writeFile('README.md', 'much longer now\n'.repeat(400));
  const second = await say('and another joke');
  assert.equal(system(second), system(first), 'the system prompt is unchanged, so nothing in it is read again');
  assert.match(last(second), /^\[Files changed since the file index in your instructions was written\. New: src\/new-feature\.js\. The workspace now has 4 files/);
  assert.match(last(second), /and another joke$/);
  // 0.2.15 rewrote the file list in place: everything after it was read again on every such message.
  const rewritten = system(first).replace('File index (3): README.md, src/app.js, src/util.js', 'File index (4): README.md, src/app.js, src/new-feature.js, src/util.js');
  assert.ok(sharedPrefix(system(first), rewritten) < system(first).length / 10, 'the file list sits near the top of the prompt');

  // Deleted files are named too; an edit alone adds nothing.
  await workspace.deleteFile('src/util.js');
  const third = await say('one more');
  assert.equal(system(third), system(first));
  assert.match(last(third), /New: src\/new-feature\.js\. No longer there: src\/util\.js\./);
  await workspace.writeFile('src/app.js', 'changed\n');
  const fourth = await say('again');
  assert.equal(last(fourth).match(/^\[Files changed[^\]]*\]/)[0], last(third).match(/^\[Files changed[^\]]*\]/)[0], 'the same note while the file list is the same');

  // A reloaded model has read nothing, so it gets the current list and no note.
  llama.generation = 2;
  const reloaded = await say('hello again');
  assert.match(system(reloaded), /File index \(3\): README\.md, src\/app\.js, src\/new-feature\.js/);
  assert.doesNotMatch(last(reloaded), /Files changed/);
  // So does a change too long to list.
  for (let index = 0; index < 45; index += 1) await workspace.writeFile(`gen/file-${index}.txt`, 'x');
  const many = await say('what now');
  assert.match(system(many), /gen\/file-0\.txt/);
  assert.doesNotMatch(last(many), /Files changed/);
  console.log('the prompt stays reusable when files change: OK');
}

function testContextTrimmingKeepsThePrefix() {
  // A long task: one large tool result per step, with a context that holds about six of them.
  const agent = new AgentRunner({});
  const budget = 100000;
  const base = [{ role: 'system', content: 's'.repeat(8000) }, { role: 'user', content: 'do the long task' }];
  const reread = (useMemory) => {
    const messages = [...base];
    const memory = useMemory ? { trimmed: new Set(), dropped: new Set() } : null;
    let previous = '';
    let total = 0;
    let overLimit = 0;
    for (let step = 0; step < 24; step += 1) {
      messages.push({ role: 'assistant', content: `call ${step}` });
      messages.push({ role: 'user', content: `<tool_result name="read_file" ok="true">\n${String(step % 10).repeat(15000)}\n</tool_result>` });
      const fitted = agent.fitMessages(messages, budget, 1, memory).map((message) => `${message.role}:${message.content}`).join('\n');
      if (fitted.length > budget * 1.05) overLimit += 1;
      // What the engine must read at this step: everything after the part shared with the last step.
      total += fitted.length - sharedPrefix(previous, fitted);
      previous = fitted;
    }
    return { total, overLimit };
  };
  const before = reread(false);
  const after = reread(true);
  assert.equal(after.overLimit, 0, 'the messages still fit the context');
  assert.ok(after.total < before.total * 0.6, `re-read ${after.total} characters with headroom, ${before.total} without`);
  // Without memory (the skill question, and tests) the result is as before: just under the limit.
  const once = agent.fitMessages([...base, ...Array.from({ length: 10 }, (_, index) => ({ role: 'user', content: `<tool_result name="x" ok="true">\n${'y'.repeat(15000)}\n</tool_result> ${index}` }))], budget, 1);
  const size = once.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(size <= budget && size > budget * 0.8, `fitted to ${size}`);
  console.log(`context trimming re-reads less: ${Math.round(before.total / 1000)}k characters before, ${Math.round(after.total / 1000)}k now: OK`);
}

async function testSemanticSearch() {
  const { ProjectIndex, isClearMatch } = require('../electron/lib/rag.cjs');
  const { VectorStore, normalize, textHash } = require('../electron/lib/embeddings.cjs');
  const dir = path.join(root, 'rag-semantic');
  await ensureDir(path.join(dir, 'src'));
  await fsp.writeFile(path.join(dir, 'src', 'auth.js'), 'export function verifyCredentials(account, secret) {\n  return digest(secret) === account.hash;\n}\n');
  await fsp.writeFile(path.join(dir, 'src', 'cart.js'), 'export function addToCart(cart, item) {\n  cart.items.push(item);\n}\n');

  // Vectors survive a round trip to disk.
  const vectorFile = path.join(root, 'semantic.vec');
  await fsp.rm(vectorFile, { force: true });
  const saved = new VectorStore(vectorFile);
  saved.set(textHash('a'), normalize(Float32Array.from([1, 2, 3])));
  await saved.save();
  const loaded = new VectorStore(vectorFile);
  await loaded.load();
  assert.ok(Math.abs(loaded.get(textHash('a'))[2] - 3 / Math.sqrt(14)) < 1e-6);
  await fsp.rm(vectorFile, { force: true });

  // A fake engine: "login"/"password"/"accesso" point one way, carts and jokes elsewhere.
  const meaning = (text) => {
    const lower = text.toLowerCase();
    if (/credential|password|accesso|login/.test(lower)) return [1, 0.1, 0];
    if (/cart|carrello/.test(lower)) return [0, 1, 0.1];
    return [0.2, 0.2, 1];
  };
  let calls = 0;
  let paused = true;
  const engine = { device: 'CPU', embed: async (texts) => { calls += 1; return texts.map((text) => normalize(Float32Array.from(meaning(text)))); } };
  const index = new ProjectIndex({ root: dir });
  await index.refresh();
  const store = new VectorStore(vectorFile);
  await index.attachSemantic({ engine, store, shouldPause: () => paused });
  await sleep(100);
  assert.equal(calls, 0, 'nothing is encoded while the chat model answers');
  paused = false;
  await index.embedding;
  assert.deepEqual(index.semanticStats(), { embedded: 2, total: 2, running: false, device: 'CPU' });

  // An Italian question with no word in common with the code still finds it, and counts as clear.
  const found = await index.search('dove si controlla la password di accesso?');
  assert.equal(found[0].file, 'src/auth.js');
  assert.ok(found[0].similarity > 0.9);
  assert.ok(isClearMatch(found, 'dove si controlla la password di accesso?'));
  // Chat about nothing in the project does not.
  assert.ok(!isClearMatch(await index.search('tell me a joke'), 'tell me a joke'));

  // Passages already encoded are not encoded again, after a restart too.
  const before = calls;
  const again = new ProjectIndex({ root: dir });
  await again.refresh();
  await again.attachSemantic({ engine, store: new VectorStore(vectorFile) });
  await again.embedding;
  assert.equal(calls, before, 'vectors are read back from disk');

  // When the engine cannot run, word search still answers.
  const broken = new ProjectIndex({ root: dir });
  await broken.refresh();
  await broken.attachSemantic({ engine: { embed: async () => { throw new Error('no engine'); } }, store: new VectorStore(path.join(root, 'none.vec')) });
  await broken.embedding;
  assert.equal((await broken.search('addToCart item'))[0].file, 'src/cart.js');
  await fsp.rm(vectorFile, { force: true });
  console.log('meaning search (embeddings) with a fake engine: OK');
}

async function testSavedConversation() {
  const { LlamaManager, promptStateKey } = require('../electron/lib/llama.cjs');
  const { ChatMemory, GB } = require('../electron/lib/chatMemory.cjs');
  const dir = path.join(root, 'chat-memory');
  await fsp.rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
  await fsp.writeFile(path.join(dir, 'uma-last.bin'), 'old single-file save');
  // A fake engine that answers chats and slot saves/restores, and records them.
  const calls = [];
  let savedSize = 30 * GB;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const action = req.url.match(/action=(\w+)/)?.[1];
      if (action) calls.push(`${action} ${JSON.parse(body).filename}`);
      if (action === 'save') {
        fs.writeFileSync(path.join(dir, JSON.parse(body).filename), 'state');
        res.end(JSON.stringify({ n_saved: 1200, n_written: savedSize }));
      } else if (action === 'restore') {
        res.end(JSON.stringify({ n_restored: 1200 }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], timings: {} }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const settings = { chatMemoryLimitGB: 50, chatMemoryOverLimit: 'ask' };
  const questions = [];
  let answer = 'overwrite';
  let free = 500 * GB;
  const memory = new ChatMemory({
    dir,
    getSettings: () => settings,
    setOverLimit: async (mode) => { settings.chatMemoryOverLimit = mode; },
    ask: async (kind) => { questions.push(kind); return answer; },
    freeBytes: async () => free,
  });
  const manager = new LlamaManager({ store: {}, logsDir: root, chatMemory: memory });
  Object.assign(manager, { state: 'ready', child: {}, port: server.address().port, apiKey: 'k', promptCache: { key: 'model A, 16k', dirty: false, owner: null } });
  const say = async (conversationId) => {
    await manager.complete({ messages: [{ role: 'user', content: 'hi' }], conversationId });
    clearTimeout(manager.promptSaveTimer);
    await manager.savePrompt();
    await memory.enforcing;
  };
  try {
    await memory.load();
    assert.ok(!fs.existsSync(path.join(dir, 'uma-last.bin')), 'the old single save is removed');

    // Each chat is saved under its own name; nothing is saved while the engine is answering.
    await manager.complete({ messages: [], conversationId: 'chat-a' });
    manager.active = 1;
    await manager.savePrompt();
    assert.equal(calls.length, 0);
    manager.active = 0;
    clearTimeout(manager.promptSaveTimer);
    await manager.savePrompt();
    assert.deepEqual(calls, ['save chat-chat-a.bin']);

    // Going to another chat and back reads the first one back from disk.
    savedSize = 30 * GB;
    calls.length = 0;
    await say('chat-b');
    assert.deepEqual(calls, ['save chat-chat-b.bin']);
    // 60 GB is over the 50 GB limit: the user is asked once; "no" keeps 50 GB by dropping the oldest.
    assert.deepEqual(questions, ['limit']);
    assert.equal(settings.chatMemoryOverLimit, 'overwrite');
    assert.deepEqual((await memory.list()).chats.map((chat) => chat.id), ['chat-b']);
    calls.length = 0;
    await manager.complete({ messages: [], conversationId: 'chat-b' });
    assert.ok(!calls.some((call) => call.startsWith('restore')), 'the chat the engine holds is not read back');
    manager.promptCache.dirty = false;
    await manager.complete({ messages: [], conversationId: 'chat-a' });
    assert.ok(!calls.some((call) => call === 'restore chat-chat-a.bin'), 'a dropped memory is not read back');
    manager.promptCache.dirty = false;
    await manager.complete({ messages: [], conversationId: 'chat-b' });
    assert.ok(calls.includes('restore chat-chat-b.bin'));

    // "Keep saving": no limit any more.
    settings.chatMemoryOverLimit = 'continue';
    savedSize = 40 * GB;
    await say('chat-c');
    assert.equal((await memory.list()).chats.length, 2);
    assert.equal(questions.length, 1, 'asked only once');

    // Under 20 GB free: one warning; when a save would fill the disk, it is skipped.
    free = 15 * GB;
    savedSize = 1 * GB;
    await say('chat-d');
    assert.deepEqual(questions, ['limit', 'disk']);
    free = 1 * GB;
    calls.length = 0;
    await say('chat-e');
    assert.ok(!calls.some((call) => call.startsWith('save')), 'no save that would fill the disk');
    assert.deepEqual(questions, ['limit', 'disk'], 'the disk warning comes once');

    // Saved memory only fits an engine started the same way.
    assert.ok(await memory.find('chat-b', 'model A, 16k'));
    assert.equal(await memory.find('chat-b', 'model A, 8k'), null);
    const file = path.join(dir, 'index.json');
    const a = promptStateKey({ path: file }, ['-m', file, '-c', '16384', '-ctk', 'q8_0', '--port', '1'], 'srv');
    const b = promptStateKey({ path: file }, ['--rpc', 'x:1', '-m', file, '-c', '16384', '-ctk', 'q8_0', '--port', '2'], 'srv');
    const c = promptStateKey({ path: file }, ['-m', file, '-c', '8192', '-ctk', 'q8_0'], 'srv');
    assert.equal(a, b);
    assert.notEqual(a, c);

    // Deleting from Settings removes the file too.
    await memory.remove('chat-b');
    assert.ok(!fs.existsSync(path.join(dir, 'chat-chat-b.bin')));
    await memory.removeAll();
    assert.equal((await memory.list()).chats.length, 0);
  } finally {
    server.close();
  }
  console.log('chat memory: one save per chat, the 50 GB limit, the disk warnings: OK');
}

async function testChatMemoryFolder() {
  const { ChatMemory, GB } = require('../electron/lib/chatMemory.cjs');
  const { CATALOG } = require('../electron/lib/models.cjs');
  const base = path.join(root, 'chat-memory-move');
  await fsp.rm(base, { recursive: true, force: true });
  const first = path.join(base, 'appdata');
  const other = path.join(base, 'second disk', 'Uma LLM chat memory');
  await ensureDir(first);
  // A folder the user chose may hold their own files: Uma never removes those.
  await ensureDir(other);
  await fsp.writeFile(path.join(other, 'my notes.txt'), 'keep me');
  const memory = new ChatMemory({ dir: first, freeBytes: async () => 500 * GB });
  await memory.load();
  await fsp.writeFile(path.join(first, 'chat-a.bin'), 'state a');
  await memory.saved('a', { key: 'k', tokens: 10, bytes: 7 });
  const progress = [];
  await memory.moveTo(other, (value) => progress.push(value));
  assert.equal(memory.dir, other);
  assert.equal(await fsp.readFile(path.join(other, 'chat-a.bin'), 'utf8'), 'state a');
  assert.ok(!fs.existsSync(path.join(first, 'chat-a.bin')), 'moved, not copied');
  assert.deepEqual(progress.at(-1), { done: 7, total: 7 });
  const reopened = new ChatMemory({ dir: other });
  await reopened.load();
  assert.ok(await reopened.find('a', 'k'), 'found again in the new folder');
  assert.ok(fs.existsSync(path.join(other, 'my notes.txt')), "the user's own files stay");
  // Not enough room on the other disk: nothing moves.
  const small = new ChatMemory({ dir: other, freeBytes: async () => 1 * GB });
  await small.load();
  small.entries.get('a').bytes = 5 * GB;
  await assert.rejects(small.moveTo(path.join('Z:', 'x')), /.+/);
  // A folder that cannot be used (drive not connected): nothing is saved, nothing breaks.
  const gone = new ChatMemory({ dir: path.join(base, 'file-not-folder') });
  await fsp.writeFile(path.join(base, 'file-not-folder'), 'x');
  await gone.load();
  assert.ok(gone.unavailable);
  assert.equal(await gone.prepareSave('a'), null);
  assert.ok((await gone.list()).unavailable);

  // Models: every Qwen3.8 card can show all its versions; the big ones only through the version list.
  const qwen = CATALOG.filter((model) => model.family === 'Qwen3.8' && !model.modified);
  assert.deepEqual(qwen.map((model) => model.versionsRepo), ['unsloth/Qwen3.8-27B-GGUF', 'unsloth/Qwen3.8-Flash-Next-GGUF', 'unsloth/Qwen3.8-2.4T-A95B-GGUF']);
  // The abliterated and modified versions are separate cards, marked as such, with every version too.
  const modifiedQwen = CATALOG.filter((model) => model.family === 'Qwen3.8' && model.modified);
  assert.ok(modifiedQwen.some((model) => model.modified === 'abliterated') && modifiedQwen.every((model) => model.versionsRepo && model.tagline && model.description));
  assert.ok(qwen.filter((model) => !model.url).every((model) => model.versionsOnly));
  console.log('chat memory in another folder, Qwen3.8 versions: OK');
}

async function testUserMemory() {
  const { UserMemory, parseImport } = require('../electron/lib/userMemory.cjs');
  const { allowedTools } = require('../electron/lib/toolcall.cjs');
  // An answer pasted from another assistant: its framing and headings are left out.
  const chatgpt = "Sure! Here's everything I remember about you:\n\n## Work\n- **Name:** Marco\n- Works on a local LLM app called Uma (Electron + llama.cpp).\n* Prefers answers in Italian.\n1. Uses a gaming laptop with an RTX 2070 as a helper PC.\n- Prefers answers in italian\n\nLet me know if you want me to update anything!";
  assert.deepEqual(parseImport(chatgpt), [
    'Name: Marco',
    'Works on a local LLM app called Uma (Electron + llama.cpp).',
    'Prefers answers in Italian.',
    'Uses a gaming laptop with an RTX 2070 as a helper PC.',
  ]);
  // JSON exports of other local assistants, and plain lists of strings.
  assert.deepEqual(parseImport(JSON.stringify([{ id: 1, content: 'Likes short answers' }, { id: 2, content: 'Lives in Milan' }])), ['Likes short answers', 'Lives in Milan']);
  assert.deepEqual(parseImport(JSON.stringify({ memories: ['Has two PCs', 'Uses Windows 11'] })), ['Has two PCs', 'Uses Windows 11']);
  assert.deepEqual(parseImport('   '), []);

  const file = path.join(root, 'memory.json');
  await fsp.rm(file, { force: true });
  const memory = new UserMemory({ file });
  assert.equal(await memory.add(['Prefers answers in Italian.', 'Has two PCs'], 'ChatGPT'), 2);
  assert.equal(await memory.add('prefers answers in italian', 'you'), 0, 'the same fact is not added twice');
  const preview = await memory.preview(['Has two PCs', 'Likes tea']);
  assert.deepEqual(preview.map((item) => item.known), [true, false]);
  assert.ok((await memory.exportText()).includes('- Has two PCs'));

  // A chat keeps the memory it started with; what is saved later goes into the next message.
  const saved = [];
  const runner = new AgentRunner({ store: {}, workspace: {}, models: {}, llama: {}, conversations: { save: async (c) => saved.push(c.id) }, toolRunner: {}, send: () => {}, memory });
  const conversation = { id: 'c1', messages: [] };
  const first = await runner.memoryForChat(conversation, {});
  assert.ok(first.text.includes('- Prefers answers in Italian.') && !first.changes);
  assert.deepEqual(saved, ['c1'], 'the snapshot is saved with the chat');
  await sleep(5);
  const tools = new ToolRunner({ workspace: { root }, store: { getSettings: () => ({}) }, memory });
  const result = await tools.run('remember', { text: 'Wants Windows builds only for now' });
  assert.ok(result.ok);
  const later = await runner.memoryForChat(conversation, {});
  assert.equal(later.text, first.text, 'the instructions of the chat do not change');
  assert.ok(later.changes.includes('Wants Windows builds only for now'));
  const other = await runner.memoryForChat({ id: 'c2', messages: [] }, {});
  assert.ok(other.text.includes('Wants Windows builds only for now'), 'a new chat gets everything');
  const id = (await memory.list()).find((item) => item.text === 'Has two PCs').id;
  await memory.remove(id);
  assert.ok((await runner.memoryForChat(conversation, {})).changes.includes('Removed from memory'));
  assert.deepEqual(await runner.memoryForChat({ id: 'c3', messages: [] }, { useMemory: false }), { text: '', changes: '' });
  assert.ok(allowedTools({}).includes('remember'));
  assert.ok(!allowedTools({ useMemory: false }).includes('remember'));
  // Reloaded from disk.
  const again = new UserMemory({ file });
  assert.equal((await again.list()).length, 2);
  await fsp.rm(file, { force: true });
  console.log('memory: import from other assistants, per-chat memory, remember tool: OK');
}

async function testMoeCache() {
  const { buildServerArgs, moeCacheShare, DEFAULTS } = require('../electron/lib/modelSettings.cjs');
  const { LlamaManager } = require('../electron/lib/llama.cjs');
  const MiB = 1024 * 1024;
  // The arguments: every layer on the GPU, the routed experts in RAM, and the cache.
  const args = buildServerArgs('m.gguf', {}, 'cuda', { moeCache: { mib: 2048, share: 0.95 } });
  assert.equal(args[args.indexOf('-ngl') + 1], 'all');
  assert.ok(args.includes('-cmoe'));
  assert.equal(args[args.indexOf('--moe-cache-mib') + 1], '2048');
  assert.equal(args[args.indexOf('--moe-cache-cpu-share') + 1], '0.95');
  assert.ok(!args.includes('--fit-target'), 'not mixed with llama.cpp fitting, which leaves the cache no room');
  assert.ok(!buildServerArgs('m.gguf', { gpuOffload: false }, 'cuda', { moeCache: { mib: 2048, share: 0.95 } }).includes('-cmoe'));
  assert.equal(moeCacheShare('auto'), 0.95);
  assert.equal(moeCacheShare('mlock'), 0);

  // The plan: what is left of the GPU after everything but the experts, minus 1 GB to spare.
  // Shaped like LFM2-8B-A1B: 24 layers, 4,447 MiB of experts in a 4.8 GB file.
  const info = {
    nLayer: 24, nEmbd: 2048, nHead: 32, nHeadKv: 8, keyLength: 64, valueLength: 64, attentionLayers: 6, contextLength: 32768,
    layerBytes: Array.from({ length: 24 }, () => 200 * MiB), inputBytes: 130 * MiB, otherBytes: 130 * MiB,
    totalBytes: 5044 * MiB, expertCount: 32, expertBytes: 4447 * MiB,
  };
  const make = (freeGB) => new LlamaManager({ store: {}, logsDir: root, freeVram: async () => freeGB * 1024 ** 3 });
  const runtime = { backend: 'cuda', version: 'b12318' };
  const settings = { ...DEFAULTS, contextSize: 8192 };
  const plan = await make(3.5).planMoeCache(settings, info, runtime);
  assert.ok(plan && plan.mib >= 1800 && plan.mib <= 2400 && plan.mib % 64 === 0, `cache ${plan?.mib} MiB`);
  assert.equal(plan.share, 0.95);
  assert.ok((await make(64).planMoeCache(settings, info, runtime)).mib <= 4447, 'never larger than the experts');
  assert.equal(await make(1.2).planMoeCache(settings, info, runtime), null, 'no room left');
  assert.equal(await make(3.5).planMoeCache(settings, info, { backend: 'cuda', version: 'b12131' }), null, 'an engine without the cache');
  assert.equal(await make(3.5).planMoeCache({ ...settings, moeCache: 'off' }, info, runtime), null, 'switched off');
  assert.equal(await make(3.5).planMoeCache(settings, { ...info, expertCount: 0, expertBytes: 0 }, runtime), null, 'not a MoE model');
  assert.equal(await make(3.5).planMoeCache({ ...settings, gpuLayers: 20 }, info, runtime), null, 'layers set by hand');
  console.log('MoE cache plan and arguments: OK');
}

async function testBatchTuner() {
  const { BatchTuner } = require('../electron/lib/batchTuner.cjs');
  const { LlamaManager } = require('../electron/lib/llama.cjs');
  const file = path.join(root, 'batch-tuning.json');
  await fsp.rm(file, { force: true });
  const tuner = new BatchTuner({ file });
  const key = 'model A with the laptop';
  // Nothing known: the smallest size is measured first, and short replies do not count.
  assert.deepEqual(await tuner.choose(key), { size: 512, exploring: true });
  assert.equal(tuner.record(key, 512, 120, 900), false, 'too little new text to measure reading');
  tuner.record(key, 512, 2000, 20000);
  assert.deepEqual(await tuner.choose(key), { size: 512, exploring: true }, 'one reply is not enough');
  tuner.record(key, 512, 2000, 20000); // 100 tok/s
  assert.deepEqual(await tuner.choose(key), { size: 1024, exploring: true });
  tuner.record(key, 1024, 2000, 12500);
  tuner.record(key, 1024, 2000, 12500); // 160 tok/s
  assert.deepEqual(await tuner.choose(key), { size: 2048, exploring: true });
  tuner.record(key, 2048, 2000, 12200);
  tuner.record(key, 2048, 2000, 12200); // 164 tok/s: under 5% better than 1024, not worth the memory
  assert.deepEqual(await tuner.choose(key), { size: 1024, exploring: false });
  const report = await tuner.report(key);
  assert.equal(report.best, 1024);
  assert.ok(report.done);
  assert.deepEqual(report.sizes.map((item) => item.tokensPerSecond), [100, 160, 163.9]);
  // A size that does not load is never tried again; another model starts from nothing.
  tuner.fail('model B', 1024);
  assert.deepEqual(await tuner.choose('model B'), { size: 512, exploring: true });
  tuner.record('model B', 512, 4000, 40000);
  tuner.record('model B', 512, 4000, 40000);
  assert.deepEqual(await tuner.choose('model B'), { size: 2048, exploring: true });
  await tuner.saving;
  const reopened = new BatchTuner({ file });
  assert.deepEqual(await reopened.choose(key), { size: 1024, exploring: false }, 'kept between runs of the app');

  // The engine manager: readings are recorded for the size in use, and the key names model, helpers and engine.
  const manager = new LlamaManager({ store: {}, logsDir: root, batchTuner: tuner, network: { launchKey: () => 'laptop' } });
  const batchKey = manager.batchKey({ path: 'm.gguf', size: 5 }, { version: 'b12318' });
  assert.notEqual(batchKey, manager.batchKey({ path: 'm.gguf', size: 5 }, { version: 'b12400' }));
  manager.batchTune = { key: batchKey, size: 512, exploring: true };
  manager.noteReading({ prompt_n: 1500, prompt_ms: 10000 });
  assert.equal((await tuner.report(batchKey)).sizes[0].replies, 1);
  console.log('batch size tuning from measured reading speeds: OK');
}

async function main() {
  await fsp.rm(root, { recursive: true, force: true });
  await ensureDir(root);
  await testLegacyEncoding();
  await testWorkspaceStats();
  await testConversationIndex();
  await testDownloadStall();
  await testStreamBatching();
  await testSkillFormat();
  await testSkillRanking();
  await testSkillLibrary();
  testMainRamFirst();
  await testSpeedReadings();
  await testHelperBusyShare();
  await testPromptStaysReusable();
  testContextTrimmingKeepsThePrefix();
  await testMainPcReports();
  await testDraftModel();
  await testProjectSearch();
  await testSemanticSearch();
  await testSavedConversation();
  await testChatMemoryFolder();
  await testUserMemory();
  await testMoeCache();
  await testBatchTuner();
  console.log('\nAll review tests passed.');
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
