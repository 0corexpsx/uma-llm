// Runs the tests that open the real app (hidden windows, each with its own data folder), one after
// the other, and says which passed. Each of them is a script of its own in this folder
// (scripts/ui-*-test.cjs) and can still be run alone.
//
//   npm run test:ui                 the ones that need nothing but this PC (about two minutes)
//   npm run test:ui -- --all        also those below
//   npm run test:ui -- --with model,input,network
//   npm run test:ui -- start terms  only the ones whose name has one of these words
//
//   model     loads a real model with a real engine (one must be installed in Uma; Uma closed)
//   input     moves the real mouse and types, inside a small window the test opens: hands off
//             the mouse and keyboard while it runs
//   network   asks Hugging Face
//
// Not part of npm test: they need a screen, and take minutes. Screenshots and logs go to .shots.
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
// name, arguments, what it needs
const TESTS = [
  ['ui-start-test', ['en'], ''],
  ['ui-start-test', ['it', 'terms'], ''],
  ['ui-terms-test', [], ''],
  ['ui-status-test', [], ''],
  ['ui-chatfolder-test', [], ''],
  ['ui-contextmenu-test', [], ''],
  ['ui-memory-test', [], ''],
  ['ui-usermemory-test', [], ''],
  ['ui-skills-test', [], ''],
  ['ui-skill-library-test', [], ''],
  ['ui-speed-test', [], ''],
  ['ui-document-test', [], ''],
  ['ui-zoom-test', [], ''],
  ['ui-update-test', [], ''],
  ['ui-terminal-test', [], ''],
  ['ui-confirm-test', [], ''],
  ['ui-input-settings-test', [], ''],
  ['ui-input-banner-test', [], ''],
  ['ui-close-test', [], ''],
  ['ui-gpu-test', [], ''],
  ['ui-gpucards-test', [], ''],
  ['ui-gpucards-test', ['one'], ''],
  ['ui-library-test', [], 'network'],
  ['ui-vision-test', [], 'network'],
  ['ui-input-test', [], 'input'],
  ['ui-clicktext-test', [], 'input'],
  ['ui-loadstart-test', [], 'model'],
  ['ui-ram-test', [], 'model'],
];

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const withIndex = argv.indexOf('--with');
const allowed = new Set(withIndex >= 0 ? String(argv[withIndex + 1] || '').split(',') : []);
const words = argv.filter((arg, index) => !arg.startsWith('--') && !(withIndex >= 0 && index === withIndex + 1));

function run(name, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    // The real app, not Electron standing in for Node (npm scripts of this project may set that).
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(__dirname, `${name}.cjs`), ...args], { cwd: root, env, windowsHide: true });
    let output = '';
    const keep = (chunk) => { output = `${output}${chunk}`.slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    // A test that hangs is a test that failed.
    const timer = setTimeout(() => { output += '\n(stopped after 4 minutes)'; child.kill(); }, 240000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !/UI TEST FAILED|^FAIL\b/m.test(output), code, seconds: Math.round((Date.now() - started) / 1000), output });
    });
  });
}

(async () => {
  const chosen = TESTS.filter(([name, args, needs]) => (words.length ? words.some((word) => `${name} ${args.join(' ')}`.includes(word)) : !needs || all || allowed.has(needs)));
  const left = TESTS.filter((test) => !chosen.includes(test) && !words.length);
  const failed = [];
  for (const [name, args] of chosen) {
    const label = `${name}${args.length ? ` ${args.join(' ')}` : ''}`;
    const result = await run(name, args);
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${label.padEnd(30)} ${String(result.seconds).padStart(3)} s`);
    if (!result.ok) {
      failed.push(label);
      console.log(result.output.trim().split('\n').filter((line) => line.trim()).slice(-6).map((line) => `     ${line.slice(0, 220)}`).join('\n') || `     (exit code ${result.code}, nothing printed: see its log in .shots)`);
    }
  }
  if (left.length) console.log(`\nNot run (see the top of scripts/test-ui.cjs): ${left.map(([name, , needs]) => `${name} (${needs})`).join(', ')}`);
  console.log(`\n${chosen.length - failed.length} of ${chosen.length} passed.${failed.length ? ` Failed: ${failed.join(', ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
})();
