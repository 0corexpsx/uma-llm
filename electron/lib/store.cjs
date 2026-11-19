const path = require('node:path');
const fsp = require('node:fs/promises');
const { readJson, writeJsonAtomic, ensureDir } = require('./util.cjs');

/** A damaged file is set aside so one bad write can never stop the app from starting. */
/**
 * A JSON file, or its last good copy (file.bak, kept by keepGoodCopy) when the file is damaged, for
 * example filled with zeros after a crash. A damaged file is kept as file.corrupt.
 */
async function readJsonOrReset(file, fallback) {
  try {
    return await readJson(file, fallback);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    await fsp.rename(file, `${file}.corrupt`).catch(() => {});
    try {
      const copy = JSON.parse(await fsp.readFile(`${file}.bak`, 'utf8'));
      await fsp.copyFile(`${file}.bak`, file).catch(() => {});
      console.warn(`[store] ${path.basename(file)} was damaged; restored the copy from the last start`);
      return copy;
    } catch {
      return fallback;
    }
  }
}

/** After a file read correctly at start, a copy of it is kept for readJsonOrReset. */
async function keepGoodCopy(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    JSON.parse(text);
    await writeJsonAtomic(`${file}.bak`, JSON.parse(text));
  } catch {}
}

const DEFAULT_SETTINGS = {
  onboarded: false,
  workspacePath: '',
  activeModelId: '',
  allowEdits: true,
  allowDelete: false,
  allowShell: false,
  // false once the user ticked "Don't ask again" in a command dialog: every terminal command,
  // downloads and installs included, then runs without asking (Settings can turn the question back on).
  askBeforeCommands: true,
  // The skills of the library shipped with Uma are offered to the model without installing them.
  useSkillLibrary: true,
  allowSystemAccess: false,
  allowInternet: false,
  // The model may take screenshots of windows (look_at_screen), when it has a vision file.
  allowScreen: false,
  // The model may move and click the mouse and use the keyboard in other programs (input.cjs).
  allowInput: false,
  contextSize: 8192,
  temperature: 0.35,
  topP: 0.9,
  gpuOffload: true,
  runtimeBackend: 'auto',
  lastConversationId: '',
  disabledSkills: [],
  // Add the workspace passages that match a request to it (rag.cjs).
  projectSearch: true,
  // Also search by meaning, once its small model is downloaded (embeddings.cjs).
  semanticSearch: true,
  // Chat memory (chatMemory.cjs): total size kept, and what happens beyond it: 'ask' once, then
  // 'overwrite' (the oldest chat memories make room) or 'continue' (until the disk is nearly full).
  chatMemoryLimitGB: 50,
  chatMemoryOverLimit: 'ask',
  // Folder for chat memory; empty means app data (another disk can be chosen in Settings).
  chatMemoryDir: '',
  // Memory (userMemory.cjs): facts about the user given to every chat, and the remember tool.
  useMemory: true,
  // Draw the window with the GPU (Chromium's usual way). Off: the CPU draws it, which leaves the
  // GPU's memory to the model and saves about 100 MB of RAM. Applies after a restart.
  interfaceGpu: true,
  // The Uma LLM version whose licence the user accepted, and when. A new version asks again.
  acceptedTermsVersion: '',
  acceptedTermsAt: '',
  // Look for a newer Uma once a day (updater.cjs), and when the last look was.
  checkForUpdates: true,
  lastUpdateCheck: 0,
  // Load the selected model when Uma opens (and when another is selected), so the first reply does not wait for it.
  loadModelAtStart: true,
  skillsSeeded: false,
  seededSkills: [],
  modelOverrides: {},
  theme: 'system',
  // Interface language (see i18n.cjs). installerLanguage is the last choice read from the Windows installer.
  language: '',
  installerLanguage: '',
  // Helper PCs on the local network; see network.cjs.
  network: { share: false, shareAddress: '', sharePort: 50052, helpers: [], helpersMode: 'auto' },
};

class Store {
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.settingsFile = path.join(userDataDir, 'settings.json');
    this.modelsFile = path.join(userDataDir, 'models.json');
    this.runtimeFile = path.join(userDataDir, 'runtime.json');
    this.benchmarksFile = path.join(userDataDir, 'benchmarks.json');
    this.conversationsDir = path.join(userDataDir, 'conversations');
    this.settings = { ...DEFAULT_SETTINGS };
    this.models = { installed: [] };
    this.runtime = {};
    this.benchmarks = [];
  }

  async init() {
    await ensureDir(this.dir);
    await ensureDir(this.conversationsDir);
    const settings = await readJsonOrReset(this.settingsFile, {});
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.models = await readJsonOrReset(this.modelsFile, { installed: [] });
    this.runtime = await readJsonOrReset(this.runtimeFile, {});
    for (const file of [this.settingsFile, this.modelsFile, this.runtimeFile]) await keepGoodCopy(file);
    this.benchmarks = await readJsonOrReset(this.benchmarksFile, []);
  }

  getSettings() {
    return { ...this.settings };
  }

  /** The general settings, with one model's own settings on top. */
  getEffectiveSettings(modelId) {
    const settings = this.getSettings();
    return { ...settings, ...(settings.modelOverrides?.[modelId] || {}) };
  }

  async setModelOverrides(modelId, overrides) {
    const all = { ...(this.settings.modelOverrides || {}) };
    if (overrides && Object.keys(overrides).length) all[modelId] = overrides;
    else delete all[modelId];
    return this.updateSettings({ modelOverrides: all });
  }

  async updateSettings(patch) {
    const allowed = Object.keys(DEFAULT_SETTINGS);
    // Allowing terminal commands is the permission: from then on they run without a question for
    // each one. Whoever wants the question turns "Ask before each command" on afterwards (or in the
    // same change, which is then left as it was asked).
    const terminalTurnedOn = patch?.allowShell === true && this.settings.allowShell !== true && patch.askBeforeCommands === undefined;
    for (const [key, value] of Object.entries(patch || {})) {
      if (allowed.includes(key)) this.settings[key] = value;
    }
    if (terminalTurnedOn) this.settings.askBeforeCommands = false;
    await writeJsonAtomic(this.settingsFile, this.settings);
    return this.getSettings();
  }

  getInstalledModels() {
    return [...(this.models.installed || [])];
  }

  async setInstalledModels(installed) {
    this.models = { installed };
    await writeJsonAtomic(this.modelsFile, this.models);
  }

  getRuntime() {
    return { ...this.runtime };
  }

  async setRuntime(runtime) {
    this.runtime = { ...runtime };
    await writeJsonAtomic(this.runtimeFile, this.runtime);
  }

  getBenchmarks() {
    return [...this.benchmarks];
  }

  async addBenchmark(record) {
    this.benchmarks = [record, ...this.benchmarks].slice(0, 12);
    await writeJsonAtomic(this.benchmarksFile, this.benchmarks);
    return record;
  }

  async clearBenchmarks() {
    this.benchmarks = [];
    await writeJsonAtomic(this.benchmarksFile, this.benchmarks);
  }
}

module.exports = { Store, DEFAULT_SETTINGS };
