// Collects every interface text marked for translation and checks each locale has all of them.
//   node scripts/i18n-check.cjs            fails, listing what is missing, if a locale is incomplete
//   node scripts/i18n-check.cjs --keys     prints every key as JSON (to translate new text)
// Keys come from t(), tn() and tj() calls, plus text kept in data and translated where it is shown
// (the model catalog, engine names, the chat suggestions, navigation labels, and similar).
const fs = require('node:fs');
const path = require('node:path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const root = path.join(__dirname, '..');
const LOCALES = require('../electron/locales/languages.json').map((language) => language.id).filter((id) => id !== 'en');

function sourceFiles() {
  const list = [path.join(root, 'electron', 'main.cjs')];
  for (const dir of ['electron/lib', 'src', 'src/components']) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      if (/\.(cjs|js|jsx)$/.test(name)) list.push(path.join(root, dir, name));
    }
  }
  return list;
}

// Object fields whose text is translated where it is displayed, not where it is written.
const DATA_FIELDS = {
  'models.cjs': ['tagline', 'description', 'tools'],
  'runtime.cjs': ['label', 'download'],
  'ChatView.jsx': ['title', 'text'],
  'Sidebar.jsx': ['label'],
  'skills.cjs': ['label'],
};

function collect() {
  const keys = new Set();
  for (const file of sourceFiles()) {
    const name = path.basename(file);
    const ast = parser.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'unambiguous', plugins: ['jsx'] });
    traverse(ast, {
      CallExpression(p) {
        const callee = p.node.callee.name;
        const args = p.node.arguments;
        if ((callee === 't' || callee === 'tj') && args[0]?.type === 'StringLiteral') keys.add(args[0].value);
        if (callee === 'tn') for (const arg of args.slice(1, 3)) if (arg?.type === 'StringLiteral') keys.add(arg.value);
        // OS words: pick('Recycle Bin', 'Trash', 'Trash') inside t().
        if (callee === 'pick' && name === 'ui.jsx' && p.parentPath.isCallExpression() && p.parent.callee.name === 't') {
          for (const arg of args) if (arg.type === 'StringLiteral') keys.add(arg.value);
        }
      },
      ObjectProperty(p) {
        const key = p.node.key.name || p.node.key.value;
        if (DATA_FIELDS[name]?.includes(key) && p.node.value.type === 'StringLiteral' && /[A-Za-z]/.test(p.node.value.value)) keys.add(p.node.value.value);
        // The Shared screen's phase and log-kind names.
        if (name === 'SharedView.jsx' && p.parentPath.parentPath.isVariableDeclarator() && /^(PHASES|KINDS)$/.test(p.parentPath.parent.id.name)) keys.add(p.node.value.value);
      },
    });
  }
  // Bundled skill descriptions, shown translated in Settings (the model still reads them in English).
  const skillsDir = path.join(root, 'electron', 'skills');
  for (const name of fs.readdirSync(skillsDir)) {
    const description = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8').match(/^description:\s*(.+)$/m)?.[1];
    if (description) keys.add(description.trim().replace(/^["']|["']$/g, ''));
  }
  // Thread groups from groupThreads(), the family filter, and the CPU engine name.
  for (const key of ['Today', 'Yesterday', 'Previous 7 days', 'Older', 'All', 'CPU']) keys.add(key);
  return [...keys].sort();
}

const keys = collect();
if (process.argv.includes('--keys')) {
  process.stdout.write(`${JSON.stringify(keys, null, 2)}\n`);
  process.exit(0);
}

let problems = 0;
for (const locale of LOCALES) {
  const dictionary = require(`../electron/locales/${locale}.json`);
  const missing = keys.filter((key) => !dictionary[key]);
  // A translation must keep every {placeholder} of its English key.
  const broken = keys.filter((key) => dictionary[key] && (key.match(/\{\w+\}/g) || []).some((slot) => !dictionary[key].includes(slot)));
  const unused = Object.keys(dictionary).filter((key) => !keys.includes(key));
  // A sentence filled in with its own English text is not translated. (A name, a unit, or a list of
  // model names may be the same in another language: only sentences count.)
  const english = keys.filter((key) => dictionary[key] === key && (key.match(/[A-Za-z]{3,}/g) || []).length >= 6);
  if (missing.length || broken.length || english.length) {
    problems += 1;
    console.log(`${locale}: ${missing.length} missing, ${broken.length} with a lost {placeholder}, ${english.length} left in English`);
    for (const key of [...missing, ...broken, ...english].slice(0, 15)) console.log(`   ${JSON.stringify(key)}`);
  }
  if (unused.length) console.log(`${locale}: ${unused.length} unused (text no longer in the app)`);
}
if (problems) process.exit(1);
console.log(`Translations complete: ${keys.length} texts in ${LOCALES.length} languages.`);
