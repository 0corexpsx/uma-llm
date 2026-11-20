const os = require('node:os');
const { execFile } = require('node:child_process');
const { newId } = require('./util.cjs');
const { queryAppleGpu } = require('./systemStats.cjs');
const { nvidiaCards, gpuSummary } = require('./hardware.cjs');
const { t } = require('./i18n.cjs');

function execJson(file, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error || !stdout) return resolve(null);
      try {
        return resolve(JSON.parse(String(stdout).trim()));
      } catch {
        return resolve(null);
      }
    });
  });
}

/** "[[dd-]hh:]mm:ss[.cc]" from ps, in seconds. */
function psSeconds(value) {
  const [days, rest] = value.includes('-') ? value.split('-') : ['0', value];
  return rest.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) + Number(days) * 86400;
}

async function sampleProcess(pid) {
  if (!pid) return null;
  if (process.platform !== 'win32') {
    const output = await new Promise((resolve) => {
      execFile('ps', ['-o', 'rss=,time=', '-p', String(Number(pid))], { timeout: 4000 }, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
    });
    const [rssKB, time] = output.split(/\s+/);
    if (!rssKB) return null;
    const memoryMB = Math.round(Number(rssKB) / 1024);
    return { cpuSeconds: psSeconds(time || '0:0') || 0, workingSetMB: memoryMB, privateMB: memoryMB };
  }
  const script = `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ cpu = [double]$p.CPU; workingSet = [long]$p.WorkingSet64; private = [long]$p.PrivateMemorySize64 } | ConvertTo-Json -Compress }`;
  const data = await execJson('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 4000);
  if (!data) return null;
  return {
    cpuSeconds: Number(data.cpu) || 0,
    workingSetMB: Math.round((Number(data.workingSet) || 0) / 1024 / 1024),
    privateMB: Math.round((Number(data.private) || 0) / 1024 / 1024),
  };
}

async function sampleGpu() {
  if (process.platform === 'darwin') {
    const gpu = await queryAppleGpu();
    if (!gpu) return null;
    return {
      name: 'Apple GPU',
      utilization: gpu.percent,
      memoryUsedMB: Math.round(gpu.usedBytes / 1024 / 1024),
      memoryTotalMB: Math.round(gpu.totalBytes / 1024 / 1024),
    };
  }
  // Every NVIDIA card: memory added up, the busiest card's percentage (see gpuReading).
  const cards = await nvidiaCards(3000);
  if (!cards.length) return null;
  return {
    name: gpuSummary(cards.map((card) => card.name)),
    utilization: Math.max(...cards.map((card) => card.percent)),
    memoryUsedMB: cards.reduce((sum, card) => sum + card.usedMB, 0),
    memoryTotalMB: cards.reduce((sum, card) => sum + card.totalMB, 0),
  };
}

function average(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

class BenchmarkManager {
  constructor({ store, models, runtime, llama, agent, emit }) {
    this.store = store;
    this.models = models;
    this.runtime = runtime;
    this.llama = llama;
    this.agent = agent;
    this.isAgentBusy = typeof agent === 'function' ? agent : () => Boolean(agent?.isBusy?.());
    this.emit = emit || (() => {});
    this.current = null;
    this.controller = null;
    this.progress = null;
  }

  isRunning() {
    return Boolean(this.current);
  }

  status() {
    return {
      running: this.isRunning(),
      progress: this.progress,
      history: this.store.getBenchmarks(),
    };
  }

  start(options = {}) {
    if (this.current) throw new Error(t('A benchmark is already running.'));
    if (this.isAgentBusy()) throw new Error(t('Stop the current chat response before benchmarking.'));
    const controller = new AbortController();
    this.controller = controller;
    this.percentFrom = 0;
    const run = options.optimize ? this.optimize({ signal: controller.signal }) : this.execute({ ...options, signal: controller.signal });
    this.current = run.catch((err) => {
      const message = err.name === 'AbortError' ? 'Benchmark cancelled.' : err.message;
      this.update({
        phase: err.name === 'AbortError' ? 'cancelled' : 'error',
        message,
        elapsedMs: this.progress?.elapsedMs || 0,
      });
      return null;
    }).finally(() => {
      this.current = null;
      this.controller = null;
    });
    return this.status();
  }

  cancel() {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  update(patch) {
    // After the optimizing steps the benchmark's own progress fills the rest of the bar.
    if (this.percentFrom && Number.isFinite(patch.percent) && patch.phase !== 'optimizing') {
      patch = { ...patch, percent: Math.round(this.percentFrom + (patch.percent * (100 - this.percentFrom)) / 100) };
    }
    this.progress = {
      ...(this.progress || {}),
      ...patch,
      at: new Date().toISOString(),
    };
    this.emit('benchmark:progress', this.progress);
  }

  /** One short, fixed reply with the model as it is loaded now: tokens written per second. */
  async measureSpeed(signal) {
    await this.llama.complete({ messages: [{ role: 'user', content: 'Reply with exactly: ready' }], maxTokens: 8, temperature: 0, signal });
    const completion = await this.llama.complete({
      messages: [{ role: 'user', content: 'Explain in plain prose, in about 150 words, how a bicycle stays upright while it moves.' }],
      maxTokens: 96,
      temperature: 0,
      signal,
    });
    const timings = completion.timings || {};
    const tokens = Number(timings.predicted_n || completion.usage?.completion_tokens || 0);
    return Number(timings.predicted_per_second) || (tokens && completion.elapsedMs ? tokens / (completion.elapsedMs / 1000) : 0);
  }

  /**
   * "Optimize and benchmark": loads the active model with one setting changed at a time, measures
   * each, saves the fastest combination in the model's own settings, and then runs the benchmark
   * with it. What is tried depends on the PC:
   * - a number of GPU layers set by hand against the automatic choice (a hand-set number left 19
   *   of 66 layers on the CPU of a PC whose three cards had room for all of them);
   * - with several graphics cards: all of them one after the other (layer) or at the same time
   *   (tensor), each kind of card alone when the model fits on it, and cards of the same kind
   *   together. Measured on an RTX 3060 with two Tesla P40: a 27B wrote 6.7 tok/s in layer mode
   *   and 9.0 in tensor mode, a 9B 22 shared between the three and 35 on the RTX 3060 alone;
   * - the number of CPU threads.
   * A change is kept only when it is at least 3% faster than what the model had. Nothing is saved
   * when the run is cancelled or fails.
   */
  async optimize({ signal }) {
    const model = await this.models.resolveActive();
    if (!model) throw new Error(t('No model is selected. Download one in Models first.'));
    if (!(await this.runtime.status()).installed) throw new Error(t('The llama.cpp runtime is not installed. Open Models to install it.'));
    const { sanitizeModelSettings, defaultThreads } = require('./modelSettings.cjs');
    const startedAt = Date.now();
    const overrides = { ...(this.store.getSettings().modelOverrides?.[model.id] || {}) };
    const effective = this.store.getEffectiveSettings(model.id);
    // The same batch size for every step: its tuning would otherwise change it between loads.
    const fixed = { batchTuning: 'off', ubatchSize: overrides.ubatchSize || 512 };
    const tried = [];
    let total = 4;
    const step = async (label, changes) => {
      if (signal.aborted) { const err = new Error('cancelled'); err.name = 'AbortError'; throw err; }
      const entry = { label, changes, tokensPerSecond: null, failed: false };
      tried.push(entry);
      total = Math.max(total, tried.length);
      this.update({
        phase: 'optimizing',
        message: t('Optimizing, step {0} of {1}: {2}', [tried.length, total, label]),
        percent: Math.min(78, Math.round(((tried.length - 1) / total) * 80) + 2),
        elapsedMs: Date.now() - startedAt,
        model: { id: model.id, name: model.name, quant: model.quant, size: model.size },
      });
      await this.llama.stop({ silent: true });
      this.llama.trialSettings = { ...fixed, ...changes };
      try {
        await this.llama.ensureServer(model);
        entry.tokensPerSecond = Math.round((await this.measureSpeed(signal)) * 100) / 100 || null;
      } catch (err) {
        if (err.name === 'AbortError' || signal.aborted) throw err;
        // A combination that does not load (not enough memory on a card, say) is only left out.
        entry.failed = true;
      }
      return entry;
    };
    const fastest = (entries, than) => entries
      .filter((entry) => entry.tokensPerSecond)
      .reduce((best, entry) => (entry.tokensPerSecond > best.tokensPerSecond * 1.03 ? entry : best), than);

    this.loadedModel = this.llama.status().running && this.llama.modelId === model.id ? '' : model.id;
    let best;
    try {
      const baseline = await step(t('Current settings'), {});
      if (!baseline.tokensPerSecond) throw new Error(t('The model did not load with its current settings, so there is nothing to compare with.'));
      best = baseline;
      const guessing = Boolean(this.llama.speculation);

      // How the model is placed: layers and graphics cards.
      const placement = [];
      const auto = overrides.gpuLayers !== undefined ? { gpuLayers: null } : {};
      if (overrides.gpuLayers !== undefined) placement.push([t('GPU layers chosen by Uma'), auto]);
      const cards = this.llama.cards.all || [];
      const helpers = this.llama.status().helpers?.servers?.length > 0;
      if (cards.length > 1 && !helpers) {
        const short = (name) => String(name || '').replace(/^NVIDIA\s+(GeForce\s+)?/i, '');
        const needMB = (this.llama.needMB || 0) + (this.llama.draft?.memoryMB || 0);
        const everything = { ...auto, gpuCards: null };
        const tensorNow = effective.splitMode === 'tensor';
        if (effective.gpuCards) placement.push([t('All cards, one after the other'), { ...everything, splitMode: null }]);
        placement.push(tensorNow && !effective.gpuCards
          ? [t('All cards, one after the other'), { ...everything, splitMode: null }]
          : [t('All cards at the same time'), { ...everything, splitMode: 'tensor' }]);
        const kinds = new Map();
        for (const device of cards) kinds.set(device.card, [...(kinds.get(device.card) || []), device]);
        for (const [card, group] of kinds) {
          // One card of this kind alone: the one with the most free memory.
          const roomiest = [...group].sort((a, b) => b.freeMB - a.freeMB)[0];
          if (needMB && needMB <= roomiest.freeMB * 0.92 && effective.gpuCards !== roomiest.name) {
            placement.push([t('{0} alone', [short(card)]), { ...auto, gpuCards: roomiest.name, splitMode: null }]);
          }
          const room = group.reduce((sum, device) => sum + device.freeMB, 0);
          if (group.length > 1 && group.length < cards.length && needMB && needMB <= room * 0.85) {
            const names = group.map((device) => device.name).join(',');
            const title = `${group.length}× ${short(card)}`;
            placement.push([t('{0}, one after the other', [title]), { ...auto, gpuCards: names, splitMode: null }]);
            placement.push([t('{0} at the same time', [title]), { ...auto, gpuCards: names, splitMode: 'tensor' }]);
          }
        }
      }
      total = 1 + placement.length + 3;
      const placed = [];
      for (const [label, changes] of placement) placed.push(await step(label, changes));
      best = fastest(placed, best);

      // CPU threads, on top of the best placement: they matter most when part of the model is in RAM.
      const logical = os.cpus().length;
      const now = Number(effective.threads) || defaultThreads();
      const counts = [...new Set([Math.max(1, Math.floor(logical / 2)), Math.min(8, logical)])].filter((count) => count !== now);
      total = tried.length + counts.length + 1;
      const threaded = [];
      for (const count of counts) threaded.push(await step(t('{0} CPU threads', [count]), { ...best.changes, threads: count }));
      best = fastest(threaded, best);

      // Guessing ahead (the model's own MTP head, n-gram): on by default, kept only when not slower.
      const guessed = [];
      if (guessing) guessed.push(await step(t('Without guessing ahead'), { ...best.changes, mtp: 'off', ngram: 'off' }));
      else if (effective.mtp === 'off' || effective.ngram === 'off') guessed.push(await step(t('With guessing ahead'), { ...best.changes, mtp: null, ngram: null }));
      best = fastest(guessed, best);
    } catch (err) {
      this.llama.trialSettings = null;
      await this.llama.stop({ silent: true }).catch(() => {});
      throw err;
    }
    this.llama.trialSettings = null;
    await this.llama.stop({ silent: true });

    const next = { ...overrides };
    for (const [key, value] of Object.entries(best.changes)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    const changed = JSON.stringify(next) !== JSON.stringify(overrides);
    if (changed) {
      await this.store.setModelOverrides(model.id, sanitizeModelSettings(next));
      this.emit('settings:changed');
    }
    this.percentFrom = 80;
    return this.execute({
      signal,
      optimization: {
        changed,
        chosen: best.label,
        tried: tried.map((entry) => ({ label: entry.label, tokensPerSecond: entry.tokensPerSecond, failed: entry.failed, chosen: entry === best })),
      },
    });
  }

  async execute({ signal, optimization = null }) {
    const model = await this.models.resolveActive();
    if (!model) throw new Error(t('No model is selected. Download one in Models first.'));
    const runtimeStatus = await this.runtime.status();
    if (!runtimeStatus.installed) throw new Error(t('The llama.cpp runtime is not installed. Open Models to install it.'));

    const totalStart = Date.now();
    const systemTotalGB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
    const systemUsedBeforeGB = Math.round(((os.totalmem() - os.freemem()) / 1024 ** 3) * 10) / 10;
    const wasReady = this.llama.status().running && this.llama.modelId === model.id;
    // A model the benchmark loaded itself is unloaded again when the Benchmark screen closes.
    this.loadedModel = wasReady ? '' : model.id;

    this.update({
      phase: 'loading',
      message: wasReady ? t('Model is already warm. Preparing the test…') : t('Loading the model into memory…'),
      percent: 5,
      model: { id: model.id, name: model.name, quant: model.quant, size: model.size },
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
    });

    const loadStart = Date.now();
    await this.llama.ensureServer(model);
    const loadMs = wasReady ? 0 : Date.now() - loadStart;
    const device = this.llama.computeInfo();
    const pid = this.llama.status().pid;

    this.update({
      phase: 'warming',
      message: t('Warming the cache with a tiny prompt…'),
      percent: 18,
      elapsedMs: Date.now() - totalStart,
      loadMs,
      device,
    });

    const warmMessages = [
      { role: 'system', content: 'You are a local benchmark. Reply briefly.' },
      { role: 'user', content: 'Reply with exactly: ready' },
    ];
    const warmStart = Date.now();
    await this.llama.complete({ messages: warmMessages, maxTokens: 8, temperature: 0, signal });
    const warmupMs = Date.now() - warmStart;

    this.update({
      phase: 'probing',
      message: t('Measuring first-token latency…'),
      percent: 26,
      elapsedMs: Date.now() - totalStart,
      warmupMs,
    });
    const firstTokenMs = await this.llama.firstTokenLatency({
      messages: [
        { role: 'system', content: 'You are a local benchmark. Follow the instruction exactly.' },
        { role: 'user', content: 'Write one short sentence about a river.' },
      ],
      signal,
    }).catch(() => null);

    const samples = [];
    let sampling = false;
    this.acceptSamples = true;
    let previous = await sampleProcess(pid);
    let previousAt = Date.now();
    const sampleOnce = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const now = Date.now();
        const currentProcess = await sampleProcess(pid);
        const gpu = await sampleGpu();
        const systemUsedGB = Math.round(((os.totalmem() - os.freemem()) / 1024 ** 3) * 10) / 10;
        let cpuPercent = null;
        let coresUsed = null;
        if (previous && currentProcess) {
          const elapsedSeconds = Math.max(0.05, (now - previousAt) / 1000);
          const cpuDelta = currentProcess.cpuSeconds - previous.cpuSeconds;
          coresUsed = Math.max(0, cpuDelta / elapsedSeconds);
          cpuPercent = Math.max(0, (cpuDelta / elapsedSeconds / os.cpus().length) * 100);
        }
        if (currentProcess) {
          previous = currentProcess;
          previousAt = now;
        }
        const sample = {
          at: new Date().toISOString(),
          cpuPercent: cpuPercent == null ? null : Math.round(cpuPercent * 10) / 10,
          coresUsed: coresUsed == null ? null : Math.round(coresUsed * 100) / 100,
          processMB: currentProcess?.workingSetMB ?? null,
          privateMB: currentProcess?.privateMB ?? null,
          systemUsedGB,
          gpuUtil: gpu?.utilization ?? null,
          vramUsedMB: gpu?.memoryUsedMB ?? null,
          // The cards this model is on come first: with some cards left out, they are not all of the PC's.
          gpuName: device.gpuName || gpu?.name || '',
        };
        if (!this.acceptSamples) return;
        samples.push(sample);
        this.update({
          phase: 'measuring',
          message: t('Generating a fixed 128-token response…'),
          percent: 32 + Math.min(62, samples.length * 4),
          elapsedMs: Date.now() - totalStart,
          sample,
          device,
        });
      } finally {
        sampling = false;
      }
    };

    this.update({
      phase: 'measuring',
      message: t('Generating a fixed 128-token response…'),
      percent: 30,
      elapsedMs: Date.now() - totalStart,
      device,
    });

    const sampler = setInterval(() => { sampleOnce().catch(() => {}); }, 700);
    sampleOnce().catch(() => {});
    const benchMessages = [
      {
        role: 'system',
        content: 'You are a precise local AI benchmark. Follow the requested length and format exactly. Do not use markdown or lists.',
      },
      {
        role: 'user',
        content: 'Write a clear, information-dense explanation of how a city water system works, from reservoir to tap, in about 180 words. Plain prose only.',
      },
    ];

    let completion;
    try {
      completion = await this.llama.complete({
        messages: benchMessages,
        maxTokens: 128,
        temperature: 0.2,
        signal,
      });
    } finally {
      clearInterval(sampler);
      await sampleOnce().catch(() => {});
      this.acceptSamples = false;
    }

    const timings = completion.timings || {};
    const usage = completion.usage || {};
    const generationTokens = Number(timings.predicted_n || usage.completion_tokens || 0);
    const promptTokens = Number(timings.prompt_n || usage.prompt_tokens || 0);
    const tokensPerSecond = Number(timings.predicted_per_second)
      || (generationTokens && timings.predicted_ms ? generationTokens / (timings.predicted_ms / 1000) : null)
      || (completion.elapsedMs ? generationTokens / (completion.elapsedMs / 1000) : null);
    const promptTokensPerSecond = Number(timings.prompt_per_second)
      || (promptTokens && timings.prompt_ms ? promptTokens / (timings.prompt_ms / 1000) : null);
    const processMemories = samples.map((sample) => sample.processMB).filter((value) => Number.isFinite(value));
    const cpuValues = samples.map((sample) => sample.cpuPercent).filter((value) => Number.isFinite(value));
    const coreValues = samples.map((sample) => sample.coresUsed).filter((value) => Number.isFinite(value));
    const gpuValues = samples.map((sample) => sample.gpuUtil).filter((value) => Number.isFinite(value));
    const vramValues = samples.map((sample) => sample.vramUsedMB).filter((value) => Number.isFinite(value));
    const systemPeak = Math.max(systemUsedBeforeGB, ...samples.map((sample) => sample.systemUsedGB || 0));
    const gpuInfo = device.gpuName || samples.find((sample) => sample.gpuName)?.gpuName || '';

    const result = {
      id: newId('bench_'),
      createdAt: new Date().toISOString(),
      model: {
        id: model.id,
        name: model.name,
        quant: model.quant || 'GGUF',
        size: model.size,
        sizeLabel: model.sizeLabel,
      },
      device: {
        mode: device.mode,
        backend: device.backend,
        gpuName: gpuInfo,
        offloadedLayers: device.offloadedLayers,
        totalLayers: device.totalLayers,
        detail: device.detail,
        gpuUtilAvg: device.mode === 'GPU' ? average(gpuValues) : null,
        gpuUtilPeak: device.mode === 'GPU' && gpuValues.length ? Math.max(...gpuValues) : null,
        vramUsedPeakMB: device.mode === 'GPU' && vramValues.length ? Math.max(...vramValues) : null,
      },
      speed: {
        tokensPerSecond: tokensPerSecond ? Math.round(tokensPerSecond * 100) / 100 : null,
        promptTokensPerSecond: promptTokensPerSecond ? Math.round(promptTokensPerSecond * 100) / 100 : null,
        firstTokenMs: firstTokenMs || (timings.prompt_ms ? Math.round(timings.prompt_ms) : null),
        generationTokens,
        promptTokens,
        totalMs: completion.elapsedMs,
        promptMs: timings.prompt_ms || null,
        loadMs,
        warmupMs,
        maxTokens: 128,
        contextSize: Number(this.store.getEffectiveSettings(this.llama.modelId).contextSize || 8192),
      },
      memory: {
        processPeakMB: processMemories.length ? Math.max(...processMemories) : null,
        processAvgMB: processMemories.length ? Math.round(average(processMemories)) : null,
        cpuAvgPercent: cpuValues.length ? Math.round(average(cpuValues) * 10) / 10 : null,
        cpuPeakPercent: cpuValues.length ? Math.round(Math.max(...cpuValues) * 10) / 10 : null,
        coresUsedAvg: coreValues.length ? Math.round(average(coreValues) * 100) / 100 : null,
        systemPeakGB: Math.round(systemPeak * 10) / 10,
        systemTotalGB,
        systemBeforeGB: systemUsedBeforeGB,
      },
      samples: samples.slice(-120),
      // After "Optimize and benchmark": what was tried, and which one this model now uses.
      ...(optimization ? { optimization } : {}),
    };

    this.update({
      phase: 'done',
      message: t('Benchmark complete.'),
      percent: 100,
      elapsedMs: Date.now() - totalStart,
      result,
      device,
    });
    await this.store.addBenchmark(result);
    this.emit('benchmark:history', this.store.getBenchmarks());
    this.update({ phase: 'done', result, history: this.store.getBenchmarks() });
    return result;
  }
}

module.exports = { BenchmarkManager, sampleProcess, sampleGpu };
