// Estimates what a model will use once loaded, from its real tensor sizes and the chosen settings.
const { t } = require('./i18n.cjs');

/** Bytes per KV cache element. Block-quantized types store a small block per 32 elements. */
const CACHE_BYTES = {
  f32: 4, f16: 2, bf16: 2, q8_0: 1 + 2 / 32, q4_0: 0.5 + 2 / 32, q4_1: 0.5 + 4 / 32, iq4_nl: 0.5 + 2 / 32, q5_0: 0.625 + 2 / 32, q5_1: 0.625 + 4 / 32,
};

const MiB = 1024 * 1024;

/**
 * With no layer count set, the engine fits as many layers as free VRAM allows, so estimate that.
 */
function estimateMemory(info, settings, hardware = {}) {
  const unset = settings.gpuLayers === undefined || settings.gpuLayers === null || settings.gpuLayers === '';
  if (!unset) return estimateFor(info, settings, hardware);
  const full = estimateFor(info, { ...settings, gpuLayers: 999 }, hardware);
  const deviceBytes = ((Number(hardware.vramGB) || 0) + (Number(hardware.helperGB) || 0)) * 1024 * MiB;
  const needsFewer = full.fit === 'too-big' && full.gpuBytes > deviceBytes - 768 * MiB;
  const result = needsFewer && full.suggestedLayers ? estimateFor(info, { ...settings, gpuLayers: full.suggestedLayers }, hardware) : full;
  return { ...result, autoLayers: true };
}

function estimateFor(info, settings, hardware) {
  const contextSize = Number(settings.contextSize) || info.contextLength || 8192;
  const gpuOn = settings.gpuOffload !== false && settings.backend !== 'cpu';
  const requested = Number(settings.gpuLayers);
  // llama.cpp counts the output layer too, so a model with N blocks has N + 1 offloadable layers.
  const maxLayers = info.nLayer + 1;
  const gpuLayers = gpuOn ? Math.max(0, Math.min(maxLayers, requested)) : 0;
  const blocksOnGpu = Math.max(0, gpuLayers - 1);
  const allOnGpu = gpuLayers >= maxLayers;

  const layerBytes = info.layerBytes.length
    ? info.layerBytes
    : Array.from({ length: info.nLayer }, () => info.totalBytes / Math.max(1, info.nLayer));
  // llama.cpp offloads the last layers first, so the first ones are what stays in system RAM.
  const cpuLayerCount = info.nLayer - blocksOnGpu;
  const onCpu = layerBytes.slice(0, cpuLayerCount).reduce((sum, bytes) => sum + bytes, 0);
  const onGpu = layerBytes.slice(cpuLayerCount).reduce((sum, bytes) => sum + bytes, 0);
  const weightsGpu = onGpu + (gpuLayers > 0 ? info.otherBytes : 0);
  const weightsCpu = onCpu + (gpuLayers > 0 ? 0 : info.otherBytes) + info.inputBytes;

  // Each layer caches a key and a value per head for every position in the context.
  const heads = info.nHeadKv || info.nHead || 1;
  const elementsK = contextSize * info.attentionLayers * (info.keyLength || 0) * heads;
  const elementsV = contextSize * info.attentionLayers * (info.valueLength || 0) * heads;
  const cacheK = elementsK * (CACHE_BYTES[settings.cacheTypeK] || CACHE_BYTES.f16);
  const cacheV = elementsV * (CACHE_BYTES[settings.cacheTypeV] || CACHE_BYTES.f16);
  const kvBytes = cacheK + cacheV + (info.hasStateMemory ? 150 * MiB : 0);
  const kvGpu = kvBytes * (blocksOnGpu / Math.max(1, info.nLayer));
  const kvCpu = kvBytes - kvGpu;

  // Working buffers: fitted to real loads, 112-240 MiB across 8k-32k contexts and batch sizes.
  const ubatch = Number(settings.ubatchSize) || 512;
  const work = ubatch * info.nEmbd * 60 + contextSize * 2500;
  const workGpu = gpuLayers ? work : 0;
  const workCpu = (64 * MiB) + (gpuLayers ? 0 : work);

  // A vision file loads whole, onto the GPU whenever any of the model is there.
  const visionBytes = Number(info.mmprojBytes) || 0;
  const gpuBytes = weightsGpu + kvGpu + workGpu + (gpuLayers ? visionBytes : 0);
  const cpuBytes = weightsCpu + kvCpu + workCpu + (gpuLayers ? 0 : visionBytes);
  const totalBytes = gpuBytes + cpuBytes;

  const vramBytes = (Number(hardware.vramGB) || 0) * 1024 * MiB;
  const ramBytes = (Number(hardware.ramGB) || 0) * 1024 * MiB;
  // Memory the helper PCs reported free at their last test; layers placed there count as GPU layers.
  const helperBytes = (Number(hardware.helperGB) || 0) * 1024 * MiB;
  // Windows and the desktop keep roughly 450 MiB of VRAM (measured) and a few GB of RAM.
  const localVram = Math.max(0, vramBytes - 768 * MiB);
  const usableVram = localVram + helperBytes;
  const usableRam = Math.max(0, ramBytes - 3 * 1024 * MiB);
  let fit = 'unknown';
  let message = '';
  if (vramBytes || ramBytes) {
    if (cpuBytes > usableRam && ramBytes) {
      fit = 'too-big';
      message = t('Likely too large for this PC: it needs more system RAM than is free.');
    } else if (gpuBytes > usableVram && gpuLayers) {
      fit = 'too-big';
      message = t('Likely too large for your GPU. Lower Context Length or GPU Offload.');
    } else if (gpuLayers && !allOnGpu) {
      fit = 'partial';
      message = t('Fits, but the layers left on the CPU will make it much slower.');
    } else if (!gpuLayers) {
      fit = 'cpu';
      message = t('Runs on the CPU only, so expect it to be slow.');
    } else if (gpuBytes > localVram) {
      fit = 'good';
      message = t('Fits across this PC and your helper PCs. Expect it to be slower than on one GPU, because each token crosses the network.');
    } else {
      fit = 'good';
      message = t('Should fit entirely on your GPU.');
    }
  }

  // The most layers that fit, for a "best GPU offload" suggestion.
  let suggestedLayers = 0;
  if (usableVram) {
    let used = work + info.otherBytes + visionBytes;
    if (used <= usableVram) {
      suggestedLayers = 1;
      for (let index = layerBytes.length - 1; index >= 0; index -= 1) {
        const next = used + layerBytes[index] + kvBytes / Math.max(1, info.nLayer);
        if (next > usableVram) break;
        used = next;
        suggestedLayers += 1;
      }
    }
  }

  return {
    gpuBytes,
    cpuBytes,
    totalBytes,
    weightsGpu,
    weightsCpu,
    kvBytes,
    gpuLayers,
    maxLayers,
    nLayer: info.nLayer,
    contextSize,
    fit,
    message,
    suggestedLayers,
  };
}

module.exports = { estimateMemory, CACHE_BYTES };
