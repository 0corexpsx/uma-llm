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
const { ToolRunner, replaceInLegacyText, toolDocs: toolDocsFor } = require('../electron/lib/tools.cjs');
const { ConversationStore } = require('../electron/lib/conversations.cjs');
const { AgentRunner, systemPrompt, classifyTask, claims, CLAIMS_CHANGE_RE, toolsClaimed, saysMissing, asksToSee, says, REPLY_CHECKS } = require('../electron/lib/agent.cjs');
const { SkillStore, skillConnector, outsideService, parseSkill, rankSkills, isStrongMatch, worthAsking, clearSkillChoice, fitSkillBody } = require('../electron/lib/skills.cjs');
const { englishGist } = require('../electron/lib/gist.cjs');
const { SkillLibrary } = require('../electron/lib/skillLibrary.cjs');
const { allowedTools, toolCallSchema, extractToolCall, cutOffWrite } = require('../electron/lib/toolcall.cjs');
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

  // Asked for by its whole name, the skill is loaded with no question at all.
  let run = await chat(['Here is the email.'], 'write a cold email to a potential customer');
  assert.equal(run.calls.length, 1, 'no extra reply to choose the skill');
  assert.match(run.calls[0].messages.at(-1).content, /Steps for cold-email/);
  // A request that only comes close is put to the model, with the matches.
  run = await chat(['{"skill":"cold-email"}', 'Here is the email.'], 'write an email to a potential customer for our sales outreach');
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

  // Skills that work only through a connector of other assistants (882 of the real library's 6,236
  // are "Automate X via Rube MCP (Composio)": every step calls RUBE_SEARCH_TOOLS, which Uma does not
  // have). The header says so in two spellings; where it is silent the description or the steps do.
  // A skill ABOUT connectors (building or checking a server) needs none.
  assert.equal(skillConnector('name: a\nrequires:\n  mcp: [rube]\n'), 'rube');
  assert.equal(skillConnector('name: a\nrequires:\n  mcp:\n    - rube\n'), 'rube');
  assert.equal(skillConnector('name: a', 'Automate Ably tasks via Rube MCP (Composio). Always search tools first.'), 'rube');
  assert.equal(skillConnector('name: a', "Automate Slack workspace operations through Composio's Slack toolkit."), 'rube');
  assert.equal(skillConnector('name: a', 'Automate Box.', 'Call `RUBE_SEARCH_TOOLS` first.'), 'rube');
  assert.equal(skillConnector('name: a\nrequires: terminal\n', 'Audit MCP servers for tool poisoning.'), '');
  assert.equal(skillConnector('name: a', 'Abuses delegation with Impacket and Rubeus.'), '', '"Rubeus" is not Rube');
  assert.equal(parseSkill('---\nname: ably-automation\ndescription: Automate Ably tasks.\nrequires:\n  mcp: [rube]\n---\nSteps.').connector, 'rube');
  // Other connectors (110 more in the real library), each said in its own way.
  for (const [header, description, body, connector] of [
    ['name: flowstudio-debug', 'Debug failing Power Automate cloud flows using the FlowStudio MCP server.', '', 'FlowStudio'],
    ['name: apple-notes-search', "Search the user's own Apple Notes via the apple-notes MCP server.", '', 'apple-notes'],
    ['name: altorank', 'Run AltoRank through its hosted MCP server: audits and keyword research.', '', 'mcp'],
    ['name: browser-testing', 'Test browser apps with Chrome DevTools MCP by inspecting the live DOM.', '', 'Chrome DevTools'],
    ['name: serply-search-mcp', 'Search Google and Bing, and read public pages.', '', 'mcp'],
    ['name: datawebot', 'Find products for sale across online shops.', 'Requires the hosted datawebot MCP.\n\nSteps.', 'datawebot'],
    ['name: busabase', 'Manage Busabase workspace records.', '## Before you start\n- An authorized Busabase MCP server must already be connected.', 'Busabase'],
    ['name: aident-loadout', 'Run multi-step work across connected apps.', 'Tools come from the hosted `aident` MCP server.', 'aident'],
    ['name: jira-expert', 'Jira setup and queries: JQL, workflows, dashboards.', 'Call mcp__atlassian__search, then mcp__atlassian__get_issue, then mcp__atlassian__update_issue.', 'atlassian'],
    ['name: github-issues\nallowed-tools: mcp__github__create_issue', 'Create and manage GitHub issues.', 'Steps.', 'mcp'],
    // Not through a connector: about one, another way offered, none needed, or named once in passing.
    ['name: mcp-builder', 'Build an MCP server in Python or TypeScript, with tools and tests.', 'Steps about MCP.', ''],
    ['name: aws-mcp-setup', 'Configure AWS MCP servers for documentation search.', '', ''],
    ['name: agent-qa', 'Create and run Agent QA tests through MCP or CLI.', '', ''],
    ['name: cooper-email', 'Give an agent its own inbox: send and receive over MCP or HTTP.', '', ''],
    ['name: gmail-automation', 'Lightweight Gmail integration with standalone OAuth. No MCP server required.', '', ''],
    ['name: apify-scraper', 'Search and export job postings with an Apify Actor.', '- Apify CLI, or the Apify MCP server.\n| mcpConnector | Needs an MCP connector the user authorized |', ''],
    ['name: daily-report', 'Scrape a preset URL list and write a daily report.', 'If it is there, mcp__chrome__open can render the page.', ''],
    ['name: ios-review', 'Review an iPhone app screen.', 'It needs the optional UXKIN MCP only for reference screens.', ''],
  ]) assert.equal(skillConnector(header, description, body), connector, `${header.split('\n')[0]}: ${description}`);
  // A request to act IN an online service (Uma cannot reach it), as against one about a service.
  for (const [text, service] of [
    ['post the message "hello team" in my Slack channel #general', 'Slack'], ['create a Jira ticket for the bug in calc.js', 'Jira'], ['add this to our Notion', 'Notion'],
    ['send it to the team on Slack', 'Slack'], ['schedule a meeting in Google Calendar for Monday', 'Google Calendar'], ['open an Asana task for this', 'Asana'],
    ['write a Slack bot in Python', null], ['how does the Jira API work?', null], ['make the page look like Notion', null], ['build a Shopify theme', null],
    ['add a function to calc.js that posts the result to Slack', null], ['write a script to send messages to my Slack channel', null], ['create a webhook for our Jira', null],
    ['explain what Slack is', null], ['fix the bug in calc.js', null], ['create a ticket system for my site', null], ['update the Trello-style board component', null],
  ]) assert.equal(outsideService(text)?.name || null, service, text);
  // Such a skill stays in the library's list, marked, and is never given to the model.
  const linkedDir = path.join(dir, 'linked');
  const linked = [
    { name: 'ably-automation', description: 'Automate Ably tasks via Rube MCP (Composio).', risk: 'critical', tags: [], files: [], connector: 'rube' },
    { name: 'ably-notes', description: 'Write notes about Ably channels in a file.', risk: 'safe', tags: [], files: [] },
  ];
  for (const entry of linked) {
    await ensureDir(path.join(linkedDir, 'skills', entry.name));
    await fsp.writeFile(path.join(linkedDir, 'skills', entry.name, 'SKILL.md'), `---\nname: ${entry.name}\ndescription: ${entry.description}\n${entry.connector ? 'requires:\n  mcp: [rube]\n' : ''}---\nSteps.`);
  }
  await fsp.writeFile(path.join(linkedDir, 'index.json'), JSON.stringify({ version: 1, skills: linked }));
  const linkedLibrary = new SkillLibrary({ dir: linkedDir });
  page = await linkedLibrary.search({});
  assert.deepEqual([page.librarySize, page.usableSize], [2, 1]);
  assert.deepEqual(page.items.map((item) => [item.name, item.connector]), [['ably-automation', 'rube'], ['ably-notes', '']]);
  assert.deepEqual((await linkedLibrary.search({ risk: 'connector' })).items.map((item) => item.name), ['ably-automation']);
  const linkedStore = new Store(path.join(dir, 'linked-data'));
  await linkedStore.init();
  const linkedGlobal = path.join(dir, 'linked-global');
  const linkedSkills = new SkillStore({ globalDir: linkedGlobal, store: linkedStore, library: linkedLibrary });
  assert.deepEqual((await linkedSkills.enabled('')).map((skill) => skill.name), ['ably-notes'], 'the model is offered only what it can use');
  await assert.rejects(linkedSkills.load('ably-automation', ''), /cannot be used here: it works only through the Rube \(Composio\) connector[\s\S]*Uma has no connectors/);
  assert.equal((await linkedSkills.load('ably-notes', '')).name, 'ably-notes');
  // Installed (to read or edit it), it is listed with its connector and still not given to the model.
  await linkedLibrary.install('ably-automation', linkedGlobal);
  linkedSkills.invalidate();
  assert.deepEqual((await linkedSkills.list('')).map((skill) => [skill.name, skill.connector]), [['ably-automation', 'rube']]);
  assert.deepEqual((await linkedSkills.enabled('')).map((skill) => skill.name), ['ably-notes']);
  await assert.rejects(linkedSkills.load('ably-automation', ''), /works only through the Rube \(Composio\) connector/);

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

async function testSkillWorkflow() {
  // A request in Italian or Spanish is the same kind of request as its English form. Before, each of
  // these was taken for small talk: no skill was offered and the file tools were taken away.
  const kind = (text) => {
    const task = classifyTask(text);
    return [Boolean(task.agentic), Boolean(task.wantsEdit), Boolean(task.asksOnly), Boolean(task.isContinue)].join();
  };
  const pairs = [
    ['make a website for my bakery', 'crea un sito web per la mia pizzeria'],
    ['make a website for my bakery', 'crea un sitio web para mi panadería'],
    ['fix the bug in the login form', 'correggi il bug nel form di login'],
    ['add a contact page to the site', 'aggiungi una pagina contatti al sito'],
    ['write the tests for this file', 'scrivi i test per questo file'],
    ['explain this project', 'spiegami questo progetto'],
    ['did you fix the bug in main.cpp?', 'hai corretto il bug in main.cpp?'],
    ['how do I create a website?', 'come si crea un sito web?'],
    ['what is the capital of France?', 'qual è la capitale della Francia?'],
    ['can you add a button to my site?', 'puoi aggiungere un pulsante al mio sito?'],
    ['tell me a joke', 'raccontami una barzelletta'],
    ['thanks, that works', 'grazie, ora funziona'],
    ['continue', 'continua'],
  ];
  for (const [english, other] of pairs) assert.equal(kind(other), kind(english), `"${other}" is read like "${english}"`);
  assert.equal(kind('crea un sito web per la mia pizzeria'), 'true,true,false,false');
  // English, and a language Uma has no words for (Russian, Korean), is left exactly as it was written.
  for (const text of ['fix the bug in the login form', 'How do I come up with a plan?', 'make an uno card game', 'ai agent builder', 'compute a modulo b', 'что это за проект?', '이 프로젝트는 무엇입니까?', '']) {
    assert.equal(englishGist(text), text);
  }
  // File names and paths keep their spelling.
  assert.equal(englishGist('correggi il bug in src/Pagina.jsx'), 'fix the bug in src/Pagina.jsx');
  assert.equal(englishGist("cos'è questo progetto?"), 'what is this project?');

  // Which skill is offered first.
  const library = (name, description) => ({ name, description, source: 'library', meta: { tags: [], category: '' } });
  const pool = [
    { name: 'fix-bug', description: 'Find and fix a bug, crash or error in existing code.', source: 'global', meta: {} },
    library('fix', 'Diagnose and fix a failing Playwright test.'),
    library('bug-hunter', 'Systematically finds and fixes bugs.'),
    library('settings', 'Old name of project-settings.'),
    library('slack-automation', 'Automate Slack tasks via Rube MCP (Composio).'),
    library('slack-messages', 'Write Slack posts for a team channel.'),
    ...makeSkills(200).map((skill) => ({ ...skill, source: 'library' })),
  ];
  assert.equal(rankSkills(pool, 'fix the bug in the login form', 3)[0].skill.name, 'fix-bug', 'the skill written for Uma goes first');
  assert.equal(rankSkills(pool, englishGist('correggi il bug nel form di login'), 3)[0].skill.name, 'fix-bug', 'the same in Italian');
  // Asked for word by word, one of Uma's own skills is chosen without a question to the model;
  // a library skill, a partial match or a close second is still put to the model.
  assert.equal(clearSkillChoice(rankSkills(pool, 'fix the bug in the login form', 8))?.name, 'fix-bug');
  assert.equal(clearSkillChoice(rankSkills(pool, englishGist('correggi il bug nel form di login'), 8))?.name, 'fix-bug');
  assert.equal(clearSkillChoice(rankSkills(pool, 'hunt the bug down', 8)), null, 'a library skill is not chosen unasked');
  assert.equal(clearSkillChoice(rankSkills(pool, 'fix the layout', 8)), null, 'half of a name is not enough');
  assert.equal(clearSkillChoice(rankSkills([...pool, { name: 'bug-fix', description: 'Fix a bug.', source: 'global', meta: {} }], 'fix the bug', 8)), null, 'two skills as close as each other');
  assert.equal(clearSkillChoice([]), null);
  assert.equal(clearSkillChoice(rankSkills(pool, 'use the bug hunter skill on this', 8))?.name, 'bug-hunter', 'named as a skill, a library skill is loaded too');
  // What is put to the model when it is asked: a wrong skill costs more than none, and a real 9B
  // model picked loosely matched ones (a Swift skill for JavaScript tests).
  const asked = (text, agentic = true) => rankSkills([...pool,
    library('write-swift', 'Write and review modern Swift code and tests.'),
    library('landing-page-generator', 'Generates landing pages with React and a button.'),
    library('docker-compose', 'Define and run multi-container Docker applications.'),
    library('commit', 'Use for every request to commit changes or draft a commit message.'),
    library('scan', 'Scans the codebase to generate a project document.'),
    library('assay', 'Write questions and answers that test a page of text.'),
  ], text, 8).filter((entry) => worthAsking(entry, { agentic })).map((entry) => entry.skill.name);
  assert.deepEqual(asked('write the tests for calc.js'), [], 'half of a library skill\'s name is not enough');
  assert.deepEqual(asked('make a web page with a title and a button'), []);
  assert.deepEqual(asked('write a docker compose file for my app'), ['docker-compose']);
  assert.deepEqual(asked('commit my changes with a good message'), ['commit'], 'a one-word name, with its description');
  assert.deepEqual(asked('scan my server for open ports'), []);
  assert.deepEqual(asked('write a page with questions and answers about cats'), [], 'a one-word name that is not in the request');
  assert.deepEqual(asked('fix the bug in the login form'), ['fix-bug']);
  assert.deepEqual(asked('be a bug hunter on this module'), ['bug-hunter']);
  // A one-word name is an ordinary word of a request, not the skill being named.
  const settings = rankSkills(pool, 'add a dark mode toggle to the settings page', 8).find((entry) => entry.skill.name === 'settings');
  assert.equal(isStrongMatch(settings), false);
  assert.equal(rankSkills(pool, 'use the settings skill', 3)[0].skill.name, 'settings');
  // A skill that drives another assistant's connectors stays findable, behind one that can work here.
  assert.deepEqual(rankSkills(pool, 'automate my slack posts', 2).map((entry) => entry.skill.name), ['slack-messages', 'slack-automation']);
  assert.equal(rankSkills(pool, 'use slack automation', 2)[0].skill.name, 'slack-automation', 'named outright, it is still the first');

  // A skill longer than the context allows keeps its steps and the part the request is about.
  const filler = (topic, count) => Array.from({ length: count }, (_, index) => `${topic} detail ${index}: some text that explains one more thing about it.`);
  const body = [
    '# Deploy helper', 'Helps to ship a web app.', '',
    '## When to use', ...filler('Usage', 30), '',
    '## Steps', '1. Build the image.', '2. Push it.', '',
    '## Kubernetes', ...filler('Cluster', 60), '',
    '## Docker', 'Write the Dockerfile first.', ...filler('Image', 6), '',
    '## References', ...filler('Link', 40),
  ].join('\n');
  const fitted = fitSkillBody(body, 1500, 'write a dockerfile for my app', 5);
  assert.ok(fitted.text.length <= 1500, `${fitted.text.length} characters`);
  assert.match(fitted.text, /## Steps\n1\. Build the image\.\n2\. Push it\./);
  assert.match(fitted.text, /## Docker\nWrite the Dockerfile first\./);
  assert.doesNotMatch(fitted.text, /## References|## Kubernetes/);
  assert.match(fitted.text, /\[Left out: .*"Kubernetes" \(lines \d+-\d+\)/);
  // The lines named are the lines of SKILL.md, header included.
  const fileLines = ['---', 'name: deploy-helper', 'description: d', '---', ...body.split('\n')];
  for (const item of fitted.left) {
    const heading = item.heading.match(/^"(.*)"$/)?.[1];
    if (heading) assert.equal(fileLines[item.start - 1], `## ${heading}`);
  }
  assert.equal(parseSkill(fileLines.join('\n')).bodyLine, 5);
  assert.deepEqual(fitSkillBody('Short steps.', 1500, 'anything'), { text: 'Short steps.', left: [] });
  // Without headings there is nothing to choose between: the room is used from the start.
  const flat = fitSkillBody(filler('Plain', 200).join('\n'), 1500, '', 1);
  assert.ok(flat.text.length > 1000 && flat.text.length <= 1500, `${flat.text.length} characters`);

  // Through the agent, with a library: an Italian task is asked about its skill, and the long skill
  // arrives fitted, with the part about the request.
  const dir = path.join(root, 'workflow');
  await fsp.rm(dir, { recursive: true, force: true });
  const libraryDir = path.join(dir, 'library');
  const siteBody = [
    '# Restaurant website', 'Builds a small site for a place that serves food.', '',
    '## Background', ...filler('History', 80), '',
    '## Steps', '1. Create index.html with the menu.', '2. Add the opening hours.', '',
    '## Hosting', ...filler('Server', 80),
  ].join('\n');
  const entries = [
    { name: 'pizzeria-website', description: 'Create a website for a restaurant or pizzeria.', risk: 'safe', tags: [], files: [] },
    ...makeSkills(60).map((skill) => ({ name: skill.name, description: skill.description, risk: 'unknown', tags: [], files: [] })),
  ];
  for (const entry of entries) {
    await ensureDir(path.join(libraryDir, 'skills', entry.name));
    await fsp.writeFile(path.join(libraryDir, 'skills', entry.name, 'SKILL.md'), `---\nname: ${entry.name}\ndescription: ${entry.description}\n---\n${entry.name === 'pizzeria-website' ? siteBody : 'Steps.'}`);
  }
  await fsp.writeFile(path.join(libraryDir, 'index.json'), JSON.stringify({ version: 1, skills: entries }));
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  await store.updateSettings({ allowEdits: true });
  const workspaceDir = path.join(dir, 'workspace');
  await ensureDir(workspaceDir);
  const workspace = new Workspace({ root: workspaceDir, trash: () => {} });
  await workspace.init();
  const skillStore = new SkillStore({ globalDir: path.join(dir, 'global'), store, library: new SkillLibrary({ dir: libraryDir }) });
  const first = await skillStore.enabled(workspaceDir);
  assert.equal(first.length, 61);
  assert.equal((await skillStore.enabled(workspaceDir))[0], first[0], 'the library is prepared once, not for every message');
  const tools = new ToolRunner({ workspace, store, onChanged: () => {}, skills: skillStore });
  const conversations = new ConversationStore(path.join(dir, 'conversations'));
  await conversations.init();
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
        yield { type: 'text', text: calls.length === 1 ? '{"skill":"pizzeria-website"}' : 'Ecco fatto.' };
      },
    },
    send: (_channel, payload) => { if (payload?.type === 'assistant-end') done(payload.message); },
  });
  await agent.send(conversation.id, 'crea un sito web per la mia pizzeria');
  await finished;
  assert.match(calls[0].messages.at(-1).content, /does one of these skills fit this task\?\n- pizzeria-website:/, 'the Italian request is asked about its skill');
  const request = calls[1].messages.at(-1).content;
  assert.ok(request.startsWith('crea un sito web per la mia pizzeria'), 'the model gets the user\'s own words');
  const loaded = request.match(/<skill name="pizzeria-website">\n([\s\S]*)\n<\/skill>/)[1];
  assert.match(loaded, /## Steps\n1\. Create index\.html with the menu\./);
  assert.match(loaded, /\[Left out: .*\(lines \d+-\d+\)/);
  assert.match(loaded, /"start_line":\d+,"max_lines":\d+/);
  assert.doesNotMatch(loaded, /truncated\]/, 'fitted, not cut at a fixed point');
  assert.ok(loaded.length <= 4423, `${loaded.length} characters for an 8k context`);
  console.log('Italian and Spanish requests, skill order, and long skills fitted by section: OK');
}

function testPromptSize() {
  const prompt = (settings, model = { name: 'Mock' }) => systemPrompt({ workspaceSummary: 'W', settings, model, skills: [] });
  // With the settings Uma starts with, the model reads about the tools it has and no others.
  const first = prompt({ allowEdits: true });
  for (const tool of ['list_files', 'read_file', 'write_file', 'replace_in_file', 'search_files']) assert.match(first, new RegExp(`^\\d+\\. ${tool} `, 'm'), tool);
  for (const tool of ['run_command', 'web_search', 'fetch_url', 'delete_file', 'look_at_screen', 'look_at_page', 'mouse', 'keyboard', 'click_text']) {
    assert.doesNotMatch(first, new RegExp(`^\\d+\\. ${tool} `, 'm'), `${tool} is off, so it is not described`);
  }
  assert.match(first, /terminal commands are NOT allowed/, 'what is off is still named, with where to turn it on');
  assert.match(first, /Settings → Agent permissions/);
  // Each permission adds its own tools and rules.
  const everything = prompt({ allowEdits: true, allowDelete: true, allowShell: true, allowInternet: true, allowScreen: true, allowInput: true }, { name: 'Mock', mmproj: {} });
  for (const tool of ['run_command', 'web_search', 'fetch_url', 'delete_file', 'look_at_screen', 'look_at_page', 'mouse', 'keyboard', 'click_text', 'remember']) {
    assert.match(everything, new RegExp(`^\\d+\\. ${tool} `, 'm'), tool);
  }
  assert.doesNotMatch(prompt({ allowEdits: true, allowInput: true }), /^\d+\. mouse /m, 'no clicking by position for a model that cannot see');
  assert.doesNotMatch(prompt({}), /^\d+\. write_file /m);
  // The size is kept: every line here is a line less of the user's files in a small context.
  // (6,600 until save_document, the tool that makes PDF and Word files, was added.)
  assert.ok(first.length < 6900, `the starting prompt grew to ${first.length} characters`);
  assert.ok(everything.length < 11900, `the full prompt grew to ${everything.length} characters`);
  console.log(`the fixed prompt describes only what is allowed (${first.length} characters to start with, ${everything.length} with everything on): OK`);
}

// Seeing as an assistant that works by screenshots does: a closer look at one part of the screen
// (zoom), and a new picture of the screen back with every mouse or keyboard action. The screen and
// the mouse are stand-ins here; the real cut-out is checked in scripts/ui-zoom-test.cjs.
async function testSeeing() {
  const dir = path.join(root, 'seeing');
  await fsp.rm(dir, { recursive: true, force: true });
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  await store.updateSettings({ allowEdits: true, allowScreen: true, allowInput: true });
  const workspaceDir = path.join(dir, 'workspace');
  await ensureDir(workspaceDir);
  const workspace = new Workspace({ root: workspaceDir, trash: () => {} });
  await workspace.init();
  const shots = [];
  const capture = async (options = {}) => {
    shots.push(options);
    const zoom = options.zoom ? options.zoom.map(Number) : null;
    return {
      name: zoom ? 'part of the whole screen' : options.window ? `the window "${options.window}"` : 'the whole screen',
      width: 1280, height: 720, image: 'data:image/jpeg;base64,AAAA', thumbnail: 'data:image/jpeg;base64,BBBB',
      ...(zoom ? { zoom: { left: zoom[0], top: zoom[1], right: zoom[2], bottom: zoom[3], times: 2.1 } } : {}),
    };
  };
  const acts = [];
  const input = {
    act: async (action, args) => { acts.push([action, args]); return `${action} done`; },
    clickItem: async (text) => ({ name: text, kind: 'Button', pictureX: 10, pictureY: 20 }),
    findItems: async () => [],
  };
  const tools = new ToolRunner({ workspace, store, onChanged: () => {}, capture, input });

  // A closer look: the part is asked for by its corners in the picture the model was given.
  let result = await tools.run('look_at_screen', { zoom: [300, 200, 900, 600] });
  assert.equal(result.ok, true, result.output);
  assert.deepEqual(shots.at(-1).zoom, [300, 200, 900, 600]);
  assert.match(result.output, /closer picture of the part from \(300, 200\) to \(900, 600\) of the whole screen is attached, about 2\.1 times larger/);
  assert.match(result.output, /positions in it are not mouse positions[\s\S]*300 \+ x\/2\.1 and 200 \+ y\/2\.1/);
  assert.equal(result.data.zoomed, true);
  assert.equal(result.data.image, 'data:image/jpeg;base64,AAAA');
  // Small models write it in other shapes too.
  await tools.run('look_at_screen', { zoom: '300, 200, 900, 600' });
  assert.deepEqual(shots.at(-1).zoom, ['300', '200', '900', '600']);
  // The corners are positions in the picture last looked at, so that picture is the one cut from,
  // whatever window is named with them (a real model named a window with the whole screen's positions).
  await tools.run('look_at_screen', {});
  await tools.run('look_at_screen', { zoom: { left: 1, top: 2, right: 300, bottom: 400 }, window: 'Brave' });
  assert.deepEqual([shots.at(-1).zoom, shots.at(-1).window], [[1, 2, 300, 400], ''], 'the last look was at the whole screen');
  await tools.run('look_at_screen', { window: 'Brave' });
  await tools.run('look_at_screen', { zoom: [1, 2, 300, 400] });
  assert.equal(shots.at(-1).window, 'Brave', 'after a look at a window, a closer look is of that window');
  result = await tools.run('look_at_screen', {});
  assert.equal(shots.at(-1).zoom, null);
  assert.match(result.output, /A screenshot of the whole screen \(1280×720\) is attached/);
  assert.match(toolDocsFor(['look_at_screen']), /"zoom":\[left,top,right,bottom\]/);
  assert.deepEqual(toolCallSchema(['look_at_screen']).anyOf[0].properties.arguments.properties.zoom, { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 });

  // Every action comes back with what the screen shows now, when the model can see.
  let before = shots.length;
  result = await tools.run('mouse', { action: 'click', x: 5, y: 5 }, { picture: true });
  assert.equal(result.ok, true, result.output);
  assert.equal(shots.length, before + 1);
  assert.deepEqual(shots.at(-1), { width: 640 }, 'the whole screen, small');
  assert.equal(result.data.screenAfter, true);
  assert.equal(result.data.image, 'data:image/jpeg;base64,AAAA');
  assert.match(result.output, /A small picture of the whole screen as it is now is attached: check in it[\s\S]*too small to read text in or to take mouse positions from/);
  assert.doesNotMatch(result.output, /look_at_screen to check/);
  for (const [name, args] of [['keyboard', { text: 'hi', keys: 'enter' }], ['focus_window', { window: 'Brave' }], ['click_text', { text: 'OK' }], ['wait', { seconds: 0.2 }]]) {
    result = await tools.run(name, args, { picture: true });
    assert.equal(result.data.screenAfter, true, name);
  }
  // A model that cannot see is told to check another way, and no picture is taken for it.
  before = shots.length;
  result = await tools.run('mouse', { action: 'click', x: 5, y: 5 }, { picture: false });
  assert.equal(shots.length, before);
  assert.equal(result.data.screenAfter, undefined);
  assert.match(result.output, /Look at the whole screen with look_at_screen to check the result/);
  // Nor when seeing the screen is turned off.
  await store.updateSettings({ allowScreen: false });
  result = await tools.run('keyboard', { text: 'hi' }, { picture: true });
  assert.equal(shots.length, before);
  assert.equal(result.data.screenAfter, undefined);
  await store.updateSettings({ allowScreen: true });

  // Through the agent, with a model that has a vision file: the picture travels with the action's
  // result, and the next click needs no look in between. (A claim that something is now playing or
  // opened is still checked with a look of its own: test-agent.cjs.)
  const conversations = new ConversationStore(path.join(dir, 'conversations'));
  await conversations.init();
  const conversation = await conversations.create();
  const calls = [];
  const script = [
    '```tool\n{"name":"look_at_screen","arguments":{}}\n```',
    '```tool\n{"name":"mouse","arguments":{"action":"click","x":100,"y":100}}\n```',
    '```tool\n{"name":"click_text","arguments":{"text":"OK"}}\n```',
    '```tool\n{"name":"mouse","arguments":{"action":"click","x":300,"y":200}}\n```',
    'The OK button is pressed and its window is gone.',
  ];
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const agent = new AgentRunner({
    store, workspace, conversations, toolRunner: tools,
    models: { resolveActive: async () => ({ id: 'mock', name: 'Mock', family: 'Test', mmproj: 'vision.gguf' }) },
    llama: {
      async ensureServer() {},
      async *streamChat(request) {
        // Counted now: a picture is taken off its message once it has been sent.
        calls.push({ pictures: request.messages.filter((item) => Array.isArray(item.content) && item.content.some((part) => part.type === 'image_url')).length });
        yield { type: 'text', text: script[Math.min(calls.length - 1, script.length - 1)] };
        yield { type: 'finish', reason: 'stop' };
      },
    },
    send: (_channel, payload) => { if (payload?.type === 'assistant-end') done(payload.message); },
  });
  await agent.send(conversation.id, 'click the OK button in the window that is open');
  const message = await finished;
  const blocks = message.blocks.filter((block) => block.type === 'tool');
  // A click by name needs no look in between; a click by position does, at full size (the small picture is no map).
  assert.deepEqual(blocks.map((block) => [block.name, block.status]), [['look_at_screen', 'done'], ['mouse', 'done'], ['click_text', 'done'], ['mouse', 'error']]);
  assert.match(blocks[3].error, /have not looked at the whole screen since the last action/);
  assert.equal(blocks[1].sawScreen, true);
  assert.equal(blocks[1].image, 'data:image/jpeg;base64,BBBB', 'the user sees the small picture too');
  const pictured = calls.map((request) => request.pictures);
  // The small pictures stay with their steps (taking one out makes the engine read everything again).
  assert.deepEqual(pictured.slice(0, 4), [0, 1, 1, 2], `the picture goes to the model with the result, and stays (${pictured.join()})`);
  assert.match(message.content, /The OK button is pressed/);
  console.log('zoom, and a picture of the screen after each action: OK');
}

// PDF and Word documents made by Uma itself (save_document): Markdown read into parts, a .docx
// written from them and read back with the reader Uma uses for attachments, and the tool's rules.
// (The PDF needs the app's own window: scripts/ui-document-test.cjs, part of npm run test:ui.)
async function testDocuments() {
  const { parseMarkdown, toHtml, titleOf } = require('../electron/lib/markdown.cjs');
  const { toDocx } = require('../electron/lib/docx.cjs');
  const { extractDocument, readZipEntry } = require('../electron/lib/attachments.cjs');
  const text = [
    '# Quarterly report', '', 'An **introduction** with *italic*, `code`, a [link](https://example.com) and snake_case_name.', 'Second line of the same paragraph.', '',
    '## Results', '', '1. First numbered item', '2. Second numbered item', '   - a bullet under it', '   - another & one <tag>', '3. Third', '', '- Apples', '- Pears', '',
    '| Month | Sales |', '| --- | ---: |', '| January | 1,200 |', '| February | **950** |', '', '> A quoted line.', '', '```js', 'function add(a, b) {', '  return a + b;', '}', '```', '', '---', '', 'Città, naïve, 日本語.',
  ].join('\n');
  const parts = parseMarkdown(text);
  const shape = (part) => `${part.type}${part.level || ''}${part.items ? `(${part.items.map((item) => `${item.level}${item.ordered ? 'n' : 'b'}`).join(',')})` : ''}${part.rows ? `(${part.header.length}x${part.rows.length})` : ''}`;
  assert.deepEqual(parts.map(shape), ['heading1', 'paragraph', 'heading2', 'list(0n,0n,1b,1b,0n)', 'list(0b,0b)', 'table(2x2)', 'quote', 'code', 'rule', 'paragraph']);
  assert.equal(titleOf(parts), 'Quarterly report');
  const intro = parts[1].runs;
  assert.deepEqual(intro.filter((run) => run.bold || run.italic || run.code || run.link).map((run) => [run.text, run.bold ? 'b' : run.italic ? 'i' : run.code ? 'c' : run.link]), [['introduction', 'b'], ['italic', 'i'], ['code', 'c'], ['link', 'https://example.com']]);
  assert.ok(intro.some((run) => run.text.includes('snake_case_name')), 'an underscore inside a word is not emphasis');
  assert.equal(parts[7].text, 'function add(a, b) {\n  return a + b;\n}', 'code keeps its lines and spaces');
  // The page a PDF is printed from: nothing of the text can break out of it.
  const html = toHtml(parts);
  assert.match(html, /<h1>Quarterly report<\/h1>/);
  assert.match(html, /<ol><li>First numbered item<\/li><li>Second numbered item<ul><li>a bullet under it<\/li><li>another &amp; one &lt;tag&gt;<\/li><\/ul><\/li><li>Third<\/li><\/ol>/);
  assert.match(html, /<table><thead><tr><th>Month<\/th><th>Sales<\/th><\/tr><\/thead>/);
  assert.match(toHtml(parseMarkdown('A [bad](javascript:run) link and <script>x</script>.')), /A bad link and &lt;script&gt;x&lt;\/script&gt;\./, 'no script, and no link that runs one');

  // The Word file: a zip whose parts are XML, with every word of the text in it once.
  const docx = toDocx(parts);
  assert.equal(docx.subarray(0, 2).toString('latin1'), 'PK');
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) {
    assert.match(readZipEntry(docx, name).toString('utf8'), /^<\?xml version="1\.0"/, name);
  }
  const body = readZipEntry(docx, 'word/document.xml').toString('utf8');
  assert.match(body, /<w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">Quarterly report<\/w:t>/);
  assert.match(body, /<w:rPr><w:b\/><w:bCs\/><\/w:rPr><w:t xml:space="preserve">introduction<\/w:t>/);
  assert.match(body, /another &amp; one &lt;tag&gt;/);
  assert.equal((body.match(/<w:tbl>/g) || []).length, 1);
  assert.match(readZipEntry(docx, 'word/_rels/document.xml.rels').toString('utf8'), /Target="https:\/\/example\.com" TargetMode="External"/);
  // Each numbered list has a number of its own, so the second one starts at 1 again.
  assert.equal((readZipEntry(toDocx(parseMarkdown('1. a\n2. b\n\ntext\n\n1. c\n2. d')), 'word/numbering.xml').toString('utf8').match(/<w:num w:numId=/g) || []).length, 3);
  const back = (await extractDocument('report.docx', docx)).text;
  for (const words of ['Quarterly report', 'An introduction with italic, code, a link and snake_case_name. Second line of the same paragraph.', 'First numbered item', 'another & one <tag>', 'February', '950', 'A quoted line.', 'function add(a, b) {', 'Città, naïve, 日本語.']) {
    assert.ok(back.includes(words), `the Word file holds "${words}"`);
  }
  assert.equal(toDocx(parts).equals(docx), true, 'the same text gives the same file');

  // The tool. A Word file needs nothing but Uma; a PDF needs the app's window, which is not here.
  const dir = path.join(root, 'documents');
  await fsp.rm(dir, { recursive: true, force: true });
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  await store.updateSettings({ allowEdits: true });
  const workspaceDir = path.join(dir, 'workspace');
  await ensureDir(workspaceDir);
  const workspace = new Workspace({ root: workspaceDir, trash: () => {} });
  await workspace.init();
  const printed = [];
  const tools = new ToolRunner({ workspace, store, onChanged: () => {}, printPdf: async (page) => { printed.push(page); return Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n%%EOF'); } });
  let result = await tools.run('save_document', { path: 'out/report.docx', content: text });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /Made out\/report\.docx: a real Word document/);
  assert.ok((await extractDocument('report.docx', await fsp.readFile(path.join(workspaceDir, 'out', 'report.docx')))).text.includes('Quarterly report'));
  // From a file already written (a long document is written in parts first).
  await fsp.writeFile(path.join(workspaceDir, 'notes.md'), '# Notes\n\n- one\n- two\n');
  result = await tools.run('save_document', { path: 'notes.docx', from: 'notes.md' });
  assert.equal(result.ok, true, result.output);
  assert.ok((await extractDocument('notes.docx', await fsp.readFile(path.join(workspaceDir, 'notes.docx')))).text.includes('Notes\none\ntwo'));
  // A PDF: the Markdown goes to the printer as a page; an HTML file of the project goes as it is.
  result = await tools.run('save_document', { path: 'report.pdf', content: text });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /Made report\.pdf: a real PDF of 2 pages/);
  assert.match(printed[0].html, /<h1>Quarterly report<\/h1>/);
  assert.equal((await fsp.readFile(path.join(workspaceDir, 'report.pdf'))).subarray(0, 5).toString('latin1'), '%PDF-');
  await fsp.writeFile(path.join(workspaceDir, 'page.html'), '<!doctype html><html><body><h1>Page</h1></body></html>');
  result = await tools.run('save_document', { path: 'page.pdf', from: 'page.html' });
  assert.equal(printed[1].file, path.join(workspaceDir, 'page.html'));
  // What it refuses, each with the way that works.
  assert.match((await tools.run('save_document', { path: 'report.txt', content: text })).output, /makes PDF \(\.pdf\) and Word \(\.docx\) files[\s\S]*use write_file/);
  assert.match((await tools.run('save_document', { path: 'report.docx' })).output, /needs the text of the document/);
  assert.match((await tools.run('save_document', { path: 'page.docx', from: 'page.html' })).output, /made from Markdown, not from HTML/);
  assert.match((await tools.run('save_document', { path: '../outside.docx', content: text })).output, /outside the chosen workspace/);
  assert.match((await new ToolRunner({ workspace, store, onChanged: () => {} }).run('save_document', { path: 'x.pdf', content: text })).output, /PDF files cannot be made here/);
  // write_file still does not save text under these names, and now says what does.
  for (const name of ['report.pdf', 'report.docx']) {
    result = await tools.run('write_file', { path: name, content: text });
    assert.equal(result.ok, false);
    assert.match(result.output, /Make it with save_document instead/);
  }
  // Off with file edits, like every tool that writes.
  await store.updateSettings({ allowEdits: false });
  assert.match((await tools.run('save_document', { path: 'no.docx', content: text })).output, /File editing is turned off/);
  assert.equal(allowedTools(store.getSettings()).includes('save_document'), false);
  await store.updateSettings({ allowEdits: true });
  assert.equal(allowedTools(store.getSettings()).includes('save_document'), true);
  // "make a PDF about cats" is work on files, as "make a page" is: the tool is offered for it.
  for (const request of ['make a PDF about cats', 'create a Word document with my CV', 'write a report and save it as report.docx', 'crea un documento Word sul mio progetto']) {
    assert.equal(Boolean(classifyTask(englishGist(request)).wantsEdit), true, request);
  }
  console.log('PDF and Word documents from Markdown: OK');
}

// What a real 9B model did in the task runs of scripts/e2e-tasks.cjs, and what Uma now does about it.
async function testRealModelFixes() {
  const dir = path.join(root, 'real-model');
  await fsp.rm(dir, { recursive: true, force: true });
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  await store.updateSettings({ allowEdits: true });
  const workspaceDir = path.join(dir, 'workspace');
  await ensureDir(workspaceDir);
  await fsp.writeFile(path.join(workspaceDir, 'calc.js'), 'module.exports = { add: (a, b) => a + b };\n');
  const workspace = new Workspace({ root: workspaceDir, trash: () => {} });
  await workspace.init();
  const tools = new ToolRunner({ workspace, store, onChanged: () => {} });
  const conversations = new ConversationStore(path.join(dir, 'conversations'));
  await conversations.init();
  // Each scripted reply is its text, or [text, why it ended].
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
          const [reply, reason] = [].concat(script[Math.min(calls.length - 1, script.length - 1)]);
          yield { type: 'text', text: reply };
          yield { type: 'finish', reason: reason || 'stop' };
        },
      },
      send: (_channel, payload) => { if (payload?.type === 'assistant-end') done(payload.message); },
    });
    await agent.send(conversation.id, text);
    return { message: await finished, calls };
  };
  const toolBlocks = (message) => message.blocks.filter((block) => block.type === 'tool');

  // Small talk that runs to the length limit gets one more reply to finish, not five: a joke that
  // never ended had filled three full replies.
  const endless = ['A man walks into a bar, and then another man walks in after him, and', 'length'];
  let run = await chat([endless, ['and then one more, and', 'length'], ['and more', 'length'], ['and more', 'length']], 'tell me a joke');
  assert.equal(run.calls.length, 2, 'one continuation for small talk');
  assert.match(run.calls[1].messages.at(-1).content, /Finish what you were writing in a few sentences/);
  assert.match(run.message.content, /reached its length limit and stops there\. Say “continue”/);
  // An answer that ends by itself gets no such note.
  run = await chat(['Why did the chicken cross the road? To get to the other side.'], 'tell me a joke');
  assert.equal(run.calls.length, 1);
  assert.doesNotMatch(run.message.content, /length limit/);
  // Work on the project keeps its several continuations.
  run = await chat([['Here is the first part of the explanation of calc.js, which', 'length'], ['goes on, and', 'length'], ['on, and', 'length'], 'ends here.'], 'explain this project in detail');
  assert.ok(run.calls.length >= 4, `work is continued more than once (${run.calls.length} replies)`);

  // With no terminal, a model that wants to run what it wrote writes the same file again and again
  // ("Now I run the tests:"). The second write is refused, and it is told what to tell the user.
  const test = (extra) => `const { add } = require('./calc');\nconst assert = require('node:assert');\nassert.equal(add(1, 2), 3);\nassert.equal(add(0, 0), 0);\nassert.equal(add(-1, 1), 0);\nconsole.log('all tests passed');${extra}\n`;
  const write = (content) => `\`\`\`tool\n${JSON.stringify({ name: 'write_file', arguments: { path: 'calc.test.js', content } })}\n\`\`\``;
  run = await chat([
    `I write the tests.\n${write(test(''))}`,
    `Now I run the tests:\n${write(`${test('')}\n`)}`,
    'I created calc.test.js. Run it with: node calc.test.js',
  ], 'write the tests for calc.js');
  assert.deepEqual(toolBlocks(run.message).map((block) => [block.name, block.status]), [['write_file', 'done'], ['write_file', 'error']]);
  const refusal = run.calls[2].messages.at(-1).content;
  assert.match(refusal, /Not written again: calc\.test\.js already holds this text/);
  assert.match(refusal, /terminal access is off, so nothing can be run from here/);
  assert.match(refusal, /give the exact command they can run themselves/);
  assert.equal(await fsp.readFile(path.join(workspaceDir, 'calc.test.js'), 'utf8'), test(''), 'the file is as it was first written');
  // A real second version of the file is written.
  run = await chat([
    write(test('')),
    write('const { add } = require(\'./calc\');\nconst test = require(\'node:test\');\nconst assert = require(\'node:assert\');\ntest(\'adds\', () => assert.equal(add(1, 2), 3));\ntest(\'adds zero\', () => assert.equal(add(0, 0), 0));\ntest(\'adds negatives\', () => assert.equal(add(-1, 1), 0));\n'),
    'Rewrote the tests with node:test.',
  ], 'write the tests for calc.js');
  assert.deepEqual(toolBlocks(run.message).map((block) => block.status), ['done', 'done']);
  // With the terminal on, the refusal points at run_command instead.
  await store.updateSettings({ allowShell: true });
  run = await chat([write(test('')), write(test('')), 'Done.'], 'write the tests for calc.js');
  assert.match(run.calls[2].messages.at(-1).content, /Not written again[\s\S]*call run_command/);
  assert.doesNotMatch(run.calls[2].messages.at(-1).content, /terminal access is off/);

  // A reply with a tool call that cannot be read, then one that can: the second runs, and the first
  // is not shown to the user as if it were the answer (a raw ```tool block with half a web page).
  const fence = '```';
  const unreadable = `${fence}tool\n{"name":"write_file","arguments":{"path":"index.html","content":"<div class="card">hello</div>\n${fence}`;
  const readable = `${fence}tool\n{"name":"list_files","arguments":{"path":"."}}\n${fence}`;
  for (const first of [unreadable, `${fence}tool\n{"name":"write_file","arguments":{"path":"index.html","content":"<!DOCTYPE html>\\n<html>`]) {
    const call = extractToolCall(`I will make the page.\n${first}\n${readable}`);
    assert.equal(call.name, 'list_files');
    assert.equal(call.cleanText, 'I will make the page.');
  }
  assert.equal(extractToolCall(`Listing the folder first.\n${readable}`).cleanText, 'Listing the folder first.');
  await store.updateSettings({ allowShell: false });
  run = await chat([`I will make the page.\n${unreadable}\n${readable}`, 'The folder holds calc.js and its test.'], 'list the files of this project');
  assert.deepEqual(toolBlocks(run.message).map((block) => block.name), ['list_files']);
  assert.doesNotMatch(run.message.content, /```tool|write_file|"arguments"/, 'no raw tool call in the answer');
  assert.doesNotMatch(run.message.blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n'), /```tool|"arguments"/);
  assert.match(run.message.content, /The folder holds calc\.js/);

  // A file longer than one reply: the call is cut off in the middle of its content. What arrived is
  // read out of the unfinished call.
  const cut = (json) => `${fence}tool\n${json}`;
  let partial = cutOffWrite(`I write the page.\n${cut('{"name":"write_file","arguments":{"path":"index.html","content":"<!DOCTYPE html>\\n<p class=\\"a\\">caf\\u00e8</p>\\n<div>half a li')}`);
  assert.deepEqual(partial, { name: 'write_file', path: 'index.html', content: '<!DOCTYPE html>\n<p class="a">cafè</p>\n<div>half a li', closed: false, cleanText: 'I write the page.' });
  // Cut in the middle of an escape: the half escape is left out. Real line breaks are taken as they are.
  assert.equal(cutOffWrite('{"name":"append_file","arguments":{"path":"app.js","content":"line one\\nline two\\').content, 'line one\nline two');
  assert.equal(cutOffWrite(cut('{"name":"write_file","arguments":{"path":"a.css","content":"body {\n  color: red;\n}\n.card {')).content, 'body {\n  color: red;\n}\n.card {');
  // The whole content arrived and only the end of the call is missing.
  partial = cutOffWrite(cut('{"name":"write_file","arguments":{"path":"a.txt","content":"all of it\\n"'));
  assert.deepEqual([partial.content, partial.closed], ['all of it\n', true]);
  // Nothing to save: the path comes after the content, another tool, or no call at all.
  assert.equal(cutOffWrite('{"name":"write_file","arguments":{"content":"x\\ny","path":"a.txt"'), null);
  assert.equal(cutOffWrite(cut('{"name":"read_file","arguments":{"path":"a.txt"')), null);
  assert.equal(cutOffWrite('Just an answer.'), null);

  // Through the agent: the part that arrived is saved up to its last whole line, the model is told
  // where the file stops, and it goes on with append_file. Before, it was asked for the whole call
  // again, sent the same three times, and the task ended with an error and no file.
  const page = Array.from({ length: 60 }, (_, index) => `<p>line ${index + 1} of the page</p>`);
  const callWith = (name, lines, { whole = true } = {}) => {
    const json = JSON.stringify({ name, arguments: { path: 'page.html', content: `${lines.join('\n')}\n` } });
    return `${fence}tool\n${whole ? `${json}\n${fence}` : `${json.slice(0, json.lastIndexOf('\\n'))}\\n<p>half a li`}`;
  };
  const pageFile = path.join(workspaceDir, 'page.html');
  run = await chat([
    [`I write the page.\n${callWith('write_file', page.slice(0, 40), { whole: false })}`, 'length'],
    callWith('append_file', page.slice(40)),
    'The page is written.',
  ], 'make a web page called page.html with sixty lines');
  assert.deepEqual(toolBlocks(run.message).map((block) => [block.name, block.status]), [['write_file', 'done'], ['append_file', 'done']]);
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${page.join('\n')}\n`, 'the file is whole, with no line twice and no half line');
  const told = run.calls[1].messages.at(-1).content;
  assert.match(told, /cut off: only its first 40 lines were saved/);
  assert.match(told, /page\.html now ends with this line:\n<p>line 40 of the page<\/p>\nGo on now with append_file/);
  assert.equal(run.message.status, 'done');
  assert.doesNotMatch(run.message.content, /```tool|"arguments"/);
  // Started over from the first line and cut off again: the saved part stays, and it is told to append.
  await fsp.rm(pageFile, { force: true });
  run = await chat([
    [callWith('write_file', page.slice(0, 40), { whole: false }), 'length'],
    [callWith('write_file', page.slice(0, 38), { whole: false }), 'length'],
    callWith('append_file', page.slice(40)),
    'The page is written.',
  ], 'make a web page called page.html with sixty lines');
  assert.deepEqual(toolBlocks(run.message).map((block) => [block.name, block.status]), [['write_file', 'done'], ['write_file', 'error'], ['append_file', 'done']]);
  assert.match(run.calls[2].messages.at(-1).content, /started page\.html from its first line again[\s\S]*ends with this line:\n<p>line 40 of the page<\/p>\nCall append_file/);
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${page.join('\n')}\n`);
  // An append that is cut off is saved the same way.
  await fsp.rm(pageFile, { force: true });
  run = await chat([
    [callWith('write_file', page.slice(0, 20), { whole: false }), 'length'],
    [callWith('append_file', page.slice(20, 45), { whole: false }), 'length'],
    callWith('append_file', page.slice(45)),
    'The page is written.',
  ], 'make a web page called page.html with sixty lines');
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${page.join('\n')}\n`);
  assert.match(run.calls[2].messages.at(-1).content, /only its first 25 lines were saved[\s\S]*<p>line 45 of the page<\/p>/);
  // A model going in circles inside the file (a real one wrote the same questions ten times, part
  // after part, to 57,000 characters): the part is saved only up to where it starts repeating, the
  // model is told to close the file, and if it goes on the same way nothing more is written.
  await fsp.rm(pageFile, { force: true });
  // Lines long enough to be content: a short line said twice (a closing tag) means nothing.
  const wide = page.map((line) => line.replace('</p>', ', with enough words to be a line of real text</p>'));
  run = await chat([
    [callWith('write_file', wide.slice(0, 40), { whole: false }), 'length'],
    [callWith('append_file', [...wide.slice(40, 50), ...wide.slice(5, 35)], { whole: false }), 'length'],
    [callWith('append_file', wide.slice(2, 30), { whole: false }), 'length'],
    'The page is saved, but its ending may be incomplete.',
  ], 'make a web page called page.html with sixty lines');
  assert.deepEqual(toolBlocks(run.message).map((block) => [block.name, block.status]), [['write_file', 'done'], ['append_file', 'done'], ['append_file', 'error']]);
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${wide.slice(0, 50).join('\n')}\n`, 'what was new is saved, what was said again is not');
  assert.match(run.calls[2].messages.at(-1).content, /Only the first 10 lines of this call were saved: after them it repeated lines that page\.html already holds/);
  assert.match(run.message.content, /kept writing the same lines into page\.html again and again/);
  assert.ok(run.calls.length <= 4, `the turn ends instead of going on (${run.calls.length} replies)`);
  // A model that stops after a part that was cut off, and says the file is written: it is told the
  // file is not finished, and finishes it.
  await fsp.rm(pageFile, { force: true });
  run = await chat([
    [callWith('write_file', wide.slice(0, 40), { whole: false }), 'length'],
    'The page is written, with all sixty lines.',
    callWith('append_file', wide.slice(40)),
    'Now the page is complete.',
  ], 'make a web page called page.html with sixty lines');
  assert.match(run.calls[2].messages.at(-1).content, /page\.html is not finished: its last part was cut off[\s\S]*Finish it now with one short append_file/);
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${wide.join('\n')}\n`);
  assert.equal(run.message.blocks.find((block) => block.type === 'text' && /all sixty lines/.test(block.text)).unchecked, 'claimed', 'the early "it is written" is set aside');
  assert.doesNotMatch(run.message.content, /probably incomplete|all sixty lines/);
  assert.match(run.message.content, /Now the page is complete\./);
  // If it still does not finish the file, the user is told that the file is incomplete.
  await fsp.rm(pageFile, { force: true });
  run = await chat([
    [callWith('write_file', wide.slice(0, 40), { whole: false }), 'length'],
    'The page is written, with all sixty lines.',
  ], 'make a web page called page.html with sixty lines');
  assert.match(run.message.content, /page\.html was longer than one reply and was saved in parts, but its last part was cut off[\s\S]*probably incomplete/);
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${wide.slice(0, 40).join('\n')}\n`);

  // A model that never ends a file (a real one wrote tests for six minutes, seven parts long): three
  // cut-off parts are saved, the third with the request to close the file, and the next is not.
  await fsp.rm(pageFile, { force: true });
  const noEnd = Array.from({ length: 200 }, (_, index) => `<p>paragraph number ${index + 1}, which says one more thing about the page and its text</p>`);
  run = await chat([
    [callWith('write_file', noEnd.slice(0, 40), { whole: false }), 'length'],
    [callWith('append_file', noEnd.slice(40, 80), { whole: false }), 'length'],
    [callWith('append_file', noEnd.slice(80, 120), { whole: false }), 'length'],
    [callWith('append_file', noEnd.slice(120, 160), { whole: false }), 'length'],
    [callWith('append_file', noEnd.slice(160, 200), { whole: false }), 'length'],
    'The page is saved up to paragraph 120 and is not finished.',
  ], 'make a web page called page.html with many paragraphs');
  assert.deepEqual(toolBlocks(run.message).map((block) => block.status), ['done', 'done', 'done', 'error'], 'the fourth cut-off part is not saved, and there is no fifth');
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${noEnd.slice(0, 120).join('\n')}\n`);
  assert.match(run.calls[2].messages.at(-1).content, /Go on now with append_file/);
  assert.match(run.calls[3].messages.at(-1).content, /no further part that is cut off will be saved\. Close it now: one short append_file/);
  assert.match(run.message.content, /page\.html was still not finished after 3 full replies of text/);
  assert.doesNotMatch(run.message.content, /kept repeating the same tool calls|probably incomplete/, 'one note, not three');
  // A whole part after the third closes the file, as asked.
  await fsp.rm(pageFile, { force: true });
  run = await chat([
    [callWith('write_file', noEnd.slice(0, 40), { whole: false }), 'length'],
    [callWith('append_file', noEnd.slice(40, 80), { whole: false }), 'length'],
    [callWith('append_file', noEnd.slice(80, 120), { whole: false }), 'length'],
    callWith('append_file', ['</body>', '</html>']),
    'The page is complete.',
  ], 'make a web page called page.html with many paragraphs');
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${[...noEnd.slice(0, 120), '</body>', '</html>'].join('\n')}\n`);
  assert.doesNotMatch(run.message.content, /not finished|incomplete/);

  // Told which line the file ends with, a model began its next part with that same line: the lines
  // the two parts share at the join are written once.
  await fsp.rm(pageFile, { force: true });
  run = await chat([
    [callWith('write_file', wide.slice(0, 40), { whole: false }), 'length'],
    callWith('append_file', wide.slice(38)),
    'The page is written.',
  ], 'make a web page called page.html with sixty lines');
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${wide.join('\n')}\n`, 'lines 39 and 40 are there once');
  // Two closing tags, one at the end of a part and one at the start of the next, are two tags.
  await fsp.rm(pageFile, { force: true });
  run = await chat([
    [callWith('write_file', [...wide.slice(0, 40), '</div>'], { whole: false }), 'length'],
    callWith('append_file', ['</div>', ...wide.slice(40)]),
    'The page is written.',
  ], 'make a web page called page.html with sixty lines');
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${[...wide.slice(0, 40), '</div>', '</div>', ...wide.slice(40)].join('\n')}\n`);
  // A few lines said again are ordinary: nothing is cut.
  await fsp.rm(pageFile, { force: true });
  run = await chat([
    [callWith('write_file', wide.slice(0, 30), { whole: false }), 'length'],
    callWith('append_file', [...wide.slice(30, 58), wide[3], wide[4], wide[58], wide[59]]),
    'The page is written.',
  ], 'make a web page called page.html with sixty lines');
  assert.equal((await fsp.readFile(pageFile, 'utf8')).split('\n').filter(Boolean).length, 62);

  // Too little arrived to be worth saving: the model is asked for a shorter call, as before.
  await fsp.rm(pageFile, { force: true });
  run = await chat([
    [callWith('write_file', page.slice(0, 2), { whole: false }), 'length'],
    callWith('write_file', page.slice(0, 3)),
    'Done.',
  ], 'make a web page called page.html with three lines');
  assert.match(run.calls[1].messages.at(-1).content, /Your tool call was cut off at the/);
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${page.slice(0, 3).join('\n')}\n`);

  // Asked to run a file, a real model began with "Here is the content of test.js:" and thirty lines it
  // had made up, and they stayed in the answer. A listing of a file that no tool has opened, and that
  // is not what the file holds, is set aside, and the model does not read it back.
  await fsp.writeFile(path.join(workspaceDir, 'notes.js'), 'const first = 1;\nconst second = 2;\nconst third = 3;\nconst fourth = 4;\nconst fifth = 5;\nmodule.exports = { first, second, third, fourth, fifth };\n');
  const madeUp = 'Here is the content of `notes.js`:\n```javascript\nfunction add(a, b) {\n  return a + b;\n}\nfunction subtract(a, b) {\n  return a - b;\n}\nconsole.log(add(2, 3));\n```';
  const toolCall = (name, args) => `\`\`\`tool\n${JSON.stringify({ name, arguments: args })}\n\`\`\``;
  run = await chat([`${madeUp}\n${toolCall('read_file', { path: 'calc.js' })}`, 'calc.js adds two numbers.'], 'what does calc.js do?');
  assert.equal(run.message.blocks.find((block) => block.type === 'text' && /subtract/.test(block.text)).unchecked, 'unseen', 'the invented listing is set aside');
  assert.doesNotMatch(run.message.content, /subtract/);
  assert.doesNotMatch(run.calls[1].messages.map((message) => message.content).join('\n'), /subtract/, 'and the model does not work from it');
  assert.match(run.message.content, /calc\.js adds two numbers\./);
  // As the whole answer, with no tool: it is told to open the file.
  run = await chat([madeUp, toolCall('read_file', { path: 'notes.js' }), 'notes.js holds five numbers, first to fifth.'], 'what is in notes.js?');
  assert.ok(run.calls.some((request) => /You showed a listing of notes\.js[\s\S]*Call read_file on notes\.js now/.test(request.messages.at(-1).content)), 'asked to read the file');
  assert.doesNotMatch(run.message.content, /subtract/);
  assert.match(run.message.content, /five numbers/);
  // What the file really holds may be shown, and so may the output of a command that ran it.
  run = await chat([`Here is \`notes.js\`:\n\`\`\`javascript\nconst first = 1;\nconst second = 2;\nconst third = 3;\nconst fourth = 4;\nconst fifth = 5;\n\`\`\`\n${toolCall('list_files', { path: '.' })}`, 'That is all of it.'], 'what is in notes.js?');
  assert.match(run.message.content, /const fourth = 4;/, 'a true listing stays');
  run = await chat([toolCall('read_file', { path: 'notes.js' }), `Running \`notes.js\` would print:\n\`\`\`\nline one of the output\nline two of the output\nline three of the output\nline four of the output\nline five of the output\n\`\`\`\n${toolCall('list_files', { path: '.' })}`, 'That is all of it.'], 'what is in notes.js?');
  assert.match(run.message.content, /line four of the output/, 'a file a tool has opened is left alone');

  // The workspace's own full path is the workspace: a model gave it as the folder to run a command
  // in, and the command was refused. A full path outside it is still refused.
  assert.equal(await workspace.resolve(path.join(workspaceDir, 'calc.js')), path.join(workspaceDir, 'calc.js'));
  assert.equal(await workspace.resolve(workspaceDir), workspaceDir);
  assert.equal(await workspace.resolve(workspaceDir.replace(/\\/g, '/')), workspaceDir);
  await assert.rejects(workspace.resolve(path.join(dir, 'data', 'settings.json')), /relative to the workspace/);
  await assert.rejects(workspace.resolve(path.join(workspaceDir, '..', 'data')), /relative to the workspace/);
  // So is its own name in front of a path: a page asked for in "workspace" does not land in a new
  // folder workspace/workspace. A folder of that name that is really there is used.
  assert.equal(await workspace.resolve('workspace/index.html'), path.join(workspaceDir, 'index.html'));
  assert.equal(await workspace.resolve('workspace'), path.join(workspaceDir, 'workspace'), 'the name alone can still be made as a folder');
  await ensureDir(path.join(workspaceDir, 'workspace'));
  assert.equal(await workspace.resolve('workspace/index.html'), path.join(workspaceDir, 'workspace', 'index.html'));
  await fsp.rm(path.join(workspaceDir, 'workspace'), { recursive: true });

  // The file pasted into the chat instead of saved. Asked for faq.html, a real model wrote the whole
  // page into the chat, and then all of it a second time as a tool call, with 8,000 characters of
  // HTML left in the answer. When it is plain which file the code is, Uma saves it itself.
  await fsp.rm(pageFile, { force: true });
  run = await chat([`Here is the page:\n${fence}html\n${wide.slice(0, 20).join('\n')}\n${fence}\nIt has twenty lines.`, 'The page is saved as page.html.'], 'make a web page called page.html with twenty lines');
  assert.deepEqual(toolBlocks(run.message).map((block) => [block.name, block.status, block.args.path]), [['write_file', 'done', 'page.html']], 'saved by Uma, as the file the request names');
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${wide.slice(0, 20).join('\n')}\n`);
  assert.equal(run.calls.length, 2, 'the reply is not thrown away and written a second time');
  assert.doesNotMatch(run.message.content, /line 5 of the page/, 'the code is in the file, not in the answer as well');
  assert.match(run.message.content, /Here is the page:[\s\S]*The page is saved as page\.html\./);
  // Cut off by the end of the reply, it is the first part of the file, and the model goes on.
  await fsp.rm(pageFile, { force: true });
  run = await chat([
    [`${fence}html\n${wide.slice(0, 40).join('\n')}\n<p>half a li`, 'length'],
    callWith('append_file', wide.slice(40)),
    'The page is written.',
  ], 'make a web page called page.html with sixty lines');
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${wide.join('\n')}\n`, 'the pasted part and the rest, each once');
  assert.match(run.calls[1].messages.at(-1).content, /Go on now with append_file/);
  assert.doesNotMatch(run.message.content, /line 5 of the page|half a li/);
  // The same when the reply ends in the middle of the code for another reason (the model stops, or
  // Uma ends a reply that had begun to repeat itself): what arrived is the first part.
  await fsp.rm(pageFile, { force: true });
  run = await chat([
    `${fence}html\n${wide.slice(0, 30).join('\n')}\n`,
    callWith('append_file', wide.slice(30)),
    'The page is written.',
  ], 'make a web page called page.html with sixty lines');
  assert.equal(await fsp.readFile(pageFile, 'utf8'), `${wide.join('\n')}\n`);
  assert.match(run.calls[1].messages.at(-1).content, /Go on now with append_file/);
  // A whole HTML document with no name anywhere is index.html, as every model names it.
  run = await chat([`${fence}html\n<!DOCTYPE html>\n<html>\n<body>\n${wide.slice(0, 20).join('\n')}\n</body>\n</html>\n${fence}`, 'The page is saved.'], 'make a web page with twenty lines');
  assert.deepEqual(toolBlocks(run.message).map((block) => [block.name, block.status, block.args.path]), [['write_file', 'done', 'index.html']]);
  await fsp.rm(path.join(workspaceDir, 'index.html'), { force: true });
  // The page, then a short block with the command to open it: the page is still the one file.
  run = await chat([`${fence}html\n<!DOCTYPE html>\n<html>\n<body>\n${wide.slice(0, 20).join('\n')}\n</body>\n</html>\n${fence}\n\nOpen it with:\n\n${fence}powershell\nStart-Process "index.html"\n${fence}\n`, 'The page is saved.'], 'make a web page with twenty lines');
  assert.deepEqual(toolBlocks(run.message).map((block) => [block.name, block.status, block.args.path]), [['write_file', 'done', 'index.html']]);
  assert.match(await fsp.readFile(path.join(workspaceDir, 'index.html'), 'utf8'), /^<!DOCTYPE html>[\s\S]*<\/html>\n$/);
  assert.doesNotMatch(await fsp.readFile(path.join(workspaceDir, 'index.html'), 'utf8'), /Start-Process/);
  await fsp.rm(path.join(workspaceDir, 'index.html'), { force: true });
  // Two long blocks are two files, and which is which is not plain: nothing is saved by Uma.
  run = await chat([`${fence}html\n${wide.slice(0, 20).join('\n')}\n${fence}\n${fence}css\n${wide.slice(20, 40).join('\n')}\n${fence}`, toolCall('write_file', { path: 'two.html', content: 'x\n' }), 'Saved.'], 'make a web page with twenty lines and its style sheet');
  assert.equal(toolBlocks(run.message).some((block) => block.args.path === 'index.html'), false);
  await fsp.rm(path.join(workspaceDir, 'two.html'), { force: true });
  // The page, then a call that changes nothing (to look at it, before it exists): the page is saved
  // first. And a whole page is never written over a code file, whatever the model calls it.
  run = await chat([`${fence}html\n<!DOCTYPE html>\n<html>\n<body>\n${wide.slice(0, 20).join('\n')}\n</body>\n</html>\n${fence}\n${toolCall('list_files', { path: '.' })}`, 'The page is saved as index.html.'], 'make a web page with twenty lines');
  assert.deepEqual(toolBlocks(run.message).map((block) => [block.name, block.status, block.args.path]), [['write_file', 'done', 'index.html']]);
  await fsp.rm(path.join(workspaceDir, 'index.html'), { force: true });
  const pageOverCode = await tools.run('write_file', { path: 'calc.js', content: '<!DOCTYPE html>\n<html><body><h1>Hello</h1></body></html>\n' });
  assert.equal(pageOverCode.ok, false);
  assert.match(pageOverCode.output, /whole HTML page, and "calc\.js" is not an HTML file[\s\S]*index\.html/);
  assert.equal((await tools.run('write_file', { path: 'hello.html', content: '<!DOCTYPE html>\n<html><body><h1>Hello</h1></body></html>\n' })).ok, true);
  await fsp.rm(path.join(workspaceDir, 'hello.html'), { force: true });
  // A file that is already there is never replaced this way, and code with no plain name is not
  // saved under a guessed one: the model is asked to save it, and the paste leaves the answer.
  const script = Array.from({ length: 20 }, (_, index) => `console.log('number ${index + 1} of twenty, printed on its own line');`);
  for (const [request, saved] of [['rewrite calc.js so that it prints twenty numbers', 'calc.js'], ['write a script that prints twenty numbers', 'numbers.js']]) {
    const before = await fsp.readFile(path.join(workspaceDir, 'calc.js'), 'utf8');
    run = await chat([`${fence}javascript\n${script.join('\n')}\n${fence}`, toolCall('write_file', { path: 'numbers.js', content: `${script.join('\n')}\n` }), `Saved as ${saved}.`], request);
    assert.ok(run.calls.some((item) => /You pasted the code into chat/.test(item.messages.at(-1).content)), `asked to save it (${request})`);
    assert.equal(await fsp.readFile(path.join(workspaceDir, 'calc.js'), 'utf8'), before, 'calc.js is not replaced by a paste');
    assert.doesNotMatch(run.message.content, /number 5 of twenty/, 'the paste does not stay in the answer');
    await fsp.rm(path.join(workspaceDir, 'numbers.js'), { force: true });
  }

  // A joke whose story has a click in it is a joke, not a claim to have clicked: a real model's was set
  // aside, and what it then wrote was nonsense. Asked to click, the same words are still a claim.
  const story = 'A programmer walks into a bar. "I clicked the button and typed my order," he says, "and the bar crashed."';
  run = await chat([story, 'something else'], 'tell me a joke');
  assert.equal(run.calls.length, 1, 'the joke is the answer');
  assert.match(run.message.content, /I clicked the button/);
  run = await chat(['I clicked the button and typed your name.', 'I cannot click or type in other programs from here.'], 'click the OK button in the window that is open');
  assert.ok(run.calls.length > 1, 'a claim to have clicked is still not taken');
  assert.doesNotMatch(run.message.content, /I clicked the button/);

  // A PDF or Word document longer than one reply: half a document cannot be made, so its text is
  // kept as a .md file, continued there, and the document is made from that file when it is whole.
  const docCall = (lines) => {
    const json = JSON.stringify({ name: 'save_document', arguments: { path: 'guide.docx', content: `${lines.join('\n')}\n` } });
    return `${fence}tool\n${json.slice(0, json.lastIndexOf('\\n'))}\\nhalf a li`;
  };
  run = await chat([
    [docCall(wide.slice(0, 40)), 'length'],
    toolCall('append_file', { path: 'guide.md', content: `${wide.slice(40).join('\n')}\n` }),
    'The guide is ready.',
    toolCall('save_document', { path: 'guide.docx', from: 'guide.md' }),
    'The guide is saved as guide.docx.',
  ], 'make a Word document called guide.docx with sixty lines');
  assert.deepEqual(toolBlocks(run.message).map((block) => [block.name, block.status, block.args.path]), [['write_file', 'done', 'guide.md'], ['append_file', 'done', 'guide.md'], ['save_document', 'done', 'guide.docx']]);
  assert.match(run.calls[1].messages.at(-1).content, /the document is not made yet: the first 40 lines of its text are saved as guide\.md[\s\S]*"name":"save_document","arguments":\{"path":"guide\.docx","from":"guide\.md"\}/);
  assert.match(run.calls[3].messages.at(-1).content, /guide\.docx has not been made yet: only its text is saved, in guide\.md/, 'saying it is ready does not make the document');
  assert.equal(await fsp.readFile(path.join(workspaceDir, 'guide.md'), 'utf8'), `${wide.join('\n')}\n`);
  assert.equal((await fsp.readFile(path.join(workspaceDir, 'guide.docx'))).subarray(0, 2).toString('latin1'), 'PK');
  assert.doesNotMatch(run.message.content, /The guide is ready\./);
  assert.match(run.message.content, /saved as guide\.docx/);
  await fsp.rm(path.join(workspaceDir, 'guide.md'), { force: true });
  await fsp.rm(path.join(workspaceDir, 'guide.docx'), { force: true });

  // "The test passes" after a command that failed: a real model wrote "the fix is confirmed, the test
  // passes" after exit code 1. It is shown the failure and may not say so; after a command that
  // worked, the same words are the truth.
  await store.updateSettings({ allowShell: true });
  const fails = toolCall('run_command', { command: 'node -e "console.error(\'AssertionError: add(2, 3) should be 5\'); process.exit(1)"' });
  run = await chat([fails, 'The fix is confirmed: the test passes now.', 'The test still fails: add(2, 3) should be 5.'], 'run the test of calc.js');
  assert.match(run.calls[2].messages.at(-1).content, /the last command you ran failed[\s\S]*AssertionError: add\(2, 3\) should be 5[\s\S]*Do not say that it passes/);
  assert.doesNotMatch(run.message.content, /the test passes now/);
  assert.match(run.message.content, /The test still fails/);
  run = await chat([toolCall('run_command', { command: 'node -e "console.log(\'all tests passed\')"' }), 'The test passes: it printed "all tests passed".'], 'run the test of calc.js');
  assert.equal(run.calls.length, 2, 'a true "it passes" is taken');
  assert.match(run.message.content, /The test passes/);

  // After a failed build the whole file comes back much shorter: a real model got rid of its
  // compiler errors by leaving out the program's tabs (411 lines, then 274, then 181). Refused once.
  const longFile = Array.from({ length: 90 }, (_, index) => `int value${index} = ${index};`).join('\n');
  const shortFile = Array.from({ length: 30 }, (_, index) => `int value${index} = ${index};`).join('\n');
  run = await chat([
    toolCall('write_file', { path: 'shrink.cpp', content: longFile }),
    toolCall('run_command', { command: 'node -e "console.error(\'shrink.cpp(12): error C2065\'); process.exit(1)"' }),
    toolCall('write_file', { path: 'shrink.cpp', content: shortFile }),
    'The build still fails with error C2065 in shrink.cpp, line 12.',
  ], 'create shrink.cpp and compile it');
  assert.deepEqual(toolBlocks(run.message).map((block) => block.status), ['done', 'error', 'error']);
  assert.match(run.calls[3].messages.at(-1).content, /shrink\.cpp has 90 lines and this would replace it with 30, leaving out parts of what the user asked for[\s\S]*replace_in_file/);
  assert.equal((await fsp.readFile(path.join(workspace.root, 'shrink.cpp'), 'utf8')).split('\n').length, 90, 'the file keeps what it had');
  await store.updateSettings({ allowShell: false, askBeforeCommands: true });

  // With full PC access, a file goes where the user wrote, not one folder off: a real model left a
  // folder out of a long path, and the file landed elsewhere on the disk.
  await store.updateSettings({ allowSystemAccess: true });
  const farDir = path.join(dir, 'far', 'deeper', 'place');
  await ensureDir(farDir);
  const rightPlace = path.join(farDir, 'made.txt');
  const wrongPlace = path.join(dir, 'far', 'place', 'made.txt');
  run = await chat([
    toolCall('write_file', { path: wrongPlace, content: 'hello\n' }),
    toolCall('write_file', { path: rightPlace, content: 'hello\n' }),
    'The file is made.',
  ], `create the file ${rightPlace} containing only the word hello`);
  assert.deepEqual(toolBlocks(run.message).map((block) => block.status), ['error', 'done']);
  assert.match(run.calls[1].messages.at(-1).content, /is not the path the user wrote[\s\S]*deeper[\s\S]*copied exactly/);
  assert.equal(fs.existsSync(wrongPlace), false, 'nothing lands in the wrong folder');
  assert.equal(await fsp.readFile(rightPlace, 'utf8'), 'hello\n');
  // A place the user did not name at all is the model's choice, as before.
  run = await chat([toolCall('write_file', { path: path.join(farDir, 'other.txt'), content: 'x\n' }), 'Made.'], `make a note next to ${rightPlace}`);
  assert.equal(toolBlocks(run.message)[0].status, 'done');
  await store.updateSettings({ allowSystemAccess: false });

  // Asked to search the web with internet off, "internet access is off" is the answer: no file has
  // to be opened for it. A claim to have searched is still not taken.
  run = await chat(['I cannot search the web: internet access is off. You can turn it on in Settings → Agent permissions.', 'The workspace holds no llama.cpp repository.'], 'search the web for the newest llama.cpp release on GitHub');
  assert.equal(run.calls.length, 1, 'the true answer is taken as it is');
  assert.match(run.message.content, /internet access is off/);
  run = await chat(['The newest llama.cpp release is b9999.', toolCall('list_files', { path: '.' }), 'I cannot look that up: internet access is off.'], 'search the web for the newest llama.cpp release on GitHub');
  assert.ok(run.calls.length > 1, 'an answer with no source is still not taken');
  assert.doesNotMatch(run.message.content, /b9999/);

  // Asked only to be told something, a real model with the terminal on ran the file, saw it fail, and
  // changed the code unasked. A file that is there is not changed for a question.
  const calcBefore = await fsp.readFile(path.join(workspaceDir, 'calc.js'), 'utf8');
  const wrongEdit = toolCall('replace_in_file', { path: 'calc.js', find: 'a + b', replace: 'a - b' });
  for (const request of ['what does calc.js do?', 'read calc.js and tell me what it returns for 2 and 3']) {
    run = await chat([toolCall('read_file', { path: 'calc.js' }), wrongEdit, 'calc.js adds two numbers. I did not change it.'], request);
    assert.deepEqual(toolBlocks(run.message).map((block) => [block.name, block.status]), [['read_file', 'done'], ['replace_in_file', 'error']], request);
    assert.ok(run.calls.some((item) => /replace_in_file was not run: the user asked a question[\s\S]*Nothing was changed/.test(item.messages.at(-1).content)), request);
    assert.equal(await fsp.readFile(path.join(workspaceDir, 'calc.js'), 'utf8'), calcBefore);
  }
  // A new file may be made for an answer.
  run = await chat([toolCall('write_file', { path: 'answer.txt', content: 'add returns the sum.\n' }), 'Saved in answer.txt.'], 'tell me what add returns and save it in answer.txt');
  assert.deepEqual(toolBlocks(run.message).map((block) => [block.name, block.status]), [['write_file', 'done']]);
  await fsp.rm(path.join(workspaceDir, 'answer.txt'), { force: true });
  await fsp.writeFile(path.join(workspaceDir, 'calc.js'), calcBefore);

  // A folder that is not there is not an empty folder. A real model listed the workspace by its own
  // name, was shown "(empty)", and told the user that the files it had just read did not exist.
  const byName = await tools.run('list_files', { path: path.basename(workspaceDir) });
  assert.equal(byName.ok, true);
  assert.match(byName.output, /calc\.js/, 'the workspace named by its own folder name is the workspace');
  const nowhere = await tools.run('list_files', { path: 'nowhere' });
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.output, /The folder "nowhere" does not exist\. The workspace itself is "\."/);

  // Allowing terminal commands is the permission: no question for each command after it.
  const settingsStore = new Store(path.join(dir, 'settings'));
  await settingsStore.init();
  assert.equal(settingsStore.getSettings().askBeforeCommands, true, 'while the terminal is off nothing has been decided');
  await settingsStore.updateSettings({ allowShell: true });
  assert.equal(settingsStore.getSettings().askBeforeCommands, false);
  // Whoever wants to approve each command turns the question on, and it stays on.
  await settingsStore.updateSettings({ askBeforeCommands: true });
  await settingsStore.updateSettings({ allowInternet: true });
  await settingsStore.updateSettings({ allowShell: true });
  assert.equal(settingsStore.getSettings().askBeforeCommands, true, 'saving the same switch again decides nothing');
  // Both in one change: what was asked for is kept.
  await settingsStore.updateSettings({ allowShell: false });
  await settingsStore.updateSettings({ allowShell: true, askBeforeCommands: true });
  assert.equal(settingsStore.getSettings().askBeforeCommands, true);
  console.log('endless small talk, the same file written again, raw tool calls kept out of answers, files longer than one reply, invented file listings, the workspace by its full path, command questions: OK');
}

/** A PC with several graphics cards: an RTX 3060 and two Tesla P40, as one user runs. */
async function testSeveralGraphicsCards() {
  const { parseNvidiaCards, gpuSummary } = require('../electron/lib/hardware.cjs');
  const { gpuReading } = require('../electron/lib/systemStats.cjs');
  const { localCards } = require('../electron/lib/placement.cjs');
  const { LlamaManager } = require('../electron/lib/llama.cjs');
  const MiB = 1024 * 1024;

  // nvidia-smi lists the cards in slot order, and an older card's name has no "NVIDIA" in it.
  const smi = ['Tesla P40, 24576, 24210, 366, 0', 'NVIDIA GeForce RTX 3060, 12288, 11020, 1268, 87', 'Tesla P40, 24576, 24210, 366, 41', ''].join('\r\n');
  const cards = parseNvidiaCards(smi);
  assert.equal(cards.length, 3, 'every card is read, not only the first');
  assert.deepEqual(cards[1], { name: 'NVIDIA GeForce RTX 3060', totalMB: 12288, freeMB: 11020, usedMB: 1268, percent: 87, lanes: 0, lanesMax: 0 });
  assert.equal(gpuSummary(cards.map((card) => card.name)), '2× Tesla P40 + NVIDIA GeForce RTX 3060');
  assert.deepEqual(parseNvidiaCards(''), []);
  assert.deepEqual(parseNvidiaCards('NVIDIA GeForce RTX 2070, 8192, 7492, 700, [N/A]')[0].percent, 0, 'a card that does not report how busy it is');

  // The title bar: memory added up, the busiest card's percentage, and each card on its own.
  const reading = gpuReading(cards);
  assert.equal(reading.percent, 87);
  assert.equal(reading.totalBytes, (24576 * 2 + 12288) * MiB);
  assert.equal(reading.usedBytes, (366 * 2 + 1268) * MiB);
  assert.deepEqual(reading.cards.map((card) => card.percent), [0, 87, 41]);
  assert.equal(gpuReading([cards[1]]).cards, undefined, 'one card: as before');
  assert.equal(gpuReading([]), null);

  // What the engine lists decides what can be used. (CUDA puts the fastest card first.)
  const names = cards.map((card) => card.name);
  const all = parseDeviceList(['Available devices:', '  CUDA0: NVIDIA GeForce RTX 3060 (12288 MiB, 11020 MiB free)', '  CUDA1: Tesla P40 (24576 MiB, 24210 MiB free)', '  CUDA2: Tesla P40 (24576 MiB, 24210 MiB free)'].join('\n'));
  let found = localCards(all, names);
  assert.deepEqual(found.used.map((device) => `${device.name} ${device.card}`), ['CUDA0 NVIDIA GeForce RTX 3060', 'CUDA1 Tesla P40', 'CUDA2 Tesla P40']);
  assert.deepEqual(found.missing, []);
  // A CUDA 13 engine has no code for a P40: it lists the RTX 3060 alone.
  found = localCards(all.slice(0, 1), names);
  assert.deepEqual([found.used.length, found.missing], [1, ['Tesla P40', 'Tesla P40']]);
  // Vulkan also lists an integrated GPU, which is none of the cards and is left to llama.cpp.
  found = localCards(parseDeviceList(['  Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 11020 MiB free)', '  Vulkan1: Intel(R) UHD Graphics 770 (16000 MiB, 15000 MiB free)'].join('\n')), names);
  assert.deepEqual([found.used.map((device) => device.name), found.missing], [['Vulkan0'], ['Tesla P40', 'Tesla P40']]);

  // A load, with the engine replaced by a program that stops at once: each try's arguments are
  // in the log, and so is the way down from Uma's plan to llama.cpp's own split.
  const layers = (count, each) => ({
    nLayer: count, nEmbd: 4096, nHead: 32, nHeadKv: 8, keyLength: 128, valueLength: 128, attentionLayers: count, contextLength: 32768,
    layerBytes: Array.from({ length: count }, () => each * MiB), inputBytes: 300 * MiB, otherBytes: 300 * MiB, totalBytes: (count * each + 600) * MiB,
  });
  const make = (info, list, gpus = names) => {
    const lines = [];
    const manager = new LlamaManager({
      store: { getRuntime: () => ({ serverPath: process.execPath, backend: 'cuda', version: 'b12318' }), getEffectiveSettings: () => ({ contextSize: 8192 }), getSettings: () => ({}) },
      runtime: { hardware: { gpus: gpus.map((name) => ({ name })) } },
      logsDir: root, modelInfo: async () => info, freeRam: () => 64 * 1024 * MiB, freeVram: async () => 24210 * MiB,
      listDevices: async () => list.map((device) => `  ${device.name}: ${device.description} (${device.totalMB} MiB, ${device.freeMB} MiB free)`).join('\n'),
    });
    const log = manager.log.bind(manager);
    manager.log = (line) => { lines.push(line); log(line); };
    return { manager, lines, starts: () => lines.filter((line) => line.startsWith('[uma] starting')) };
  };
  const runtimeConfig = { serverPath: process.execPath, backend: 'cuda', version: 'b12318' };
  const model = { id: 'big', name: 'Big', path: __filename };
  const after = (line, flag) => { const parts = line.split(' '); return parts[parts.indexOf(flag) + 1]; };

  // 20 GB on 57 GB of free cards: fixed shares by free memory, then a fill plan, then no plan.
  let run = make(layers(40, 480), all);
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  let starts = run.starts();
  assert.equal(starts.length, 3, run.lines.join('\n'));
  assert.equal(after(starts[0], '-dev'), 'CUDA0,CUDA1,CUDA2');
  const shares = after(starts[0], '-ts').split(',').map(Number);
  assert.ok(shares[0] >= 16 && shares[0] <= 20 && shares[1] === shares[2] && shares[1] >= 39 && shares[1] <= 43, `shares ${shares}`);
  assert.equal(after(starts[0], '-ngl'), 'auto');
  assert.ok(!starts[1].includes(' -ts ') && after(starts[1], '--fit-target') === '512,512,512', 'the fill plan');
  assert.ok(!starts[2].includes(' -dev ') && after(starts[2], '--fit-target') === '300', "llama.cpp's own split");
  assert.match(run.lines.join('\n'), /graphics cards the engine can use: CUDA0 NVIDIA GeForce RTX 3060 \(11020 of 12288 MiB free\), CUDA1 Tesla P40/);
  assert.match(run.lines.join('\n'), /plan for 3 graphics cards \(the model fits/);
  assert.match(run.lines.join('\n'), /balanced plan for this PC's graphics cards did not load; retrying with a fill plan/);
  assert.match(run.lines.join('\n'), /loading again with llama\.cpp's own split/);
  assert.equal(run.manager.computeInfo().gpuName, 'NVIDIA GeForce RTX 3060 + 2× Tesla P40');

  // 80 GB does not fit: the cards are filled, and there is nothing balanced to retry.
  run = make(layers(80, 1000), all);
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  starts = run.starts();
  assert.equal(starts.length, 2);
  assert.ok(!starts[0].includes(' -ts ') && after(starts[0], '-dev') === 'CUDA0,CUDA1,CUDA2' && after(starts[0], '--fit-target') === '512,512,512');

  // The engine lists one card of the three: only that card's memory counts, and the user is told.
  run = make(layers(40, 480), all.slice(0, 1));
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  starts = run.starts();
  assert.equal(starts.length, 1);
  assert.ok(!starts[0].includes(' -dev ') && after(starts[0], '-ngl') === 'auto', '20 GB does not fit on the 12 GB card, whatever the other two have free');
  assert.deepEqual(run.manager.cards.missing, ['Tesla P40', 'Tesla P40']);
  assert.match(run.lines.join('\n'), /NOT usable with this engine \(cuda b12318\): 2× Tesla P40/);
  run = make(layers(20, 200), all.slice(0, 1));
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.equal(after(run.starts()[0], '-ngl'), 'all', 'a small model fits on the one usable card');

  // One card in the PC: the engine is not asked for its list, and the load goes as it always did.
  let asked = 0;
  run = make(layers(20, 200), all.slice(0, 1), ['NVIDIA GeForce RTX 3060']);
  run.manager.listDevices = async () => { asked += 1; return ''; };
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.equal(asked, 0);
  assert.equal(after(run.starts()[0], '-ngl'), 'all');
  assert.deepEqual([run.manager.cards.used, run.manager.cards.missing], [[], []]);

  // Cards chosen for the model (its settings, or "Optimize and benchmark" trying them): one card
  // alone gets -dev and every layer when the model fits on it; two cards share it between them;
  // a name the engine does not list, or all the cards, changes nothing.
  run = make(layers(20, 200), all);
  run.manager.trialSettings = { gpuCards: 'CUDA0', splitMode: 'tensor' };
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  starts = run.starts();
  assert.equal(starts.length, 1, 'one card: no plan to fall back from');
  assert.ok(after(starts[0], '-dev') === 'CUDA0' && after(starts[0], '-ngl') === 'all' && !starts[0].includes(' -ts '), starts[0]);
  assert.ok(!starts[0].includes('--split-mode'), 'one card has nothing to share, whatever the setting says');
  assert.match(run.lines.join('\n'), /only CUDA0 NVIDIA GeForce RTX 3060 is used, as chosen for this model/);
  assert.deepEqual([run.manager.status().onlyCards, run.manager.status().splitMode], [[], ''], 'nothing is reported for an engine that is not running');
  assert.deepEqual(run.manager.cards.all.map((device) => device.name), ['CUDA0', 'CUDA1', 'CUDA2']);
  assert.equal(run.manager.computeInfo().gpuName, 'NVIDIA GeForce RTX 3060');
  run = make(layers(40, 480), all);
  run.manager.trialSettings = { gpuCards: 'CUDA1,CUDA2' };
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.ok(after(run.starts()[0], '-dev') === 'CUDA1,CUDA2' && after(run.starts()[0], '-ts') === '50,50' && !run.starts()[0].includes('--split-mode'), run.starts()[0]);
  run = make(layers(40, 480), all);
  run.manager.trialSettings = { gpuCards: 'CUDA7' };
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.equal(after(run.starts()[0], '-dev'), 'CUDA0,CUDA1,CUDA2');
  // Guessing ahead without a second model: on when the engine's own help lists it, the MTP head
  // only for a model that has one; a load that fails with it is tried again without it.
  const { speculationArgs, speculationSupport } = require('../electron/lib/modelSettings.cjs');
  const help = '--spec-type none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,ngram-simple,ngram-mod,ngram-cache\n   comma-separated list of types';
  assert.deepEqual(speculationSupport(help), { mtp: true, ngram: true, loadMode: false, cacheRam: false });
  assert.deepEqual(speculationSupport('--spec-type none,draft-simple\n'), { mtp: false, ngram: false, loadMode: false, cacheRam: false });
  assert.deepEqual(speculationSupport(''), { mtp: false, ngram: false, loadMode: false, cacheRam: false });
  assert.deepEqual(speculationArgs({ mtp: true, ngram: true }), ['--spec-type', 'draft-mtp,ngram-mod']);
  assert.deepEqual(speculationArgs({}), []);
  const guessing = (info, settings = {}) => {
    const made = make(info, all.slice(0, 1), ['NVIDIA GeForce RTX 3060']);
    made.manager.engineHelp = async () => help;
    made.manager.store.getEffectiveSettings = () => ({ contextSize: 8192, ...settings });
    return made;
  };
  run = guessing({ ...layers(20, 200), mtpLayers: 1 });
  await assert.rejects(run.manager.ensureServer(model), /stopped while loading/);
  starts = run.starts();
  assert.equal(starts.length, 2, 'with guessing ahead, then without');
  assert.equal(after(starts[0], '--spec-type'), 'draft-mtp,ngram-mod');
  assert.ok(!starts[1].includes('--spec-type'), starts[1]);
  assert.match(run.lines.join('\n'), /guessing ahead without a second model: the model's own MTP head and text already in the chat/);
  assert.match(run.lines.join('\n'), /the load failed with guessing ahead[^\n]*loading again without it/);
  run = guessing(layers(20, 200));
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.equal(after(run.starts()[0], '--spec-type'), 'ngram-mod', 'no MTP head: only repeated text is guessed');
  run = guessing({ ...layers(20, 200), mtpLayers: 1 }, { mtp: 'off', ngram: 'off' });
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.ok(!run.starts()[0].includes('--spec-type'), 'both turned off in the model settings');
  run = guessing({ ...layers(20, 200), mtpLayers: 1 }, { extraArgs: '--spec-type ngram-simple' });
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.equal(after(run.starts()[0], '--spec-type'), 'ngram-simple', 'a --spec-type written by hand is left alone');
  // An engine whose help does not list them (the stand-in engine here is Node itself): nothing is added.
  run = make({ ...layers(20, 200), mtpLayers: 1 }, all.slice(0, 1), ['NVIDIA GeForce RTX 3060']);
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.ok(!run.starts()[0].includes('--spec-type'));

  // RAM. With every layer on this PC's cards, Windows gets the model file read, not memory-mapped
  // (mapped, a 30 GB model held 30 GB of a 40 GB PC's RAM), and the engine's own prompt cache is
  // kept to a tenth of the PC's RAM. Both only when the engine's help knows the options.
  const { promptCacheLimit, buildServerArgs: serverArgs } = require('../electron/lib/modelSettings.cjs');
  assert.deepEqual([8, 16, 40, 64, 128].map((gb) => promptCacheLimit(gb * 1024)), [1024, 1638, 4096, 6553, 8192]);
  assert.equal(promptCacheLimit(0), 1024);
  const fullHelp = `${help}\n-lm,   --load-mode MODE   model loading mode\n-cram, --cache-ram N   set the maximum cache size in MiB`;
  assert.deepEqual(speculationSupport(fullHelp), { mtp: true, ngram: true, loadMode: true, cacheRam: true });
  const onWindows = (info, list, settings = {}, platform = 'win32') => {
    const made = make(info, list, list.length > 1 ? names : ['NVIDIA GeForce RTX 3060']);
    Object.assign(made.manager, { platform, totalRam: () => 40 * 1024 * MiB, engineHelp: async () => fullHelp });
    made.manager.store.getEffectiveSettings = () => ({ contextSize: 8192, mtp: 'off', ngram: 'off', ...settings });
    return made;
  };
  // One card that holds the whole model: read, with the cache limit; a failed load is tried again mapped.
  run = onWindows(layers(20, 200), all.slice(0, 1));
  await assert.rejects(run.manager.ensureServer(model), /stopped while loading/);
  starts = run.starts();
  assert.equal(starts.length, 2, 'read whole, then memory-mapped');
  assert.ok(after(starts[0], '--load-mode') === 'none' && after(starts[0], '--cache-ram') === '4096', starts[0]);
  assert.ok(!starts[1].includes('--load-mode') && after(starts[1], '--cache-ram') === '4096', starts[1]);
  assert.match(run.lines.join('\n'), /the model file is read, not memory-mapped[\s\S]*the load failed with the model file read whole; loading again memory-mapped/);
  // Shared between several cards with room to spare: read too. Larger than the cards: mapped, as part of it stays in RAM.
  run = onWindows(layers(40, 480), all);
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.equal(after(run.starts()[0], '--load-mode'), 'none');
  assert.ok(!run.starts()[1].includes('--load-mode'), 'the fill plan may leave layers in RAM');
  run = onWindows(layers(80, 1000), all);
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.ok(!run.starts()[0].includes('--load-mode'));
  // A loading mode chosen by hand stays; so does a cache limit written in the extra arguments.
  run = onWindows(layers(20, 200), all.slice(0, 1), { loadMode: 'mmap+mlock', extraArgs: '--cache-ram 2048' });
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.equal(after(run.starts()[0], '--load-mode'), 'mmap+mlock');
  assert.deepEqual(run.starts()[0].split(' ').filter((arg) => arg === '--cache-ram').length, 1);
  assert.equal(after(run.starts()[0], '--cache-ram'), '2048');
  // Linux and macOS give a mapped file's pages back by themselves: nothing changes there.
  run = onWindows(layers(20, 200), all.slice(0, 1), {}, 'linux');
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.ok(!run.starts()[0].includes('--load-mode') && after(run.starts()[0], '--cache-ram') === '4096');
  // GPU layers set by hand may leave some on the CPU: mapped.
  run = onWindows(layers(20, 200), all.slice(0, 1), { gpuLayers: 10 });
  await assert.rejects(run.manager.startWithHelpers(model, runtimeConfig, 'key'), /stopped while loading/);
  assert.ok(!run.starts()[0].includes('--load-mode'));
  assert.ok(!serverArgs('m.gguf', {}, 'cuda').includes('--cache-ram') && !serverArgs('m.gguf', {}, 'cuda').includes('--load-mode'), 'nothing is added unless asked for');

  // A trial setting of null takes a saved setting away, and nothing of a trial is left afterwards.
  run = make(layers(40, 480), all);
  run.manager.store.getEffectiveSettings = () => ({ contextSize: 8192, gpuLayers: 20 });
  assert.equal(run.manager.settingsFor('big').gpuLayers, 20);
  run.manager.trialSettings = { gpuLayers: null };
  assert.equal('gpuLayers' in run.manager.settingsFor('big'), false);
  console.log('several graphics cards (readings, what the engine lists, the split and its fallbacks): OK');
}

/**
 * "Optimize and benchmark": the plans (what is tried for a model on a PC) and the rules for keeping
 * a result, then a whole run with a stand-in engine whose speeds are the ones measured on an RTX
 * 3060 with two Tesla P40.
 */
async function testOptimizer() {
  const { placementSteps, skipStep, threadCounts, fastest, contextTarget, keepContext } = require('../electron/lib/optimizer.cjs');
  const { chosenCards, cardChoice, localCards } = require('../electron/lib/placement.cjs');
  const { BenchmarkManager } = require('../electron/lib/benchmark.cjs');
  const names = ['Tesla P40', 'NVIDIA GeForce RTX 3060', 'Tesla P40'];
  const cards = localCards(parseDeviceList(['  CUDA0: NVIDIA GeForce RTX 3060 (12288 MiB, 11245 MiB free)', '  CUDA1: Tesla P40 (22937 MiB, 22781 MiB free)', '  CUDA2: Tesla P40 (22937 MiB, 22700 MiB free)'].join('\n')), names).used;
  const ids = (devices) => devices.map((device) => device.name).join(',');

  // The cards chosen for a model, by name: still the same cards when the engine numbers them
  // differently. The engine's own names, as 0.2.90 to 0.2.92 saved them, are still understood.
  assert.equal(ids(chosenCards(cards, 'Tesla P40,Tesla P40')), 'CUDA1,CUDA2');
  assert.equal(ids(chosenCards(cards, 'Tesla P40')), 'CUDA1', 'one of two alike: the one with more free memory');
  assert.equal(ids(chosenCards(cards, 'NVIDIA GeForce RTX 3060')), 'CUDA0');
  assert.equal(ids(chosenCards(cards, 'tesla p40, nvidia geforce rtx 3060')), 'CUDA0,CUDA1', "in the engine's order");
  assert.equal(ids(chosenCards(cards, 'CUDA1,CUDA2')), 'CUDA1,CUDA2', 'a choice saved by 0.2.92');
  assert.equal(ids(chosenCards(cards, '')), '');
  assert.equal(ids(chosenCards(cards, 'Tesla P40,Tesla P40,Tesla P40')), '', 'three wanted, two there: every card is used');
  assert.equal(ids(chosenCards(cards, 'CUDA7')), '');
  assert.equal(cardChoice(chosenCards(cards, 'CUDA1,CUDA2')), 'Tesla P40,Tesla P40');
  const renumbered = localCards(parseDeviceList(['  CUDA0: Tesla P40 (22937 MiB, 22781 MiB free)', '  CUDA1: Tesla P40 (22937 MiB, 22781 MiB free)', '  CUDA2: NVIDIA GeForce RTX 3060 (12288 MiB, 11245 MiB free)'].join('\n')), names).used;
  assert.equal(ids(chosenCards(renumbered, 'Tesla P40,Tesla P40')), 'CUDA0,CUDA1', 'the same two cards after the engine numbers them anew');
  assert.equal(ids(chosenCards(renumbered, 'NVIDIA GeForce RTX 3060')), 'CUDA2');

  // What is tried for a 30 GB model that uses all three cards one after the other.
  const labels = (steps) => steps.map((step) => step.label);
  let steps = placementSteps({ cards, needMB: 29646, overrides: {}, effective: {} });
  assert.deepEqual(labels(steps), ['All cards at the same time', '2× Tesla P40, one after the other', '2× Tesla P40 at the same time']);
  assert.deepEqual(steps[2].changes, { gpuCards: 'Tesla P40,Tesla P40', splitMode: 'tensor' });
  assert.deepEqual(steps[0].changes, { gpuCards: null, splitMode: 'tensor' });
  // With the two P40 at the same time already chosen, that is the baseline and is not tried again.
  steps = placementSteps({ cards, needMB: 29646, overrides: { gpuCards: 'Tesla P40,Tesla P40', splitMode: 'tensor' }, effective: { gpuCards: 'Tesla P40,Tesla P40', splitMode: 'tensor' } });
  assert.deepEqual(labels(steps), ['All cards, one after the other', 'All cards at the same time', '2× Tesla P40, one after the other']);
  // A 10 GB model also fits on one card of each kind; GPU layers set by hand are tried on automatic first.
  steps = placementSteps({ cards, needMB: 10000, overrides: { gpuLayers: 20 }, effective: { gpuLayers: 20 } });
  assert.deepEqual(labels(steps), ['GPU layers chosen by Uma', 'All cards at the same time', 'RTX 3060 alone', 'Tesla P40 alone', '2× Tesla P40, one after the other', '2× Tesla P40 at the same time']);
  assert.deepEqual(steps[2].changes, { gpuLayers: null, gpuCards: 'NVIDIA GeForce RTX 3060', splitMode: null });
  // One card, or helper PCs taking part: no cards to choose between.
  assert.deepEqual(placementSteps({ cards: cards.slice(0, 1), needMB: 5000 }), []);
  assert.deepEqual(placementSteps({ cards, needMB: 5000, helpers: true }), []);
  // When all the cards together were faster at the same time, a group is not tried one after the other.
  const group = { split: 'layer', devices: 2, all: false };
  assert.equal(skipStep(group, { layer: 6.6, tensor: 9.0 }), true);
  assert.equal(skipStep({ ...group, split: 'tensor' }, { layer: 6.6, tensor: 9.0 }), false);
  assert.equal(skipStep(group, { layer: 6.6 }), false, 'only one way measured: nothing is left out');
  assert.equal(skipStep({ split: 'layer', devices: 1, all: false }, { layer: 6.6, tensor: 9.0 }), false, 'one card alone is always tried');
  // Threads only when part of the model runs on the CPU.
  assert.deepEqual(threadCounts({ logical: 28, now: 28, allOnGpu: true }), []);
  assert.deepEqual(threadCounts({ logical: 28, now: 28, allOnGpu: false }), [14, 8]);
  assert.deepEqual(threadCounts({ logical: 8, now: 4, allOnGpu: false }), [8]);
  // Kept only when clearly faster (3%); a larger context when it loads whole and is no slower.
  const base = { label: 'now', write: 10 };
  assert.equal(fastest([{ label: 'a', write: 10.2 }, { label: 'b', write: null }], base), base);
  assert.equal(fastest([{ label: 'a', write: 10.4 }, { label: 'b', write: 12 }], base).label, 'b');
  assert.equal(contextTarget({ current: 20480, trained: 262144, fits: () => true }), 65536);
  assert.equal(contextTarget({ current: 20480, trained: 262144, fits: (size) => size <= 32768 }), 32768);
  assert.equal(contextTarget({ current: 20480, trained: 32768 }), 32768, 'never past what the model was trained for');
  assert.equal(contextTarget({ current: 65536, trained: 262144 }), 0, 'never smaller than it is');
  assert.equal(contextTarget({ current: 8192, trained: 16384 }), 0);
  assert.equal(keepContext({ write: 9.8, allOnGpu: true }, base), true);
  assert.equal(keepContext({ write: 9.6, allOnGpu: true }, base), false, 'slower with it');
  assert.equal(keepContext({ write: 10.5, allOnGpu: false }, base), false, 'layers left the cards');
  assert.equal(keepContext({ failed: true, write: null }, base), false);

  // A whole run. The stand-in engine answers with the speeds measured on the real cards; what it was
  // loaded with is read from the trial settings.
  const speeds = (trial) => {
    const tensor = trial.splitMode === 'tensor';
    const pair = trial.gpuCards === 'Tesla P40,Tesla P40';
    let write = pair ? (tensor ? 24.0 : 12.2) : (tensor ? 15.1 : 12.4);
    if (trial.mtp === 'off') write = pair && tensor ? 12.6 : write / 2;
    if (trial.contextSize === 65536) write += 0.3;
    return write;
  };
  const loads = [];
  let saved = null;
  const llama = {
    modelId: '', trialSettings: null, cards: { all: cards }, needMB: 29646, draft: null, speculation: { mtp: true, ngram: true },
    status: () => ({ running: false, helpers: { servers: [] } }),
    computeInfo: () => ({ offloadedLayers: 66, totalLayers: 66 }),
    freeVram: async () => 22781 * 1024 * 1024,
    async stop() {},
    async ensureServer() { loads.push({ ...llama.trialSettings }); },
    async complete({ maxTokens }) {
      // What the engine is loaded with: the model's settings with the trial on top (null takes one away).
      const loaded = { ...bench.store.getEffectiveSettings() };
      for (const [key, value] of Object.entries(llama.trialSettings || {})) { if (value === null) delete loaded[key]; else loaded[key] = value; }
      const write = speeds(loaded);
      return maxTokens === 1 ? { timings: { prompt_n: 1300, prompt_per_second: 256 } } : { timings: { predicted_n: maxTokens, predicted_per_second: write } };
    },
  };
  const info = { nLayer: 65, nEmbd: 5120, nHead: 24, nHeadKv: 4, keyLength: 256, valueLength: 256, attentionLayers: 17, contextLength: 262144, layerBytes: Array.from({ length: 65 }, () => 440 * 1024 * 1024), inputBytes: 300 * 1024 * 1024, otherBytes: 300 * 1024 * 1024, totalBytes: 29200 * 1024 * 1024 };
  const before = { threads: 28, ubatchSize: 1024, contextSize: 20480 };
  const bench = new BenchmarkManager({
    store: { getSettings: () => ({ modelOverrides: { big: before } }), getEffectiveSettings: () => ({ contextSize: 8192, ...before }), setModelOverrides: async (_id, next) => { saved = next; }, getBenchmarks: () => [] },
    models: { resolveActive: async () => ({ id: 'big', name: 'Big 27B' }), modelInfo: async () => info },
    runtime: { status: async () => ({ installed: true }) },
    llama,
    agent: () => false,
  });
  bench.execute = async ({ optimization }) => ({ optimization });
  let result = await bench.optimize({ signal: new AbortController().signal });
  assert.deepEqual(result.optimization.tried.map((entry) => `${entry.label}: ${entry.failed ? 'failed' : entry.write}${entry.kept ? ' kept' : ''}`), [
    'Current settings: 12.4',
    'All cards at the same time: 15.1',
    '2× Tesla P40 at the same time: 24 kept',
    'Without guessing ahead: 12.6',
    'Context of 65,536 tokens: 24.3 kept',
  ], 'the group is not tried one after the other, and threads are not tried with every layer on the cards');
  assert.deepEqual(result.optimization.kept, ['2× Tesla P40 at the same time', 'Context of 65,536 tokens']);
  assert.equal(result.optimization.tried[0].read, 256);
  assert.deepEqual(saved, { threads: 28, ubatchSize: 1024, contextSize: 65536, gpuCards: 'Tesla P40,Tesla P40', splitMode: 'tensor' }, 'what the model had is kept, with what was faster on top');
  assert.equal(llama.trialSettings, null, 'nothing of a trial is left in the engine');
  assert.ok(loads.every((trial) => trial.batchTuning === 'off' && trial.ubatchSize === 1024), 'the same batch size for every step');
  // Run again with what it saved: nothing is faster, and nothing is saved.
  saved = null;
  const after = { threads: 28, ubatchSize: 1024, contextSize: 65536, gpuCards: 'Tesla P40,Tesla P40', splitMode: 'tensor' };
  bench.store.getSettings = () => ({ modelOverrides: { big: after } });
  bench.store.getEffectiveSettings = () => ({ ...after });
  result = await bench.optimize({ signal: new AbortController().signal });
  assert.equal(result.optimization.changed, false);
  assert.deepEqual(result.optimization.kept, []);
  assert.equal(saved, null);
  // Cancelled half way: nothing is saved, and the trial is taken out of the engine.
  const stopper = new AbortController();
  llama.ensureServer = async () => { if (llama.trialSettings?.gpuCards === null) stopper.abort(); };
  bench.store.getSettings = () => ({ modelOverrides: { big: after } });
  await assert.rejects(bench.optimize({ signal: stopper.signal }), (err) => err.name === 'AbortError');
  assert.equal(saved, null);
  assert.equal(llama.trialSettings, null);
  console.log('optimize and benchmark (cards by name, the plans, what is kept, a whole run, a second run, a cancelled one): OK');
}

/**
 * Small things a PC with several cards and a chat that builds programs need: a card in a narrow
 * slot, a draft model that was removed, a program started by its bare name.
 */
async function testLooseEnds() {
  const { parseNvidiaCards } = require('../electron/lib/hardware.cjs');
  const { gpuReading } = require('../electron/lib/systemStats.cjs');
  const { fixStartProcess } = require('../electron/lib/tools.cjs');
  // PCIe lanes: only a card in a slot with fewer lanes than it can use is marked.
  const smi = ['Tesla P40, 23040, 22900, 9, 0, 4, 16', 'NVIDIA GeForce RTX 3060, 12288, 11800, 400, 3, 16, 16', 'Tesla P40, 23040, 22900, 9, 0, [N/A], [N/A]', ''].join('\r\n');
  const cards = parseNvidiaCards(smi);
  assert.deepEqual(cards.map((card) => [card.lanes, card.lanesMax]), [[4, 16], [16, 16], [0, 0]]);
  assert.deepEqual(gpuReading(cards).cards.map((card) => card.lanes || 0), [4, 0, 0]);
  assert.equal(gpuReading(cards).cards[0].lanesMax, 16);
  assert.equal(parseNvidiaCards('Tesla P40, 24576, 24210, 366, 0')[0].lanes, 0, 'an answer without the lanes still reads');
  // An nvidia-smi that does not know the two lane fields answers with an error and no cards: the
  // plain question is asked instead, and from then on only that one. (A fresh copy of the module,
  // so what it learns here does not stay with the other tests.)
  const hardwarePath = require.resolve('../electron/lib/hardware.cjs');
  const keptModule = require.cache[hardwarePath];
  delete require.cache[hardwarePath];
  const fresh = require('../electron/lib/hardware.cjs');
  require.cache[hardwarePath] = keptModule;
  if (process.platform !== 'darwin') {
    const asked = [];
    const oldSmi = async (_file, args) => { asked.push(args[0].includes('pcie') ? 'lanes' : 'plain'); return args[0].includes('pcie') ? '' : 'NVIDIA GeForce GTX 1060, 6144, 5900, 244, 7'; };
    assert.equal((await fresh.nvidiaCards(1000, oldSmi))[0].name, 'NVIDIA GeForce GTX 1060');
    assert.equal((await fresh.nvidiaCards(1000, oldSmi)).length, 1);
    assert.deepEqual(asked, ['lanes', 'plain', 'plain'], 'the lanes are asked for once');
  }

  // A draft model that was removed leaves the settings of the model it drafted for.
  const dir = path.join(root, 'loose-ends');
  await fsp.rm(dir, { recursive: true, force: true });
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  await store.setModelOverrides('big', { threads: 28, draftModelId: 'small', draftTokens: 8 });
  await store.setModelOverrides('other', { draftModelId: 'gone' });
  await store.setModelOverrides('third', { contextSize: 4096 });
  assert.equal(await store.forgetMissingDrafts(new Set(['big', 'small', 'other', 'third'])), 1);
  assert.deepEqual(store.getSettings().modelOverrides, { big: { threads: 28, draftModelId: 'small', draftTokens: 8 }, third: { contextSize: 4096 } }, 'a model whose only setting was the lost draft has none left');
  assert.equal(await store.forgetMissingDrafts(new Set(['big', 'third'])), 1);
  assert.deepEqual(store.getSettings().modelOverrides.big, { threads: 28 });
  assert.equal(await store.forgetMissingDrafts(new Set(['big', 'third'])), 0);

  // Start-Process: a program in the folder goes by its full path (Windows would start its own
  // taskmgr.exe), and the older fixes still hold.
  const folder = 'C:\\work\\my app';
  const there = (file) => file === `${folder}\\taskmgr.exe` || file === `${folder}\\run.bat`;
  assert.equal(fixStartProcess('Start-Process taskmgr.exe', folder, there), `Start-Process "${folder}\\taskmgr.exe"`);
  assert.equal(fixStartProcess('Start-Process "taskmgr.exe" -Wait', folder, there), `Start-Process "${folder}\\taskmgr.exe" -Wait`);
  assert.equal(fixStartProcess('Start-Process -FilePath run.bat', folder, there), `Start-Process -FilePath "${folder}\\run.bat"`);
  assert.equal(fixStartProcess('Start-Process notepad.exe', folder, there), 'Start-Process notepad.exe', 'not in the folder: Windows finds it');
  assert.equal(fixStartProcess('Start-Process .\\taskmgr.exe', folder, there), 'Start-Process .\\taskmgr.exe');
  assert.equal(fixStartProcess('Start-Process chrome --args https://example.com', folder, there), 'Start-Process chrome -ArgumentList https://example.com');
  assert.equal(fixStartProcess('Start-Process "C:\\Program Files\\Google\\Brave\\brave.exe"', folder, () => false), 'Start-Process brave');
  assert.equal(fixStartProcess('Get-Process taskmgr.exe', folder, there), 'Get-Process taskmgr.exe');
  // A program of the folder called by its bare name gets the ".\" PowerShell wants (a real model
  // ran "hello.exe" right after compiling it, and the command failed).
  const { fixLocalProgram } = require('../electron/lib/tools.cjs');
  assert.equal(fixLocalProgram('taskmgr.exe', folder, there), '.\\taskmgr.exe');
  assert.equal(fixLocalProgram('run.bat --fast "a b"', folder, there), '.\\run.bat --fast "a b"');
  assert.equal(fixLocalProgram('notepad.exe notes.txt', folder, there), 'notepad.exe notes.txt', 'not in the folder: left to Windows');
  assert.equal(fixLocalProgram('.\\taskmgr.exe', folder, there), '.\\taskmgr.exe');
  assert.equal(fixLocalProgram('node taskmgr.exe', folder, there), 'node taskmgr.exe', 'only the program that is called');
  console.log('a card in a narrow slot, a removed draft model, a program started by its bare name: OK');
}

/**
 * Getting ready while the user types: the engine reads Uma's instructions before the first message,
 * the very ones that message is then sent with, and never over what a chat left in the engine.
 */
async function testWarmAhead() {
  const { LlamaManager } = require('../electron/lib/llama.cjs');
  const dir = path.join(root, 'warm');
  await fsp.rm(dir, { recursive: true, force: true });
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  const workspaceDir = path.join(dir, 'workspace');
  await ensureDir(workspaceDir);
  await fsp.writeFile(path.join(workspaceDir, 'notes.txt'), 'hello\n');
  const workspace = new Workspace({ root: workspaceDir, trash: () => {} });
  await workspace.init();
  const conversations = new ConversationStore(path.join(dir, 'conversations'));
  await conversations.init();
  const make = ({ fresh = true, remembered = false } = {}) => {
    const seen = { warmed: [], calls: [], loads: 0 };
    let done;
    const finished = new Promise((resolve) => { done = resolve; });
    const agent = new AgentRunner({
      store, workspace, conversations,
      models: { resolveActive: async () => ({ id: 'mock', name: 'Mock', family: 'Test' }) },
      toolRunner: new ToolRunner({ workspace, store, onChanged: () => {} }),
      llama: {
        generation: 1,
        async ensureServer() { seen.loads += 1; },
        canWarm: () => fresh,
        hasMemoryOf: async () => remembered,
        warm: async (messages) => { seen.warmed.push(messages); return true; },
        async *streamChat(request) { seen.calls.push(request); yield { type: 'text', text: 'Hello.' }; yield { type: 'finish', reason: 'stop' }; },
      },
      send: (_channel, payload) => { if (payload?.type === 'assistant-end') done(payload.message); },
    });
    return { agent, seen, finished };
  };
  // A new chat: what is read ahead is word for word the instructions the first message goes out with.
  let chat = make();
  const conversation = await conversations.create();
  assert.equal(await chat.agent.warm(conversation.id), true);
  assert.equal(chat.seen.loads, 1, 'the model is loaded if it was asleep');
  assert.deepEqual(chat.seen.warmed[0].map((message) => message.role), ['system', 'user']);
  await chat.agent.send(conversation.id, 'hello there');
  await chat.finished;
  assert.equal(chat.seen.calls[0].messages[0].content, chat.seen.warmed[0][0].content, 'the same instructions, so the engine reuses what it read');
  assert.ok(chat.seen.warmed[0][0].content.length > 1500);
  // With no chat open yet, the instructions of a new chat are read.
  chat = make();
  assert.equal(await chat.agent.warm(null), true);
  const fresh = await conversations.create();
  await chat.agent.send(fresh.id, 'hi');
  await chat.finished;
  assert.equal(chat.seen.calls[0].messages[0].content, chat.seen.warmed[0][0].content);
  // An engine that has read something, or a chat whose memory is on disk: nothing is read ahead.
  chat = make({ fresh: false });
  assert.equal(await chat.agent.warm(conversation.id), false);
  assert.equal(chat.seen.warmed.length, 0);
  chat = make({ remembered: true });
  assert.equal(await chat.agent.warm(conversation.id), false);
  assert.equal(chat.seen.warmed.length, 0);
  // While a reply is being written, nothing is read ahead either.
  chat = make();
  chat.agent.current = { conversationId: conversation.id, controller: new AbortController() };
  assert.equal(await chat.agent.warm(conversation.id), false);
  assert.equal(chat.seen.loads, 0);

  // The engine's side, with a stand-in engine that answers slowly: one reading per load, a message
  // sent meanwhile waits for it, and an engine that holds a chat is left alone.
  const order = [];
  const engine = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const sent = JSON.parse(body);
      const warming = sent.max_tokens === 1 && sent.stream === false && sent.cache_prompt === true;
      order.push(warming ? 'warm:start' : 'chat:start');
      setTimeout(() => {
        order.push(warming ? 'warm:end' : 'chat:end');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], timings: { prompt_n: 3701, predicted_n: 1 } }));
      }, warming ? 250 : 10);
    });
  });
  await new Promise((resolve) => engine.listen(0, '127.0.0.1', resolve));
  try {
    const manager = new LlamaManager({ store: { getRuntime: () => ({}), getEffectiveSettings: () => ({}), getSettings: () => ({}) }, runtime: {}, logsDir: dir, modelInfo: async () => null });
    const lines = [];
    manager.log = (line) => lines.push(line);
    Object.assign(manager, { state: 'ready', port: engine.address().port, apiKey: 'k', generation: 3, idleMinutes: 0 });
    const messages = [{ role: 'system', content: 'instructions' }, { role: 'user', content: '.' }];
    assert.equal(manager.canWarm(), true);
    const warming = manager.warm(messages);
    assert.equal(manager.canWarm(), false, 'not twice at once');
    const reply = manager.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(await warming, true);
    await reply;
    assert.deepEqual(order, ['warm:start', 'warm:end', 'chat:start', 'chat:end'], 'the message waited for the reading to end');
    assert.match(lines.join('\n'), /read the instructions ahead of the first message: 3701 tokens/);
    assert.equal(await manager.warm(messages), false, 'once per load');
    manager.generation = 4;
    manager.promptCache = { key: 'k', owner: 'c_1', dirty: false };
    assert.equal(manager.canWarm(), false, 'the engine holds a chat');
    manager.promptCache = { key: 'k', owner: null, dirty: false };
    assert.equal(manager.canWarm(), true, 'a new load that holds no chat');
    manager.state = 'stopped';
    assert.equal(await manager.warm(messages), false);
    clearTimeout(manager.idleTimer);
    clearTimeout(manager.promptSaveTimer);
  } finally {
    await new Promise((resolve) => engine.close(resolve));
  }
  console.log('getting ready while the user types (the same instructions, never over a chat, one reading per load): OK');
}

/**
 * A chat that built a program stays about that program. The user's report (2026-11-19, "Make an
 * taskmanager in C++ and make the exe"): after the first build, "i want a GUI exe version like
 * windows 7 taskmanager" was read as plain talk, the tools that write files were taken away, the
 * model pasted the program into the chat for six replies, and then answered "where is the exe?"
 * with a folder that did not exist.
 */
function testWorkChat() {
  const { COMMAND_IN_CHAT_RE } = require('../electron/lib/agentChecks.cjs');
  const work = { priorUsedTools: true };
  const read = (text, options = work) => { const task = classifyTask(text, options); return [Boolean(task.agentic), Boolean(task.wantsEdit), Boolean(task.asksOnly)].join(); };
  // What is wanted, said without a verb Uma knows, or with a typo in it.
  assert.equal(read('i want a GUI exe version like windows 7 taskmanager'), 'true,true,false');
  assert.equal(read('reamke it to looks like windows xp'), 'true,true,false');
  assert.equal(read('remake it looking like windows xp'), 'true,true,false');
  assert.equal(read('there is nothing'), 'true,true,false');
  // A question about what the work made is answered by looking, and changes nothing.
  assert.equal(read('where is the exe?'), 'true,false,true');
  // "continue" resumes that request as it was read: work on the files, and a change.
  const resumed = classifyTask('continue', { priorTask: 'i want a GUI exe version like windows 7 taskmanager', priorUsedTools: true });
  assert.deepEqual([resumed.isContinue, resumed.agentic, resumed.wantsEdit, resumed.workChat], [true, true, true, true]);
  // The same words in a chat that never touched a file stay plain talk.
  const none = { priorUsedTools: false };
  assert.equal(read('i want a pizza recipe like the one from Naples', none), 'false,false,false');
  assert.equal(read('there is nothing', none), 'false,false,false');
  assert.equal(read('thanks, that works'), 'false,false,false');
  assert.equal(read('tell me a joke'), 'false,false,false');
  // A command written into the chat where it was meant to be run.
  assert.match('The build output folder doesn\'t exist yet. Let me rebuild the project to generate the executable.\n\n```powershell\ncd "C:\\Users\\me\\Documents\\Uma LLM"\n& "C:\\Program Files\\MSBuild.exe" TaskManager.vcxproj /p:Configuration=Release\n```', COMMAND_IN_CHAT_RE);
  assert.match('Let me check the current state of the workspace and rebuild.\n\n```powershell\nGet-ChildItem -Recurse | Select-Object FullName\n```', COMMAND_IN_CHAT_RE);
  assert.doesNotMatch('To build it yourself, run this in the project folder:\n\n```powershell\nmsbuild TaskManager.vcxproj\n```', COMMAND_IN_CHAT_RE);
  assert.doesNotMatch('Let me explain how the loop works.\n\n```cpp\nfor (int i = 0; i < n; i += 1) { total += values[i]; }\n```', COMMAND_IN_CHAT_RE);
  // Microsoft's compiler called the three ways that fail in PowerShell (the user's second chat,
  // 2026-11-20): each is recognised, so Uma can run it inside Visual Studio's environment.
  const { compilerCall } = require('../electron/lib/tools.cjs');
  assert.equal(compilerCall('cl taskmgr.cpp /link /subsystem:windows /out:taskmgr.exe'), 'cl taskmgr.cpp /link /subsystem:windows /out:taskmgr.exe');
  assert.equal(compilerCall('& "C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\cl.exe" taskmgr.cpp /link /out:a.exe'), 'cl taskmgr.cpp /link /out:a.exe');
  assert.equal(compilerCall('& "C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat" && cl taskmgr.cpp /Fe:a.exe'), 'cl taskmgr.cpp /Fe:a.exe');
  assert.equal(compilerCall('& "C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe" a.vcxproj'), '');
  assert.equal(compilerCall('clang main.c'), '');
  assert.equal(compilerCall('Get-ChildItem cl.exe'), '');
  // A second command after the compiler stays in PowerShell and runs when the compiler built.
  const { splitAfterCompiler } = require('../electron/lib/tools.cjs');
  assert.deepEqual(splitAfterCompiler('cl hello.cpp /Fe:hello.exe; .\\hello.exe'), { compile: 'cl hello.cpp /Fe:hello.exe', rest: '.\\hello.exe' });
  assert.deepEqual(splitAfterCompiler('cl hello.cpp /Fe:hello.exe && .\\hello.exe'), { compile: 'cl hello.cpp /Fe:hello.exe', rest: '.\\hello.exe' });
  assert.deepEqual(splitAfterCompiler('cl /D "NAME=a;b" hello.cpp'), { compile: 'cl /D "NAME=a;b" hello.cpp', rest: '' }, 'a ; inside quotes belongs to the compiler');
  assert.deepEqual(splitAfterCompiler(''), { compile: '', rest: '' });
  // What a window shows, quoted, after only the small picture: a real model read "65031 MB" off a 40 GB PC.
  const { QUOTES_SCREEN_RE } = require('../electron/lib/agentChecks.cjs');
  assert.match('The XP-style Task Manager is built and running. You can see it in the top-left of the screen — it shows a list of processes, plus a memory bar at the bottom showing "28471 MB / 65031 MB (27%)".', QUOTES_SCREEN_RE);
  assert.match('The title bar reads “Task Manager”.', QUOTES_SCREEN_RE);
  assert.doesNotMatch('The program is built. Start xpTaskMgr.exe from the folder to see it.', QUOTES_SCREEN_RE);
  assert.doesNotMatch('You can see the full code in taskmgr.cpp.', QUOTES_SCREEN_RE);
  assert.doesNotMatch('The build output shows "0 errors, 0 warnings".', QUOTES_SCREEN_RE, 'what a command printed is not the screen');
  console.log('a chat that built a program stays about it (wants, typos, questions, continue, commands pasted in chat, compiler calls, quoted screens): OK');
}

async function testOtherLanguages() {
  const kind = (text) => {
    const task = classifyTask(text);
    return [Boolean(task.agentic), Boolean(task.wantsEdit), Boolean(task.asksOnly), Boolean(task.isContinue)].join();
  };
  // A request in Chinese (simplified and traditional) or Japanese is read like its English form.
  const requests = [
    ['make a website for my bakery', '给我的面包店做一个网站', '幫我的麵包店做一個網站', '私のパン屋のウェブサイトを作ってください'],
    ['fix the bug in the login form', '修复登录表单里的bug', '修復登入表單裡的bug', 'ログインフォームのバグを修正してください'],
    ['add a contact page to the site', '给网站添加一个联系页面', '為網站新增一個聯絡頁面', 'サイトに連絡先ページを追加して'],
    ['write the tests for this file', '为这个文件编写测试', '為這個檔案編寫測試', 'このファイルのテストを書いて'],
    ['explain this project', '解释一下这个项目', '解釋一下這個專案', 'このプロジェクトを説明して'],
    ['what is this project?', '这个项目是什么？', '這個專案是什麼？', 'このプロジェクトは何ですか？'],
    ['did you fix the bug in main.cpp?', '你修复了main.cpp里的bug吗？', '你修復了main.cpp裡的bug嗎？', 'main.cppのバグを修正しましたか？'],
    ['how do I create a website?', '怎么创建网站？', '怎麼建立網站？', 'ウェブサイトはどうやって作りますか？'],
    ['what is the capital of France?', '法国的首都是什么？', '法國的首都是什麼？', 'フランスの首都はどこですか？'],
    ['can you add a button to my site?', '你能在我的网站上添加一个按钮吗？', '你能在我的網站上新增一個按鈕嗎？', '私のサイトにボタンを追加してもらえますか？'],
    ['tell me a joke', '讲个笑话', '講個笑話', 'ジョークを言って'],
    ['thanks, that works', '谢谢，可以了', '謝謝，可以了', 'ありがとう、動きました'],
    ['continue', '继续', '繼續', '続けて'],
    ['is the performance ok?', '性能有问题吗？', '效能有問題嗎？', '性能は大丈夫ですか？'],
  ];
  for (const [english, ...others] of requests) {
    for (const other of others) assert.equal(kind(other), kind(english), `"${other}" is read like "${english}" (${englishGist(other)})`);
  }
  assert.equal(englishGist('你修复了main.cpp里的bug吗？').includes('main.cpp'), true, 'a file name keeps its spelling');

  // What a reply says, whatever language the model answers in. Each of these was unchecked before:
  // the checks only knew English.
  const sayings = [
    ['claims a change', (text) => claims(CLAIMS_CHANGE_RE, text), true, [
      'I have fixed the bug in main.cpp.',
      'Ho corretto il bug in main.cpp.', 'Ho già aggiornato il file index.html.', 'Il file è stato aggiornato.', 'Ho aggiunto la funzione e modificato lo stile.', 'La build è riuscita.', 'Ora è corretto.',
      'He corregido el error en main.cpp.', 'El archivo ha sido actualizado.', 'Se ha actualizado el archivo.', 'Ya he añadido la función.',
      '我已经修复了main.cpp中的bug。', '文件已更新。', '我添加了一个新函数。', '构建成功。', '已創建檔案 index.html。',
      'main.cppのバグを修正しました。', 'ファイルが更新されました。', 'ビルドに成功しました。', '関数を追加しました。',
    ]],
    // A denial, a condition, a question, an offer or an explanation is not a claim.
    ['claims a change', (text) => claims(CLAIMS_CHANGE_RE, text), false, [
      'Non ho modificato nulla.', 'Se vuoi, posso correggere il bug.', 'Hai corretto il bug?', 'Potrei aggiungere una funzione.', 'Il file non è stato aggiornato.', 'Per correggerlo devi aggiornare il file.',
      'Il codice è corretto e ben organizzato.', 'Il file è aggiornato all\'ultima versione.', 'La funzione aggiorna lo stato quando clicchi il pulsante.',
      'No he modificado nada.', 'Si quieres, puedo corregir el error.', 'Podría añadir una función.', 'El código es correcto y está bien organizado.',
      '我没有修改任何文件。', '如果需要，我可以修复这个bug。', '你修复了吗？', '尚未更新文件。', '这个函数用于更新界面状态。', '要添加页面，请创建一个html文件。',
      '何も変更していません。', '必要であれば、バグを修正できます。', '修正しましたか？', 'この関数は画面の状態を更新します。', 'ページを追加するには、htmlファイルを作成してください。',
    ]],
    ['names a tool as used', (text) => toolsClaimed(text).includes('read_file'), true, [
      'Ho usato read_file per leggere il file.', 'Ho usato lo strumento read_file.', 'He usado read_file.', '我使用了read_file工具。', 'read_fileを使用しました。',
    ]],
    ['says the file is not there', (text) => saysMissing(text, 'electron/main.cjs'), true, [
      'Il file electron/main.cjs non esiste.', 'Non ho trovato main.cjs.', 'El archivo electron/main.cjs no existe.', 'electron/main.cjs 不存在。', 'electron/main.cjs は存在しません。',
    ]],
    ['asks what is on the screen', asksToSee, true, [
      'cosa vedi?', 'riesci a vedere il mio schermo?', 'guarda il mio schermo', '¿qué ves?', '¿puedes ver mi pantalla?', '你能看到什么？', '你能看到我的屏幕吗？', '何が見えますか？', '画面が見えますか？',
    ]],
    ['says it sees the screen', (text) => says(REPLY_CHECKS.sight, text), true, [
      'Vedo la finestra del browser.', 'Posso vedere il tuo schermo.', 'Ecco cosa vedo.', 'La pagina mostra un elenco.', 'Veo la pantalla del navegador.', '我看到屏幕上有一个浏览器窗口。', '屏幕上显示了一个错误。', '画面にブラウザのウィンドウが見えます。',
    ]],
    ['says it cannot click', (text) => says(REPLY_CHECKS.cannotInput, text), true, [
      'Non posso cliccare sul pulsante.', 'Non sono in grado di controllare il mouse.', 'No puedo hacer clic en el botón.', '我无法点击按钮。', 'ボタンをクリックできません。',
    ]],
    ['says it clicks, with no tool for it', (text) => says(REPLY_CHECKS.pretendsInput, text), true, [
      'Ora clicco sul pulsante.', 'Cliccherò sul link.', 'Lasciami cliccare sulla casella.', '我点击了搜索框。', '我将点击这个按钮。',
    ]],
    ['says it is done', (text) => says(REPLY_CHECKS.done, text), true, [
      'Ho aperto YouTube.', 'Ho cliccato sul video.', 'Il video è ora in riproduzione.', 'Il compito è completato.', 'He abierto YouTube.', '我已经打开了YouTube。', '视频正在播放。', 'YouTubeを開きました。', '動画を再生しています。', '検索ボックスをクリックしました。',
    ]],
    ['announces a next step', (text) => says(REPLY_CHECKS.nextStep, text), true, [
      'Ora leggerò il file.', 'Adesso devo controllare il codice.', 'Vediamo cosa contiene il file.', 'Ahora voy a leer el archivo.', '接下来我会检查文件。', '让我看一下这个文件。', '次にファイルを確認します。',
    ]],
    ['announces a next step', (text) => says(REPLY_CHECKS.nextStep, text), false, [
      'Il file contiene tre funzioni.', 'Grazie per la pazienza.', '这个文件包含三个函数。', 'ご確認をお願いします。', 'この関数は画面の状態を更新します。',
    ]],
    ['offers, and waits for an answer', (text) => says(REPLY_CHECKS.offers, text), true, [
      'Vuoi che corregga il bug?', 'Devo procedere con la modifica?', 'Fammi sapere se vuoi che continui.', '¿Quieres que corrija el error?', '需要我修复它吗？', '修正しましょうか？',
    ]],
    ['says the build worked', (text) => says(REPLY_CHECKS.build, text), true, [
      'La build è riuscita.', 'Compila senza errori.', 'La compilación fue exitosa.', '编译成功。', 'ビルドが成功しました。',
    ]],
    ['agrees', (text) => says(REPLY_CHECKS.agrees, text), true, ['sì', 'sí', 'vale', '好的', 'はい', 'はい、お願いします']],
    ['asks what was said in the chat', (text) => says(REPLY_CHECKS.recall, text), true, [
      'cosa ricordi di questa chat?', '¿qué recuerdas de este chat?', '你还记得我们聊了什么吗？', '总结一下这次对话', 'この会話を要約して', '覚えていますか？',
    ]],
  ];
  for (const [label, check, wanted, texts] of sayings) {
    for (const text of texts) assert.equal(Boolean(check(text)), wanted, `${label} (${wanted}): "${text}" read as "${englishGist(text)}"`);
  }
  // French, German and Portuguese: the same two tables, in scripts/test-languages.json (a request
  // in English and how it is asked in each language; what a reply says, and whether it should count).
  const more = JSON.parse(await fsp.readFile(path.join(__dirname, 'test-languages.json'), 'utf8'));
  for (const [english, ...others] of more.requests) {
    for (const other of others) assert.equal(kind(other), kind(english), `"${other}" is read like "${english}" (${englishGist(other)})`);
  }
  const named = {
    change: (text) => claims(CLAIMS_CHANGE_RE, text), tool: (text) => toolsClaimed(text).includes('read_file'), missing: (text) => saysMissing(text, 'electron/main.cjs'), asksSee: asksToSee,
    sight: (text) => says(REPLY_CHECKS.sight, text), cannotInput: (text) => says(REPLY_CHECKS.cannotInput, text), pretendsInput: (text) => says(REPLY_CHECKS.pretendsInput, text),
    done: (text) => says(REPLY_CHECKS.done, text), nextStep: (text) => says(REPLY_CHECKS.nextStep, text), offers: (text) => says(REPLY_CHECKS.offers, text),
    build: (text) => says(REPLY_CHECKS.build, text), agrees: (text) => says(REPLY_CHECKS.agrees, text), recall: (text) => says(REPLY_CHECKS.recall, text),
  };
  for (const [name, wanted, texts] of more.sayings) {
    for (const text of texts) assert.equal(Boolean(named[name](text)), wanted, `${name} (${wanted}): "${text}" read as "${englishGist(text)}"`);
  }
  // One language does not take another's text: these are read as before the three were added.
  for (const [text, reading] of [
    ['Ho corretto il bug in main.cpp.', /^i fixed the bug in main\.cpp\.$/], ['togli lo sfondo da index.html', /^remove /], ['aggiungi le pagine al sito', /^add the pages to the website$/],
    ['añade dos botones a la página', /^add /], ['El archivo ha sido actualizado.', /has been updated/], ['il file é stato aggiornato', /updated/],
  ]) assert.match(englishGist(text), reading, text);
  // English is read as it was written, and code between fences is never read as prose.
  for (const text of ['I have fixed the bug in main.cpp.', 'He said the file is missing.', 'Let me check the file.', 'The build succeeded.',
    'Was the test page updated in the last build?', 'The process will die if the war file is missing, so restart it.', 'This project uses the MIT license and has no tests.',
    'Um, so the button is not working on the site.', 'Put the aux cable in, et voila: it is done.']) assert.equal(englishGist(text), text);
  assert.match(englishGist('Ecco il codice:\n```js\nfor (let i = 0; i < 3; i++) console.log(i)\n```\nHo aggiunto il ciclo.'), /for \(let i = 0; i < 3; i\+\+\) console\.log\(i\)[\s\S]*i added/);

  // Through the agent: a model answers that it fixed the bug, having touched nothing. Uma does not
  // pass that on as done: it tells the model nothing was changed, and marks the text for the user.
  // The same reply gets the same treatment in every language.
  const dir = path.join(root, 'languages');
  await fsp.rm(dir, { recursive: true, force: true });
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  await store.updateSettings({ allowEdits: true });
  const workspaceDir = path.join(dir, 'workspace');
  await ensureDir(workspaceDir);
  await fsp.writeFile(path.join(workspaceDir, 'main.cpp'), 'int main() { return 1; }\n');
  const workspace = new Workspace({ root: workspaceDir, trash: () => {} });
  await workspace.init();
  const tools = new ToolRunner({ workspace, store, onChanged: () => {} });
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
  // What Uma marked in the reply: the text it set aside as a claim, and the answer it kept.
  const marks = (message) => message.blocks.map((block) => block.unchecked).filter(Boolean).join();
  const english = await chat(['I have fixed the bug in main.cpp: it now returns 0.', 'I have not changed anything yet: the file returns 1.'], 'fix the bug in main.cpp');
  assert.match(marks(english.message), /^claimed/);
  for (const [request, lie, truth] of [
    ['correggi il bug in main.cpp', 'Ho corretto il bug in main.cpp: ora restituisce 0.', 'Non ho ancora modificato nulla: il file restituisce 1.'],
    ['corrige el error en main.cpp', 'He corregido el error en main.cpp: ahora devuelve 0.', 'Todavía no he modificado nada: el archivo devuelve 1.'],
    ['修复main.cpp里的bug', '我已经修复了main.cpp中的bug。', '我还没有修改任何文件。'],
    ['main.cppのバグを修正してください', 'main.cppのバグを修正しました。', 'まだ何も変更していません。'],
    ['corrige le bug dans main.cpp', "J'ai corrigé le bug dans main.cpp : il renvoie maintenant 0.", "Je n'ai encore rien modifié : le fichier renvoie 1."],
    ['behebe den Fehler in main.cpp', 'Ich habe den Fehler in main.cpp behoben: Es gibt jetzt 0 zurück.', 'Ich habe noch nichts geändert: Die Datei gibt 1 zurück.'],
    ['corrija o bug em main.cpp', 'Corrigi o bug em main.cpp: agora retorna 0.', 'Ainda não modifiquei nada: o arquivo retorna 1.'],
  ]) {
    const run = await chat([lie, truth], request);
    assert.ok(run.calls.length >= 2, `"${lie}" was not let through`);
    assert.match(run.calls[1].messages.at(-1).content, /Nothing was changed/);
    assert.equal(await fsp.readFile(path.join(workspaceDir, 'main.cpp'), 'utf8'), 'int main() { return 1; }\n');
    assert.equal(run.calls.length, english.calls.length, request);
    assert.equal(marks(run.message), marks(english.message), `"${lie}" is marked like the English one`);
  }
  console.log('requests and replies in Italian, Spanish, French, German, Portuguese, Chinese and Japanese are checked like English ones: OK');
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
  await testSkillWorkflow();
  await testOtherLanguages();
  await testRealModelFixes();
  await testDocuments();
  await testSeeing();
  await testSeveralGraphicsCards();
  await testOptimizer();
  await testLooseEnds();
  await testWarmAhead();
  testWorkChat();
  testPromptSize();
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
