const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, nativeTheme, clipboard, globalShortcut } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

if (process.env.UMA_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.UMA_USER_DATA));
} else {
  // models, chats and settings live in the "Uma LLM" folder under the user's app data
  app.setPath('userData', path.join(app.getPath('appData'), 'Uma LLM'));
}

// "Use the GPU to draw Uma's window" (Settings → Appearance) has to be decided before Electron
// starts, so it is read straight from the settings file here.
const interfaceGpu = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')).interfaceGpu !== false;
  } catch {
    return true;
  }
})();
if (!interfaceGpu) app.disableHardwareAcceleration();

// Apps opened from the Finder or Dock get a bare PATH (/usr/bin:/bin:...), without Homebrew or
// the user's own tools, so take the PATH the user's login shell would have.
if (process.platform === 'darwin') {
  try {
    const shellPath = require('node:child_process')
      .execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 4000 })
      .split('__PATH__').pop().trim();
    const dirs = [...shellPath.split(':'), ...String(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin'];
    process.env.PATH = [...new Set(dirs.filter(Boolean))].join(':');
  } catch {}
}

const { Store } = require('./lib/store.cjs');
const { detectHardware } = require('./lib/hardware.cjs');
const { Workspace } = require('./lib/workspace.cjs');
const { ModelManager } = require('./lib/models.cjs');
const { RuntimeManager, ENGINE_BUILD } = require('./lib/runtime.cjs');
const { LlamaManager } = require('./lib/llama.cjs');
const { ConversationStore } = require('./lib/conversations.cjs');
const { ToolRunner } = require('./lib/tools.cjs');
const { AgentRunner } = require('./lib/agent.cjs');
const { UndoLog } = require('./lib/undo.cjs');
const { SkillStore } = require('./lib/skills.cjs');
const { SkillLibrary } = require('./lib/skillLibrary.cjs');
const { Updater } = require('./lib/updater.cjs');
const { ProjectIndex } = require('./lib/rag.cjs');
const { EmbeddingEngine, VectorStore } = require('./lib/embeddings.cjs');
const { freeVramBytes } = require('./lib/hardware.cjs');
const { ChatMemory, FOLDER_NAME: CHAT_MEMORY_FOLDER } = require('./lib/chatMemory.cjs');
const { UserMemory, parseImport, EXPORT_PROMPT } = require('./lib/userMemory.cjs');
const { BatchTuner, CANDIDATES: BATCH_SIZES } = require('./lib/batchTuner.cjs');
const { capture, printPdf } = require('./lib/capture.cjs');
const { InputController } = require('./lib/input.cjs');
const crypto = require('node:crypto');
const { estimateMemory } = require('./lib/memory.cjs');
const { DEFAULTS: MODEL_DEFAULTS, sanitizeModelSettings, defaultThreads, draftCompatibility, SUGGESTED_DRAFTS } = require('./lib/modelSettings.cjs');
const { searchModels, repoVariants, remoteModelInfo } = require('./lib/huggingface.cjs');
const { findVision } = require('./lib/visionFinder.cjs');
const { readGguf: readModelHeader, fileSource: localSource } = require('./lib/gguf.cjs');
const { AttachmentStore } = require('./lib/attachments.cjs');
const { SystemStats } = require('./lib/systemStats.cjs');
const { NetworkManager } = require('./lib/network.cjs');
const { ensureDir, formatBytes } = require('./lib/util.cjs');
const { t, setLanguage, systemLanguage, fromWindowsLanguageId, isLanguage, LANGUAGES } = require('./lib/i18n.cjs');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.setAppUserModelId('com.ocorex.uma');

let mainWindow = null;
let store;
let hardware;
let workspace = null;
let models;
let runtime;
let llama;
let conversations;
let agent;
let benchmark;
let toolRunner;
let undoLog;
let skills;
let skillLibrary;
let updater;
// One search index per workspace folder, kept while Uma runs, so switching back is instant.
const projectIndexes = new Map();
let projectIndex = null;
// Meaning search: one embedding engine for every workspace, started only when it is needed.
let embeddingEngine = null;
let chatMemory = null;
let userMemory = null;
let batchTuner = null;
let attachments;
let network;
let userDataDir;
const systemStats = new SystemStats();
let lastStats = null;
let dirs;

function send(channel, payload) {
  if (channel === 'chat:event' && mainWindow && !mainWindow.isDestroyed()) {
    if (payload?.type === 'assistant-start') mainWindow.setProgressBar(2);
    if (payload?.type === 'assistant-end') mainWindow.setProgressBar(-1);
  }
  if (channel === 'chat:event' && payload?.type === 'assistant-end') reportReplySpeed(payload.message?.stats);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** After a reply that used helper PCs: its measured speed goes to them, for their Shared screen. */
function reportReplySpeed(stats) {
  const servers = llama?.status().helpers?.servers || [];
  if (!stats || !servers.length || !network) return;
  const rate = (tokens, ms) => (ms > 0 ? (tokens / (ms / 1000)).toFixed(1) : '0');
  const summary = [
    `read ${stats.promptTokens} tokens at ${rate(stats.promptTokens, stats.promptMs)} tok/s`,
    stats.cachedTokens ? `${stats.cachedTokens} more were already read` : '',
    `wrote ${stats.outputTokens} tokens at ${rate(stats.outputTokens, stats.outputMs)} tok/s`,
    stats.draftTokens ? `draft guesses kept ${Math.round((stats.draftAccepted / stats.draftTokens) * 100)}% (${stats.draftAccepted} of ${stats.draftTokens})` : '',
    stats.firstTokenMs != null ? `first word after ${Math.round(stats.firstTokenMs / 1000)} s` : '',
    `${Math.round((stats.totalMs || 0) / 1000)} s in total over ${stats.calls} model call${stats.calls === 1 ? '' : 's'}`,
  ].filter(Boolean).join('; ');
  network.reportToHelpers(servers, { kind: 'reply', summary });
}

let autoApproveActions = false;

async function confirmAction(kind, detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const isInstall = kind === 'install';
  // Downloads and installs always ask: auto-accept must not let a web page talk the model into one.
  if (autoApproveActions && !isInstall) return true;
  const isCommand = kind === 'run_command';
  // "Don't ask again" in a command dialog: the user chose to let every terminal command run.
  if ((isCommand || isInstall) && store?.getSettings().askBeforeCommands === false) return true;
  // The dialog is in the app's language: it asks the user to approve something, so it must be understood.
  const title = isInstall
    ? t('Download or install software?')
    : isCommand
      ? t('Run this command?')
      : t('Confirm file change');
  const message = isInstall
    ? t('The agent wants to download or install software.')
    : isCommand
      ? t('The agent wants to run a terminal command.')
      : t('The agent wants to change files in the workspace.');
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title,
    message,
    detail: t('{0}\n\n{1}\n\nYou are responsible for everything this action does on this computer.', [title, String(detail).slice(0, 1500)]),
    buttons: [t('Yes'), t('No')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    checkboxLabel: isCommand || isInstall
      ? t("Don't ask again: run every terminal command without asking, downloads and installs included (I take full responsibility). You can turn the question back on in Settings.")
      : t('Auto-accept future file changes and commands this session, except downloads and installs (I take full responsibility)'),
    checkboxChecked: false,
  });
  if (result.response === 0 && result.checkboxChecked) {
    if (isCommand || isInstall) {
      await store.updateSettings({ askBeforeCommands: false });
      // Settings shows the switch off without being reopened.
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('settings:changed');
    }
    else autoApproveActions = true;
  }
  return result.response === 0;
}

/**
 * Mouse and keyboard for the model (Settings → "Control the mouse and keyboard"). While it acts, a
 * small notice stays in the bottom-right corner; Ctrl+Alt+Esc, or pushing the pointer into the
 * top-left corner, stops it until the next message.
 */
const STOP_SHORTCUT = 'Control+Alt+Escape';
let input = null;
let inputBanner = null;
let inputBannerTimer = null;
function screenGeometry() {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  // The picture is made from the screen's real pixels; input uses points on a Mac, pixels elsewhere.
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
function showInputBanner(text) {
  if (process.env.UMA_TEST_HIDE === '1' && !process.env.UMA_TEST_INPUT_BANNER) return;
  const area = screen.getPrimaryDisplay().workArea;
  if (!inputBanner || inputBanner.isDestroyed()) {
    inputBanner = new BrowserWindow({
      width: 480, height: 66, x: area.x + area.width - 496, y: area.y + area.height - 82,
      frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
      alwaysOnTop: true, show: false, hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    inputBanner.setIgnoreMouseEvents(true);
    inputBanner.setAlwaysOnTop(true, 'screen-saver');
    // Left out of screenshots, so the model sees the screen as it is.
    inputBanner.setContentProtection(true);
  }
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;overflow:hidden;font:600 12px 'Segoe UI',sans-serif;color:#fff">
<div style="margin:3px;padding:9px 14px;border-radius:7px;background:linear-gradient(#2a76c6,#174f93);border:1px solid #8fd0ff;box-shadow:0 2px 10px rgba(0,0,0,.4)">${text}</div></body>`;
  inputBanner.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => inputBanner?.showInactive()).catch(() => {});
  clearTimeout(inputBannerTimer);
  inputBannerTimer = setTimeout(() => { if (inputBanner && !inputBanner.isDestroyed()) inputBanner.hide(); }, 6000);
}
function inputController() {
  if (!input) {
    input = new InputController({
      geometry: screenGeometry,
      onAction: () => showInputBanner(t('Uma is using the mouse and keyboard — Ctrl+Alt+Esc or top-left corner to stop')),
    });
  }
  return input;
}
/** The emergency stop: Ctrl+Alt+Esc, from any program. */
function stopInput() {
  input?.halt();
  agent?.stop();
  showInputBanner(t('Stopped: Uma no longer controls the mouse and keyboard'));
}

function connectWorkspace(next) {
  workspace = next;
  if (!projectIndexes.has(workspace.root)) projectIndexes.set(workspace.root, new ProjectIndex({ root: workspace.root }));
  projectIndex = projectIndexes.get(workspace.root);
  // Built in the background, so the first message does not wait for a large folder to be read.
  if (store.getSettings().projectSearch !== false) projectIndex.refresh({ budgetMs: 120000 }).catch(() => {});
  syncSemantic();
  toolRunner = new ToolRunner({
    workspace,
    store,
    onChanged: (changedPath) => {
      projectIndex?.invalidate();
      send('workspace:changed', { path: changedPath });
    },
    confirmAction,
    undoLog,
    skills,
    memory: userMemory,
    capture,
    printPdf,
    input: inputController(),
  });
  agent = new AgentRunner({ store, workspace, models, llama, conversations, toolRunner, send, attachments, projectIndex, memory: userMemory, indexFor: projectIndexFor });
}

/**
 * The two questions about chat memory: the limit was reached ('limit': keep saving, or keep the
 * limit by replacing the oldest), or the disk is nearly full ('disk': free space or delete memory).
 */
async function askAboutChatMemory(kind, info) {
  const gb = (bytes) => (bytes / 1073741824).toFixed(bytes < 10737418240 ? 1 : 0);
  if (kind === 'limit') {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: t('Chat memory'),
      message: t('Chat memory has reached {0} GB', [gb(info.limitBytes)]),
      detail: t('Uma saves what the local model has already read of each chat, so it remembers a chat and continues in seconds instead of reading it all again. The saved chats now use {0} GB.\n\nKeep saving: the memory keeps growing until the disk is nearly full.\nNo: Uma stops growing it and keeps {1} GB by replacing the memory of the chats you used longest ago.\n\nYou can change this or delete chat memory in Settings → Chat memory.', [gb(info.totalBytes), gb(info.limitBytes)]),
      buttons: [t('Keep saving'), t('No, keep {0} GB', [gb(info.limitBytes)])],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return result.response === 0 ? 'continue' : 'overwrite';
  }
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: t('Chat memory'),
    message: t('Only {0} GB free on this disk', [gb(info.freeBytes)]),
    detail: t('Chat memory uses {0} GB. Free some space on the disk, or delete chat memory, so Uma can keep remembering your chats. When the disk is almost full, chats are no longer saved.', [gb(info.totalBytes)]),
    buttons: [t('Open chat memory settings'), t('Delete all chat memory'), t('Later')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (result.response === 1) await chatMemory.removeAll();
  if (result.response === 0) send('app:open-settings', { section: 'settings-memory' });
  return null;
}

/** Whether meaning search is wanted and possible now: switched on, and its model downloaded. */
function semanticWanted() {
  const settings = store.getSettings();
  return settings.projectSearch !== false && settings.semanticSearch !== false && Boolean(embeddingEngine?.installed());
}

/** Attaches or detaches meaning search on the current workspace to match the settings. */
function syncSemantic(index = projectIndex) {
  if (!index) return;
  if (!semanticWanted()) {
    for (const each of projectIndexes.values()) each.detachSemantic();
    embeddingEngine?.stop();
    return;
  }
  if (index.semantic) return;
  const vectors = new VectorStore(path.join(userDataDir, 'rag', `${crypto.createHash('sha1').update(index.root).digest('hex').slice(0, 16)}.vec`));
  // Passages are encoded in the background, and wait while the chat model is answering.
  index.attachSemantic({ engine: embeddingEngine, store: vectors, shouldPause: () => Boolean(agent?.isBusy()) }).catch(() => {});
}

/** The project search of another folder (a chat's own folder), made and read on first use. */
async function projectIndexFor(root) {
  if (!projectIndexes.has(root)) {
    const index = new ProjectIndex({ root });
    projectIndexes.set(root, index);
    // A first look now (a few seconds at most), the rest in the background.
    await index.refresh({ budgetMs: 4000 }).catch(() => {});
    index.refresh({ budgetMs: 120000 }).catch(() => {});
  }
  const index = projectIndexes.get(root);
  syncSemantic(index);
  return index;
}

function ragStatus() {
  const settings = store.getSettings();
  return {
    ...(projectIndex?.stats || {}),
    enabled: settings.projectSearch !== false,
    building: Boolean(projectIndex?.scanning),
    semantic: {
      ...(embeddingEngine ? embeddingEngine.status() : {}),
      ...(projectIndex?.semanticStats() || {}),
      enabled: settings.semanticSearch !== false,
    },
  };
}

/**
 * CPU, memory, GPU and network speed of this PC. The title bar and the Server status screen (and a
 * main PC asking this helper) share one sample, at most one a second, so their readings agree.
 */
let statsAt = 0;
let statsPending = null;
function freshStats() {
  if (lastStats && Date.now() - statsAt < 1000) return Promise.resolve(lastStats);
  statsPending ||= systemStats.sample()
    .then((sample) => {
      lastStats = { ...sample, helpers: lastStats?.helpers ?? null };
      statsAt = Date.now();
      return lastStats;
    })
    .finally(() => { statsPending = null; });
  return statsPending;
}

/**
 * Loads the selected model without waiting for the first message, when "Load the model when Uma
 * opens" is on. Never while this PC is shared as a helper, which needs the memory.
 */
async function loadSelectedModel() {
  if (store.getSettings().loadModelAtStart === false || network.isSharing() || network.settings().share) return;
  if (benchmark?.status().running) return;
  const model = await models.resolveActive();
  if (!model || !(await runtime.status()).installed) return;
  await llama.ensureServer(model).catch(() => {});
  // With the model in memory, the engine reads Uma's instructions too, so the first message does not wait for them.
  agent?.warm().catch(() => {});
}

/**
 * The user began to write a message: the model is loaded if it is asleep, and the engine reads
 * Uma's instructions meanwhile ("Get ready while I type" in Settings). Nothing is waited for here.
 */
async function warmForTyping(conversationId) {
  if (store.getSettings().loadOnTyping === false || !workspace || !agent) return false;
  if (network.isSharing() || network.settings().share || benchmark?.status().running || agent.isBusy()) return false;
  if (!(await runtime.status()).installed) return false;
  agent.warm(conversationId || null).catch(() => {});
  return true;
}

/** Refreshes the title bar readings, and skips the work while the window is minimized. */
function startSystemStats() {
  setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    await freshStats().catch(() => null);
    if (!lastStats) return;
    const helpers = await network.presence(llama.status().helpers.servers).catch(() => null);
    lastStats = { ...lastStats, helpers };
    send('system:stats', lastStats);
  }, 5000);
}

async function initServices() {
  userDataDir = app.getPath('userData');
  dirs = {
    models: path.join(userDataDir, 'models'),
    runtime: path.join(userDataDir, 'runtime'),
    downloads: path.join(userDataDir, 'downloads'),
    logs: path.join(userDataDir, 'logs'),
    conversations: path.join(userDataDir, 'conversations'),
    undo: path.join(userDataDir, 'undo'),
    skills: path.join(userDataDir, 'skills'),
    attachments: path.join(userDataDir, 'attachments'),
    rpcCache: path.join(userDataDir, 'helper-cache'),
  };
  await Promise.all(Object.values(dirs).map((dir) => ensureDir(dir)));
  undoLog = new UndoLog({ dir: dirs.undo, trash: (target) => shell.trashItem(target) });
  attachments = new AttachmentStore({ dir: dirs.attachments });

  store = new Store(userDataDir);
  await store.init();
  await resolveLanguage();
  userMemory = new UserMemory({ file: path.join(userDataDir, 'memory.json') });
  batchTuner = new BatchTuner({ file: path.join(userDataDir, 'batch-tuning.json') });
  chatMemory = new ChatMemory({
    dir: store.getSettings().chatMemoryDir || path.join(userDataDir, 'chat-memory'),
    defaultDir: path.join(userDataDir, 'chat-memory'),
    getSettings: () => store.getSettings(),
    setOverLimit: (mode) => store.updateSettings({ chatMemoryOverLimit: mode }),
    titleOf: async (id) => (await conversations.get(id).catch(() => null))?.title || '',
    ask: askAboutChatMemory,
  });
  // Saved by 0.2.22-0.2.23 as one file for the latest chat; replaced by one file per chat.
  fsp.rm(path.join(userDataDir, 'prompt-cache'), { recursive: true, force: true }).catch(() => {});
  embeddingEngine = new EmbeddingEngine({
    dir: path.join(userDataDir, 'embedding'),
    serverPath: () => store.getRuntime().serverPath,
    freeVramMB: async () => ((await freeVramBytes()) || 0) / 1048576,
    emit: send,
  });
  // One archive file in the installed app; the folder it is built from when run from source.
  skillLibrary = new SkillLibrary({
    // (A checkout may hold only the archive: the folder is 190 MB of other people's files.)
    dir: app.isPackaged ? path.join(process.resourcesPath, 'skill-library.asar')
      : [path.join(__dirname, '..', 'build', 'skill-library'), path.join(__dirname, '..', 'build', 'skill-library.asar')].find((item) => fs.existsSync(item)) || path.join(__dirname, '..', 'build', 'skill-library'),
  });
  skills = new SkillStore({ globalDir: dirs.skills, bundledDir: path.join(__dirname, 'skills'), store, trash: (target) => shell.trashItem(target), library: skillLibrary });
  // Where a newer Uma is published: the releases of its own repository (package.json → updates).
  const updates = require('../package.json').updates || {};
  updater = new Updater({
    version: UMA_VERSION,
    feed: process.env.UMA_UPDATE_FEED ?? updates.feed,
    downloads: process.env.UMA_UPDATE_DOWNLOADS ?? updates.downloads,
    page: updates.page,
    dir: path.join(userDataDir, 'updates'),
    onChange: (state) => send('updates:changed', state),
  });
  await skills.seed().catch((err) => console.error(err));
  hardware = await detectHardware();
  models = new ModelManager({
    store,
    modelsDir: dirs.models,
    downloadsDir: dirs.downloads,
    emit: send,
  });
  await models.init();
  // Draft models that were removed are taken out of the other models' settings (store.forgetMissingDrafts).
  await store.forgetMissingDrafts(new Set(store.getInstalledModels().map((entry) => entry.id))).catch(() => 0);
  runtime = new RuntimeManager({
    store,
    runtimeDir: dirs.runtime,
    downloadsDir: dirs.downloads,
    emit: send,
    hardware,
  });
  network = new NetworkManager({ store, emit: send, cacheDir: dirs.rpcCache, logsDir: dirs.logs, runtime, sampleStats: () => freshStats(), appVersion: app.getVersion() });
  llama = new LlamaManager({ store, runtime, emit: send, logsDir: dirs.logs, modelInfo: (id) => models.modelInfo(id), getModel: (id) => models.getModel(id), network, chatMemory, batchTuner });
  conversations = new ConversationStore(dirs.conversations);
  await conversations.init();
  // The benchmark is set up only when the Benchmark screen asks for it (benchmarkManager).

  const settings = store.getSettings();
  if (settings.workspacePath) {
    try {
      const next = new Workspace({ root: settings.workspacePath, trash: (target) => shell.trashItem(target) });
      await next.init();
      connectWorkspace(next);
    } catch {
      workspace = null;
    }
  }
  await ensureWorkspace();
  nativeTheme.themeSource = 'dark';
}

/** The language picked in the Windows installer, as its Windows language ID, or '' elsewhere. */
function installerLanguage() {
  if (process.platform !== 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    require('node:child_process').execFile('reg', ['query', 'HKCU\\Software\\Uma LLM', '/v', 'Language'], { windowsHide: true, timeout: 4000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout).match(/Language\s+REG_\w+\s+(\S+)/)?.[1] || '');
    });
  });
}

/**
 * Chooses the interface language: a new choice in the installer wins, then the one saved in
 * Settings, then the system's language on first run.
 */
async function resolveLanguage() {
  const settings = store.getSettings();
  const fromInstaller = await installerLanguage();
  let language = settings.language;
  const patch = {};
  if (fromInstaller && fromInstaller !== settings.installerLanguage) {
    language = fromWindowsLanguageId(fromInstaller) || language;
    patch.installerLanguage = fromInstaller;
  }
  if (!isLanguage(language)) language = systemLanguage(app.getPreferredSystemLanguages?.() || [app.getLocale()]);
  if (language !== settings.language) patch.language = language;
  if (Object.keys(patch).length) await store.updateSettings(patch);
  setLanguage(language);
}

/** There is no setup step, so a missing or deleted working folder is replaced with a default one. */
async function ensureWorkspace() {
  if (workspace) return;
  const fallback = path.join(app.getPath('documents'), 'Uma LLM');
  await ensureDir(fallback);
  const next = new Workspace({ root: fallback, trash: (target) => shell.trashItem(target) });
  await next.init();
  connectWorkspace(next);
  await store.updateSettings({ workspacePath: next.root });
}

const SHARED_MESSAGE = 'This PC is shared as a helper, so the local assistant is paused. Stop sharing in Settings → Network to chat again.';

/** A shared PC gives its GPU to other PCs, so the local model and any benchmark are stopped first. */
async function freeForSharing() {
  benchmark?.cancel();
  await llama.stop({ silent: true });
}

/** Installing over the engine in use: stop what runs from its folder, or Windows keeps the files locked. */
async function beforeEngineReplace() {
  await llama.stop({ silent: true });
  await network.stopSharing({ quiet: true, remember: false });
}

/** The first launch fetches the inference engine by itself; a model is still the user's choice. */
async function ensureRuntime() {
  const status = await runtime.status();
  if (status.installing) return;
  if (status.installed) {
    // Nothing runs yet: older engine folders left by updates go, and an engine older than the one
    // this Uma was tested with is updated in the background.
    await runtime.removeUnused().catch(() => {});
    network.upgradeEngine(ENGINE_BUILD, t('This version of Uma uses llama.cpp {0}; installing it in the background. The next model load uses it.', [ENGINE_BUILD]));
    return;
  }
  runtime.install(store.getSettings().runtimeBackend || 'auto', { beforeReplace: beforeEngineReplace })
    .then(() => network.resume())
    .catch(() => {});
}

/** The benchmark, made on first use and dropped again when its screen closes (releaseBenchmark). */
function benchmarkManager() {
  if (!benchmark) {
    const { BenchmarkManager } = require('./lib/benchmark.cjs');
    benchmark = new BenchmarkManager({ store, models, runtime, llama, agent: () => agent?.isBusy(), emit: send });
  }
  return benchmark;
}

/**
 * The Benchmark screen closed: a run still going is cancelled, a model the benchmark loaded itself
 * (it was not loaded before) is unloaded, and the benchmark's own data is let go.
 */
async function releaseBenchmark() {
  const current = benchmark;
  if (!current) return false;
  current.cancel();
  await Promise.race([current.current, sleepMs(5000)]).catch(() => {});
  const loaded = current.loadedModel;
  benchmark = null;
  if (loaded && llama.modelId === loaded && llama.status().running && !agent?.isBusy()) await llama.stop();
  return Boolean(loaded);
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootstrap() {
  const settings = store.getSettings();
  await ensureWorkspace();
  const active = await models.resolveActive();
  const modelInfo = await models.list();
  const runtimeInfo = await runtime.status();
  const workspaceInfo = workspace ? await workspace.info().catch(() => null) : null;
  const conversationList = await conversations.list();
  const totalModelBytes = modelInfo.installed.reduce((sum, entry) => sum + (entry.size || 0), 0);

  return {
    appVersion: app.getVersion(),
    // How this window is drawn right now; the setting may say otherwise until Uma restarts.
    interfaceGpu,
    platform: process.platform,
    onboarded: true,
    settings: {
      ...settings,
      activeModelId: active?.id || settings.activeModelId,
      effectiveContextSize: (active ? store.getEffectiveSettings(active.id) : settings).contextSize,
    },
    activeModel: active,
    workspace: workspaceInfo,
    models: modelInfo,
    runtime: runtimeInfo,
    server: llama.status(),
    network: network.status(),
    hardware,
    languages: LANGUAGES,
    conversations: conversationList,
    benchmarks: store.getBenchmarks(),
    benchmark: benchmark ? benchmark.status() : { running: false, progress: null, history: store.getBenchmarks() },
    storage: {
      userData: userDataDir,
      modelsDir: dirs.models,
      modelBytes: totalModelBytes,
      modelLabel: formatBytes(totalModelBytes),
      downloadsDir: dirs.downloads,
    },
  };
}

async function setWorkspace(root) {
  const next = new Workspace({ root, trash: (target) => shell.trashItem(target) });
  await next.init();
  benchmark?.cancel();
  if (agent?.isBusy()) agent.stop();
  await llama.stop({ silent: true });
  connectWorkspace(next);
  await store.updateSettings({ workspacePath: workspace.root });
  send('workspace:changed', { path: '.' });
  return workspace.info();
}

function requireWorkspace() {
  if (!workspace) throw new Error(t('Choose a workspace folder first.'));
  return workspace;
}

async function chooseWorkspace() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t('Choose a working folder for Uma'),
    buttonLabel: t('Use this folder'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const info = await setWorkspace(result.filePaths[0]);
  return info;
}

/** LICENSE.txt or THIRD-PARTY-NOTICES.txt: next to the program once installed, in the project otherwise. */
function legalFile(name) {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(__dirname, '..', name);
}

/**
 * The licence window, shown before anything else on the first start and after every update (the
 * accepted version is kept in the settings). Resolves with the window when Accept is pressed, so it
 * can close once the main window is up, or with null on Decline or when it is closed.
 */
// Uma's own version (app.getVersion() is Electron's when Uma runs from the project folder).
const UMA_VERSION = require('../package.json').version;
let termsWindow = null;
let termsAnswer = null;
function askForTerms() {
  if (store.getSettings().acceptedTermsVersion === UMA_VERSION) return Promise.resolve(true);
  const testHidden = process.env.UMA_TEST_HIDE === '1';
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 780,
      height: 720,
      minWidth: 560,
      minHeight: 480,
      show: false,
      title: t('Uma LLM · Licence'),
      backgroundColor: '#0a2650',
      autoHideMenuBar: true,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: testHidden,
      ...(testHidden ? { x: -10000, y: -10000 } : {}),
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    termsWindow = win;
    let settled = false;
    termsAnswer = async (accepted) => {
      if (settled) return;
      settled = true;
      if (accepted) {
        await store.updateSettings({ acceptedTermsVersion: UMA_VERSION, acceptedTermsAt: new Date().toISOString() });
        resolve(win);
      } else {
        resolve(null);
      }
    };
    // Closing the window is the same as Decline.
    win.on('closed', () => {
      termsWindow = null;
      termsAnswer?.(false);
    });
    win.once('ready-to-show', () => (testHidden ? win.showInactive() : win.show()));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    const devServer = process.env.VITE_DEV_SERVER_URL;
    (devServer ? win.loadURL(`${devServer}#terms`) : win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'terms' }))
      .catch(() => termsAnswer?.(false));
  });
}

/**
 * The small window shown at every start (Uma, the Ko-fi and ADA donation links, the support email).
 * Uma's main window loads hidden behind it and appears on Continue. Closing it also continues.
 * Hidden test windows skip it unless UMA_TEST_START_SCREEN=1.
 */
let startWindow = null;
let startContinue = null;
let holdMainWindow = false;
let mainWindowReady = false;
function startWindowWanted() {
  return process.env.UMA_TEST_HIDE !== '1' || process.env.UMA_TEST_START_SCREEN === '1';
}
function showStartWindow() {
  const testHidden = process.env.UMA_TEST_HIDE === '1';
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 500,
      height: 600,
      useContentSize: true,
      resizable: false,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      show: false,
      title: t('Uma LLM'),
      backgroundColor: '#0a2650',
      autoHideMenuBar: true,
      skipTaskbar: testHidden,
      ...(testHidden ? { x: -10000, y: -10000 } : {}),
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    startWindow = win;
    let done = false;
    startContinue = () => {
      if (done) return;
      done = true;
      resolve(win);
    };
    win.on('closed', () => {
      startWindow = null;
      startContinue?.();
    });
    win.once('ready-to-show', () => (testHidden ? win.showInactive() : win.show()));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    const devServer = process.env.VITE_DEV_SERVER_URL;
    (devServer ? win.loadURL(`${devServer}#start`) : win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'start' }))
      .catch(() => startContinue?.());
  });
}
function revealMainWindow() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (process.env.UMA_TEST_HIDE === '1') win.showInactive();
  else win.show();
  if (process.env.UMA_MAXIMIZE === '1') win.maximize();
}

async function createWindow() {
  const testHidden = process.env.UMA_TEST_HIDE === '1';
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0a2650',
    show: false,
    title: t('Uma LLM'),
    // On a Mac the title bar is the app's own, with the system's traffic-light buttons inside it.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
      : { frame: false }),
    skipTaskbar: testHidden,
    ...(testHidden ? { x: -10000, y: -10000 } : {}),
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  mainWindow = win;

  // Closing Uma's window closes Uma. Waiting for "every window closed" was not enough: the
  // mouse-and-keyboard notice is a hidden window, so Uma kept running unseen, and starting it again
  // then reached a destroyed window ("Object has been destroyed").
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    app.quit();
  });

  win.once('ready-to-show', () => {
    mainWindowReady = true;
    // While the start window is open, Uma waits behind it (see showStartWindow).
    if (!holdMainWindow) revealMainWindow();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (url !== current) event.preventDefault();
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    await win.loadURL(devServer);
  } else {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  if (process.env.UMA_CAPTURE) {
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage();
        await fsp.writeFile(process.env.UMA_CAPTURE, image.toPNG());
        if (process.env.UMA_CAPTURE_TWO) {
          win.webContents.executeJavaScript("window.scrollTo(0, document.body.scrollHeight)").catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 500));
          const second = await win.webContents.capturePage();
          await fsp.writeFile(process.env.UMA_CAPTURE_TWO, second.toPNG());
        }
      } catch (err) {
        console.error(err);
      } finally {
        app.quit();
      }
    }, Number(process.env.UMA_CAPTURE_DELAY || 2200));
  }
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', async () => bootstrap());
  ipcMain.handle('app:open-data', async () => {
    await shell.openPath(userDataDir);
    return true;
  });
  // Settings → About: the licence and the third-party notices, in the PC's text viewer.
  // The licence window: its text, and the answer. Only that window can answer.
  ipcMain.handle('terms:info', async () => {
    const settings = store.getSettings();
    return {
      text: await fsp.readFile(legalFile('LICENSE.txt'), 'utf8').catch(() => ''),
      version: UMA_VERSION,
      previous: settings.acceptedTermsVersion || '',
      theme: settings.theme || 'system',
    };
  });
  ipcMain.handle('terms:answer', async (event, accepted) => {
    if (!termsWindow || event.sender !== termsWindow.webContents) return false;
    await termsAnswer?.(accepted === true);
    return true;
  });
  ipcMain.handle('app:open-legal', async (_event, which) => {
    const name = which === 'notices' ? 'THIRD-PARTY-NOTICES.txt' : 'LICENSE.txt';
    const file = legalFile(name);
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('app:open-external', async (_event, url) => {
    // Web links, and an email address for the support link (nothing else after it).
    const mail = /^mailto:[^\s?&/\\]+@[^\s?&/\\]+$/i.test(url || '');
    if (!/^https?:\/\//i.test(url) && !mail) throw new Error(t('Only web links are supported.'));
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('app:show-item', async (_event, target) => {
    if (target === 'models') {
      await shell.openPath(dirs.models);
    } else if (target === 'data') {
      await shell.openPath(userDataDir);
    } else {
      await shell.openPath(userDataDir);
    }
    return true;
  });

  ipcMain.handle('window:minimize', async () => {
    mainWindow?.minimize();
    return true;
  });
  ipcMain.handle('window:toggle-maximize', async () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', async () => {
    mainWindow?.close();
    return true;
  });
  // Starts Uma again, for settings that only apply at start.
  ipcMain.handle('app:restart', async () => {
    app.relaunch();
    app.quit();
    return true;
  });
  ipcMain.handle('window:is-maximized', async () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()));

  ipcMain.handle('workspace:choose', async () => chooseWorkspace());
  ipcMain.handle('workspace:info', async () => (workspace ? workspace.info() : null));
  ipcMain.handle('workspace:reveal', async (_event, relative = '.') => {
    const ws = requireWorkspace();
    const abs = await ws.resolve(relative);
    if (abs === ws.root) await shell.openPath(abs);
    else shell.showItemInFolder(abs);
    return true;
  });

  ipcMain.handle('models:list', async () => models.list());
  ipcMain.handle('models:download', async (_event, id) => {
    const state = models.startDownload(id);
    // The download continues in the background; progress arrives over the event channel.
    if (state && typeof state.catch === 'function') state.catch(() => {});
    return models.states.get(id) || null;
  });
  ipcMain.handle('models:add-url', async (_event, { url, name }) => {
    if (!/^https:\/\//i.test(url || '')) throw new Error(t('Enter an https:// link to a .gguf file.'));
    const clean = new URL(url);
    const filename = decodeURIComponent(clean.pathname.split('/').pop() || '');
    if (!filename.toLowerCase().endsWith('.gguf')) throw new Error(t('The URL must end in .gguf.'));
    const id = `custom-${Buffer.from(url).toString('base64url').slice(-16)}`;
    models.startDownload(id, {
      url,
      filename,
      name: name || filename.replace(/\.gguf$/i, '').replace(/[-_]/g, ' '),
    }).catch(() => {});
    return models.states.get(id) || null;
  });
  ipcMain.handle('models:cancel', async (_event, id) => models.cancelDownload(id));
  ipcMain.handle('models:pause', async (_event, id) => models.pauseDownload(id));
  ipcMain.handle('models:resume', async (_event, id) => models.resumeDownload(id));
  ipcMain.handle('models:remove', async (_event, id) => {
    await llama.stop({ silent: true });
    await models.remove(id);
    await store.forgetMissingDrafts(new Set(store.getInstalledModels().map((entry) => entry.id))).catch(() => 0);
    return models.list();
  });
  ipcMain.handle('models:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('Choose a GGUF model'),
      properties: ['openFile'],
      filters: [{ name: 'GGUF model', extensions: ['gguf'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const entry = await models.importFile(result.filePaths[0]);
    return entry;
  });
  ipcMain.handle('models:set-active', async (_event, id) => {
    const installed = store.getInstalledModels();
    if (!installed.find((entry) => entry.id === id)) throw new Error(t('Model not found.'));
    benchmark?.cancel();
    if (store.getSettings().activeModelId !== id) await llama.stop({ silent: true });
    await store.updateSettings({ activeModelId: id });
    loadSelectedModel().catch(() => {});
    return bootstrap();
  });
  const estimateFor = (info, settings) => estimateMemory(info, {
    ...MODEL_DEFAULTS,
    ...settings,
    backend: store.getRuntime().backend,
    gpuOffload: store.getSettings().gpuOffload,
  }, { ...hardware, helperGB: network.helperFreeGB() });

  ipcMain.handle('models:details', async (_event, id) => {
    const entry = await models.getModel(id);
    if (!entry) throw new Error(t('Model not found.'));
    const info = await models.modelInfo(id);
    const general = store.getSettings();
    const overrides = general.modelOverrides?.[id] || {};
    const defaults = {
      ...MODEL_DEFAULTS,
      threads: defaultThreads(),
      contextSize: general.contextSize,
      temperature: general.temperature,
      topP: general.topP,
    };
    const settings = { ...defaults, ...overrides };
    // This PC's graphics cards as the engine lists them, when it has several. A card choice saved
    // as the engine's own device names (0.2.90 to 0.2.92) is shown, and saved again, as card names.
    const cards = await llama.engineCards(store.getRuntime()).catch(() => []);
    if (settings.gpuCards && cards.length > 1) {
      const { chosenCards, cardChoice } = require('./lib/placement.cjs');
      const picked = chosenCards(cards, settings.gpuCards);
      settings.gpuCards = picked.length && picked.length < cards.length ? cardChoice(picked) : '';
    }
    // Installed models that can guess words for this one: the same vocabulary, and much smaller.
    const ownSize = (item) => (item.parts?.length ? item.parts.reduce((sum, part) => sum + (part.size || 0), 0) : item.size || 0);
    const draftCandidates = [];
    for (const other of store.getInstalledModels()) {
      if (other.id === id || ownSize(other) >= ownSize(entry) / 3) continue;
      const otherInfo = await models.modelInfo(other.id).catch(() => null);
      if (otherInfo && !draftCompatibility(info, otherInfo)) draftCandidates.push({ id: other.id, name: other.name, size: ownSize(other) });
    }
    const suggestion = SUGGESTED_DRAFTS[info.tokenizer?.pre];
    return {
      model: entry,
      info: { ...info, layerBytes: undefined },
      defaults,
      overrides,
      settings,
      cpuCount: os.cpus().length,
      estimate: estimateFor(info, settings),
      draftCandidates,
      draftSuggestion: !draftCandidates.length && suggestion && ownSize(entry) > suggestion.sizeBytes * 3 ? suggestion : null,
      // The batch sizes measured for this model with the current helper PCs and engine.
      batchTuning: { ...(await batchTuner.report(llama.batchKey(entry, store.getRuntime()))), byHand: overrides.ubatchSize !== undefined },
      cards,
    };
  });
  // Measures the three batch sizes now: the model is loaded with each and reads a fixed text twice.
  ipcMain.handle('models:tune-batch', async (_event, id) => {
    if (agent?.isBusy()) throw new Error(t('Wait for the current response to finish, then tune the batch size.'));
    if (network.isSharing()) throw new Error(t(SHARED_MESSAGE));
    const model = await models.getModel(id);
    if (!model) throw new Error(t('Model not found.'));
    benchmark?.cancel();
    const key = llama.batchKey(model, store.getRuntime());
    await batchTuner.forget(key);
    // About 1,800 tokens of ordinary text; a different last line each time, so nothing is reused.
    const text = `${'The workshop keeps a ledger of every repair: the date, the owner, the fault that was found, the part that was changed and how long the work took. '.repeat(55)}\nIn one word, what is this text about?`;
    try {
      for (const [index, size] of BATCH_SIZES.entries()) {
        send('models:tune-progress', { id, size, step: index + 1, total: BATCH_SIZES.length });
        await llama.stop({ silent: true });
        llama.forcedBatch = size;
        try {
          await llama.ensureServer(model);
          for (let run = 0; run < 2; run += 1) await llama.complete({ messages: [{ role: 'user', content: `${text} (${size}/${run})` }], maxTokens: 4 });
        } catch (err) {
          if (err.code !== 'SERVER_FAILED') throw err;
        }
      }
    } finally {
      llama.forcedBatch = 0;
      await llama.stop({ silent: true });
      send('models:tune-progress', { id, done: true });
    }
    return batchTuner.report(key);
  });
  ipcMain.handle('models:estimate', async (_event, { id, settings }) => estimateFor(await models.modelInfo(id), sanitizeModelSettings(settings)));
  ipcMain.handle('models:save-settings', async (_event, { id, settings }) => {
    if (agent?.isBusy()) throw new Error(t('Wait for the current response to finish, then change model settings.'));
    if (!(await models.getModel(id))) throw new Error(t('Model not found.'));
    await store.setModelOverrides(id, sanitizeModelSettings(settings));
    if (llama.modelId === id) await llama.stop({ silent: true });
    return bootstrap();
  });

  const hubController = { search: null };
  ipcMain.handle('hub:search', async (_event, options) => {
    hubController.search?.abort();
    hubController.search = new AbortController();
    return searchModels({ ...options, signal: hubController.search.signal });
  });
  ipcMain.handle('hub:variants', async (_event, repo) => repoVariants(repo));
  ipcMain.handle('hub:estimate', async (_event, { repo, key }) => {
    const detail = await repoVariants(repo);
    const variant = detail.variants.find((item) => item.key === key);
    if (!variant) throw new Error(t('That version is no longer available.'));
    const info = { ...(await remoteModelInfo(variant.files)), mmprojBytes: detail.vision?.size || 0 };
    const general = store.getSettings();
    return {
      info: { ...info, layerBytes: undefined },
      estimate: estimateFor(info, { contextSize: general.contextSize }),
    };
  });
  // The draft model suggested in a model's settings, by repository and quantization.
  ipcMain.handle('models:draft-download', async (_event, pre) => {
    const suggestion = SUGGESTED_DRAFTS[pre];
    if (!suggestion) throw new Error(t('No draft model is known for this model.'));
    const detail = await repoVariants(suggestion.repo);
    const variant = detail.variants.find((item) => item.quant === suggestion.quant) || detail.variants[0];
    if (!variant) throw new Error(t('That version is no longer available.'));
    return downloadHubVariant(suggestion.repo, detail, variant);
  });
  ipcMain.handle('hub:download', async (_event, { repo, key }) => {
    const detail = await repoVariants(repo);
    const variant = detail.variants.find((item) => item.key === key);
    if (!variant) throw new Error(t('That version is no longer available.'));
    return downloadHubVariant(repo, detail, variant);
  });
  function downloadHubVariant(repo, detail, variant) {
    const key = variant.key;
    if (detail.gated) throw new Error(t('This repository needs a Hugging Face login and licence approval, which Uma does not support yet. Download the file in a browser, then use Import GGUF.'));
    const id = `hub:${repo}:${key}`;
    models.startDownload(id, {
      name: `${repo.split('/').pop().replace(/-GGUF$/i, '')} ${variant.quant}`,
      url: variant.files[0].url,
      filename: path.basename(variant.files[0].path),
      sizeBytes: variant.sizeBytes,
      license: detail.license || 'See model card',
      repo,
      quant: variant.quant,
      folder: repo.replace('/', '__'),
      files: variant.files.map((file) => ({ url: file.url, filename: path.basename(file.path), size: file.size })),
      ...(detail.vision ? { vision: { url: detail.vision.url, filename: path.basename(detail.vision.path), size: detail.vision.size } } : {}),
    }).catch(() => {});
    return models.states.get(id) || null;
  }

  ipcMain.handle('models:vision-download', async (_event, id) => {
    const entry = await models.getModel(id);
    if (!entry) throw new Error(t('Model not found.'));
    // The model's own repository first; then the vision file of the model it was made from, or of a
    // close relative, used only if its numbers fit this model (visionFinder.cjs).
    const metadata = await readModelHeader(localSource(entry.parts?.[0]?.path || entry.path)).then((info) => info.metadata).catch(() => null);
    let found = metadata ? await findVision({ metadata, ownRepo: entry.repo || '' }).catch(() => null) : null;
    if (!found?.file && !metadata && entry.repo) {
      const detail = await repoVariants(entry.repo).catch(() => null);
      if (detail?.vision) found = { file: detail.vision, repo: entry.repo, match: 'own' };
    }
    if (!found?.file) {
      throw new Error(t('No vision file fits {0}. The model it is made from cannot see images, so this model is text-only. To see pictures, choose a model that can (for example Qwen3.8, Qwen3.5 or Gemma 3), or use Choose file if you have a vision file made for this one.', [entry.name]));
    }
    models.downloadVision(id, found.file, { from: found.repo, match: found.match }).catch(() => {});
    return { size: found.file.size, repo: found.repo, match: found.match };
  });
  ipcMain.handle('models:vision-import', async (_event, id) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('Choose a vision file (mmproj)'),
      properties: ['openFile'],
      filters: [{ name: 'GGUF vision file', extensions: ['gguf'] }],
    });
    if (result.canceled || !result.filePaths[0]) return false;
    await models.importVision(id, result.filePaths[0]);
    if (llama.modelId === id) await llama.stop({ silent: true });
    return true;
  });
  ipcMain.handle('models:vision-remove', async (_event, id) => {
    if (agent?.isBusy()) throw new Error(t('Wait for the current response to finish.'));
    if (llama.modelId === id) await llama.stop({ silent: true });
    await models.removeVision(id);
    return true;
  });

  ipcMain.handle('models:reveal', async () => {
    await shell.openPath(dirs.models);
    return true;
  });

  ipcMain.handle('network:status', async () => network.status());
  ipcMain.handle('network:share', async (_event, on, options) => {
    if (!on) return network.stopSharing();
    if (agent?.isBusy()) throw new Error(t('Wait for the current response to finish, then share this PC.'));
    await freeForSharing();
    return network.startSharing(options);
  });
  ipcMain.handle('network:add-helper', async (_event, helper) => network.addHelper(helper || {}));
  ipcMain.handle('network:update-helper', async (_event, id, patch) => network.updateHelper(id, patch || {}));
  ipcMain.handle('network:remove-helper', async (_event, id) => network.removeHelper(id));
  ipcMain.handle('network:test-helper', async (_event, id) => network.testHelper(id));
  ipcMain.handle('network:mode', async (_event, mode) => network.setMode(mode));
  ipcMain.handle('network:helper-ram-first', async (_event, on) => {
    if (agent?.isBusy()) throw new Error(t('Wait for the current response to finish, then change how helpers are used.'));
    const status = await network.setHelperRamFirst(on);
    // The split is decided when a model loads, so the next message loads it again.
    await llama.stop({ silent: true });
    return status;
  });
  ipcMain.handle('network:share-ram', async (_event, on) => network.setShareRam(on));
  ipcMain.handle('network:full-power', async (_event, on) => network.setFullPower(on));

  ipcMain.handle('runtime:status', async () => runtime.status());
  ipcMain.handle('runtime:install', async (_event, backend) => {
    const choice = backend || store.getSettings().runtimeBackend || 'auto';
    runtime.install(choice, { beforeReplace: beforeEngineReplace })
      .then(() => store.updateSettings({ runtimeBackend: choice }))
      .then(() => network.resume())
      .catch(() => {});
    return runtime.status();
  });
  ipcMain.handle('runtime:use', async (_event, backend) => {
    if (agent?.isBusy()) throw new Error(t('Wait for the current response to finish, then switch engines.'));
    benchmark?.cancel();
    await runtime.use(backend);
    await llama.stop({ silent: true });
    await store.updateSettings({ runtimeBackend: backend });
    // A shared PC serves with the engine in use, so restart sharing on the new one.
    if (network.settings().share) await network.startSharing().catch(() => {});
    return bootstrap();
  });
  ipcMain.handle('runtime:cancel', async () => {
    runtime.cancel();
    return true;
  });
  ipcMain.handle('server:status', async () => llama.status());
  // "Stop model and free memory": the engine and the small search model both leave RAM and VRAM.
  ipcMain.handle('server:stop', async () => {
    benchmark?.cancel();
    await llama.stop();
    embeddingEngine?.stop();
    return llama.status();
  });
  ipcMain.handle('server:start', async () => {
    if (network.isSharing()) throw new Error(t('This PC is shared as a helper, so it cannot load a model of its own. Turn sharing off first.'));
    const model = await models.resolveActive();
    if (!model) throw new Error(t('Choose a model first'));
    await llama.ensureServer(model);
    agent?.warm().catch(() => {});
    return llama.status();
  });
  // Server status screen: this PC and every helper, asked every two seconds while it is open.
  ipcMain.handle('status:servers', async () => {
    const server = llama.status();
    const [list, model] = await Promise.all([network.serverStatus(server.helpers.servers), models.resolveActive()]);
    return { ...list, model: model ? { name: model.name, size: model.size || 0 } : null, server: { state: server.state, running: server.running, error: server.error || '' } };
  });

  // The window asks for the language before its first paint, so nothing flashes in English.
  ipcMain.on('app:language', (event) => { event.returnValue = store?.getSettings().language || 'en'; });
  // The start screen (Uma and the Ko-fi link) shows at every start; the hidden test windows skip it
  // unless a test asks for it.
  // Continue in the start window: only that window can send it.
  ipcMain.handle('start:continue', async (event) => {
    if (!startWindow || event.sender !== startWindow.webContents) return false;
    startContinue?.();
    return true;
  });
  ipcMain.handle('settings:update', async (_event, patch) => {
    const previous = store.getSettings();
    const settings = await store.updateSettings(patch || {});
    if (previous.language !== settings.language) setLanguage(settings.language);
    if (previous.projectSearch !== settings.projectSearch || previous.semanticSearch !== settings.semanticSearch) syncSemantic();
    if (previous.chatMemoryLimitGB !== settings.chatMemoryLimitGB || previous.chatMemoryOverLimit !== settings.chatMemoryOverLimit) chatMemory.enforceLimit(null).catch(() => {});
    if (
      previous.contextSize !== settings.contextSize ||
      previous.gpuOffload !== settings.gpuOffload
    ) {
      benchmark?.cancel();
      await llama.stop({ silent: true });
    }
    return settings;
  });

  const skillForPanel = ({ body: _body, dir: _dir, ...skill }) => skill;
  ipcMain.handle('skills:list', async () => (await skills.list(workspace?.root)).map(skillForPanel));
  ipcMain.handle('skills:create', async (_event, { name, description, scope }) => {
    const created = await skills.create({ name, description, scope, root: workspace?.root });
    await shell.openPath(created.path);
    return (await skills.list(workspace?.root)).map(skillForPanel);
  });
  ipcMain.handle('skills:open', async (_event, name) => {
    const skill = (await skills.list(workspace?.root)).find((item) => item.name === name);
    if (!skill) throw new Error(t('That skill no longer exists.'));
    const result = await shell.openPath(skill.path);
    if (result) throw new Error(result);
    return true;
  });
  const installedSkillNames = async () => new Set((await skills.list(workspace?.root)).filter((skill) => skill.source === 'global').map((skill) => skill.name));
  ipcMain.handle('skills:library', async (_event, options) => skillLibrary.search(options || {}, await installedSkillNames()));
  ipcMain.handle('skills:install', async (_event, name) => {
    const entry = await skillLibrary.get(name);
    if (!entry) throw new Error(t('That skill is not in the library.'));
    // The authors' own warning is repeated before the skill can reach the model.
    if (entry.risk === 'critical' || entry.risk === 'offensive') {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: t('Install this skill?'),
        message: entry.risk === 'offensive'
          ? t('“{0}” describes attack techniques for security testing.', [entry.name])
          : t('“{0}” can act on real accounts, servers, or repositories.', [entry.name]),
        detail: entry.risk === 'offensive'
          ? t('Use it only on systems you own or are authorized to test. Uma still asks before each file change and command.')
          : t('Its authors marked it as high-impact: following it can change things outside this PC. Uma still asks before each file change and command. Read the skill before you rely on it.'),
        buttons: [t('Install'), t('Cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (result.response !== 0) return { installed: false };
    }
    await skillLibrary.install(entry.name, dirs.skills);
    skills.invalidate();
    return { installed: true };
  });
  ipcMain.handle('skills:remove', async (_event, name) => {
    await skills.remove(name);
    return (await skills.list(workspace?.root)).map(skillForPanel);
  });
  ipcMain.handle('rag:status', async () => ragStatus());
  ipcMain.handle('chat-memory:list', async () => chatMemory.list());
  // Memory: facts about the user, added here, imported from other assistants, or exported.
  ipcMain.handle('memory:list', async () => ({ items: await userMemory.list(), exportPrompt: EXPORT_PROMPT }));
  ipcMain.handle('memory:add', async (_event, text) => { await userMemory.add(text, 'you'); return userMemory.list(); });
  ipcMain.handle('memory:update', async (_event, { id, text }) => { await userMemory.update(id, text); return userMemory.list(); });
  ipcMain.handle('memory:remove', async (_event, id) => { await userMemory.remove(id); return userMemory.list(); });
  ipcMain.handle('memory:parse', async (_event, text) => userMemory.preview(parseImport(text)));
  ipcMain.handle('memory:import', async (_event, { items, source }) => {
    const added = await userMemory.add((items || []).map(String), String(source || 'import').slice(0, 40));
    return { added, items: await userMemory.list() };
  });
  ipcMain.handle('memory:open-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('Choose a memory export'),
      properties: ['openFile'],
      filters: [{ name: t('Memory export'), extensions: ['txt', 'md', 'json', 'markdown'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    const stat = await fsp.stat(file);
    if (stat.size > 20 * 1024 * 1024) throw new Error(t('That file is too large for a memory export (over 20 MB).'));
    return { name: path.basename(file), text: await fsp.readFile(file, 'utf8') };
  });
  ipcMain.handle('memory:export', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: t('Export memory'),
      defaultPath: 'uma-memory.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await fsp.writeFile(result.filePath, await userMemory.exportText(), 'utf8');
    return result.filePath;
  });
  // Another folder for chat memory (another HDD or M.2 drive), or back to the default one.
  ipcMain.handle('chat-memory:move', async (_event, { reset = false } = {}) => {
    if (agent?.isBusy()) throw new Error(t('Wait for the current response to finish, then move chat memory.'));
    let target = chatMemory.defaultDir;
    if (!reset) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: t('Choose where to save chat memory'),
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return chatMemory.list();
      const picked = result.filePaths[0];
      target = path.basename(picked) === CHAT_MEMORY_FOLDER ? picked : path.join(picked, CHAT_MEMORY_FOLDER);
    }
    if (path.resolve(target).toLowerCase() === path.resolve(chatMemory.dir).toLowerCase()) return chatMemory.list();
    // The engine was started with the old folder: it saves what it holds, then stops; the next
    // message starts it with the new folder.
    await llama.stop({ silent: true });
    await chatMemory.moveTo(target, (progress) => send('chat-memory:moving', progress));
    await store.updateSettings({ chatMemoryDir: reset ? '' : target });
    send('chat-memory:moving', null);
    return chatMemory.list();
  });
  ipcMain.handle('chat-memory:remove', async (_event, id) => {
    if (id === '*') await chatMemory.removeAll();
    else {
      llama?.forgetConversation(id);
      await chatMemory.remove(id);
    }
    return chatMemory.list();
  });
  ipcMain.handle('rag:install-semantic', async () => {
    await embeddingEngine.install();
    syncSemantic();
    return ragStatus();
  });
  ipcMain.handle('rag:rebuild', async () => {
    if (!workspace) throw new Error(t('Choose a workspace folder first.'));
    projectIndexes.delete(workspace.root);
    projectIndex = new ProjectIndex({ root: workspace.root });
    projectIndexes.set(workspace.root, projectIndex);
    if (agent) agent.projectIndex = projectIndex;
    await projectIndex.refresh({ budgetMs: 120000 });
    syncSemantic();
    return ragStatus();
  });
  ipcMain.handle('skills:open-folder', async () => {
    await ensureDir(dirs.skills);
    await shell.openPath(dirs.skills);
    return true;
  });

  ipcMain.handle('benchmark:run', async (_event, options) => {
    if (network.isSharing()) throw new Error(SHARED_MESSAGE);
    return benchmarkManager().start(options || {});
  });
  ipcMain.handle('benchmark:cancel', async () => benchmark?.cancel() ?? false);
  ipcMain.handle('benchmark:status', async () => benchmarkManager().status());
  ipcMain.handle('benchmark:release', async () => releaseBenchmark());
  ipcMain.handle('benchmark:clear', async () => {
    if (benchmark?.isRunning()) throw new Error(t('Cancel the running benchmark first.'));
    await store.clearBenchmarks();
    send('benchmark:history', []);
    return [];
  });

  ipcMain.handle('conversations:list', async () => conversations.list());
  ipcMain.handle('conversations:get', async (_event, id) => conversations.get(id));
  ipcMain.handle('conversations:create', async (_event, title) => conversations.create({ title: title || t('New conversation') }));
  ipcMain.handle('conversations:rename', async (_event, { id, title }) => conversations.rename(id, title));
  // The folder a chat works in, chosen with the folder button (null: back to the workspace).
  ipcMain.handle('conversations:set-folder', async (_event, { id, folder, choose = false }) => {
    const conversation = await conversations.get(id);
    if (!conversation) throw new Error(t('Conversation not found.'));
    let next = folder || null;
    if (choose) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: t('Choose the folder for this chat'),
        buttonLabel: t('Use this folder'),
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return { folder: conversation.folder || null };
      next = result.filePaths[0];
    }
    if (next) {
      const stat = await fsp.stat(next).catch(() => null);
      if (!stat?.isDirectory()) throw new Error(t('That folder does not exist.'));
      next = path.resolve(next);
    }
    conversation.folder = next;
    await conversations.save(conversation);
    return { folder: next };
  });
  // Copies text with the system clipboard, which works even when the page has no focus.
  ipcMain.handle('app:copy', async (_event, text) => { clipboard.writeText(String(text || '')); return true; });
  // Settings → Updates.
  ipcMain.handle('updates:state', async () => updater.state);
  ipcMain.handle('updates:check', async () => {
    await store.updateSettings({ lastUpdateCheck: Date.now() });
    return updater.check();
  });
  ipcMain.handle('updates:download', async () => updater.download());
  ipcMain.handle('updates:install', async () => {
    await updater.install();
    // The installer replaces Uma's files, so Uma closes; the installer starts it again.
    setTimeout(() => app.quit(), 600);
    return true;
  });
  ipcMain.handle('conversations:open-folder', async (_event, id) => {
    const conversation = await conversations.get(id);
    if (conversation?.folder) await shell.openPath(conversation.folder);
    return Boolean(conversation?.folder);
  });
  ipcMain.handle('conversations:remove', async (_event, id) => {
    if (agent?.isBusy(id)) agent.stop(id);
    const conversation = await conversations.get(id).catch(() => null);
    const attachedIds = (conversation?.messages || []).flatMap((message) => (message.attachments || []).map((item) => item.id));
    await attachments.remove(attachedIds).catch(() => {});
    await conversations.remove(id);
    llama?.forgetConversation(id);
    await chatMemory.remove(id).catch(() => {});
    return conversations.list();
  });

  ipcMain.handle('chat:send', async (_event, { conversationId, text, attached }) => {
    if (network.isSharing()) throw new Error(SHARED_MESSAGE);
    if (!workspace) throw new Error(t('Choose a workspace folder first.'));
    if (benchmark?.isRunning()) throw new Error(t('A benchmark is running. Wait for it to finish or cancel it first.'));
    // A new message lifts the emergency stop.
    input?.resume();
    return agent.send(conversationId, text, attached || []);
  });
  ipcMain.handle('chat:warm', async (_event, conversationId) => warmForTyping(conversationId).catch(() => false));
  ipcMain.handle('attachments:add', async (_event, file) => attachments.add(file));
  ipcMain.handle('attachments:remove', async (_event, id) => attachments.remove([id]));
  ipcMain.handle('system:stats', async () => {
    if (!lastStats) {
      const helpers = await network.presence(llama.status().helpers.servers).catch(() => null);
      lastStats = { ...(await systemStats.sample()), helpers };
    }
    return lastStats;
  });
  ipcMain.handle('chat:stop', async (_event, conversationId) => agent?.stop(conversationId) ?? false);
  ipcMain.handle('chat:undo', async (_event, { conversationId, messageId, blockId }) => {
    if (agent?.isBusy(conversationId)) throw new Error(t('Wait for the current response to finish, then undo.'));
    const conversation = await conversations.get(conversationId);
    const message = conversation?.messages.find((item) => item.id === messageId);
    const index = message?.blocks?.findIndex((block) => block.id === blockId) ?? -1;
    const block = message?.blocks?.[index];
    if (!block?.undoId || block.undone) throw new Error(t('This change can no longer be undone.'));
    const restored = await undoLog.restore(block.undoId);
    workspace?.invalidateStats();
    block.undone = true;
    await conversations.save(conversation);
    send('chat:event', { type: 'tool-update', conversationId, messageId, index, patch: { undone: true } });
    send('workspace:changed', { path: restored.path });
    return restored;
  });
}

/**
 * The right-click menu every window gets: Copy on selected text (a chat message, a path), and Cut,
 * Paste and Select all in the message box and other fields. Electron shows none by default.
 */
function contextMenuFor(params) {
  const { editFlags = {}, isEditable, selectionText = '' } = params;
  const selected = selectionText.trim().length > 0;
  const items = [];
  if (isEditable) {
    items.push(
      { label: t('Cut'), role: 'cut', enabled: Boolean(editFlags.canCut && selected) },
      { label: t('Copy'), role: 'copy', enabled: Boolean(editFlags.canCopy && selected) },
      { label: t('Paste'), role: 'paste', enabled: Boolean(editFlags.canPaste) },
      { type: 'separator' },
      { label: t('Select all'), role: 'selectAll', enabled: Boolean(editFlags.canSelectAll) },
    );
  } else if (selected) {
    items.push({ label: t('Copy'), role: 'copy' });
  } else if (params.linkURL && /^https?:/i.test(params.linkURL)) {
    items.push({ label: t('Copy link'), click: () => clipboard.writeText(params.linkURL) });
  }
  return items;
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('context-menu', (_menuEvent, params) => {
    const items = contextMenuFor(params);
    if (!items.length) return;
    const window = BrowserWindow.fromWebContents(contents);
    Menu.buildFromTemplate(items).popup(window ? { window } : {});
  });
});

async function boot() {
  // A Mac needs an app menu for Cmd+C, Cmd+V, Cmd+Q and the rest to work.
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }])
    : null);
  await initServices();
  registerIpc();
  // Nothing starts (no model, no sharing, no downloads) until the licence is accepted.
  const accepted = await askForTerms();
  if (!accepted) {
    app.quit();
    return;
  }
  // The start window opens first; Uma's main window loads hidden behind it.
  const started = startWindowWanted() ? showStartWindow() : null;
  holdMainWindow = Boolean(started);
  await createWindow();
  // The licence window stays until the next window is there, or closing it would end the app.
  if (accepted !== true) {
    termsAnswer = null;
    accepted.destroy();
  }
  startSystemStats();
  try { globalShortcut.register(STOP_SHORTCUT, stopInput); } catch {}
  ensureRuntime().catch(() => {}).then(() => loadSelectedModel()).catch(() => {});
  if (started) {
    started.then((win) => {
      holdMainWindow = false;
      if (mainWindowReady) revealMainWindow();
      startContinue = null;
      if (win && !win.isDestroyed()) win.destroy();
    });
  }
  if (network.settings().share) freeForSharing().then(() => network.resume()).catch(() => {});
  // A look for a newer Uma, once a day at most and only while the user leaves it on. Not when Uma
  // runs from its source folder or under a test.
  setTimeout(async () => {
    const settings = store.getSettings();
    if (settings.checkForUpdates === false || !(app.isPackaged || process.env.UMA_UPDATE_FEED) || !updater.due(settings.lastUpdateCheck)) return;
    await store.updateSettings({ lastUpdateCheck: Date.now() });
    const state = await updater.check();
    if (state.status === 'available') send('updates:found', state);
  }, 20000).unref?.();
  // Search by meaning is on from the start: its small model (334 MB) is fetched once, in the
  // background, unless project search or search by meaning was switched off.
  setTimeout(() => {
    const settings = store.getSettings();
    if (settings.projectSearch === false || settings.semanticSearch === false || embeddingEngine.installed()) return;
    embeddingEngine.install().then(() => syncSemantic()).catch(() => {});
  }, 20000);
}

app.on('second-instance', () => {
  // While Uma is closing its window is gone: nothing to bring forward.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(boot).catch((err) => {
  console.error(err);
  dialog.showErrorBox(t('Uma LLM could not start'), String(err.stack || err));
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
});

let quitReady = false;
app.on('before-quit', (event) => {
  if (quitReady) return;
  benchmark?.cancel();
  network?.stopSharing({ quiet: true, remember: false });
  systemStats.stop();
  embeddingEngine?.stop();
  input?.stop();
  clearTimeout(inputBannerTimer);
  if (inputBanner && !inputBanner.isDestroyed()) inputBanner.destroy();
  try { globalShortcut.unregisterAll(); } catch {}
  // A reply the engine has not saved yet for the next start is saved first (a few seconds,
  // at most 20), so closing Uma right after a reply does not mean reading the chat again.
  const pending = llama && llama.child && (llama.savingPrompt || (llama.promptCache?.dirty && llama.state === 'ready' && !llama.active));
  if (!pending) {
    if (llama) llama.stop({ silent: true });
    return;
  }
  event.preventDefault();
  quitReady = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  Promise.race([llama.stop({ silent: true }), new Promise((resolve) => setTimeout(resolve, 20000))])
    .catch(() => {})
    .finally(() => {
      llama.flushLog();
      app.quit();
    });
});

// Tests reach the notice and the emergency stop (scripts/ui-input-banner-test.cjs).
if (process.env.UMA_TEST_CONTEXT_MENU) module.exports = { contextMenuFor };
if (process.env.UMA_TEST_CLOSE) module.exports = { showInputBanner, mainWindow: () => mainWindow };
if (process.env.UMA_TEST_CONFIRM) module.exports = { confirmAction, setDialog: (fake) => { dialog.showMessageBox = fake; }, store: () => store, mainWindow: () => mainWindow };
if (process.env.UMA_TEST_INPUT_BANNER) module.exports = { mainWindow: () => mainWindow, showInputBanner, stopInput, inputBannerWindow: () => inputBanner, globalShortcut, STOP_SHORTCUT };
