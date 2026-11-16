const { contextBridge, ipcRenderer } = require('electron');

function cleanError(error) {
  const message = String(error?.message || error || 'Something went wrong.');
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '');
}

async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    throw new Error(cleanError(error));
  }
}

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('uma', {
  platform: process.platform,
  language: ipcRenderer.sendSync('app:language'),
  bootstrap: () => invoke('app:bootstrap'),
  openData: () => invoke('app:open-data'),
  openExternal: (url) => invoke('app:open-external', url),
  openLegal: (which) => invoke('app:open-legal', which),
  termsInfo: () => invoke('terms:info'),
  answerTerms: (accepted) => invoke('terms:answer', accepted),
  startContinue: () => invoke('start:continue'),
  showItem: (target) => invoke('app:show-item', target),

  minimizeWindow: () => invoke('window:minimize'),
  toggleMaximize: () => invoke('window:toggle-maximize'),
  closeWindow: () => invoke('window:close'),
  restartApp: () => invoke('app:restart'),
  isMaximized: () => invoke('window:is-maximized'),

  chooseWorkspace: () => invoke('workspace:choose'),
  setChatFolder: (id, folder, choose = false) => invoke('conversations:set-folder', { id, folder, choose }),
  openChatFolder: (id) => invoke('conversations:open-folder', id),
  copyText: (text) => invoke('app:copy', text),
  getWorkspaceInfo: () => invoke('workspace:info'),
  revealPath: (path) => invoke('workspace:reveal', path),

  listModels: () => invoke('models:list'),
  downloadModel: (id) => invoke('models:download', id),
  addModelUrl: (url, name) => invoke('models:add-url', { url, name }),
  cancelDownload: (id) => invoke('models:cancel', id),
  pauseDownload: (id) => invoke('models:pause', id),
  resumeDownload: (id) => invoke('models:resume', id),
  removeModel: (id) => invoke('models:remove', id),
  importModel: () => invoke('models:import'),
  setActiveModel: (id) => invoke('models:set-active', id),
  modelDetails: (id) => invoke('models:details', id),
  tuneBatch: (id) => invoke('models:tune-batch', id),
  onTuneProgress: (callback) => subscribe('models:tune-progress', callback),
  estimateModel: (id, settings) => invoke('models:estimate', { id, settings }),
  saveModelSettings: (id, settings) => invoke('models:save-settings', { id, settings }),
  searchHub: (options) => invoke('hub:search', options),
  hubVariants: (repo) => invoke('hub:variants', repo),
  hubEstimate: (repo, key) => invoke('hub:estimate', { repo, key }),
  downloadFromHub: (repo, key) => invoke('hub:download', { repo, key }),
  revealModels: () => invoke('models:reveal'),

  runtimeStatus: () => invoke('runtime:status'),
  installRuntime: (backend) => invoke('runtime:install', backend),
  useRuntime: (backend) => invoke('runtime:use', backend),
  cancelRuntime: () => invoke('runtime:cancel'),
  serverStatus: () => invoke('server:status'),
  stopServer: () => invoke('server:stop'),
  startServer: () => invoke('server:start'),
  serverList: () => invoke('status:servers'),

  runBenchmark: (options) => invoke('benchmark:run', options),
  cancelBenchmark: () => invoke('benchmark:cancel'),
  benchmarkStatus: () => invoke('benchmark:status'),
  clearBenchmarks: () => invoke('benchmark:clear'),
  releaseBenchmark: () => invoke('benchmark:release'),

  updateSettings: (patch) => invoke('settings:update', patch),

  listSkills: () => invoke('skills:list'),
  createSkill: (payload) => invoke('skills:create', payload),
  openSkill: (name) => invoke('skills:open', name),
  openSkillsFolder: () => invoke('skills:open-folder'),
  ragStatus: () => invoke('rag:status'),
  rebuildRag: () => invoke('rag:rebuild'),
  installSemanticSearch: () => invoke('rag:install-semantic'),
  chatMemory: () => invoke('chat-memory:list'),
  memory: () => invoke('memory:list'),
  addMemory: (text) => invoke('memory:add', text),
  updateMemory: (id, text) => invoke('memory:update', { id, text }),
  removeMemory: (id) => invoke('memory:remove', id),
  parseMemoryImport: (text) => invoke('memory:parse', text),
  importMemory: (items, source) => invoke('memory:import', { items, source }),
  openMemoryFile: () => invoke('memory:open-file'),
  exportMemory: () => invoke('memory:export'),
  removeChatMemory: (id) => invoke('chat-memory:remove', id),
  moveChatMemory: (options) => invoke('chat-memory:move', options),
  onChatMemoryMoving: (callback) => subscribe('chat-memory:moving', callback),
  searchSkillLibrary: (options) => invoke('skills:library', options),
  installSkill: (name) => invoke('skills:install', name),
  removeSkill: (name) => invoke('skills:remove', name),

  listConversations: () => invoke('conversations:list'),
  getConversation: (id) => invoke('conversations:get', id),
  createConversation: (title) => invoke('conversations:create', title),
  renameConversation: (id, title) => invoke('conversations:rename', { id, title }),
  removeConversation: (id) => invoke('conversations:remove', id),

  sendMessage: (conversationId, text, attached) => invoke('chat:send', { conversationId, text, attached }),
  addAttachment: (file) => invoke('attachments:add', file),
  removeAttachment: (id) => invoke('attachments:remove', id),
  systemStats: () => invoke('system:stats'),
  networkStatus: () => invoke('network:status'),
  setSharing: (on, options) => invoke('network:share', on, options),
  addHelper: (helper) => invoke('network:add-helper', helper),
  updateHelper: (id, patch) => invoke('network:update-helper', id, patch),
  removeHelper: (id) => invoke('network:remove-helper', id),
  testHelper: (id) => invoke('network:test-helper', id),
  setHelpersMode: (mode) => invoke('network:mode', mode),
  setShareRam: (on) => invoke('network:share-ram', on),
  setFullPower: (on) => invoke('network:full-power', on),
  downloadDraftModel: (pre) => invoke('models:draft-download', pre),
  setHelperRamFirst: (on) => invoke('network:helper-ram-first', on),
  onSystemStats: (callback) => subscribe('system:stats', callback),
  onRagDownload: (callback) => subscribe('rag:download', callback),
  onOpenSettings: (callback) => subscribe('app:open-settings', callback),
  downloadVision: (id) => invoke('models:vision-download', id),
  importVision: (id) => invoke('models:vision-import', id),
  removeVision: (id) => invoke('models:vision-remove', id),
  stopChat: (conversationId) => invoke('chat:stop', conversationId),
  undoToolChange: (conversationId, messageId, blockId) => invoke('chat:undo', { conversationId, messageId, blockId }),

  onChatEvent: (callback) => subscribe('chat:event', callback),
  onModelsProgress: (callback) => subscribe('models:progress', callback),
  onModelsChanged: (callback) => subscribe('models:changed', callback),
  onSettingsChanged: (callback) => subscribe('settings:changed', callback),
  onRuntimeProgress: (callback) => subscribe('runtime:progress', callback),
  onServerStatus: (callback) => subscribe('server:status', callback),
  onNetworkStatus: (callback) => subscribe('network:status', callback),
  onWorkspaceChanged: (callback) => subscribe('workspace:changed', callback),
  onBenchmarkProgress: (callback) => subscribe('benchmark:progress', callback),
  onBenchmarkHistory: (callback) => subscribe('benchmark:history', callback),
});
