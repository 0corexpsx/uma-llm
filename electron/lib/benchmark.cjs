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

  /**
   * How the model does as it is loaded now, in tokens per second: writing prose, writing new
   * code, and reading a text of about 1,300 tokens it has not seen (`seed` makes it new each time).
   * `write` is the mean of the two kinds of writing, and is what decides between settings: guessing
   * ahead keeps more of its guesses in prose than in code, and Uma is used for both.
   */
  async measure(signal, seed) {
    const say = (content, maxTokens) => this.llama.complete({ messages: [{ role: 'user', content }], maxTokens, temperature: 0, signal });
    const speed = (completion) => {
      const timings = completion.timings || {};
      const tokens = Number(timings.predicted_n || completion.usage?.completion_tokens || 0);
      return Number(timings.predicted_per_second) || (tokens && completion.elapsedMs ? tokens / (completion.elapsedMs / 1000) : 0);
    };
    await say('Reply with exactly: ready', 8);
    const prose = speed(await say('Explain in plain prose, in about 150 words, how a bicycle stays upright while it moves.', 96));
    const code = speed(await say('Write a C++ class TaskList for a to-do program: add a task with a title and a due date, mark one done, remove one, and list the open tasks sorted by date. Code only, with short comments.', 96));
    const text = Array.from({ length: 38 }, (_, index) => `Entry ${seed}-${index}: the workshop ledger notes the date, the owner, the fault that was found, the part that was changed and how long the work took.`).join(' ');
    const reading = (await say(`${text}\nIn one word, what is this text about?`, 1)).timings || {};
    const round = (value) => Math.round(value * 100) / 100 || null;
    return {
      prose: round(prose),
      code: round(code),
      write: round(prose && code ? (prose + code) / 2 : prose || code),
      read: Number(reading.prompt_n) >= 400 ? Math.round(Number(reading.prompt_per_second) || 0) || null : null,
    };
  }

  /**
   * "Optimize and benchmark": loads the active model with one thing changed at a time, measures
   * each (see measure), saves what was clearly faster in the model's own settings, and then runs
   * the benchmark with it. The plans and the rules for keeping a result are in optimizer.cjs:
   * - where the model goes: GPU layers set by hand against Uma's choice, and with several
   *   graphics cards which of them take part and whether they work at the same time;
   * - the number of CPU threads, when part of the model runs on the CPU;
   * - guessing ahead on or off;
   * - a larger context, when it fits on the cards and the model writes no slower with it.
   * A faster setting is kept when it writes at least 3% faster than what the model had. Nothing is
   * saved when the run is cancelled or fails.
   */
  async optimize({ signal }) {
    const model = await this.models.resolveActive();
    if (!model) throw new Error(t('No model is selected. Download one in Models first.'));
    if (!(await this.runtime.status()).installed) throw new Error(t('The llama.cpp runtime is not installed. Open Models to install it.'));
    const { sanitizeModelSettings, defaultThreads, DEFAULTS } = require('./modelSettings.cjs');
    const { placementSteps, skipStep, threadCounts, fastest, contextTarget, keepContext } = require('./optimizer.cjs');
    const { chosenCards } = require('./placement.cjs');
    const { estimateMemory } = require('./memory.cjs');
    const MiB = 1024 * 1024;
    const startedAt = Date.now();
    const overrides = { ...(this.store.getSettings().modelOverrides?.[model.id] || {}) };
    const effective = this.store.getEffectiveSettings(model.id);
    // The same batch size for every step: its tuning would otherwise change it between loads.
    const fixed = { batchTuning: 'off', ubatchSize: overrides.ubatchSize || 512 };
    const tried = [];
    const kept = [];
    let total = 4;
    // The most free memory on one graphics card with no model loaded, for a PC with one card.
    let freeBeforeMB = 0;
    const step = async (label, changes) => {
      if (signal.aborted) { const err = new Error('cancelled'); err.name = 'AbortError'; throw err; }
      const entry = { label, changes, write: null, read: null, failed: false, allOnGpu: null };
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
      if (tried.length === 1) freeBeforeMB = Math.round((await Promise.resolve(this.llama.freeVram?.()).catch(() => 0) || 0) / MiB);
      this.llama.trialSettings = { ...fixed, ...changes };
      try {
        await this.llama.ensureServer(model);
        Object.assign(entry, await this.measure(signal, tried.length));
        const device = this.llama.computeInfo?.() || {};
        entry.allOnGpu = device.totalLayers ? device.offloadedLayers >= device.totalLayers : null;
      } catch (err) {
        if (err.name === 'AbortError' || signal.aborted) throw err;
        // A combination that does not load (not enough memory on a card, say) is only left out.
        entry.failed = true;
      }
      return entry;
    };
    // The best so far, and a note of each step that became it.
    let best;
    const adopt = (entry) => {
      if (entry !== best) kept.push(entry);
      best = entry;
    };
    const applied = (changes) => {
      const settings = { ...effective };
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete settings[key];
        else settings[key] = value;
      }
      return settings;
    };

    this.loadedModel = this.llama.status().running && this.llama.modelId === model.id ? '' : model.id;
    try {
      const baseline = await step(t('Current settings'), {});
      if (!baseline.write) throw new Error(t('The model did not load with its current settings, so there is nothing to compare with.'));
      best = baseline;
      const guessing = Boolean(this.llama.speculation);
      const cards = this.llama.cards?.all || [];
      const helpers = this.llama.status().helpers?.servers?.length > 0;
      const needMB = (this.llama.needMB || 0) + (this.llama.draft?.memoryMB || 0);

      // Where the model goes: GPU layers and graphics cards.
      const placement = placementSteps({ cards, needMB, overrides, effective, helpers });
      total = 1 + placement.length + 2;
      // What all the cards together showed, each way of sharing: the baseline counts when it is one of them.
      const usesAll = !chosenCards(cards, effective.gpuCards).length;
      const allSpeeds = usesAll && cards.length > 1 && overrides.gpuLayers === undefined ? { [effective.splitMode === 'tensor' ? 'tensor' : 'layer']: baseline.write } : {};
      const placed = [];
      for (const plan of placement) {
        if (skipStep(plan, allSpeeds)) { total -= 1; continue; }
        const entry = await step(plan.label, plan.changes);
        if (plan.all && plan.split && entry.write) allSpeeds[plan.split] = entry.write;
        placed.push(entry);
      }
      adopt(fastest(placed, best));

      // CPU threads, on top of the best placement, when part of the model runs on the CPU.
      const counts = threadCounts({ logical: os.cpus().length, now: Number(effective.threads) || defaultThreads(), allOnGpu: best.allOnGpu === true });
      total = tried.length + counts.length + 2;
      const threaded = [];
      for (const count of counts) threaded.push(await step(t('{0} CPU threads', [count]), { ...best.changes, threads: count }));
      adopt(fastest(threaded, best));

      // Guessing ahead (the model's own MTP head, n-gram): on by default, kept only when not slower.
      const guessed = [];
      if (guessing) guessed.push(await step(t('Without guessing ahead'), { ...best.changes, mtp: 'off', ngram: 'off' }));
      else if (effective.mtp === 'off' || effective.ngram === 'off') guessed.push(await step(t('With guessing ahead'), { ...best.changes, mtp: null, ngram: null }));
      adopt(fastest(guessed, best));

      // A larger context, when every layer is on the cards and stays there with it.
      const info = await Promise.resolve(this.models.modelInfo?.(model.id)).catch(() => null);
      const using = chosenCards(cards, applied(best.changes).gpuCards);
      const inUse = using.length ? using : cards;
      const roomMB = inUse.length > 1 ? inUse.reduce((sum, device) => sum + device.freeMB, 0) * 0.85 : (inUse[0]?.freeMB || freeBeforeMB) * 0.92;
      const wantMB = (size) => (info ? Math.ceil(estimateMemory(info, { ...DEFAULTS, ...applied(best.changes), contextSize: size, gpuLayers: 999 }).gpuBytes / MiB) || 0 : 0);
      const current = Number(applied(best.changes).contextSize) || 8192;
      const target = best.allOnGpu === true && roomMB > 0
        ? contextTarget({ current, trained: info?.contextLength || 0, fits: (size) => wantMB(size) > 0 && wantMB(size) + 700 * Math.max(1, inUse.length) + (this.llama.draft?.memoryMB || 0) <= roomMB })
        : 0;
      total = tried.length + (target ? 1 : 0);
      if (target) {
        const larger = await step(t('Context of {0} tokens', [target.toLocaleString('en-US')]), { ...best.changes, contextSize: target });
        if (keepContext(larger, best)) adopt(larger);
      }
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
        kept: changed ? kept.map((entry) => entry.label) : [],
        tried: tried.map((entry) => ({ label: entry.label, write: entry.write, prose: entry.prose ?? null, code: entry.code ?? null, read: entry.read, failed: entry.failed, kept: changed && kept.includes(entry) })),
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
