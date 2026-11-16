// Skills: saved instructions the model loads when a task matches, in the same folder format Claude
// uses. A skill is a folder with a SKILL.md (a short header with name and description, then the
// instructions) and, optionally, more files beside it: references to read and scripts to run.
// Only the name and description cost context until a skill is loaded, and its other files cost
// nothing until the model asks for one.
const path = require('node:path');
const fsp = require('node:fs/promises');
const { ensureDir } = require('./util.cjs');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 240;
// The other files of one skill that are listed for the model.
const MAX_SKILL_FILES = 300;
const MAX_SKILL_DEPTH = 4;
// The installed skills are read from disk again at most this often.
const LIST_TTL_MS = 5000;

/** "value", 'value' or value, without the quotes. */
function unquote(value) {
  const text = String(value).trim();
  const quoted = text.match(/^(["'])([\s\S]*)\1$/);
  return quoted ? quoted[2] : text;
}

/**
 * Reads the header of a SKILL.md. It is YAML, but only the shapes skills really use are understood:
 * `key: value`, quoted values, values folded over several lines (`>` or `|`, or just indented), and
 * lists written as `[a, b]` or as `- a` lines. Anything nested deeper is ignored.
 */
function parseHeader(text) {
  const fields = {};
  let key = '';
  let inline = '';
  let extra = [];
  const finish = () => {
    if (!key) return;
    const lines = extra.map((line) => line.trim()).filter(Boolean);
    if (/^[>|][+-]?$/.test(inline)) {
      fields[key] = lines.join(inline.startsWith('|') ? '\n' : ' ');
    } else if (!inline && lines.length && lines.every((line) => line.startsWith('- '))) {
      fields[key] = lines.map((line) => unquote(line.slice(2)));
    } else if (/^\[.*\]$/.test(inline)) {
      fields[key] = inline.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      // Indented lines under a plain value continue it; under an empty value they are a nested map.
      // "description:" with the text on the indented lines below (a plain YAML value over several
      // lines, as Vercel's skills write it) is that text, not a nested map.
      const plain = !inline && lines.length && !lines.some((line) => /^[\w-]+:(\s|$)/.test(line));
      fields[key] = inline ? unquote([inline, ...lines.filter((line) => !/^[\w-]+:\s/.test(line))].join(' ')) : plain ? unquote(lines.join(' ')) : '';
    }
  };
  for (const line of text.split('\n')) {
    const field = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (field) {
      finish();
      key = field[1].toLowerCase();
      inline = field[2].trim();
      extra = [];
    } else if (key && /^\s+\S/.test(line)) {
      extra.push(line);
    }
  }
  finish();
  return fields;
}

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

/** A description short enough for a list, cut at a word. */
function shortDescription(value) {
  const text = String(Array.isArray(value) ? value.join(' ') : value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  const cut = text.slice(0, MAX_DESCRIPTION_CHARS - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX_DESCRIPTION_CHARS - 40)).replace(/[\s,;:.]+$/, '')}…`;
}

function parseSkill(raw) {
  const text = String(raw).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { error: 'SKILL.md must start with a --- header holding name and description.' };
  const fields = parseHeader(match[1]);
  const description = shortDescription(fields.description);
  if (!description) return { error: 'The header needs a description, so the model knows when to use this skill.' };
  const body = match[2].trim();
  if (!body) return { error: 'SKILL.md has no instructions below its header.' };
  return {
    description,
    body,
    requires: asList(fields.requires),
    // What a skill from a library says about itself. None of it changes what the skill may do.
    meta: {
      risk: String(fields.risk || '').toLowerCase(),
      category: String(fields.category || '').toLowerCase(),
      tags: asList(fields.tags),
      source: String(fields.source || ''),
      license: String(fields.license || ''),
    },
  };
}

const PERMISSIONS = {
  terminal: { setting: 'allowShell', label: 'Terminal access' },
  internet: { setting: 'allowInternet', label: 'Internet access' },
  edits: { setting: 'allowEdits', label: 'File edits' },
};

/** Names the switch this skill still needs, so it is not offered to the model until it can work. */
function missingPermission(requires, settings) {
  const needed = requires.map((item) => PERMISSIONS[item]).find((item) => item && !settings[item.setting]);
  return needed ? needed.label : '';
}

// ---- finding the skills that fit a request ----

const STOPWORDS = new Set(('a an and are as at be but by can do for from has have how i if in into is it its me my of on or our '
  + 'please so that the their them then there these this to use used using want was we what when which who why will with you your '
  + 'about all any also make need needs get help new some should would could file files code project').split(' '));

/** Words that carry meaning, lowercased, with plural and verb endings removed so "tests" finds "testing". */
function keywords(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.]*[a-z0-9+#]|[a-z0-9]/g) || [];
  return words
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map((word) => (word.length > 4 ? word.replace(/(?:ing|ed|es|s)$/, '') : word));
}

/**
 * The skills that match some text, best first. Each word of the text counts once per skill: most in
 * the name, less in its tags, least in the description, and rarer words count more. This costs no
 * model time, so it can run on every message, however many skills are installed.
 */
function rankSkills(skills, text, limit = 8) {
  const wanted = [...new Set(keywords(text))];
  if (!wanted.length || !skills.length) return [];
  const documents = skills.map((skill) => ({
    skill,
    name: new Set(keywords(String(skill.name).replace(/-/g, ' '))),
    tags: new Set(keywords([...(skill.meta?.tags || []), skill.meta?.category || ''].join(' '))),
    description: new Set(keywords(skill.description)),
  }));
  const frequency = new Map();
  for (const document of documents) {
    for (const word of new Set([...document.name, ...document.tags, ...document.description])) {
      frequency.set(word, (frequency.get(word) || 0) + 1);
    }
  }
  const phrase = ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const ranked = [];
  for (const document of documents) {
    let score = 0;
    let hits = 0;
    let nameHits = 0;
    for (const word of wanted) {
      const weight = document.name.has(word) ? 4 : document.tags.has(word) ? 2 : document.description.has(word) ? 1 : 0;
      if (!weight) continue;
      hits += 1;
      if (weight === 4) nameHits += 1;
      score += weight * Math.log(1 + documents.length / frequency.get(word));
    }
    // "use the code review skill" names it outright.
    if (phrase.includes(` ${String(document.skill.name).replace(/-/g, ' ')} `)) {
      score += 20;
      nameHits += 1;
      hits += 1;
    }
    if (score > 0) ranked.push({ skill: document.skill, score, hits, nameHits });
  }
  ranked.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return ranked.slice(0, limit);
}

/** A match good enough to ask the model about, even for a request that is not about the workspace. */
function isStrongMatch(entry) {
  return Boolean(entry) && (entry.nameHits >= 2 || (entry.nameHits >= 1 && entry.hits >= 2) || entry.hits >= 3);
}

/**
 * Finds skills in a project's .uma/skills folder and in the
 * shared folder. Project skills win on a name clash.
 */
class SkillStore {
  constructor({ globalDir, bundledDir = '', store, trash = null, library = null }) {
    this.globalDir = globalDir;
    // The skill library shipped with Uma (skillLibrary.cjs): with "Use the whole skill library" on,
    // its skills are offered to the model without being installed (copied) first.
    this.library = library;
    this.bundledDir = bundledDir;
    this.store = store;
    this.trash = trash;
    // Parsed SKILL.md files, kept while the file's size and time stay the same.
    this.parsed = new Map();
    this.scanned = new Map();
  }

  projectDir(root) {
    return path.join(root, '.uma', 'skills');
  }

  /** Forget what was read, after something changed the skill folders. */
  invalidate() {
    this.scanned.clear();
  }

  async scan(dir, source) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    // One message asks for the skills several times. While the folder holds the same skills, what
    // was read a moment ago is reused; an edit to a SKILL.md is picked up within a few seconds.
    const listing = entries.map((entry) => entry.name).join('\n');
    const recent = this.scanned.get(dir);
    if (recent && recent.listing === listing && Date.now() - recent.at < LIST_TTL_MS) return recent.skills;
    const skills = [];
    for (const entry of entries) {
      // Symlinks are skipped, so a project cannot point a skill at a file elsewhere on the PC.
      if (!entry.isDirectory() || entry.isSymbolicLink() || !NAME_RE.test(entry.name)) continue;
      const file = path.join(dir, entry.name, 'SKILL.md');
      const stat = await fsp.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const base = { name: entry.name, source, path: file, dir: path.join(dir, entry.name) };
      if (stat.size > MAX_FILE_BYTES) {
        skills.push({ ...base, description: '', error: 'SKILL.md is larger than 64 KB. Keep skills short: they use the model\'s context.' });
        continue;
      }
      // With hundreds of skills installed, reading every file again for each message is slow.
      const stamp = `${stat.size}:${stat.mtimeMs}`;
      let known = this.parsed.get(file);
      if (!known || known.stamp !== stamp) {
        known = { stamp, parsed: parseSkill(await fsp.readFile(file, 'utf8')) };
        this.parsed.set(file, known);
      }
      const { parsed } = known;
      skills.push({ ...base, description: parsed.description || '', body: parsed.body, requires: parsed.requires || [], meta: parsed.meta || {}, error: parsed.error || '' });
    }
    this.scanned.set(dir, { at: Date.now(), listing, skills });
    return skills;
  }

  /** Every skill, including disabled and broken ones, for the Settings panel. */
  async list(root) {
    const settings = this.store.getSettings();
    const disabled = new Set(settings.disabledSkills || []);
    const project = root ? await this.scan(this.projectDir(root), 'project') : [];
    const shared = await this.scan(this.globalDir, 'global');
    const names = new Set(project.map((skill) => skill.name));
    return [...project, ...shared.filter((skill) => !names.has(skill.name))]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => ({ ...skill, enabled: !disabled.has(skill.name), needs: missingPermission(skill.requires || [], settings) }));
  }

  /**
   * The library's skills that are not installed, as skills the model may use. Their instructions
   * are read only when one is loaded. A skill switched off in Settings stays off.
   */
  async librarySkills(installedNames) {
    if (!this.library) return [];
    const { skills } = await this.library.index();
    return skills
      .filter((entry) => !installedNames.has(entry.name))
      .map((entry) => ({
        name: entry.name,
        source: 'library',
        description: entry.description,
        dir: path.join(this.library.dir, 'skills', entry.name),
        path: path.join(this.library.dir, 'skills', entry.name, 'SKILL.md'),
        requires: [],
        meta: { risk: entry.risk || 'unknown', category: entry.category || '', tags: entry.tags || [], source: entry.source || '', license: entry.license || '' },
        libraryFiles: entry.files || [],
        enabled: true,
        error: '',
        needs: '',
      }));
  }

  /** The skills the model may use: the installed ones, then the library's. */
  async enabled(root) {
    const all = await this.list(root);
    const installed = all.filter((skill) => skill.enabled && !skill.error && !skill.needs);
    return [...installed, ...(await this.librarySkills(new Set(all.map((skill) => skill.name))))];
  }

  async load(name, root) {
    const skills = await this.enabled(root);
    const wanted = String(name || '').trim();
    let skill = skills.find((item) => item.name === wanted);
    if (skill?.source === 'library' && !skill.body) {
      // A library skill's instructions, read from the library when it is used.
      const parsed = parseSkill(await fsp.readFile(skill.path, 'utf8'));
      if (parsed.error) throw new Error(`The skill "${wanted}" could not be read: ${parsed.error}`);
      const needs = missingPermission(parsed.requires || [], this.store.getSettings());
      if (needs) throw new Error(`The skill "${wanted}" needs ${needs}, which is off. Tell the user they can turn it on in Settings.`);
      skill = { ...skill, body: parsed.body, requires: parsed.requires || [], meta: { ...skill.meta, ...parsed.meta, risk: skill.meta.risk } };
    }
    if (!skill) {
      // With a large library installed, the whole list would not fit in the reply.
      const close = skills.length > 30 ? rankSkills(skills, wanted.replace(/-/g, ' '), 8).map((entry) => entry.skill) : skills;
      const label = skills.length > 30 ? 'Closest skills' : 'Available skills';
      throw new Error(`There is no skill called "${name}". ${label}: ${close.map((item) => item.name).join(', ') || 'none'}.`);
    }
    return skill;
  }

  /** The other files of a skill (references, scripts, templates), as paths inside its folder. */
  async files(skill) {
    // The library lists each skill's files, so nothing inside the app archive has to be listed.
    if (skill.source === 'library') return (skill.libraryFiles || []).map((file) => ({ path: file.path, size: file.size || 0 }));
    const found = [];
    const walk = async (dir, depth, prefix) => {
      if (depth > MAX_SKILL_DEPTH || found.length >= MAX_SKILL_FILES) return;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (found.length >= MAX_SKILL_FILES) return;
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), depth + 1, relative);
        } else if (entry.isFile() && relative !== 'SKILL.md') {
          const stat = await fsp.stat(path.join(dir, entry.name)).catch(() => null);
          found.push({ path: relative, size: stat?.size || 0 });
        }
      }
    };
    await walk(skill.dir, 0, '');
    return found;
  }

  /**
   * Reads part of one file of a skill. The path is confined to the skill's own folder the same way
   * a workspace confines paths, so a skill cannot be used to read anything else on the PC.
   */
  async readFile(name, relative, root, options = {}) {
    const skill = await this.load(name, root);
    const { Workspace } = require('./workspace.cjs');
    const folder = new Workspace({ root: skill.dir, trash: null });
    await folder.init();
    const file = await folder.readFileRange(String(relative || 'SKILL.md'), options);
    return { skill, file };
  }

  async create({ name, description, scope = 'global', root }) {
    const clean = String(name || '').trim().toLowerCase();
    if (!NAME_RE.test(clean)) throw new Error('Use lowercase letters, numbers, and hyphens for the skill name, like fix-build-errors.');
    const summary = String(description || '').replace(/\s+/g, ' ').trim();
    if (!summary) throw new Error('Describe when the model should use this skill.');
    if (scope === 'project' && !root) throw new Error('Choose a workspace folder first.');
    const dir = path.join(scope === 'project' ? this.projectDir(root) : this.globalDir, clean);
    const file = path.join(dir, 'SKILL.md');
    if (await fsp.stat(file).catch(() => null)) throw new Error(`A skill called "${clean}" already exists there.`);
    await ensureDir(dir);
    await fsp.writeFile(file, `---\nname: ${clean}\ndescription: ${summary}\n---\n\n# ${clean}\n\nWrite the steps for the model here, as a short numbered list. Exact commands work best.\n\n1. First step\n2. Second step\n`, 'utf8');
    this.invalidate();
    return { name: clean, path: file };
  }

  /** Removes a skill from the shared folder (to the Recycle Bin when one is available). */
  async remove(name) {
    const clean = String(name || '');
    if (!NAME_RE.test(clean)) throw new Error('That skill no longer exists.');
    const dir = path.join(this.globalDir, clean);
    const stat = await fsp.lstat(dir).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('Only skills in the shared folder can be removed here. Delete a project skill from the project\'s .uma/skills folder.');
    if (this.trash) await this.trash(dir);
    else await fsp.rm(dir, { recursive: true, force: true });
    // A starter skill that was removed must not come back with the next update.
    const settings = this.store.getSettings();
    await this.store.updateSettings({
      seededSkills: [...new Set([...(settings.seededSkills || []), clean])],
      disabledSkills: (settings.disabledSkills || []).filter((item) => item !== clean),
    });
    this.invalidate();
  }

  /**
   * Copies each starter skill into the shared folder once, so it can be edited or deleted.
   * A new app version can add skills, and one the user deleted is never brought back.
   */
  async seed() {
    if (!this.bundledDir) return;
    const settings = this.store.getSettings();
    const seeded = new Set(settings.seededSkills || []);
    // 0.1.29 recorded a single flag, and shipped these two.
    if (settings.skillsSeeded) ['cpp-cmake-project', 'website-restyle'].forEach((name) => seeded.add(name));
    const entries = await fsp.readdir(this.bundledDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || seeded.has(entry.name)) continue;
      const target = path.join(this.globalDir, entry.name, 'SKILL.md');
      if (!(await fsp.stat(target).catch(() => null))) {
        await ensureDir(path.dirname(target));
        // Read and write rather than copy: the source may be inside the packaged app archive.
        await fsp.writeFile(target, await fsp.readFile(path.join(this.bundledDir, entry.name, 'SKILL.md')));
      }
      seeded.add(entry.name);
    }
    await this.store.updateSettings({ seededSkills: [...seeded] });
    this.invalidate();
  }
}

module.exports = { SkillStore, parseSkill, parseHeader, rankSkills, isStrongMatch, keywords, NAME_RE };
