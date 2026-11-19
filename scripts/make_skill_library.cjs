// Builds Uma's skill library from the Advance Skills Pack from Genesys Lab (one folder per skill,
// each with a SKILL.md). Skills can sit at any depth inside the folder.
//
//   node scripts/make_skill_library.cjs [folder ...] [--include-offensive]
//
// Writes build/skill-library/ (index.json and skills/<name>/...) and build/skill-library.asar, the
// single file the installers ship. Left out on purpose:
// - skills Uma may not pass on: a proprietary licence, or no licence at all (neither the skill nor
//   the repository it came from has one, and without a licence files may not be redistributed);
// - offensive skills were excluded before 0.2.84; now included (user wants them for self-testing);
// - the same skill found again in another collection (the first one is kept);
// - binaries, fonts, images, and anything large: a skill is instructions, references and scripts.
const fs = require('node:fs');
const path = require('node:path');
const { parseSkill, NAME_RE } = require('../electron/lib/skills.cjs');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const includeOffensive = true;
const folders = args.filter((arg) => !arg.startsWith('--'));
const sources = (folders.length ? folders : [path.join('Advance Skills  Pack from Genesys Lab', 'AI-Skills')])
  .map((folder) => path.resolve(root, folder))
  .filter((folder) => fs.existsSync(folder));
const outDir = path.join(root, 'build', 'skill-library');
const asarFile = path.join(root, 'build', 'skill-library.asar');

const TEXT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.py', '.sh', '.bash', '.ps1', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.csv', '.html', '.css', '.scss', '.xml', '.sql', '.template', '.example', '.tpl',
  '.go', '.rs', '.rb', '.php', '.java', '.kt', '.swift', '.cs', '.ini', '.cfg', '.env.example']);
// Not copied with a skill's files:
const SKIP_FOLDERS = new Set(['node_modules', '.git', 'evals', 'tests', '__pycache__', '.github', 'docs']);
// Not searched for skills:
const FIND_SKIP = new Set(['node_modules', 'evals', 'tests', '__pycache__', 'docs']);
const MAX_SKILL_MD = 64 * 1024;
const MAX_FILE = 256 * 1024;
const MAX_SKILL_BYTES = 1536 * 1024;
const MAX_SKILL_FILES = 150;
// Whole collections that are offensive by purpose (red-team attack tooling).
const OFFENSIVE_COLLECTIONS = new Set(['SnailSploit-Claude-Red']);

// Licences that allow passing the files on, and what to call them in the library.
const OPEN_LICENSES = [
  [/Permission is hereby granted, free of charge|\bMIT\b/i, 'MIT'],
  [/Apache License|\bApache[- ]2/i, 'Apache-2.0'],
  [/Attribution-ShareAlike|CC[- ]BY[- ]SA/i, 'CC-BY-SA-4.0'],
  [/Attribution 4\.0|CC[- ]BY(?![- ]?(SA|NC|ND))/i, 'CC-BY-4.0'],
  [/CC0|Public Domain Dedication/i, 'CC0-1.0'],
  [/GNU AFFERO|\bAGPL/i, 'AGPL-3.0'],
  [/GNU LESSER|\bLGPL/i, 'LGPL'],
  [/GNU GENERAL PUBLIC|\bGPL/i, 'GPL'],
  [/Mozilla Public|\bMPL/i, 'MPL-2.0'],
  [/Redistribution and use in source and binary forms|\bBSD/i, 'BSD'],
  [/ISC License|\bISC\b/i, 'ISC'],
  [/The Unlicense|\bUnlicense\b/i, 'Unlicense'],
];
const PROPRIETARY = /proprietary|complete terms in license|all rights reserved|non-?commercial|\bCC[- ]BY[- ]?(NC|ND)/i;

/** "MIT", "proprietary", or "" for a licence text or name. */
function classify(text) {
  if (!text) return '';
  const head = String(text).slice(0, 4000);
  for (const [pattern, name] of OPEN_LICENSES) if (pattern.test(head)) return name;
  if (PROPRIETARY.test(head)) return 'proprietary';
  return '';
}

const licenseCache = new Map();
/** The licence of a folder: its LICENSE / COPYING file, or the "license" in its package.json. */
function folderLicense(dir) {
  if (licenseCache.has(dir)) return licenseCache.get(dir);
  let found = '';
  for (const name of fs.readdirSync(dir)) {
    if (!/^(licen[cs]e|copying)(\.(txt|md))?$/i.test(name)) continue;
    found = classify(fs.readFileSync(path.join(dir, name), 'utf8')) || 'proprietary';
    break;
  }
  if (!found && fs.existsSync(path.join(dir, 'package.json'))) {
    try { found = classify(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).license); } catch {}
  }
  // A collection that states its licence only in its README ("This repository is licensed under the
  // Apache License 2.0", as awesome-claude-skills does). Only that sentence counts, not every licence
  // the README happens to mention.
  if (!found) {
    const readme = fs.readdirSync(dir).find((name) => /^readme(\.md|\.txt)?$/i.test(name) && fs.statSync(path.join(dir, name)).isFile());
    if (readme) {
      const text = fs.readFileSync(path.join(dir, readme), 'utf8');
      const stated = /(?:this (?:repository|project|repo|collection)|everything here|all (?:skills|content)[^.\n]{0,40}) (?:is|are) (?:released |distributed |made available )?(?:licensed )?under (?:the )?([^.\n]{3,60})/i.exec(text);
      if (stated) found = classify(stated[1]);
    }
  }
  licenseCache.set(dir, found);
  return found;
}

/**
 * A skill's licence: its own field or file first, then each folder above it up to the pack.
 * "" when nothing says, "proprietary" when the files may not be passed on.
 */
function skillLicense(dir, field, packRoot) {
  const own = classify(field);
  if (own) return own;
  for (let folder = dir; ; folder = path.dirname(folder)) {
    const found = folderLicense(folder);
    if (found) return found;
    if (folder === packRoot || path.dirname(folder) === folder) return '';
  }
}

function collectFiles(dir) {
  const files = [];
  let bytes = 0;
  const walk = (folder, prefix, depth) => {
    if (depth > 4) return;
    const entries = fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_FOLDERS.has(entry.name)) walk(abs, relative, depth + 1);
      } else if (entry.isFile() && relative !== 'SKILL.md') {
        const size = fs.statSync(abs).size;
        const isLicense = /^LICENSE(\.txt|\.md)?$/i.test(entry.name);
        if (!isLicense && !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        if (size > MAX_FILE || files.length >= MAX_SKILL_FILES || bytes + size > MAX_SKILL_BYTES) continue;
        files.push({ path: relative, size });
        bytes += size;
      }
    }
  };
  walk(dir, '', 0);
  return { files, bytes };
}

/**
 * Every skill in a pack, in folder order: a folder with a SKILL.md is a skill (nothing inside it is
 * searched further). `collection` is the folder the skill came in, such as "microsoft-skills".
 */
function findSkills(packRoot) {
  const found = [];
  const walk = (dir, depth, trail) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // Hidden folders are searched too: collections keep skills in .github/plugins, .claude/skills
      // or skills/.system. Only .git, node_modules and test folders are not.
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === '.git' || entry.name.startsWith('_sources') || FIND_SKIP.has(entry.name)) continue;
      const sub = path.join(dir, entry.name);
      if (fs.existsSync(path.join(sub, 'SKILL.md'))) found.push({ dir: sub, folder: entry.name, trail: [...trail] });
      else walk(sub, depth + 1, [...trail, entry.name]);
    }
  };
  walk(packRoot, 0, []);
  return found;
}

/** "Official · microsoft-skills" from the folders above a skill in the Genesys Labs pack. */
function collectionLabel(trail, packName) {
  const [group, repo] = trail;
  const groupName = group ? group.replace(/^\d+-/, '').replace(/-/g, ' ') : packName;
  return repo && !repo.startsWith('_') ? `${groupName} · ${repo}` : groupName;
}

/** owner__repo lines from a pack's _sources.tsv, for crediting each collection. */
function packSources(packRoot) {
  const file = path.join(packRoot, '_sources.tsv');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, commit] = line.split('\t');
    const [owner, repo] = id.split('__');
    return { owner, repo, commit: commit || '' };
  }).filter((item) => item.owner && item.repo);
}

/** The GitHub repository a collection folder came from, such as microsoft-skills -> microsoft/skills. */
function repoFor(folder, known) {
  const name = String(folder || '').toLowerCase();
  return known.find((item) => `${item.owner}-${item.repo}`.toLowerCase() === name)
    || known.find((item) => item.repo.toLowerCase() === name)
    || known.find((item) => name.startsWith(`${item.owner.toLowerCase()}-`))
    || null;
}

/**
 * --reindex [folder]: reads every SKILL.md of a library that is already built (build/skill-library,
 * or the folder given) again, refreshes what the index says about each skill that comes from its
 * header (today: its connector), and packs the .asar again. No skill is added or removed.
 */
function reindex() {
  const dir = folders[0] ? path.resolve(folders[0]) : outDir;
  const file = path.join(dir, 'index.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  let connectors = 0;
  for (const skill of data.skills) {
    const parsed = parseSkill(fs.readFileSync(path.join(dir, 'skills', skill.name, 'SKILL.md'), 'utf8'));
    delete skill.connector;
    if (parsed.connector) { skill.connector = parsed.connector; connectors += 1; }
  }
  fs.writeFileSync(file, JSON.stringify(data));
  console.log(`library: ${data.skills.length} skills, ${connectors} of them need a connector`);
  return require('@electron/asar').createPackage(dir, asarFile).then(() => {
    console.log(`wrote ${asarFile} (${(fs.statSync(asarFile).size / 1024 / 1024).toFixed(1)} MB)`);
  });
}

function main() {
  if (args.includes('--reindex')) return reindex();
  if (!sources.length) throw new Error('No skills folder found.');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'skills'), { recursive: true });
  const skipped = { broken: [], noLicense: [], proprietary: [], offensive: [], tooLarge: [], badName: [], duplicate: [] };
  const index = [];
  const names = new Set();
  const perPack = {};
  const collections = new Map();
  for (const packRoot of sources) {
    const packName = path.basename(packRoot);
    const known = packSources(packRoot);
    perPack[packName] = 0;
    for (const { dir, folder, trail } of findSkills(packRoot)) {
      // "-21risk-automation": a name may not start or end with a dash.
      const name = folder.toLowerCase().replace(/[_\s]+/g, '-').replace(/^-+|-+$/g, '');
      if (!NAME_RE.test(name)) { skipped.badName.push(folder); continue; }
      if (names.has(name)) { skipped.duplicate.push(folder); continue; }
      const file = path.join(dir, 'SKILL.md');
      if (fs.statSync(file).size > MAX_SKILL_MD) { skipped.tooLarge.push(folder); continue; }
      const parsed = parseSkill(fs.readFileSync(file, 'utf8'));
      if (parsed.error) { skipped.broken.push(folder); continue; }
      const license = skillLicense(dir, parsed.meta.license, packRoot);
      if (license === 'proprietary') { skipped.proprietary.push(folder); continue; }
      if (!license) { skipped.noLicense.push(`${trail.join('/')}/${folder}`); continue; }
      const offensiveCollection = trail.some((part) => OFFENSIVE_COLLECTIONS.has(part));
      const risk = offensiveCollection ? 'offensive'
        : ['safe', 'none', 'critical', 'offensive'].includes(parsed.meta.risk) ? parsed.meta.risk : 'unknown';
      if (risk === 'offensive' && !includeOffensive) { skipped.offensive.push(folder); continue; }
      const { files, bytes } = collectFiles(dir);
      const target = path.join(outDir, 'skills', name);
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(file, path.join(target, 'SKILL.md'));
      for (const item of files) {
        fs.mkdirSync(path.dirname(path.join(target, item.path)), { recursive: true });
        fs.copyFileSync(path.join(dir, item.path), path.join(target, item.path));
      }
      names.add(name);
      perPack[packName] += 1;
      // Credit for the notices: which collection, from which repository, under which licences.
      const repoFolder = trail[1] && !trail[1].startsWith('_') ? trail[1] : '';
      const key = `${packName}/${trail[0] || ''}/${repoFolder}`;
      if (!collections.has(key)) {
        const origin = repoFolder ? repoFor(repoFolder, known) : null;
        collections.set(key, {
          collection: collectionLabel(trail, packName),
          repository: origin ? `https://github.com/${origin.owner}/${origin.repo}` : '',
          commit: origin?.commit || '',
          licenses: new Set(),
          skills: 0,
        });
      }
      const credit = collections.get(key);
      credit.licenses.add(license);
      credit.skills += 1;
      index.push({
        name,
        description: parsed.description,
        risk,
        category: parsed.meta.category || (trail[0] ? trail[0].replace(/^\d+-/, '').replace(/-/g, ' ') : ''),
        tags: parsed.meta.tags.slice(0, 12),
        source: (parsed.meta.source || collectionLabel(trail, packName)).slice(0, 120),
        license: license.slice(0, 60),
        bytes: bytes + fs.statSync(file).size,
        files,
        // Works only through a connector of another assistant (skills.cjs skillConnector): listed, never offered.
        ...(parsed.connector ? { connector: parsed.connector } : {}),
      });
    }
  }
  index.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ version: 1, skills: index }));
  const credits = [...collections.values()].map((item) => ({ ...item, licenses: [...item.licenses].sort() }))
    .sort((a, b) => b.skills - a.skills);
  fs.writeFileSync(path.join(outDir, 'sources.json'), JSON.stringify(credits, null, 2));
  const totalBytes = index.reduce((sum, skill) => sum + skill.bytes, 0);
  const totalFiles = index.reduce((sum, skill) => sum + skill.files.length + 1, 0);
  console.log(`library: ${index.length} skills, ${totalFiles} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  for (const [pack, count] of Object.entries(perPack)) console.log(`  from ${pack}: ${count}`);
  for (const [reason, list] of Object.entries(skipped)) {
    if (list.length) console.log(`  left out (${reason}): ${list.length}${list.length <= 12 ? ` — ${list.join(', ')}` : ''}`);
  }
  if (skipped.noLicense.length) {
    const byGroup = {};
    for (const item of skipped.noLicense) {
      const group = item.split('/').slice(0, 2).join('/');
      byGroup[group] = (byGroup[group] || 0) + 1;
    }
    console.log(`  no licence, by folder: ${Object.entries(byGroup).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([g, n]) => `${g} ${n}`).join('; ')}`);
  }
  const licenses = {};
  for (const skill of index) licenses[skill.license] = (licenses[skill.license] || 0) + 1;
  console.log(`  licences: ${Object.entries(licenses).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(', ')}`);
  return require('@electron/asar').createPackage(outDir, asarFile).then(() => {
    console.log(`wrote ${asarFile} (${(fs.statSync(asarFile).size / 1024 / 1024).toFixed(1)} MB)`);
  });
}

Promise.resolve().then(main).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
