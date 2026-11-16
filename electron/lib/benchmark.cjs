const os = require('node:os');
const { execFile } = require('node:child_process');
const { newId } = require('./util.cjs');
const { queryAppleGpu } = require('./systemStats.cjs');
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
  const data = await new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error ? '' : String(stdout || '').trim()),
    );
  });
  if (!data) return null;
  const [name, util, used, total] = data.split(/\r?\n/)[0].split(',').map((part) => part.trim());
  return {
    name,
    utilization: Number(util) || 0,
    memoryUsedMB: Number(used) || 0,
    memoryTotalMB: Number(total) || 0,
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
    this.current = this.execute({ ...options, signal: controller.signal }).catch((err) => {
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
    this.progress = {
      ...(this.progress || {}),
      ...patch,
      at: new Date().toISOString(),
    };
    this.emit('benchmark:progress', this.progress);
  }

  async execute({ signal }) {
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
          gpuName: gpu?.name || device.gpuName || '',
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
    const gpuInfo = samples.find((sample) => sample.gpuName)?.gpuName || device.gpuName || '';

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
