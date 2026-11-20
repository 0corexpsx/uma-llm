const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { sleep } = require('./util.cjs');
const { DEFAULTS, buildServerArgs, cacheTypeFixes, draftCompatibility, draftArgs, moeCacheShare, speculationArgs, speculationSupport, parseExtraArgs } = require('./modelSettings.cjs');

// The first llama.cpp build with the MoE cache (--moe-cache-mib, --moe-cache-cpu-share).
const MOE_CACHE_BUILD = 12191;
// From this engine build on, what was read before a picture can be reused after it (see streamChat).
const CACHE_AFTER_IMAGE_BUILD = 12318;
const MiB = 1024 * 1024;
const { estimateMemory } = require('./memory.cjs');
const { freeVramBytes, gpuSummary } = require('./hardware.cjs');
const { planPlacement, placementArgs, parseDeviceList, localCards } = require('./placement.cjs');
const { t } = require('./i18n.cjs');

// Chat memory (chatMemory.cjs): what the engine has read of a chat is saved to disk a few seconds
// after the last reply, and read back when that chat is used again with the same model, so a
// restart, an update, an idle unload or a switch to another chat does not mean reading it again.
const PROMPT_SAVE_DELAY_MS = 4000;

function appError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function freePort(start = 8099) {
  for (let port = start; port < start + 40; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    if (available) return port;
  }
  throw new Error(t('Could not find a free local port.'));
}

/** What `llama-server --list-devices` prints: the devices this engine can put a model on. */
function listEngineDevices(serverPath) {
  return new Promise((resolve) => {
    require('node:child_process').execFile(serverPath, ['--list-devices'], {
      cwd: path.dirname(serverPath), windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => resolve(`${stdout}\n${stderr}`));
  });
}

/** The engine's own --help text: which ways of guessing ahead this build knows. */
function engineHelpText(serverPath) {
  return new Promise((resolve) => {
    require('node:child_process').execFile(serverPath, ['--help'], {
      cwd: path.dirname(serverPath), windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve(`${stdout}\n${stderr}`));
  });
}

class LlamaManager {
  constructor({ store, runtime, emit, logsDir, modelInfo, getModel = null, freeVram = freeVramBytes, freeRam = () => os.freemem(), network = null, chatMemory = null, batchTuner = null, listDevices = listEngineDevices, engineHelp = engineHelpText }) {
    this.store = store;
    // Guessing ahead without a second model (see modelSettings.speculationArgs): what each engine
    // build knows, asked once, and what the current load uses.
    this.engineHelp = engineHelp;
    this.specSupport = new Map();
    this.speculation = null;
    // This PC's graphics cards for the current load, when it has several (see localGpus).
    this.listDevices = listDevices;
    this.cards = { used: [], missing: [] };
    // Settings being tried by "Optimize and benchmark", on top of the model's own (null removes one).
    this.trialSettings = null;
    // Picks the physical batch size from measured reading speeds (null: the setting is used as it is).
    this.batchTuner = batchTuner;
    this.batchTune = null;
    this.forcedBatch = 0;
    // Where what the engine has read of each chat is kept (null: not kept).
    this.chatMemory = chatMemory;
    this.promptCache = null;
    this.promptSaveTimer = null;
    this.savingPrompt = null;
    this.active = 0;
    // Looks up an installed model by id, for the draft model (speculative decoding).
    this.getModel = getModel;
    this.freeRam = freeRam;
    this.modelInfo = modelInfo || null;
    this.freeVram = freeVram;
    this.network = network;
    this.helpers = { servers: [], skipped: [] };
    this.runtime = runtime;
    this.emit = emit || (() => {});
    this.logsDir = logsDir;
    this.child = null;
    this.port = 0;
    this.modelId = '';
    this.state = 'stopped';
    this.error = '';
    this.logs = [];
    this.logBuffer = [];
    this.logTimer = null;
    this.starting = null;
    this.idleTimer = null;
    this.apiKey = '';
    this.compute = {
      mode: '',
      backend: '',
      gpuName: '',
      offloadedLayers: null,
      totalLayers: null,
      detail: '',
    };
  }

  status() {
    return {
      state: this.state,
      modelId: this.modelId,
      port: this.port,
      pid: this.child?.pid || 0,
      error: this.error,
      running: this.state === 'ready',
      compute: this.computeInfo(),
      // Helper PCs this model is loaded across, and enabled ones that did not answer.
      helpers: this.child ? this.helpers : { servers: [], skipped: [] },
      // How the model is divided between this PC and its helpers, when a plan was used.
      placement: this.child && this.placement ? {
        mode: this.placement.mode,
        devices: this.placement.devices.map((device) => ({ name: device.name, label: device.remote ? device.label : '', card: device.remote ? '' : device.card || '', kind: device.kind, wantMB: device.wantMB })),
      } : null,
      // Graphics cards in this PC that the installed engine does not list, so nothing can run on them.
      unusedGpus: this.child ? this.cards.missing : [],
      // Settings Uma changed for this model so it can load (see cacheTypeFixes).
      cacheFix: this.child ? this.cacheFix || '' : '',
      // The small model guessing ahead for this one, and where it runs.
      draft: this.child && this.draft ? { name: this.draft.name, device: this.draftDeviceLabel() } : null,
      moeCache: this.child && this.moeCache ? { ...this.moeCache } : null,
      // Guessing ahead without a second model: the model's own MTP head, text already in the chat.
      speculation: this.child && this.speculation ? { ...this.speculation } : null,
      batch: this.child && this.batchTune ? { size: this.batchTune.size, exploring: this.batchTune.exploring } : null,
      logs: this.logs.slice(-12),
    };
  }

  computeInfo() {
    const runtimeConfig = this.store.getRuntime();
    const settings = this.store.getSettings();
    const backend = runtimeConfig.backend || 'cpu';
    const gpuBackend = ['vulkan', 'cuda', 'metal', 'rocm'].includes(backend);
    const intended = gpuBackend && settings.gpuOffload !== false ? 'GPU' : 'CPU';
    const parsedMode = this.compute.mode;
    const mode = parsedMode || intended;
    return {
      mode,
      backend,
      gpuName: this.compute.gpuName || this.runtime?.hardware?.gpu || '',
      offloadedLayers: this.compute.offloadedLayers,
      totalLayers: this.compute.totalLayers,
      detail: this.compute.detail || (mode === 'GPU'
        ? t('llama.cpp {0} backend with GPU offload enabled', [backend])
        : t('llama.cpp CPU backend or GPU offload disabled')),
    };
  }

  broadcast() {
    this.emit('server:status', this.status());
  }

  log(line) {
    const text = String(line).replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    if (!text) return;
    this.parseComputeLog(text);
    const stamp = new Date().toISOString();
    this.logs.push(text);
    if (this.logs.length > 300) this.logs.shift();
    // A model load prints thousands of lines; they are written together a few times a second
    // instead of opening the log file once for every line.
    this.logBuffer.push(`${stamp} ${text}\n`);
    if (!this.logTimer) {
      this.logTimer = setTimeout(() => this.flushLog(), 300);
      this.logTimer.unref?.();
    }
  }

  flushLog() {
    clearTimeout(this.logTimer);
    this.logTimer = null;
    if (!this.logBuffer.length) return;
    const text = this.logBuffer.join('');
    this.logBuffer = [];
    fs.appendFile(path.join(this.logsDir, 'llama.log'), text, () => {});
  }

  parseComputeLog(text) {
    const offloaded = text.match(/offloaded\s+(\d+)\/(\d+)\s+layers to GPU/i);
    if (offloaded) {
      this.compute.offloadedLayers = Number(offloaded[1]);
      this.compute.totalLayers = Number(offloaded[2]);
      this.compute.mode = Number(offloaded[1]) > 0 ? 'GPU' : 'CPU';
      this.compute.detail = `${offloaded[1]}/${offloaded[2]} layers offloaded to GPU`;
    }
    const repeating = text.match(/offloading\s+(\d+)\s+repeating layers to GPU/i);
    if (repeating) {
      this.compute.offloadedLayers = Number(repeating[1]);
      this.compute.mode = 'GPU';
      this.compute.detail = `${repeating[1]} repeating layers offloaded to GPU`;
    }
    const device = text.match(/using device\s+([^\s,]+)/i);
    if (device) {
      const value = device[1];
      if (/Vulkan|CUDA|Metal|ROCm/i.test(value)) {
        this.compute.mode = 'GPU';
        this.compute.backend = value;
      } else if (/CPU/i.test(value)) {
        this.compute.mode = 'CPU';
      }
    }
    const gpu = text.match(/ggml_(?:vulkan|cuda|metal|rocm)[^:]*:\s*([^|\n]+)/i);
    if (gpu) {
      const name = gpu[1].trim();
      if (name && !this.compute.gpuName) this.compute.gpuName = name.slice(0, 100);
    }
  }

  /** A model's settings, with the ones "Optimize and benchmark" is trying on top of them. */
  settingsFor(modelId) {
    const settings = { ...this.store.getEffectiveSettings(modelId) };
    for (const [key, value] of Object.entries(this.trialSettings || {})) {
      if (value === null || value === undefined) delete settings[key];
      else settings[key] = value;
    }
    return settings;
  }

  /** This PC's graphics cards as the installed engine names them, for the settings screen ([] with fewer than two). */
  async engineCards(runtimeConfig) {
    const names = (this.runtime?.hardware?.gpus || []).map((card) => card.name);
    if (names.length < 2 || !runtimeConfig?.serverPath || runtimeConfig.backend === 'cpu') return [];
    const output = await this.listDevices(runtimeConfig.serverPath).catch(() => '');
    return localCards(parseDeviceList(output), names).used.map((device) => ({ name: device.name, card: device.card, totalMB: device.totalMB, freeMB: device.freeMB }));
  }

  async ensureServer(model) {
    const runtimeConfig = this.store.getRuntime();
    if (!runtimeConfig.serverPath || !(await fsp.stat(runtimeConfig.serverPath).catch(() => null))) {
      throw appError(t('The local inference engine is not installed yet. Open Models to install it.'), 'RUNTIME_MISSING');
    }
    if (!model || !(await fsp.stat(model.path).catch(() => null))) {
      throw appError(t('The selected model file is missing. Open Models to download it again.'), 'MODEL_MISSING');
    }
    const launchKey = JSON.stringify([
      runtimeConfig.serverPath,
      buildServerArgs(model.path, this.settingsFor(model.id), runtimeConfig.backend, { mmproj: model.mmproj?.path }),
      this.network?.launchKey() || '',
      this.settingsFor(model.id).gpuCards || '',
      `${this.settingsFor(model.id).mtp || ''}/${this.settingsFor(model.id).ngram || ''}`,
    ]);
    if (this.child && this.modelId === model.id && this.state === 'ready' && this.launchKey === launchKey) {
      this.touch();
      return this.status();
    }
    if (this.starting) {
      await this.starting;
      if (this.state === 'ready' && this.modelId === model.id) return this.status();
    }
    // A draft model that made the load fail is left out until the settings change (see draftFor).
    if (this.draftFailedKey && this.draftFailedKey !== launchKey) this.draftFailedKey = '';
    if (this.moeFailedKey && this.moeFailedKey !== launchKey) this.moeFailedKey = '';
    if (this.specFailedKey && this.specFailedKey !== launchKey) this.specFailedKey = '';
    const remedy = (err) => {
        if (err.code === 'SERVER_FAILED' && this.batchTune && this.batchTune.size > 512) {
          // A larger batch needs more GPU memory: this size is not tried again for this model.
          this.batchTuner.fail(this.batchTune.key, this.batchTune.size);
          this.log(`[uma] the load failed with batch size ${this.batchTune.size}; it will not be tried again for this model`);
          if (this.forcedBatch) throw err;
          return this.startWithHelpers(model, runtimeConfig, launchKey);
        }
        if (err.code === 'SERVER_FAILED' && this.moeCache) {
          this.log('[uma] the load failed with the MoE cache; loading again with the usual split');
          this.moeFailedKey = launchKey;
          return this.startWithHelpers(model, runtimeConfig, launchKey);
        }
        if (err.code !== 'SERVER_FAILED' || !this.draft) throw err;
        this.log(`[uma] the load failed with the draft model ${this.draft.name}; loading again without it`);
        this.draftFailedKey = launchKey;
        return this.startWithHelpers(model, runtimeConfig, launchKey);
    };
    this.starting = this.startWithHelpers(model, runtimeConfig, launchKey)
      .catch((err) => {
        if (err.code !== 'SERVER_FAILED' || !this.speculation) return remedy(err);
        // Guessing ahead must never keep a model from loading: first the same load without it,
        // then whatever else may be in the way.
        this.log('[uma] the load failed with guessing ahead (MTP head, n-gram) on; loading again without it');
        this.specFailedKey = launchKey;
        return this.startWithHelpers(model, runtimeConfig, launchKey).catch(remedy);
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /**
   * Loads with the helper PCs, falling back step by step, so a helper can never take the model down:
   * - a balanced plan (fixed proportions) that does not load, say because a helper's GPU had less
   *   free memory than it reported, is retried once as a fill plan, which llama.cpp adjusts itself
   *   and which still keeps every helper's RAM reserve;
   * - if the load still fails while helpers take part, or a helper's engine stopped (llama.cpp then
   *   ends with "Remote RPC server crashed"), the model loads on this PC alone.
   * A PC with several graphics cards and no helpers goes the same way: fixed shares, then a fill
   * plan, and last llama.cpp's own split, with no plan of Uma's at all.
   */
  async startWithHelpers(model, runtimeConfig, launchKey) {
    let lastError;
    for (const attempt of [{}, { plan: 'fill' }, { helpers: false }, { helpers: false, plan: false }]) {
      if (attempt.plan === 'fill' && this.placement?.mode !== 'balanced') continue;
      // No helpers took part: there are none to leave out.
      if (attempt.helpers === false && attempt.plan === undefined && !this.helpers.servers.length) continue;
      // No plan was used: there is none to drop.
      if (attempt.plan === false && !this.placement) break;
      try {
        if (attempt.plan === 'fill') this.log(`[uma] the balanced plan for ${this.helpers.servers.length ? 'the helpers' : "this PC's graphics cards"} did not load; retrying with a fill plan`);
        if (attempt.plan === false) this.log("[uma] the load failed with Uma's plan for this PC's graphics cards; loading again with llama.cpp's own split");
        return await this.startServer(model, runtimeConfig, launchKey, attempt);
      } catch (err) {
        if (err.code !== 'SERVER_FAILED' || (!this.helpers.servers.length && !this.placement)) throw err;
        lastError = err;
        const helperFailed = this.logs.some((line) => /ggml-rpc|RPC server|rpc_/i.test(line));
        if (attempt.helpers === undefined && helperFailed) {
          // Retrying with the same helper would fail the same way.
          const names = this.helpers.details.map((item) => item.label).join(', ') || this.helpers.servers.join(', ');
          this.log(`[uma] a helper PC stopped during the load (${names}); loading on this PC alone`);
          this.placement = null;
        }
      }
    }
    throw lastError;
  }

  /**
   * The engine's automatic offload is cautious: on an 8 GB card it moved Qwen3 8B at 32k context
   * to 35/37 layers, cutting 56 tokens/s to 41, though all of them fit. So when the estimate says
   * everything fits in the VRAM free right now, load it all, and otherwise let the engine choose.
   */
  /**
   * The MoE cache for this load, or null: how many MiB of the GPU are left for it once everything
   * but the routed experts is there (weights, context cache, working buffers, a draft model, and
   * 1 GB to spare), and the CPU share for the loading mode.
   */
  async planMoeCache(settings, info, runtimeConfig, freeBytes = null) {
    const build = Number(String(runtimeConfig.version || '').match(/^b(\d+)$/)?.[1]) || 0;
    if (settings.moeCache === 'off' || settings.gpuOffload === false || settings.gpuLayers !== undefined) return null;
    if (runtimeConfig.backend === 'cpu' || build < MOE_CACHE_BUILD || !info?.expertCount || !info.expertBytes) return null;
    const free = freeBytes ?? await this.freeVram().catch(() => 0);
    if (!free) return null;
    const full = estimateMemory(info, { ...DEFAULTS, ...settings, gpuLayers: 999 });
    const rest = Math.max(0, full.gpuBytes - info.expertBytes) + (this.draft ? this.draft.memoryMB * MiB : 0);
    const room = Math.min(info.expertBytes, free - rest - 1024 * MiB);
    if (room < 512 * MiB) {
      this.log(`[uma] no MoE cache: after the rest of the model only ${Math.max(0, Math.round(room / MiB))} MiB of the GPU would be left`);
      return null;
    }
    const plan = { mib: Math.floor(room / MiB / 64) * 64, share: moeCacheShare(settings.loadMode), expertMB: Math.round(info.expertBytes / MiB) };
    this.log(`[uma] mixture-of-experts model that does not fit: its experts (${plan.expertMB} MiB) stay in RAM, with a ${plan.mib} MiB cache of the most used ones on the GPU (CPU share ${plan.share})`);
    return plan;
  }

  /** What a measured batch size belongs to: the model file, the helper PCs and the engine. */
  batchKey(model, runtimeConfig) {
    return JSON.stringify([model.path, model.size || 0, this.network?.launchKey() || '', runtimeConfig?.version || '']);
  }

  /** A model call's own measurement of how fast it read its new text feeds the batch size choice. */
  noteReading(timings) {
    if (this.batchTuner && this.batchTune) this.batchTuner.record(this.batchTune.key, this.batchTune.size, Number(timings?.prompt_n) || 0, Number(timings?.prompt_ms) || 0);
  }

  async allLayersFit(model, settings, extraBytes = 0, freeBytes = null) {
    if (!this.modelInfo || settings.gpuLayers !== undefined) return false;
    try {
      const free = freeBytes ?? await this.freeVram();
      if (!free) return false;
      const info = await this.modelInfo(model.id);
      const estimate = estimateMemory(info, { ...DEFAULTS, ...settings, gpuLayers: 999 });
      return estimate.gpuBytes + extraBytes + 150 * 1024 * 1024 <= free;
    } catch {
      return false;
    }
  }

  /**
   * This PC's graphics cards as the installed engine lists them, when the PC has more than one
   * (say an RTX 3060 and two Tesla P40). `used` is [] on a PC with one card, and the load then goes
   * as it always did. `missing` names cards the engine does not list: nothing can be put on those,
   * so their memory must not be counted, and the user is told (status().unusedGpus).
   */
  async localGpus(runtimeConfig, settings) {
    const names = (this.runtime?.hardware?.gpus || []).map((card) => card.name);
    if (names.length < 2 || runtimeConfig.backend === 'cpu' || settings.gpuOffload === false) return { used: [], missing: [] };
    const output = await this.listDevices(runtimeConfig.serverPath).catch(() => '');
    const found = localCards(parseDeviceList(output), names);
    if (!found.used.length) {
      this.log(`[uma] this PC has ${names.length} graphics cards (${gpuSummary(names)}), but the engine listed none of them; llama.cpp chooses the split itself`);
      return { used: [], missing: [] };
    }
    this.log(`[uma] graphics cards the engine can use: ${found.used.map((device) => `${device.name} ${device.card} (${device.freeMB} of ${device.totalMB} MiB free)`).join(', ')}`);
    if (found.missing.length) {
      this.log(`[uma] NOT usable with this engine (${runtimeConfig.backend}${runtimeConfig.version ? ` ${runtimeConfig.version}` : ''}): ${gpuSummary(found.missing)}. The engine does not list ${found.missing.length > 1 ? 'these cards' : 'this card'}, so nothing is put there. A Tesla P40 or GTX 10 card needs a CUDA 12 engine (CUDA 13 has no code for them); Vulkan cannot see a card in compute-only (TCC) mode.`);
    }
    return found;
  }

  /** How the model is shared between this PC's graphics cards (see placement.cjs), with the plan written to the log. */
  planCards(needMB, { fill = false, draftMB = 0 } = {}) {
    const mainFreeRamMB = Math.round(this.freeRam() / 1024 / 1024);
    const plan = planPlacement({ devices: this.cards.used, needMB, mainFreeRamMB, forceFill: fill, draftMB });
    this.log(`[uma] plan for ${this.cards.used.length} graphics cards (${plan.mode === 'balanced' ? 'the model fits: shared in proportion to free memory' : 'the cards are filled, the rest stays in RAM'}): the model needs about ${needMB || '?'} MiB; ${plan.gpuRoomMB} MiB is free on the cards in total`);
    if (draftMB) this.log(plan.draftDevice ? `[uma]   the draft model (about ${draftMB} MiB) runs on ${plan.draftDevice}` : '[uma]   no card has room for the draft model; it follows the main model');
    for (const device of plan.devices) {
      this.log(`[uma]   ${device.name} ${device.card}: ${plan.mode === 'balanced' ? `about ${device.wantMB} MiB (${Math.round(device.share * 100)}%)` : `up to ${device.wantMB} MiB`}, keeping ${device.targetMB} MiB free`);
    }
    return plan;
  }

  /**
   * Decides how the model is shared between this PC and the helpers (see placement.cjs), from the
   * free memory llama.cpp reports for every device and the model's own memory estimate. Without a
   * plan, llama.cpp's own fitting is used as before.
   */
  async planHelpers(model, settings, runtimeConfig, { fill = false, draftMB = 0 } = {}) {
    try {
      const output = await new Promise((resolve) => {
        require('node:child_process').execFile(runtimeConfig.serverPath, ['--rpc', this.helpers.servers.join(','), '--list-devices'], {
          cwd: path.dirname(runtimeConfig.serverPath), windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => resolve(`${stdout}\n${stderr}`));
      });
      const devices = parseDeviceList(output);
      // No helper device listed: the helpers' engines did not answer (one may have just stopped).
      // Passing --rpc anyway would make llama-server stop, so the model loads on this PC alone.
      if (!devices.some((device) => /^RPC\d+$/.test(device.name))) {
        const reason = output.match(/(Remote RPC server[^\n]*|Failed to connect[^\n]*|version mismatch[^\n]*)/i)?.[1] || 'no helper device listed';
        this.log(`[uma] the helper PCs did not list their devices (${reason.trim()}); loading on this PC alone`);
        return { unusable: true };
      }
      // Without model details the plan still keeps each helper's RAM reserve; it just cannot
      // tell whether the model would fit on the GPUs alone.
      const info = this.modelInfo ? await this.modelInfo(model.id).catch(() => null) : null;
      const needMB = info ? Math.ceil(estimateMemory(info, { ...DEFAULTS, ...settings, gpuLayers: 999 }).gpuBytes / 1024 / 1024) : 0;
      // "Helpers' RAM first" in Settings gives the split used before 0.2.14, to compare the two.
      const helperRamFirst = Boolean(this.network?.settings().helperRamFirst);
      const mainFreeRamMB = helperRamFirst ? 0 : Math.round(this.freeRam() / 1024 / 1024);
      const plan = planPlacement({ devices, helpers: this.helpers.details, needMB, mainFreeRamMB, forceFill: fill, draftMB });
      this.log(`[uma] helper plan (${plan.mode}): the model needs about ${needMB} MiB on GPUs; ${plan.gpuRoomMB} MiB of GPU memory is free in total`);
      if (helperRamFirst) this.log("[uma]   layers that fit no GPU go to the helpers' RAM first (chosen in Settings → Network)");
      if (plan.mode === 'fill' && plan.leftoverMB > 0 && plan.ramHereMB !== null) {
        const onHelpers = plan.leftoverMB - plan.ramHereMB;
        this.log(`[uma]   about ${plan.leftoverMB} MiB fits no GPU: ${plan.ramHereMB} MiB stays in this PC's RAM (${mainFreeRamMB} MiB free), which is faster than a helper's RAM${onHelpers > 0 ? `; the other ${onHelpers} MiB goes to the helpers' RAM` : ''}`);
      }
      if (draftMB) this.log(plan.draftDevice ? `[uma]   the draft model (about ${draftMB} MiB) runs on ${plan.draftDevice}` : '[uma]   no GPU has room for the draft model; it follows the main model');
      for (const device of plan.devices) {
        this.log(`[uma]   ${device.name} ${device.remote ? `(${device.label}, ${device.kind === 'cpu' ? 'RAM' : 'GPU'})` : '(this PC, GPU)'}: up to ${device.wantMB} MiB, keeping ${device.targetMB} MiB free`);
      }
      return plan;
    } catch (err) {
      this.log(`[uma] helper plan skipped: ${err.message}`);
      return null;
    }
  }

  async startServer(model, runtimeConfig, launchKey, { plan = true, helpers: useHelpers = true } = {}) {
    const previousHelpers = this.helpers;
    await this.stop({ silent: true });
    // Counts model loads: a freshly started engine has read nothing yet (see AgentRunner.workspaceForPrompt).
    this.generation = (this.generation || 0) + 1;
    this.modelId = model.id;
    this.launchKey = launchKey;
    this.state = 'starting';
    this.error = '';
    this.logs = [];
    this.compute = {
      mode: '',
      backend: '',
      gpuName: '',
      offloadedLayers: null,
      totalLayers: null,
      detail: '',
    };
    this.broadcast();

    await this.rotateLog();
    let chosen = this.settingsFor(model.id);
    // The physical batch size: measured and picked by Uma, unless it was set by hand for this model.
    this.batchTune = null;
    const batchByHand = this.store.getSettings?.()?.modelOverrides?.[model.id]?.ubatchSize !== undefined;
    if (this.batchTuner && chosen.batchTuning !== 'off' && (!batchByHand || this.forcedBatch)) {
      const key = this.batchKey(model, runtimeConfig);
      const pick = this.forcedBatch ? { size: this.forcedBatch, exploring: true } : await this.batchTuner.choose(key);
      this.batchTune = { key, size: pick.size, exploring: pick.exploring };
      chosen = { ...chosen, ubatchSize: pick.size, batchSize: Math.max(Number(chosen.batchSize) || 2048, pick.size) };
      this.log(`[uma] batch size ${pick.size}${pick.exploring ? ' (measuring how fast this size reads)' : ' (the fastest measured for this model)'}`);
    }
    const info = this.modelInfo ? await this.modelInfo(model.id).catch(() => null) : null;
    let settings = chosen;
    this.idleMinutes = settings.idleMinutes ?? 30;
    const port = await freePort(8099);
    this.apiKey = crypto.randomBytes(24).toString('hex');
    this.draft = launchKey && this.draftFailedKey === launchKey ? null : await this.draftFor(model, settings, info);
    const draftBytes = this.draft ? this.draft.memoryMB * 1024 * 1024 : 0;
    // Several graphics cards in this PC: what the engine lists of them is what counts (see localGpus).
    const found = await this.localGpus(runtimeConfig, settings);
    // Cards chosen for this model in its settings (or by "Optimize and benchmark"): a model that
    // fits on one card is faster there than shared between several (9B Q8: 35 tok/s on an RTX 3060
    // alone, 22 shared with two Tesla P40). Names the engine no longer lists are ignored.
    const wanted = String(settings.gpuCards || '').split(',').map((name) => name.trim()).filter(Boolean);
    const picked = found.used.filter((device) => wanted.includes(device.name));
    this.cards = picked.length && picked.length < found.used.length
      ? { used: picked, missing: found.missing, all: found.used, chosen: true }
      : { ...found, all: found.used };
    if (this.cards.chosen) this.log(`[uma] only ${picked.map((device) => `${device.name} ${device.card}`).join(', ')} ${picked.length > 1 ? 'are' : 'is'} used, as chosen for this model`);
    const several = this.cards.used.length > 1;
    // What the whole model needs on GPUs, for "Optimize and benchmark" (0 when it cannot be worked out).
    this.needMB = info ? Math.ceil(estimateMemory(info, { ...DEFAULTS, ...settings, gpuLayers: 999 }).gpuBytes / MiB) || 0 : 0;
    if (this.cards.used.length) this.compute.gpuName = gpuSummary(this.cards.used.map((device) => device.card)).slice(0, 100);
    const draftMB = this.draft?.memoryMB || 0;
    // What the whole model needs on GPUs, or 0 when that cannot be worked out (the cards are then filled).
    const needMB = several && info && settings.gpuLayers === undefined
      ? Math.ceil(estimateMemory(info, { ...DEFAULTS, ...settings, gpuLayers: 999 }).gpuBytes / MiB) || 0
      : 0;
    const fitsHere = several
      // On several cards "fits" means with room to spare on each: fixed shares cannot be adjusted.
      ? needMB > 0 && planPlacement({ devices: this.cards.used, needMB, draftMB }).mode === 'balanced'
      : await this.allLayersFit(model, settings, draftBytes, this.cards.used.length ? this.cards.used[0].freeMB * MiB : null);
    this.helpers = !useHelpers
      // After a helper failed: this PC alone, and the helpers that were tried are reported as left out.
      ? { servers: [], details: [], skipped: [...(previousHelpers.skipped || []), ...(previousHelpers.details || []).map((item) => item.label)], mismatched: previousHelpers.mismatched || [] }
      : this.network && settings.gpuOffload !== false
        ? await this.network.helpersForLaunch({ fitsHere: fitsHere && runtimeConfig.backend !== 'cpu' })
        : { servers: [], skipped: [], details: [] };
    // With helpers the engine spreads the layers over every device, steered by Uma's placement plan.
    // So does a PC with several graphics cards: the cards get fixed shares when the model fits on
    // them, and are filled one after the other when it does not.
    const allLayers = fitsHere && !this.helpers.servers.length && !several;
    this.placement = !plan || settings.gpuLayers !== undefined
      ? null
      : this.helpers.servers.length
        ? await this.planHelpers(model, settings, runtimeConfig, { fill: plan === 'fill', draftMB })
        : several ? this.planCards(needMB, { fill: plan === 'fill', draftMB }) : null;
    if (this.placement?.unusable) {
      this.placement = null;
      this.helpers = { servers: [], details: [], skipped: [...this.helpers.skipped, ...this.helpers.details.map((item) => item.label)], mismatched: this.helpers.mismatched || [] };
    }
    // Cache types the GPUs that will run this model cannot handle (see cacheTypeFixes); a helper's
    // abilities cannot be checked by llama.cpp, so helpers count as NVIDIA GPUs.
    const fixes = cacheTypeFixes(chosen, info, { helpers: this.helpers.servers.length > 0 });
    settings = fixes.settings;
    // A mixture-of-experts model that does not fit on this PC's GPU: its routed experts stay in RAM
    // and the GPU keeps a cache of the most used ones. At the same VRAM this wrote 92.2 tok/s where
    // llama.cpp's usual split wrote 54.8 (LFM2-8B-A1B, RTX 2070, b12318). Not with helper PCs yet:
    // over the network the cache's uploads are untested. Nor over several graphics cards, where the
    // experts usually fit anyway; with one card of several usable, that card's free memory counts.
    this.moeCache = !fitsHere && !this.helpers.servers.length && !this.placement && !several && launchKey !== this.moeFailedKey
      ? await this.planMoeCache(settings, info, runtimeConfig, this.cards.used.length ? this.cards.used[0].freeMB * MiB : null)
      : null;
    for (const note of fixes.notes) this.log(`[uma] ${note}`);
    this.cacheFix = fixes.changed;
    // Guessing ahead without a second model, when the engine knows how. A draft model chosen by
    // the user comes first, and so does a --spec-type written in the extra arguments. The MTP head
    // is left out with helper PCs: untested over the network.
    this.speculation = null;
    const specByHand = parseExtraArgs(settings.extraArgs).some((arg) => arg.split('=')[0] === '--spec-type');
    if (!this.draft && !specByHand && launchKey !== this.specFailedKey && (settings.mtp !== 'off' || settings.ngram !== 'off')) {
      if (!this.specSupport.has(runtimeConfig.serverPath)) {
        this.specSupport.set(runtimeConfig.serverPath, speculationSupport(await this.engineHelp(runtimeConfig.serverPath).catch(() => '')));
      }
      const support = this.specSupport.get(runtimeConfig.serverPath);
      const mtp = settings.mtp !== 'off' && support.mtp && info?.mtpLayers > 0 && !this.helpers.servers.length;
      const ngram = settings.ngram !== 'off' && support.ngram;
      if (mtp || ngram) {
        this.speculation = { mtp, ngram };
        this.log(`[uma] guessing ahead without a second model: ${[mtp ? "the model's own MTP head" : '', ngram ? 'text already in the chat (n-gram)' : ''].filter(Boolean).join(' and ')}`);
      }
    }
    // The engine's build number, from the folder Uma installed it in (llama-b12318-cuda): 0 when unknown.
    this.engineBuild = Number(/llama-b(\d+)/i.exec(String(runtimeConfig.serverPath || ''))?.[1]) || 0;
    const args = [
      // --rpc first: llama-server reads arguments in order, and -dev can only name RPC devices once
      // --rpc has registered them.
      ...(this.helpers.servers.length ? ['--rpc', this.helpers.servers.join(',')] : []),
      ...buildServerArgs(model.path, settings, runtimeConfig.backend, { allLayers, mmproj: model.mmproj?.path, placement: placementArgs(this.placement), extraFitMB: this.draft?.memoryMB || 0, moeCache: this.moeCache }),
      ...(this.draft ? draftArgs({ path: this.draft.path, tokens: this.draft.tokens, device: this.placement?.draftDevice || '' }) : speculationArgs(this.speculation || {})),
      // One card chosen of several: without -dev the engine would use every card it lists.
      ...(this.cards.chosen && !several && !this.helpers.servers.length ? ['-dev', this.cards.used[0].name] : []),
      '--host', '127.0.0.1',
      '--port', String(port),
      '--api-key', this.apiKey,
    ];
    // Only with one slot: with several, a chat may be in any of them.
    // `owner`: the chat whose text the engine holds now; `dirty`: it read more since the last save.
    if (this.chatMemory) await this.chatMemory.load().catch(() => {});
    this.promptCache = this.chatMemory && !this.chatMemory.unavailable && Number(settings.parallel || 1) === 1
      ? { key: promptStateKey(model, args, runtimeConfig.serverPath), dirty: false, owner: null }
      : null;
    if (this.promptCache) args.push('--slot-save-path', this.chatMemory.dir);
    else if (this.chatMemory?.unavailable) this.log(`[uma] chat memory is off for this load: its folder cannot be used (${this.chatMemory.unavailable})`);

    const safeArgs = args.map((arg, index) => (index > 0 && args[index - 1] === '--api-key' ? '••••••' : arg));
    this.log(`[uma] starting ${model.name}: ${runtimeConfig.serverPath} ${safeArgs.join(' ')}`);
    if (this.helpers.skipped.length) this.log(`[uma] helper PCs left out of this load: ${this.helpers.skipped.join(', ')}`);
    for (const reason of this.helpers.mismatched || []) this.log(`[uma] ${reason}`);
    const child = spawn(runtimeConfig.serverPath, args, {
      cwd: path.dirname(runtimeConfig.serverPath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LLAMA_LOG_COLORS: '0' },
    });
    this.child = child;
    this.port = port;

    child.stdout.on('data', (data) => {
      for (const line of String(data).split(/\r?\n/)) this.log(line);
    });
    child.stderr.on('data', (data) => {
      for (const line of String(data).split(/\r?\n/)) this.log(line);
    });
    child.on('error', (err) => {
      this.error = err.message;
      this.state = 'error';
      this.log(`[uma] process error: ${err.message}`);
      this.broadcast();
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        if (this.state !== 'stopped') {
          this.state = code === 0 ? 'stopped' : 'error';
          if (code !== 0 && !this.error) {
            this.error = `llama-server exited with code ${code}. ${this.logs.slice(-3).join(' ')}`.trim();
          }
        }
        this.broadcast();
        this.log(`[uma] llama-server exited (code ${code}, signal ${signal})`);
        this.flushLog();
      }
    });

    // Slow disks, big models, and a GPU already in use by another program can all take minutes.
    const loadStartedAt = Date.now();
    const deadline = loadStartedAt + 600000;
    while (Date.now() < deadline) {
      await sleep(350);
      if (!this.child) {
        throw appError(t('The local model server stopped while loading.\n\n{0}', [this.logs.slice(-10).join('\n')]), 'SERVER_FAILED');
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
        if (response.ok) {
          this.state = 'ready';
          this.error = '';
          this.broadcast();
          this.log('[uma] model ready');
          this.reportLoad(model, settings, Date.now() - loadStartedAt);
          this.touch();
          return this.status();
        }
      } catch {}
    }

    await this.stop({ silent: true });
    throw appError(
      t('The model took too long to load. Try a smaller model or a smaller context window.\n\n{0}', [this.logs.slice(-10).join('\n')]),
      'SERVER_TIMEOUT',
    );
  }

  /**
   * The draft model chosen in this model's settings, if it can be used: installed, the same
   * vocabulary as the big model, and smaller. Its memory need is estimated so the plan leaves room.
   */
  async draftFor(model, settings, info) {
    const id = settings.draftModelId;
    if (!id || !this.getModel || !this.modelInfo) return null;
    const entry = await this.getModel(id).catch(() => null);
    if (!entry || entry.id === model.id || !(await fsp.stat(entry.path).catch(() => null))) {
      this.log('[uma] the draft model chosen for this model is no longer installed; loading without it');
      return null;
    }
    const draftInfo = await this.modelInfo(entry.id).catch(() => null);
    const problem = draftCompatibility(info, draftInfo);
    if (problem) {
      this.log(`[uma] ${entry.name} cannot draft for ${model.name}: ${problem}; loading without it`);
      return null;
    }
    // Its weights and cache on one GPU, plus llama.cpp's work buffers for a second model.
    const estimate = estimateMemory(draftInfo, { ...DEFAULTS, contextSize: settings.contextSize || 8192, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', gpuLayers: 999 });
    return {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      tokens: settings.draftTokens || DEFAULTS.draftTokens,
      memoryMB: Math.ceil(estimate.gpuBytes / 1024 / 1024) + 400,
    };
  }

  /** "Laptop GPU" when the draft runs on a helper's GPU, '' when it runs on this PC. */
  draftDeviceLabel() {
    const name = this.placement?.draftDevice;
    if (!name) return '';
    const device = this.placement.devices.find((item) => item.name === name);
    return device?.remote ? `${device.label} GPU` : '';
  }

  /**
   * After a load with helpers: writes down what a look at the speed needs (RAM, threads, the split),
   * and tells the helpers, whose Shared screen otherwise shows only their own share of the work.
   */
  reportLoad(model, settings, loadMs) {
    if (!this.helpers.servers.length) return;
    const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    const mib = (value) => gb(value * 1024 * 1024);
    const s = { ...DEFAULTS, ...settings };
    const modelBytes = model.parts?.length ? model.parts.reduce((sum, part) => sum + (part.size || 0), 0) : model.size || 0;
    const facts = [
      modelBytes ? `${gb(modelBytes)} model` : '',
      `context ${s.contextSize || 8192}`,
      `${s.threads || os.cpus().length} threads of ${os.cpus().length}`,
      `loading mode ${s.loadMode}`,
      `this PC has ${gb(this.freeRam())} of RAM free of ${gb(os.totalmem())} after loading`,
      `loaded in ${Math.round(loadMs / 1000)} s`,
    ];
    if (this.placement) {
      const parts = this.placement.devices.map((device) => `${device.remote ? `${device.label} ${device.kind === 'cpu' ? 'RAM' : 'GPU'}` : 'main PC GPU'} up to ${mib(device.wantMB)}`);
      facts.push(`split (${this.placement.mode}): ${parts.join(', ')}`);
      if (this.placement.ramHereMB) facts.push(`about ${mib(this.placement.ramHereMB)} stays in the main PC's RAM for its CPU`);
    }
    if (this.draft) facts.push(`draft model ${this.draft.name} guessing ${this.draft.tokens} tokens ahead${this.draftDeviceLabel() ? ` on ${this.draftDeviceLabel()}` : ''}`);
    if (this.compute.offloadedLayers !== null) facts.push(`${this.compute.offloadedLayers}${this.compute.totalLayers ? ` of ${this.compute.totalLayers}` : ''} layers on GPUs`);
    const summary = facts.filter(Boolean).join('; ');
    this.log(`[uma] loaded with helpers: ${summary}`);
    this.network?.reportToHelpers?.(this.helpers.servers, { kind: 'loaded', model: model.name, summary });
  }

  async rotateLog() {
    const file = path.join(this.logsDir, 'llama.log');
    const stat = await fsp.stat(file).catch(() => null);
    if (stat && stat.size > 20 * 1024 * 1024) {
      await fsp.rename(file, `${file}.1`).catch(() => {});
    }
  }

  touch() {
    clearTimeout(this.idleTimer);
    const minutes = this.idleMinutes ?? 30;
    if (!minutes) return;
    this.idleTimer = setTimeout(() => {
      if (this.state === 'ready') this.stop();
    }, minutes * 60 * 1000);
  }

  /** Sends llama.cpp a slot action ('save' or 'restore') for the one slot. */
  async slotAction(action, filename, timeoutMs = 300000) {
    const response = await fetch(`http://127.0.0.1:${this.port}/slots/0?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ filename }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${action} failed (${response.status}): ${body.slice(0, 200)}`);
    return JSON.parse(body);
  }

  /**
   * Before a request: if the engine holds another chat, that one is saved (when it changed) and
   * this chat's memory is read back from disk, if it has one. Requests are taken one at a time.
   */
  useConversation(conversationId = null) {
    const run = async () => {
      const cache = this.promptCache;
      if (!cache || cache.owner === conversationId) return;
      if (this.active > 0) {
        // Another request is using the engine: what it holds belongs to no chat for certain.
        cache.owner = null;
        cache.dirty = false;
        return;
      }
      clearTimeout(this.promptSaveTimer);
      if (cache.dirty) await this.savePrompt();
      if (this.savingPrompt) await this.savingPrompt;
      cache.owner = conversationId;
      cache.dirty = false;
      if (!conversationId) return;
      const entry = await this.chatMemory.find(conversationId, cache.key).catch(() => null);
      if (!entry) return;
      try {
        const started = Date.now();
        const result = await this.slotAction('restore', entry.file);
        this.log(`[uma] continued from this chat's memory: ${result.n_restored} tokens read back from disk in ${((Date.now() - started) / 1000).toFixed(1)} s, so they are not read again`);
      } catch (err) {
        this.log(`[uma] this chat's memory could not be read back: ${err.message}`);
      }
    };
    this.switching = (this.switching || Promise.resolve()).then(run, run);
    return this.switching;
  }

  /** A chat was deleted: what the engine holds of it is no longer saved under its name. */
  forgetConversation(conversationId) {
    if (this.promptCache?.owner === conversationId) {
      this.promptCache.owner = null;
      this.promptCache.dirty = false;
    }
  }

  /** Called after every request: saves the conversation once the engine has been quiet for a moment. */
  schedulePromptSave() {
    if (!this.promptCache) return;
    this.promptCache.dirty = true;
    clearTimeout(this.promptSaveTimer);
    this.promptSaveTimer = setTimeout(() => { this.savePrompt().catch(() => {}); }, PROMPT_SAVE_DELAY_MS);
    this.promptSaveTimer.unref?.();
  }

  async savePrompt() {
    const cache = this.promptCache;
    if (this.savingPrompt) return this.savingPrompt;
    if (!cache || !cache.dirty || !cache.owner || this.state !== 'ready' || !this.child || this.active > 0) return;
    const owner = cache.owner;
    this.savingPrompt = (async () => {
      cache.dirty = false;
      const file = await this.chatMemory.prepareSave(owner);
      if (!file) {
        this.log('[uma] chat memory not saved: the disk is almost full');
        return;
      }
      const started = Date.now();
      const result = await this.slotAction('save', file);
      if (!result.n_saved || this.promptCache !== cache) return;
      await this.chatMemory.saved(owner, { key: cache.key, tokens: result.n_saved, bytes: result.n_written });
      this.log(`[uma] saved this chat's memory: ${result.n_saved} tokens, ${Math.round((result.n_written || 0) / 1048576)} MB in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    })().catch((err) => {
      this.log(`[uma] chat memory could not be saved: ${err.message}`);
    }).finally(() => { this.savingPrompt = null; });
    return this.savingPrompt;
  }

  async stop({ silent = false } = {}) {
    clearTimeout(this.idleTimer);
    clearTimeout(this.promptSaveTimer);
    // A reply not saved yet is saved before the engine goes (idle unload, model switch).
    if (this.child && this.state === 'ready') await Promise.race([this.savePrompt(), sleep(30000)]).catch(() => {});
    else if (this.savingPrompt) await Promise.race([this.savingPrompt, sleep(30000)]).catch(() => {});
    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      if (!silent) this.broadcast();
      return;
    }
    this.state = 'stopped';
    this.child = null;
    try {
      child.kill();
    } catch {}
    await sleep(250);
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else if (child.pid) {
        child.kill('SIGKILL');
      }
    } catch {}
    this.port = 0;
    this.apiKey = '';
    this.broadcast();
  }

  async complete(options) {
    await this.useConversation(options.conversationId || null);
    this.active += 1;
    try {
      return await this.completeOnce(options);
    } finally {
      this.active -= 1;
      this.schedulePromptSave();
    }
  }

  async completeOnce({ messages, temperature = 0.2, topP = 0.9, maxTokens = 128, signal }) {
    if (this.state !== 'ready' || !this.port) throw new Error(t('The model server is not ready.'));
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000),
      body: JSON.stringify({
        messages,
        stream: false,
        temperature,
        top_p: topP,
        max_tokens: maxTokens,
        cache_prompt: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    const elapsedMs = Date.now() - started;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(t('Local model error ({0}): {1}', [response.status, body.slice(0, 1200)]));
    }
    const data = await response.json();
    this.noteReading(data.timings);
    return {
      text: data.choices?.[0]?.message?.content || '',
      finishReason: data.choices?.[0]?.finish_reason || '',
      usage: data.usage || {},
      timings: data.timings || {},
      elapsedMs,
    };
  }

  async firstTokenLatency({ messages, signal }) {
    if (this.state !== 'ready' || !this.port) throw new Error(t('The model server is not ready.'));
    const started = Date.now();
    let firstTokenMs = null;
    for await (const event of this.streamChat({
      messages,
      signal,
      temperature: 0,
      topP: 1,
      maxTokens: 2,
    })) {
      if (event.type === 'text' && event.text && firstTokenMs === null) {
        firstTokenMs = Date.now() - started;
        break;
      }
    }
    return firstTokenMs;
  }

  async *streamChat({ messages, signal, temperature = 0.35, topP = 0.9, maxTokens = 2048, responseSchema, sampling = {}, conversationId = null }) {
    if (this.state !== 'ready' || !this.port) throw new Error(t('The model server is not ready.'));
    this.touch();
    await this.useConversation(conversationId);
    this.active += 1;
    clearTimeout(this.promptSaveTimer);
    const local = new AbortController();
    let timedOut = false;
    let lastActivity = Date.now();
    const onAbort = () => local.abort(signal?.reason || new Error('Stopped.'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > 180000) {
        timedOut = true;
        local.abort(new Error(t('The local model stopped producing activity for 3 minutes.')));
      }
    }, 5000);
    let reader;
    // Reusing the cache after an image left Qwen3.8 stopping after one word on every later reply,
    // so the request right after one read its prompt in full: three to five seconds at every step
    // of a task with screenshots (measured: 36 s for a task that takes 22 s without it). With
    // engine b12318 the replies are whole again (Qwen3.8-9B: twenty-one replies after pictures, and
    // follow-up messages), so only an older engine still reads in full.
    // UMA_CACHE_AFTER_IMAGE=0 or 1 forces one or the other, to try an engine.
    const reuseAfterImage = process.env.UMA_CACHE_AFTER_IMAGE ? process.env.UMA_CACHE_AFTER_IMAGE === '1' : this.engineBuild >= CACHE_AFTER_IMAGE_BUILD;
    const cachePrompt = reuseAfterImage || !this.afterImage;
    this.afterImage = messages.some((message) => Array.isArray(message.content));
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: local.signal,
        body: JSON.stringify({
          messages,
          stream: true,
          temperature,
          top_p: topP,
          max_tokens: maxTokens,
          cache_prompt: cachePrompt,
          chat_template_kwargs: { enable_thinking: false },
          // The notes Uma adds to earlier replies in the history: a model that starts writing one
          // itself is stopped there (one user's model wrote 150 lines of it).
          stop: ['(Tools Uma ran for this reply', '(Uma: in this reply'],
          ...sampling,
          ...(responseSchema ? { response_format: { type: 'json_schema', json_schema: { schema: responseSchema } } } : {}),
        }),
      });
      lastActivity = Date.now();
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        if (/exceed_context_size|exceeds? the available context/i.test(body)) {
          throw appError(t('This conversation no longer fits in the context window. Start a new conversation, or raise Context window in Settings.'), 'CONTEXT_EXCEEDED');
        }
        throw appError(t('Local model error ({0}): {1}', [response.status, body.slice(0, 1200)]), response.status === 400 ? 'BAD_REQUEST' : 'SERVER_ERROR');
      }
      if (!response.body) throw new Error(t('The local model returned an empty response.'));

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        lastActivity = Date.now();
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';
        for (const event of events) {
          for (const line of event.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') {
              finished = true;
              continue;
            }
            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }
            if (parsed.error) {
              throw new Error(parsed.error.message || String(parsed.error));
            }
            // The last piece of a reply carries llama.cpp's own measurements: how many tokens it
            // had to read, how many it wrote, and how long each took.
            if (parsed.timings) {
              this.noteReading(parsed.timings);
              yield { type: 'timings', timings: parsed.timings };
            }
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta || {};
            if (delta.content) yield { type: 'text', text: delta.content };
            if (delta.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
            if (choice.finish_reason) {
              yield { type: 'finish', reason: choice.finish_reason };
              finished = true;
            }
          }
        }
      }
    } catch (err) {
      if (timedOut) throw new Error(t('The local model stopped responding for 3 minutes. The request was cancelled; check the model/VRAM and try again.'));
      if (!this.child && !signal?.aborted) {
        throw appError(t('The local model server stopped unexpectedly, often because it ran out of memory. Try a smaller context or model.\n\n{0}', [this.logs.slice(-6).join('\n')]), 'SERVER_FAILED');
      }
      throw err;
    } finally {
      clearInterval(watchdog);
      signal?.removeEventListener('abort', onAbort);
      try { await reader?.cancel(); } catch {}
      this.active -= 1;
      this.schedulePromptSave();
    }
  }
}

/**
 * What a saved conversation depends on: the engine build, the model file, and the settings that
 * shape the engine's memory of it (context size, cache types, image model).
 */
function promptStateKey(model, args, serverPath) {
  const value = (flag) => {
    const at = args.indexOf(flag);
    return at >= 0 ? String(args[at + 1]) : '';
  };
  const stat = fs.statSync(model.path, { throwIfNoEntry: false });
  return JSON.stringify([serverPath, model.path, stat?.size || 0, Math.round(stat?.mtimeMs || 0), value('-c'), value('-ctk'), value('-ctv'), value('--mmproj')]);
}

module.exports = { LlamaManager, promptStateKey };
