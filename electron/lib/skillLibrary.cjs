// The skill library: a large collection of ready-made skills that ships with Uma but is not
// installed. Nothing in it reaches the model until the user installs a skill from Settings, which
// copies that skill's folder into the shared skills folder, where it can be edited or removed.
//
// The library is built by scripts/make_skill_library.cjs into a folder (or one .asar file) holding
// index.json and skills/<name>/.... The index lists every file of every skill, so installing needs
// no directory listing and works the same from a folder or from inside the packaged archive.
const path = require('node:path');
const fsp = require('node:fs/promises');
const { ensureDir } = require('./util.cjs');
const { rankSkills, NAME_RE } = require('./skills.cjs');

// What the authors of a skill say about it. "critical" skills act on real accounts and servers;
// "offensive" ones describe attack techniques for security testing.
const RISK_LEVELS = ['safe', 'none', 'unknown', 'critical', 'offensive'];

function safeRelative(file) {
  const clean = String(file || '').replace(/\\/g, '/');
  return Boolean(clean) && !clean.startsWith('/') && !/^[a-zA-Z]:/.test(clean) && !clean.split('/').some((part) => part === '..' || part === '');
}

class SkillLibrary {
  constructor({ dir }) {
    this.dir = dir;
    this.loaded = null;
  }

  /** Every skill in the library. An app built without one has an empty library. */
  async index() {
    if (!this.loaded) {
      this.loaded = fsp.readFile(path.join(this.dir, 'index.json'), 'utf8')
        .then((text) => {
          const data = JSON.parse(text);
          const skills = (data.skills || []).filter((skill) => NAME_RE.test(skill.name) && skill.description);
          return { skills, byName: new Map(skills.map((skill) => [skill.name, skill])) };
        })
        .catch(() => ({ skills: [], byName: new Map() }));
    }
    return this.loaded;
  }

  /**
   * One page of the library. With a query the best matches come first; without one the list is
   * alphabetical. `installed` is the set of skill names already in the shared folder.
   */
  async search({ query = '', risk = '', offset = 0, limit = 40 } = {}, installed = new Set()) {
    const { skills } = await this.index();
    const wantedRisk = RISK_LEVELS.includes(risk) ? risk : '';
    // 'connector' as a filter lists the skills that need one, which Uma cannot use.
    const pool = risk === 'connector' ? skills.filter((skill) => skill.connector)
      : wantedRisk ? skills.filter((skill) => (skill.risk || 'unknown') === wantedRisk) : skills;
    const text = String(query || '').trim();
    let matches = pool;
    if (text) {
      const lower = text.toLowerCase();
      const ranked = rankSkills(pool.map((skill) => ({ ...skill, meta: { tags: skill.tags, category: skill.category } })), text, 300)
        .map((entry) => entry.skill.name);
      // A fragment of a name ("dock") is no whole word, so plain containment is added after the ranked ones.
      const seen = new Set(ranked);
      const byName = new Map(pool.map((skill) => [skill.name, skill]));
      const partial = pool.filter((skill) => !seen.has(skill.name) && skill.name.includes(lower.replace(/\s+/g, '-'))).map((skill) => skill.name);
      matches = [...ranked, ...partial].map((name) => byName.get(name));
    }
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.max(1, Math.min(100, Number(limit) || 40));
    return {
      total: matches.length,
      librarySize: skills.length,
      // How many of them the model can really use: the others need a connector Uma does not have.
      usableSize: skills.filter((skill) => !skill.connector).length,
      items: matches.slice(start, start + size).map((skill) => ({
        name: skill.name,
        description: skill.description,
        risk: skill.risk || 'unknown',
        category: skill.category || '',
        source: skill.source || '',
        license: skill.license || '',
        files: (skill.files || []).length,
        bytes: skill.bytes || 0,
        installed: installed.has(skill.name),
        connector: skill.connector || '',
      })),
    };
  }

  async get(name) {
    return (await this.index()).byName.get(String(name || '')) || null;
  }

  /** Copies one skill into `targetRoot/<name>`. Returns the path of its SKILL.md. */
  async install(name, targetRoot) {
    const skill = await this.get(name);
    if (!skill) throw new Error('That skill is not in the library.');
    const target = path.join(targetRoot, skill.name);
    if (await fsp.stat(path.join(target, 'SKILL.md')).catch(() => null)) throw new Error(`A skill called "${skill.name}" is already installed.`);
    const source = path.join(this.dir, 'skills', skill.name);
    const files = ['SKILL.md', ...(skill.files || []).map((file) => file.path)].filter(safeRelative);
    try {
      for (const file of files) {
        const destination = path.join(target, file);
        await ensureDir(path.dirname(destination));
        // Read and write rather than copy: the library may be inside the packaged app archive.
        await fsp.writeFile(destination, await fsp.readFile(path.join(source, file)));
      }
    } catch (err) {
      // Half a skill is worse than none.
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    return path.join(target, 'SKILL.md');
  }
}

module.exports = { SkillLibrary, RISK_LEVELS };
