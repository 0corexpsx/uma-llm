// Writes THIRD-PARTY-NOTICES.txt: the licences of the open-source parts that ship inside Uma LLM
// (the packages the interface and the PDF reader are built from, Electron) and of the parts it
// downloads (llama.cpp, the search-by-meaning model). Run it before each release:
//   node scripts/make_notices.cjs
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

/** The package folder for a name, looked up the way Node does from a package folder. */
function packageDir(name, from) {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function licenseText(dir) {
  const file = fs.readdirSync(dir).find((name) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(name));
  return file ? fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim() : '';
}

// Every package the shipped code comes from: the dependencies and everything they depend on.
const found = new Map();
const queue = Object.keys(pkg.dependencies || {}).map((name) => [name, root]);
while (queue.length) {
  const [name, from] = queue.shift();
  const dir = packageDir(name, from);
  if (!dir || found.has(dir)) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  found.set(dir, meta);
  for (const child of Object.keys(meta.dependencies || {})) queue.push([child, dir]);
}

const packages = [...found.entries()]
  .map(([dir, meta]) => ({
    name: meta.name,
    version: meta.version,
    license: typeof meta.license === 'string' ? meta.license : meta.license?.type || (meta.licenses || []).map((item) => item.type).join(' OR ') || 'see text',
    homepage: meta.homepage || (typeof meta.repository === 'string' ? meta.repository : meta.repository?.url) || '',
    text: licenseText(dir),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

// The same licence text is printed once, with every package that uses it.
const groups = new Map();
for (const item of packages) {
  const key = item.text || `(${item.license}: no licence file in the package)`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(item);
}

const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
const electronLicense = licenseText(path.join(root, 'node_modules', 'electron', 'dist')) || licenseText(path.join(root, 'node_modules', 'electron'));
const rule = '='.repeat(78);
const thin = '-'.repeat(78);

const out = [];
out.push(`THIRD-PARTY NOTICES FOR UMA LLM ${pkg.version}`);
out.push('');
out.push('Uma LLM is made by Ocorex and is free software under the GNU GPL v3 (LICENSE.txt). It is built');
out.push('with, and downloads, open-source software made by others. Each of those parts');
out.push('stays under its own licence, printed or named below, and you keep every right it gives you.');
out.push('');
out.push(rule);
out.push('1. PARTS THAT SHIP INSIDE UMA LLM');
out.push(rule);
out.push('');
out.push(`Electron ${electronVersion} — MIT — https://www.electronjs.org`);
out.push('Electron includes Chromium, Node.js and other components. Their licences are in the files');
out.push('LICENSES.chromium.html and LICENSE.electron.txt next to the program (Windows: the Uma LLM');
out.push('folder; Mac: Uma LLM.app/Contents/Resources).');
out.push('');
if (electronLicense) {
  out.push(electronLicense);
  out.push('');
}
for (const [text, items] of groups) {
  out.push(thin);
  for (const item of items) out.push(`${item.name} ${item.version} — ${item.license}${item.homepage ? ` — ${item.homepage.replace(/^git\+/, '').replace(/\.git$/, '')}` : ''}`);
  out.push('');
  out.push(text);
  out.push('');
}
// unpdf bundles pdf.js and its image decoders, with their licences in dist/licenses.
const unpdfLicenses = path.join(root, 'node_modules', 'unpdf', 'dist', 'licenses');
const bundled = { LICENSE_PDFJS: 'pdf.js (Mozilla) — Apache-2.0 — https://github.com/mozilla/pdf.js', LICENSE_PDFJS_JBIG2: 'pdf.js JBIG2 decoder (Mozilla)', LICENSE_JBIG2: 'PDFium JBIG2 decoder — BSD-3-Clause', LICENSE_PDFJS_OPENJPEG: 'pdf.js OpenJPEG decoder (Mozilla)', LICENSE_OPENJPEG: 'OpenJPEG — BSD-2-Clause' };
for (const [file, title] of Object.entries(bundled)) {
  const full = path.join(unpdfLicenses, file);
  if (!fs.existsSync(full)) continue;
  out.push(thin);
  out.push(`${title} (inside unpdf)`);
  out.push('');
  out.push(fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n').trim());
  out.push('');
}
out.push(rule);
out.push('2. PARTS UMA LLM DOWNLOADS WHEN YOU USE IT');
out.push(rule);
out.push('');
out.push('llama.cpp and ggml — MIT — https://github.com/ggml-org/llama.cpp');
out.push('Copyright (c) 2023-2026 The ggml authors. Downloaded from the official llama.cpp releases with');
out.push('their own licence files. NVIDIA CUDA runtime files that come with the CUDA builds are under the');
out.push('NVIDIA CUDA Toolkit End User License Agreement; the LLVM OpenMP runtime is under Apache 2.0 with');
out.push('LLVM exceptions (LICENSE-LLVM-OpenMP in the engine folder).');
out.push('');
out.push('EmbeddingGemma 300M (search by meaning) — Gemma Terms of Use — https://ai.google.dev/gemma/terms');
out.push('Downloaded from https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF. Gemma is provided under');
out.push('and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms.');
out.push('');
out.push('AI models you choose in Models — each under its own licence, shown on its Hugging Face page.');
out.push('');
out.push(rule);
out.push('3. SKILL LIBRARY');
out.push(rule);
out.push('');
out.push('The skill library (skill-library.asar) was assembled by Genesys Labs from public repositories.');
out.push('Each skill keeps its author\'s licence, shown with the skill in Uma (and kept in its folder when');
out.push('the skill has its own licence file). Skills without a licence, or whose licence does not allow');
out.push('passing them on, are left out. The Uma LLM licence does not apply to these skills.');
out.push('');
// The collections in the library, with their source and licences (written by make_skill_library.cjs).
const creditsFile = path.join(root, 'build', 'skill-library', 'sources.json');
if (fs.existsSync(creditsFile)) {
  const credits = JSON.parse(fs.readFileSync(creditsFile, 'utf8'));
  out.push(`Collections in the library (${credits.reduce((sum, item) => sum + item.skills, 0)} skills):`);
  out.push('');
  for (const item of credits) {
    out.push(`${item.collection} — ${item.skills} skills — ${item.licenses.join(', ')}`);
    if (item.repository) out.push(`  ${item.repository}${item.commit ? ` (commit ${item.commit})` : ''}`);
  }
  out.push('');
  out.push('Licences named CC-BY-SA-4.0 are Creative Commons Attribution-ShareAlike 4.0: the skills under it');
  out.push('may be shared and adapted with credit to the authors above, and adaptations under the same licence.');
  out.push('');
}

fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.txt'), `${out.join('\n')}\n`);
console.log(`THIRD-PARTY-NOTICES.txt: ${packages.length} packages, ${groups.size} licence texts`);
const missing = packages.filter((item) => !item.text).map((item) => `${item.name} (${item.license})`);
if (missing.length) console.log(`no licence file: ${missing.join(', ')}`);
