// Real-model test of whole tasks, in English, Italian and Chinese: the agent loop, the skills and
// the engine exactly as the app uses them, on a model already installed in the app. Each task runs in
// its own throwaway workspace in the system's temporary folder (uma-llm-e2e-tasks); your folders,
// chats and settings are only read. Not under this repository: a command the model runs there, such
// as git or npm, would act on the repository around it (a model once committed a test file to it).
//
//   node scripts/e2e-tasks.cjs                       lists the installed models
//   node scripts/e2e-tasks.cjs qwen3.8-9b            runs the tasks on that model (part of its name)
//   node scripts/e2e-tasks.cjs qwen3.8-9b --samples 3 --against HEAD
//
//   --samples N     each task N times (default 1). A local model is not the same twice: 3 says more.
//   --against REF   also runs the code of that git commit or tag, and shows both side by side:
//                   did a change make Uma better or worse with a real model?
//   --only LIST     some tasks (fix-en,page-it) or a group of them: files, terminal, internet,
//                   skills (work only a connector could do), system (full PC access), screen,
//                   documents (a Word file; with --screen also PDF files, which the app prints)
//   --screen        also the tasks about seeing (a page as a picture, the screen): the script then
//                   runs as a windowless Electron app, and the model needs a vision file
//   --input         with --screen: also the task in which the model uses the REAL mouse and
//                   keyboard, in a small window this script opens. Hands off both while it runs
//                   (about two minutes); pushing the pointer into the top-left corner stops it.
//   --on LIST       permissions turned on for every task: terminal, internet, delete, system.
//                   "--on terminal,internet,delete" is Uma with most switches on: a longer prompt and
//                   more tools to choose from. Tasks of the terminal and internet groups turn their
//                   own switch on; they run real commands in the throwaway folder and need a connection.
//   --context N     context length (default 8192, what Uma starts with)
//   --ask "TEXT"    your own request instead of the tasks, to replay a chat that went wrong
//   --trace         prints every step of each reply: tools, text set aside, and the answer shown
//
// Uma must be closed: a second loaded model would not fit, and would skew the times.
// Not part of npm test: it needs a model and takes a few minutes.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { execFileSync, spawnSync } = require('node:child_process');

const repo = path.join(__dirname, '..');
const root = process.env.UMA_E2E_DIR || path.join(os.tmpdir(), 'uma-llm-e2e-tasks');
// And git never looks for a repository above the tasks' folders, wherever they are.
process.env.GIT_CEILING_DIRECTORIES = root;
const appData = process.env.UMA_APPDATA || {
  win32: path.join(process.env.APPDATA || os.homedir(), 'Uma LLM'),
  darwin: path.join(os.homedir(), 'Library', 'Application Support', 'Uma LLM'),
}[process.platform] || path.join(os.homedir(), '.config', 'Uma LLM');

const argv = process.argv.slice(2);
const option = (name, fallback = '') => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] || '' : fallback;
};
const flags = new Set(['samples', 'against', 'only', 'context', 'ask', 'on']);
const wanted = argv.filter((arg, index) => !arg.startsWith('--') && !flags.has(String(argv[index - 1] || '').slice(2)))[0] || '';
const samples = Math.max(1, Number(option('samples', 1)) || 1);
const against = option('against');
const only = option('only').split(',').map((item) => item.trim()).filter(Boolean);
const SWITCHES = { terminal: 'allowShell', internet: 'allowInternet', delete: 'allowDelete', system: 'allowSystemAccess', screen: 'allowScreen', input: 'allowInput' };
// A place outside every task's folder, for the tasks about full PC access.
const outside = path.join(root, 'outside');
const SECRET = 'the heron lands at seven';
const alwaysOn = option('on').split(',').map((item) => item.trim()).filter(Boolean);
for (const name of alwaysOn) {
  if (!SWITCHES[name]) { console.log(`--on knows: ${Object.keys(SWITCHES).join(', ')}`); process.exit(1); }
}
const contextSize = Number(option('context', 8192)) || 8192;
const ask = option('ask');
const trace = argv.includes('--trace');

// The skill library is a folder when built here, and one .asar file otherwise. Plain Node cannot
// read inside an .asar; Electron can, so the script starts itself again under Electron.
const libraryFolder = path.join(repo, 'build', 'skill-library');
const libraryArchive = path.join(repo, 'build', 'skill-library.asar');
// With --screen it runs as a real (windowless) Electron app instead, because taking a picture of
// the screen or of a page needs Electron itself.
const wantsScreen = argv.includes('--screen');
if (!process.versions.electron && (wantsScreen || (!fs.existsSync(libraryFolder) && fs.existsSync(libraryArchive)))) {
  const env = { ...process.env };
  if (wantsScreen) delete env.ELECTRON_RUN_AS_NODE;
  else env.ELECTRON_RUN_AS_NODE = '1';
  const run = spawnSync(require('electron'), [__filename, ...argv], { stdio: 'inherit', env });
  process.exit(run.status ?? 1);
}
const asApp = Boolean(process.versions.electron) && !process.env.ELECTRON_RUN_AS_NODE;
const libraryDir = fs.existsSync(libraryFolder) ? libraryFolder : fs.existsSync(libraryArchive) ? libraryArchive : '';

const CALC = 'function add(a, b) {\n  return a - b;\n}\n\nfunction multiply(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, multiply };\n';
const CALC_TEST = "const assert = require('node:assert');\nconst { add, multiply } = require('./calc');\n\nassert.strictEqual(add(2, 3), 5, 'add(2, 3) should be 5');\nassert.strictEqual(multiply(2, 3), 6, 'multiply(2, 3) should be 6');\nconsole.log('all tests passed');\n";
const filesIn = async (dir) => (await fsp.readdir(dir, { recursive: true })).map((name) => name.replace(/\\/g, '/')).filter((name) => !/^\.(?:uma|git)(?:\/|$)/.test(name)).sort();
const ran = (tools, name) => tools.some((block) => block.name === name && block.status !== 'error');
const passes = (dir) => spawnSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).status === 0;
const nodeVersion = () => { try { return execFileSync('node', ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, ''); } catch { return ''; } };
// llama.cpp tags its builds b12345 (pre-releases) and its releases v1.0.0: either is a tag the model read.
const RELEASE_TAG = /\bb\d{4,5}\b|\bv\d+\.\d+\.\d+\b/;
const saysOff =(reply, what) => what.test(reply) && /\boff\b|disabled|not (?:enabled|available|allowed)|enable|turn(?:ed)? on|settings|disattivat|spent|attiva|impostazioni/i.test(reply);
const read = (dir, name) => fsp.readFile(path.join(dir, name), 'utf8').catch(() => '');
const fixed = async (dir) => /return\s+a\s*\+\s*b/.test(await read(dir, 'calc.js'));
const untouched = async (dir) => (await read(dir, 'calc.js')) === CALC && (await filesIn(dir)).join() === 'calc.js';
const made = (pattern) => async (dir) => (await filesIn(dir)).some((name) => pattern.test(name));

// Every task starts from a folder with one file, calc.js, whose add() subtracts.
const TASKS = [
  { id: 'fix-en', ask: 'fix the bug in calc.js: add() returns the wrong result', ok: fixed },
  { id: 'fix-it', ask: 'correggi il bug in calc.js: add() restituisce il risultato sbagliato', ok: fixed },
  { id: 'fix-zh', ask: '修复 calc.js 里的 bug：add() 返回了错误的结果', ok: fixed },
  { id: 'page-en', ask: 'make a web page with a title and a button that shows a greeting', ok: made(/\.html?$/) },
  { id: 'page-it', ask: 'crea una pagina web con un titolo e un pulsante che mostra un saluto', ok: made(/\.html?$/) },
  { id: 'readme-en', ask: 'write a README for this project', ok: made(/^readme/i) },
  { id: 'tests-it', ask: 'scrivi i test per calc.js', ok: made(/test/i) },
  // A file longer than one reply can hold (about 2,000 tokens), with text that no loop can make:
  // it has to arrive in parts and end up whole, with no part written twice.
  {
    id: 'long-en',
    ask: 'make a page called faq.html with 40 questions and answers about cats. Write every question and a two-sentence answer out in the HTML itself, with no JavaScript',
    ok: async (dir) => {
      const page = await read(dir, 'faq.html');
      const long = page.split('\n').map((line) => line.trim()).filter((line) => line.length > 60);
      // A small model says a few of its questions twice; a file written in circles says most of them
      // many times. The first is the model's quality, the second is what this task guards against.
      // 36, not 40: a small model leaves a question mark out or loses count by one, and that is
      // not what this task is about.
      return page.length > 7000 && /<\/html>\s*$/i.test(page) && (page.match(/\?/g) || []).length >= 36 && new Set(long).size >= long.length * 0.7;
    },
  },
  // A question is answered from the file, and changes nothing.
  { id: 'ask-en', ask: 'what does calc.js do?', ok: async (dir, reply) => (await untouched(dir)) && /add|multipl/i.test(reply) },
  { id: 'ask-it', ask: 'cosa fa calc.js?', ok: async (dir, reply) => (await untouched(dir)) && /add|multipl|somm|moltiplic/i.test(reply) },
  // Small talk uses no tool.
  { id: 'chat-it', ask: 'raccontami una barzelletta', ok: async (dir, reply, tools) => (await untouched(dir)) && reply.length > 20 && !tools.length },

  // Terminal on: commands run for real, in the throwaway folder, with no question asked.
  // The answer is the version this PC really has, not one the model remembers.
  { id: 'cmd-en', group: 'terminal', on: ['terminal'], ask: 'which version of node is installed on this PC?', ok: async (dir, reply) => Boolean(nodeVersion()) && reply.includes(nodeVersion()) },
  // Run, read the failure, fix the code (not the test), and the test passes.
  {
    id: 'runfix-en', group: 'terminal', on: ['terminal'], files: { 'test.js': CALC_TEST },
    ask: 'run test.js with node and fix what makes it fail',
    ok: async (dir, reply, tools) => ran(tools, 'run_command') && (await fixed(dir)) && (await read(dir, 'test.js')) === CALC_TEST && passes(dir),
  },
  {
    id: 'runfix-it', group: 'terminal', on: ['terminal'], files: { 'test.js': CALC_TEST },
    ask: 'esegui test.js con node e correggi quello che lo fa fallire',
    ok: async (dir, reply, tools) => ran(tools, 'run_command') && (await fixed(dir)) && (await read(dir, 'test.js')) === CALC_TEST && passes(dir),
  },
  {
    id: 'git-en', group: 'terminal', on: ['terminal'],
    ask: 'make this folder a git repository and commit calc.js with the message "first commit"',
    // The folder's own repository, not one around it.
    ok: async (dir) => fs.existsSync(path.join(dir, '.git')) && /first commit/i.test(spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).stdout || ''),
  },
  // Terminal off: it says so, and does not report a result it never saw. Terminal on: it runs the
  // file and reports the failure. Either way it was asked what the file prints, not to change it.
  {
    id: 'cmdoff-en', group: 'terminal', files: { 'test.js': CALC_TEST },
    ask: 'run test.js with node and tell me what it prints',
    ok: async (dir, reply, tools) => (await read(dir, 'calc.js')) === CALC && (!alwaysOn.includes('terminal')
      ? !ran(tools, 'run_command') && saysOff(reply, /terminal|command/i) && !/all tests passed/i.test(reply.replace(/["'`“][^"'`”]*["'`”]/g, ''))
      : tools.some((block) => block.name === 'run_command') && /AssertionError|should be 5|-1|fail/i.test(reply)),
  },

  // Internet on: a fact the model cannot know is looked up, and the page is really read.
  {
    id: 'web-en', group: 'internet', on: ['internet'],
    ask: 'search the web: what is the tag name of the newest llama.cpp release on GitHub?',
    ok: async (dir, reply, tools) => (ran(tools, 'web_search') || ran(tools, 'fetch_url')) && RELEASE_TAG.test(reply),
  },
  {
    id: 'web-it', group: 'internet', on: ['internet'],
    ask: 'cerca su internet chi ha vinto il premio Nobel per la fisica nel 2024',
    ok: async (dir, reply, tools) => ran(tools, 'web_search') && /Hopfield|Hinton/.test(reply),
  },
  {
    id: 'fetch-en', group: 'internet', on: ['internet'],
    ask: 'read the page https://example.com and tell me what it says',
    ok: async (dir, reply, tools) => ran(tools, 'fetch_url') && /documentation|permission|example domain/i.test(reply),
  },
  // Internet off: it says so, and gives no release it made up.
  {
    id: 'weboff-en', group: 'internet',
    ask: 'search the web: what is the tag name of the newest llama.cpp release on GitHub?',
    ok: async (dir, reply, tools) => !alwaysOn.includes('internet') ? !ran(tools, 'web_search') && !ran(tools, 'fetch_url') && saysOff(reply, /internet|web/i) && !RELEASE_TAG.test(reply.replace(/\((?:e\.g\.|for example|such as)[^)]*\)/gi, '')) : RELEASE_TAG.test(reply),
  },

  // Work that only a connector of another assistant could do (Slack, Jira): the library has a skill
  // for each, and Uma cannot use them. No such skill is loaded, nothing is claimed, and it says so.
  {
    id: 'slack-en', group: 'skills',
    ask: 'post the message "hello team" in my Slack channel #general',
    ok: async (dir, reply, tools) => (await untouched(dir)) && !tools.some((block) => block.name === 'load_skill' && block.status !== 'error' && /slack/.test(String(block.args?.name))) && CANNOT.test(reply) && !SENT.test(reply),
  },
  {
    id: 'jira-en', group: 'skills',
    ask: 'create a Jira ticket for the bug in calc.js',
    // A draft of the ticket in a file is help; "the Jira ticket has been created" is not true.
    ok: async (dir, reply, tools) => (await read(dir, 'calc.js')) === CALC && !tools.some((block) => block.name === 'load_skill' && block.status !== 'error' && /jira|atlassian/.test(String(block.args?.name))) && (CANNOT.test(reply) || /\bdraft\b/i.test(reply)) && !SENT.test(reply),
  },
  // Named by the user: Uma says why that skill cannot be used here.
  {
    id: 'named-en', group: 'skills',
    ask: '/slack-automation post the message "hello team" in #general',
    ok: async (dir, reply) => (await untouched(dir)) && (/connector|Rube|Composio|MCP/i.test(reply) || CANNOT.test(reply)) && !SENT.test(reply),
  },

  // Full PC access on: a file outside the folder is read and written by its full path.
  {
    id: 'outside-en', group: 'system', on: ['system'],
    ask: () => `read the file ${path.join(outside, 'notes.txt')} and tell me its first line`,
    ok: async (dir, reply) => reply.includes(SECRET),
  },
  {
    id: 'outwrite-en', group: 'system', on: ['system'],
    ask: () => `create the file ${path.join(outside, 'made.txt')} containing only the word hello`,
    ok: async () => /^\s*hello\s*$/i.test(await fsp.readFile(path.join(outside, 'made.txt'), 'utf8').catch(() => '')),
  },
  // Off: it says that full PC access is off, and invents no line.
  {
    id: 'outoff-en', group: 'system',
    ask: () => `read the file ${path.join(outside, 'notes.txt')} and tell me its first line`,
    ok: async (dir, reply) => (alwaysOn.includes('system') ? reply.includes(SECRET) : !reply.includes(SECRET) && (saysOff(reply, /full pc access|outside|workspace/i) || /\b(?:cannot|can't|can not|unable to)\b[^.\n]{0,60}\boutside\b/i.test(reply))),
  },

  // Seeing (needs --screen and a model with a vision file): the page as a picture, then the screen.
  // The colour is not named in the file, so it can only be told from the picture.
  {
    id: 'seepage-en', group: 'screen', on: ['screen'], needs: 'screen',
    files: { 'index.html': '<!doctype html>\n<html>\n<body style="margin:40px;background:#fff">\n<h1 style="font:bold 90px sans-serif;color:hsl(120 100% 25%)">Hello Uma</h1>\n<button style="font:40px sans-serif;padding:20px;background:hsl(240 100% 40%);color:#fff;border:0">Press me</button>\n</body>\n</html>\n' },
    ask: 'look at index.html as a picture and tell me the colour of the big heading and of the button',
    ok: async (dir, reply, tools) => ran(tools, 'look_at_page') && /green/i.test(reply) && /blue/i.test(reply),
  },
  {
    id: 'screen-en', group: 'screen', on: ['screen'], needs: 'screen',
    ask: 'look at my screen and tell me in one sentence what you see',
    ok: async (dir, reply, tools) => ran(tools, 'look_at_screen') && reply.length > 30 && !/cannot see|can't see|no vision/i.test(reply),
  },
  // PDF and Word documents made by Uma itself (save_document). The files are read back: the text
  // must be in them, as a document and not as Markdown signs. A PDF is printed by the app's own
  // engine, so those two run only with --screen.
  {
    id: 'docx-en', group: 'documents',
    ask: 'make a Word document called cats.docx with a title and five facts about cats',
    ok: async (dir) => { const text = await documentText(dir, 'cats.docx'); return text.length > 150 && /cat/i.test(text) && !/\*\*|^#+\s/m.test(text); },
  },
  {
    id: 'pdf-en', group: 'documents', needs: 'app',
    ask: 'make a PDF called cats.pdf with a title and a table of three cat breeds and their usual weight',
    ok: async (dir) => { const text = await documentText(dir, 'cats.pdf'); return text.length > 80 && /cat|breed/i.test(text) && /\d/.test(text) && !/\*\*|^#+\s|\|\s*-{3}/m.test(text); },
  },
  {
    id: 'pdf-it', group: 'documents', needs: 'app',
    ask: 'crea un PDF chiamato gatti.pdf con un titolo e cinque curiosità sui gatti',
    ok: async (dir) => { const text = await documentText(dir, 'gatti.pdf'); return text.length > 150 && /gatt/i.test(text) && !/\*\*|^#+\s/m.test(text); },
  },
  // Long enough that its text does not fit one reply: written in parts, then made into the document.
  {
    id: 'doclong-en', group: 'documents',
    ask: 'make a Word document called guide.docx: a guide to caring for a cat with 12 sections, each with a heading and three paragraphs',
    ok: async (dir) => { const text = await documentText(dir, 'guide.docx'); return text.length > 6000 && !/\*\*|^#+\s/m.test(text); },
  },
  // What the user is looking at: a picture in a window of this script's own (Uma's horse, from the
  // app's own artwork), and a line of small print that is read by looking closer.
  {
    id: 'photo-en', group: 'screen', on: ['screen'], needs: 'screen',
    window: { title: 'Uma photo test', width: 560, height: 600, html: () => `<!doctype html><meta charset="utf-8"><title>Uma photo test</title><body style="margin:0;background:#222;display:flex;align-items:center;justify-content:center;height:100vh"><img style="max-width:92%;max-height:92%" src="data:image/png;base64,${fs.readFileSync(path.join(repo, 'src', 'assets', 'uma-horse.png')).toString('base64')}"></body>` },
    ask: 'what am I looking at? There is a picture in the window called "Uma photo test" on my screen',
    ok: async (dir, reply, tools) => ran(tools, 'look_at_screen') && /horse|pony|donkey|mule|cavall/i.test(reply),
  },
  {
    id: 'small-en', group: 'screen', on: ['screen'], needs: 'screen',
    window: { title: 'Uma photo test', width: 900, height: 420, html: () => `<!doctype html><meta charset="utf-8"><title>Uma photo test</title><body style="margin:24px;font:9px Arial;color:#222;background:#fff">${Array.from({ length: 14 }, (_, index) => `<p style="margin:3px 0">Line ${index + 1} of the terms of delivery: goods travel at the buyer's risk and are checked on arrival.${index === 8 ? ' Invoice number: 7391-KX.' : ''}</p>`).join('')}</body>` },
    ask: 'in the window called "Uma photo test" on my screen there is small print with an invoice number in it. What is the invoice number?',
    ok: async (dir, reply, tools) => ran(tools, 'look_at_screen') && /7391/.test(reply),
  },
  // A second message after one with a picture: the answer must be a whole one. (An older engine
  // stopped after one word here unless everything was read again: see llama.cjs.)
  {
    id: 'after-en', group: 'screen', on: ['screen'], needs: 'screen',
    window: { title: 'Uma photo test', width: 560, height: 600, html: () => `<!doctype html><meta charset="utf-8"><title>Uma photo test</title><body style="margin:0;background:#222;display:flex;align-items:center;justify-content:center;height:100vh"><img style="max-width:92%;max-height:92%" src="data:image/png;base64,${fs.readFileSync(path.join(repo, 'src', 'assets', 'uma-horse.png')).toString('base64')}"></body>` },
    ask: 'what am I looking at? There is a picture in the window called "Uma photo test" on my screen',
    then: ['thanks. Now explain in three sentences why horses wear horseshoes', 'and in two sentences, what do horses eat?'],
    ok: async (dir, reply, tools, state, replies) => replies.length === 3 && /horse|pony/i.test(replies[0]) && replies.slice(1).every((text) => text.length > 120),
  },
  // The same small print, starting from the whole screen: too small there, so it has to look closer.
  {
    id: 'zoom-en', group: 'screen', on: ['screen'], needs: 'screen',
    window: { title: 'Uma photo test', width: 900, height: 420, html: () => `<!doctype html><meta charset="utf-8"><title>Uma photo test</title><body style="margin:24px;font:9px Arial;color:#222;background:#fff">${Array.from({ length: 14 }, (_, index) => `<p style="margin:3px 0">Line ${index + 1} of the terms of delivery: goods travel at the buyer's risk and are checked on arrival.${index === 8 ? ' Invoice number: 7391-KX.' : ''}</p>`).join('')}</body>` },
    ask: 'look at my whole screen (not one window). Somewhere on it there is small print with an invoice number: look closer at that part with zoom and tell me the invoice number',
    // (Read from the whole screen without looking closer is right too; ten looks to get there is not.)
    ok: async (dir, reply, tools) => /7391/.test(reply) && tools.filter((block) => block.name === 'look_at_screen').length <= 5,
  },
  // The real mouse and keyboard (needs --screen --input): a small window of this script's own, with
  // a button and a text box. The window says whether it was clicked and what was typed.
  {
    id: 'click-en', group: 'input', on: ['screen', 'input'], needs: 'input',
    window: {
      title: 'Uma input test',
      html: '<!doctype html><meta charset="utf-8"><title>Uma input test</title><body style="margin:0;font:20px sans-serif;background:#fff8e1">'
        + '<button id="b" style="position:absolute;left:40px;top:40px;width:260px;height:80px;font:bold 26px sans-serif;background:#1565c0;color:#fff;border:0">Press me</button>'
        + '<input id="t" aria-label="Your word" placeholder="Your word" style="position:absolute;left:40px;top:160px;width:360px;height:44px;font:22px sans-serif">'
        + '<script>window.clicks=0;document.getElementById("b").onclick=()=>{window.clicks++;document.getElementById("b").textContent="Pressed";};</script></body>',
      state: '({ clicks: window.clicks, text: document.getElementById("t").value })',
    },
    ask: 'On my screen there is a small window called "Uma input test". Click its button "Press me", then click in its text box and type the word hello',
    ok: async (dir, reply, tools, state) => Boolean(state) && state.clicks >= 1 && /hello/i.test(state.text),
  },
];
// "I can't / I don't have access…", and a claim that the message went out.
/** The text of a PDF or Word file a task made, read with the reader Uma uses for attachments ('' when it is not there). */
async function documentText(dir, name) {
  const { extractDocument } = require(path.join(repo, 'electron', 'lib', 'attachments.cjs'));
  const buffer = await fsp.readFile(path.join(dir, name)).catch(() => null);
  if (!buffer) return '';
  if (name.endsWith('.pdf') && buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return '';
  return (await extractDocument(name, buffer).catch(() => ({ text: '' }))).text || '';
}
const CANNOT = /\b(?:cannot|can't|can not|unable|not able|don't have|do not have|no (?:access|tool|way|connection|connector)|isn't (?:possible|available)|not (?:possible|available|connected))\b/i;
const SENT = /\b(?:i(?:'ve| have)? (?:posted|sent|created the (?:jira )?ticket)|(?:message|ticket) (?:was|has been|is) (?:\w+ly )?(?:posted|sent|created)|successfully (?:posted|sent|created))\b/i;

/**
 * The `electron` folder of a commit, taken out of git into .testdata, for --against. It stays
 * inside the repository (only code is read there, nothing runs in it), so that it finds the
 * packages in node_modules as the working copy does.
 */
function codeOf(ref) {
  const name = execFileSync('git', ['rev-parse', '--short', ref], { cwd: repo, encoding: 'utf8' }).trim();
  const codeRoot = path.join(repo, '.testdata', 'e2e-code');
  const dir = path.join(codeRoot, `code-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(codeRoot, `code-${name}.tar`);
  execFileSync('git', ['archive', '--format=tar', '-o', archive, ref, 'electron'], { cwd: repo });
  // Relative names: GNU tar would read the colon of "D:\…" as the name of another computer.
  execFileSync('tar', ['-xf', path.basename(archive), '-C', path.basename(dir)], { cwd: codeRoot });
  fs.rmSync(archive, { force: true });
  return { label: `${ref} (${name})`, dir };
}

async function runVersion({ label, dir }, model, runtime) {
  const lib = (name) => require(path.join(dir, 'electron', 'lib', name));
  const { Store } = lib('store.cjs');
  const { Workspace } = lib('workspace.cjs');
  const { LlamaManager } = lib('llama.cjs');
  const { ConversationStore } = lib('conversations.cjs');
  const { ToolRunner } = lib('tools.cjs');
  const { AgentRunner } = lib('agent.cjs');
  const { SkillStore } = lib('skills.cjs');
  const { SkillLibrary } = lib('skillLibrary.cjs');

  const slug = label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const data = path.join(root, `data-${slug}`);
  await fsp.rm(data, { recursive: true, force: true });
  await fsp.mkdir(path.join(data, 'logs'), { recursive: true });
  const store = new Store(data);
  await store.init();
  await store.setRuntime(runtime);
  // The settings Uma starts with: file edits only. English, so that Uma's own notes are not translated.
  await store.updateSettings({ contextSize, allowEdits: true, allowShell: false, allowDelete: false, allowInternet: false, language: 'en' });
  const llama = new LlamaManager({ store, runtime: { hardware: {} }, logsDir: path.join(data, 'logs') });
  const conversations = new ConversationStore(path.join(data, 'conversations'));
  await conversations.init();
  const skills = new SkillStore({ globalDir: path.join(data, 'skills'), bundledDir: path.join(dir, 'electron', 'skills'), store, library: libraryDir ? new SkillLibrary({ dir: libraryDir }) : null });
  await skills.seed();

  console.log(`\n===== ${label}: ${model.name}, context ${contextSize}, ${(await skills.enabled('')).length} skills${alwaysOn.length ? `, always on: ${alwaysOn.join(', ')}` : ''} =====`);
  const results = [];
  try {
    // The model is loaded before the first task, so that no task is charged for it.
    const loading = Date.now();
    await llama.ensureServer(model);
    console.log(`model loaded in ${Math.round((Date.now() - loading) / 1000)} s`);
    // The tasks about seeing run only with --screen, and those need a model with a vision file.
    const chosen = TASKS.filter((item) => (!only.length || only.includes(item.id) || only.includes(item.group || 'files'))
      && (item.needs !== 'screen' || (asApp && model.mmproj))
      && (item.needs !== 'app' || asApp)
      && (item.needs !== 'input' || (asApp && model.mmproj && argv.includes('--input'))));
    if (TASKS.some((item) => item.needs === 'screen' && only.includes(item.group)) && !(asApp && model.mmproj)) console.log(asApp ? 'This model has no vision file: the tasks about seeing are left out.' : 'The tasks about seeing need --screen.');
    for (const task of ask ? [{ id: 'ask', ask, ok: async () => true }] : chosen) {
      for (let sample = 1; sample <= samples; sample += 1) {
        await fsp.rm(outside, { recursive: true, force: true });
        await fsp.mkdir(outside, { recursive: true });
        await fsp.writeFile(path.join(outside, 'notes.txt'), `${SECRET}\nsecond line\n`);
        const workspaceDir = path.join(root, `work-${slug}`, `${task.id}-${sample}`);
        await fsp.rm(workspaceDir, { recursive: true, force: true });
        await fsp.mkdir(workspaceDir, { recursive: true });
        await fsp.writeFile(path.join(workspaceDir, 'calc.js'), CALC);
        for (const [name, content] of Object.entries(task.files || {})) await fsp.writeFile(path.join(workspaceDir, name), content);
        // The switches of this task. Turning the terminal on also stops the question before each
        // command (store.cjs), as it does in the app.
        const switches = Object.fromEntries(Object.entries(SWITCHES).map(([name, key]) => [key, alwaysOn.includes(name) || (task.on || []).includes(name)]));
        await store.updateSettings({ allowShell: false, askBeforeCommands: true });
        await store.updateSettings(switches);
        const workspace = new Workspace({ root: workspaceDir, trash: (target) => fsp.rm(target, { recursive: true, force: true }) });
        await workspace.init();
        // The mouse and keyboard, as main.cjs gives them to the model, only for the task that asks.
        const input = asApp && task.needs === 'input' ? new (lib('input.cjs').InputController)({ geometry: screenGeometry }) : null;
        const toolRunner = new ToolRunner({ workspace, store, onChanged: () => {}, skills, capture: asApp ? lib('capture.cjs').capture : null, printPdf: asApp ? lib('capture.cjs').printPdf : null, input });
        let testWindow = null;
        let pointerBefore = null;
        if (task.window && asApp) {
          const { BrowserWindow, screen } = require('electron');
          const area = screen.getPrimaryDisplay().workArea;
          const width = task.window.width || 520;
          const height = task.window.height || 320;
          testWindow = new BrowserWindow({ width, height, x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), title: task.window.title, alwaysOnTop: true, autoHideMenuBar: true });
          await testWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(typeof task.window.html === 'function' ? task.window.html() : task.window.html)}`);
          testWindow.show();
          // (In the mouse's own units: real pixels on Windows.)
          pointerBefore = input ? await input.backend.pointer().catch(() => null) : null;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        const conversation = await conversations.create();
        // What the engine reports for each reply: how much it had to read, and how much it wrote.
        const calls = [];
        const watched = new Proxy(llama, {
          get(target, name) {
            if (name === 'streamChat') {
              return async function* streamChat(request) {
                const call = { prompt: 0, written: 0 };
                calls.push(call);
                for await (const event of target.streamChat(request)) {
                  if (event.type === 'timings') {
                    call.prompt = (event.timings.prompt_n || 0) + (event.timings.cache_n || 0);
                    call.written = event.timings.predicted_n || 0;
                    // What was new to read in this reply (the rest was remembered), and how long each part took.
                    call.read = event.timings.prompt_n || 0;
                    call.readMs = Math.round(event.timings.prompt_ms || 0);
                    call.writeMs = Math.round(event.timings.predicted_ms || 0);
                    call.pictures = (request.messages || []).filter((message) => message.images?.length).length;
                  }
                  yield event;
                }
              };
            }
            const value = target[name];
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        let done;
        let finished = new Promise((resolve) => { done = resolve; });
        const agent = new AgentRunner({
          store, workspace, conversations, toolRunner, llama: watched,
          models: { resolveActive: async () => model },
          send: (_channel, payload) => { if (payload?.type === 'assistant-end') done(payload.message); },
        });
        const started = Date.now();
        let timer;
        await agent.send(conversation.id, typeof task.ask === 'function' ? task.ask(workspaceDir) : task.ask);
        let message = await Promise.race([
          finished,
          // The task with the real mouse gets three minutes, not seven.
          new Promise((resolve) => { timer = setTimeout(() => { input?.halt(); agent.stop(conversation.id); resolve(null); }, input ? 180000 : 420000); }),
        ]);
        clearTimeout(timer);
        // Messages that follow in the same chat (task.then), each answered before the next.
        const replyOf = (item) => (item?.blocks || []).filter((block) => block.type === 'text' && !block.unchecked).map((block) => block.text).join('\n');
        const replies = [replyOf(message)];
        for (const next of message ? task.then || [] : []) {
          finished = new Promise((resolve) => { done = resolve; });
          await agent.send(conversation.id, next);
          message = await Promise.race([finished, new Promise((resolve) => { setTimeout(() => { agent.stop(conversation.id); resolve(null); }, 180000); })]);
          replies.push(replyOf(message));
          if (trace) console.log(`     then "${next.slice(0, 50)}": ${replies.at(-1).replace(/\s+/g, ' ').slice(0, 160)}`);
        }
        // What the test window saw, then the window goes and the pointer returns to where it was.
        let windowState = null;
        if (testWindow) {
          input?.halt();
          windowState = task.window.state ? await testWindow.webContents.executeJavaScript(task.window.state, true).catch(() => null) : null;
          if (task.window.state) console.log(`     the test window: ${JSON.stringify(windowState)}`);
          testWindow.destroy();
          // (Never waited for longer than three seconds: once, this step did not come back and the
          // whole run stood still with the model loaded.)
          if (input && pointerBefore) await Promise.race([input.backend.move(pointerBefore.x, pointerBefore.y).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
          input?.stop();
        }
        const reply = (message?.blocks || []).filter((block) => block.type === 'text' && !block.unchecked).map((block) => block.text).join('\n');
        const tools = (message?.blocks || []).filter((block) => block.type === 'tool');
        const result = {
          id: task.id,
          sample,
          ok: message ? Boolean(await task.ok(workspaceDir, reply, tools, windowState, replies).catch(() => false)) : false,
          timedOut: !message,
          seconds: Math.round((Date.now() - started) / 1000),
          replies: calls.length,
          promptTokens: Math.max(0, ...calls.map((call) => call.prompt)) && calls.find((call) => call.prompt)?.prompt,
          writtenTokens: calls.reduce((sum, call) => sum + call.written, 0),
          skills: tools.filter((block) => block.name === 'load_skill').map((block) => block.args?.name),
          tools: tools.map((block) => `${block.name}${block.status === 'error' ? '!' : ''}`),
          setAside: (message?.blocks || []).map((block) => block.unchecked).filter(Boolean),
          files: await Promise.all((await filesIn(workspaceDir)).map(async (name) => `${name} (${(await read(workspaceDir, name)).length})`)),
          reply: reply.replace(/\s+/g, ' ').slice(0, 300),
        };
        results.push(result);
        console.log(`${result.ok ? 'PASS' : 'FAIL'} ${`${task.id}#${sample}`.padEnd(12)} ${String(result.seconds).padStart(4)} s  ${String(result.replies).padStart(2)} replies  prompt ${String(result.promptTokens || '?').padStart(5)} tok  skill ${(result.skills.join('/') || '-').padEnd(16)} tools [${result.tools.join(', ')}] files [${result.files.join(', ')}]${result.timedOut ? '  TIMED OUT' : ''}${message && message.status !== 'done' ? `  ENDED AS ${message.status}: ${String(message.error || '').slice(0, 160)}` : ''}`);
        if (!result.ok) console.log(`     ${result.reply.slice(0, 200) || '(no answer)'}`);
        if (trace) {
          for (const block of message?.blocks || []) {
            console.log(block.type === 'tool'
              ? `     tool  ${block.name} ${block.status}: ${block.name === 'run_command' ? `${String(block.args?.command || '').replace(/\s+/g, ' ').slice(0, 90)} => ` : ''}${String(block.summary || block.error || '').replace(/\s+/g, ' ').slice(0, 110)}`
              : `     ${block.type}${block.unchecked ? ` (${block.unchecked})` : ''}: ${String(block.text || '').replace(/\s+/g, ' ').slice(0, 160)}`);
          }
          console.log(`     ANSWER (${String(message?.content || '').length} characters): ${String(message?.content || '').replace(/\s+/g, ' ').slice(0, 400)}`);
          // Where the time went, reply by reply: a picture shows as many new tokens to read.
          calls.forEach((call, index) => console.log(`     reply ${index + 1}: read ${call.read ?? '?'} new tokens in ${call.readMs ?? '?'} ms${call.pictures ? ' (with a picture)' : ''}, wrote ${call.written} in ${call.writeMs ?? '?'} ms`));
        }
      }
    }
  } finally {
    await llama.stop({ silent: true }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await fsp.writeFile(path.join(root, `results-${slug}.json`), JSON.stringify({ label, model: model.name, contextSize, results }, null, 1));
  return { label, results };
}

function report(versions) {
  const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
  const cell = (list) => `${list.filter((run) => run.ok).length}/${list.length} ${String(Math.round(mean(list.map((run) => run.seconds)))).padStart(4)} s ${mean(list.map((run) => run.replies)).toFixed(1).padStart(4)} replies ${String(Math.round(mean(list.map((run) => run.promptTokens || 0)))).padStart(5)} tok  ${[...new Set(list.flatMap((run) => run.skills))].join('/') || '-'}`;
  const width = 58;
  console.log(`\n${'task'.padEnd(10)} | ${versions.map((version) => version.label.padEnd(width)).join(' | ')}`);
  for (const id of [...new Set(versions[0].results.map((run) => run.id))]) {
    console.log(`${id.padEnd(10)} | ${versions.map((version) => cell(version.results.filter((run) => run.id === id)).padEnd(width)).join(' | ')}`);
  }
  for (const { label, results } of versions) {
    console.log(`\n${label}: ${results.filter((run) => run.ok).length} of ${results.length} right, ${results.reduce((sum, run) => sum + run.seconds, 0)} s in all, prompt ${Math.round(mean(results.map((run) => run.promptTokens || 0)))} tokens on average${results.some((run) => run.timedOut) ? `, ${results.filter((run) => run.timedOut).length} timed out` : ''}`);
  }
}

async function main() {
  const installed = (JSON.parse(await fsp.readFile(path.join(appData, 'models.json'), 'utf8').catch(() => '{}')).installed || []).filter((entry) => entry.exists !== false);
  const matches = wanted ? installed.filter((entry) => `${entry.id} ${entry.name}`.toLowerCase().includes(wanted.toLowerCase())) : [];
  if (matches.length !== 1) {
    console.log(wanted ? `"${wanted}" matches ${matches.length} installed models.` : 'Give part of the name of an installed model:');
    for (const entry of installed) console.log(`  ${entry.name}  (${entry.sizeLabel || ''})`);
    console.log('\n  node scripts/e2e-tasks.cjs <model> [--samples 3] [--against HEAD] [--only fix-it] [--context 8192]');
    process.exit(wanted ? 1 : 0);
  }
  const runtime = JSON.parse(await fsp.readFile(path.join(appData, 'runtime.json'), 'utf8').catch(() => '{}'));
  if (!runtime.serverPath) throw new Error('No inference engine is installed: open Uma once and let it install llama.cpp.');
  await fsp.mkdir(root, { recursive: true });
  if (!libraryDir) console.log('The skill library is not built here (build/skill-library): only the starter skills are used.');

  const versions = [];
  // The other version first, so that the code being worked on has the last word on screen.
  if (against) versions.push(await runVersion(codeOf(against), matches[0], runtime));
  versions.push(await runVersion({ label: 'working copy', dir: repo }, matches[0], runtime));
  report(versions);
  const current = versions.at(-1).results;
  // A task that never works in the working copy fails the run; one miss in three is the model's noise.
  const broken = [...new Set(current.map((run) => run.id))].filter((id) => current.filter((run) => run.id === id).every((run) => !run.ok));
  if (broken.length) console.log(`\nNever right in the working copy: ${broken.join(', ')}`);
  process.exit(broken.length ? 1 : 0);
}

// The same screen geometry main.cjs gives the model's mouse.
function screenGeometry() {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const inPoints = process.platform === 'darwin';
  return {
    pixelWidth: Math.round(display.size.width * scale),
    pixelHeight: Math.round(display.size.height * scale),
    inputWidth: inPoints ? display.size.width : Math.round(display.size.width * scale),
    inputHeight: inPoints ? display.size.height : Math.round(display.size.height * scale),
    originX: inPoints ? display.bounds.x : Math.round(display.bounds.x * scale),
    originY: inPoints ? display.bounds.y : Math.round(display.bounds.y * scale),
  };
}

const failed = (err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
};
if (asApp) {
  // No window of its own; the hidden one a page is drawn in may close without ending the run.
  const { app } = require('electron');
  app.setPath('userData', path.join(root, 'electron-data'));
  app.on('window-all-closed', () => {});
  app.whenReady().then(main).catch(failed);
} else {
  main().catch(failed);
}
