const os = require('node:os');
const { t } = require('./i18n.cjs');

const CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'];

/** Every setting a model can override. Anything not listed here is dropped when saving. */
const FIELDS = {
  contextSize: { type: 'int', min: 512, max: 4194304 },
  gpuLayers: { type: 'int', min: 0, max: 9999 },
  threads: { type: 'int', min: 0, max: 512 },
  threadsBatch: { type: 'int', min: 0, max: 512 },
  batchSize: { type: 'int', min: 1, max: 131072 },
  ubatchSize: { type: 'int', min: 1, max: 131072 },
  parallel: { type: 'int', min: 1, max: 64 },
  ctxCheckpoints: { type: 'int', min: 0, max: 1024 },
  reasoningBudget: { type: 'int', min: -1, max: 1048576 },
  idleMinutes: { type: 'int', min: 0, max: 10080 },
  seed: { type: 'int', min: -1, max: 4294967295 },
  topK: { type: 'int', min: 0, max: 100000 },
  temperature: { type: 'number', min: 0, max: 5 },
  topP: { type: 'number', min: 0, max: 1 },
  minP: { type: 'number', min: 0, max: 1 },
  repeatPenalty: { type: 'number', min: 0, max: 5 },
  kvUnified: { type: 'boolean' },
  flashAttn: { type: 'enum', values: ['auto', 'on', 'off'] },
  cacheTypeK: { type: 'enum', values: CACHE_TYPES },
  cacheTypeV: { type: 'enum', values: CACHE_TYPES },
  // mmap+mlock keeps the part of the model that is not on a GPU in RAM, so the system cannot push it out between messages.
  loadMode: { type: 'enum', values: ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock'] },
  moeCache: { type: 'enum', values: ['auto', 'off'] },
  batchTuning: { type: 'enum', values: ['auto', 'off'] },
  extraArgs: { type: 'string', max: 2000 },
  reasoningBudgetMessage: { type: 'text', max: 2000 },
  // A small model of the same family that guesses the next words for this one (speculative decoding).
  draftModelId: { type: 'text', max: 400 },
  draftTokens: { type: 'int', min: 1, max: 16 },
};

/** What Uma uses when a model has no override of its own. GPU layers are automatic unless set. */
const DEFAULTS = {
  threads: 0,
  threadsBatch: 0,
  batchSize: 2048,
  ubatchSize: 512,
  parallel: 1,
  // Snapshots of a hybrid model's state (Qwen3.5/3.8): 8 keep retries, tool steps and the skill step
  // fast (measured the same as 32), and cap the RAM and chat memory they use (150 MB each on a 27B).
  ctxCheckpoints: 8,
  reasoningBudget: -1,
  idleMinutes: 30,
  seed: -1,
  topK: 40,
  minP: 0.05,
  repeatPenalty: 1,
  kvUnified: false,
  flashAttn: 'auto',
  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',
  loadMode: 'auto',
  // Mixture-of-experts models that do not fit: experts in RAM, the most used ones cached on the GPU.
  moeCache: 'auto',
  // Uma picks the physical batch size from measured reading speeds (batchTuner.cjs).
  batchTuning: 'auto',
  extraArgs: '',
  reasoningBudgetMessage: '',
  draftModelId: '',
  draftTokens: 6,
};

/** Flags Uma must control itself: where it listens, its key, and which files it opens. */
const RESERVED_FLAGS = new Set([
  '-m', '--model', '-mu', '--model-url', '-hf', '--hf-repo', '-hff', '--hf-file', '-hft', '--hf-token', '-dr', '--docker-repo',
  '--host', '--port', '--api-key', '--api-key-file', '--path', '--api-prefix', '--ssl-key-file', '--ssl-cert-file', '--webui', '--no-webui',
  '--webui-config', '--webui-config-file', '--log-file', '--models-dir', '--models-preset', '--mmproj', '--mmproj-url', '-mm', '-mmu', '--tools',
  '--slot-save-path', '--media-path', '--lora', '--control-vector', '-lv', '--verbosity', '--log-verbosity', '--rpc',
  '-md', '--model-draft', '--spec-draft-model', '-devd', '--device-draft', '--spec-draft-device',
]);

function parseExtraArgs(text) {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of String(text || '').matchAll(pattern)) args.push(match[1] ?? match[2] ?? match[3]);
  const reserved = args.find((arg) => RESERVED_FLAGS.has(arg.split('=')[0]));
  if (reserved) throw new Error(t('{0} cannot be set here, because Uma manages it.', [reserved.split('=')[0]]));
  return args;
}

/** Keeps only known fields with valid values. Throws, naming the field, on a bad value. */
function sanitizeModelSettings(raw) {
  const clean = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const field = FIELDS[key];
    if (!field || value === undefined || value === null || value === '') continue;
    if (field.type === 'int' || field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number) || number < field.min || number > field.max || (field.type === 'int' && !Number.isInteger(number))) {
        throw new Error(t('{0} must be {1} from {2} to {3}.', [key, field.type === 'int' ? 'a whole number' : 'a number', field.min, field.max]));
      }
      clean[key] = number;
    } else if (field.type === 'boolean') {
      clean[key] = Boolean(value);
    } else if (field.type === 'enum') {
      if (!field.values.includes(value)) throw new Error(t('{0} must be one of: {1}.', [key, field.values.join(', ')]));
      clean[key] = value;
    } else {
      const text = String(value).trim();
      if (text.length > field.max) throw new Error(t('{0} is too long.', [key]));
      if (field.type === 'string') parseExtraArgs(text);
      if (text) clean[key] = text;
    }
  }
  return clean;
}

function defaultThreads() {
  return Math.max(2, Math.min(12, Math.floor(os.cpus().length / 2)));
}

/** Everything about how the server runs, except the port and key that change each start. */
function buildServerArgs(modelPath, settings, backend, { allLayers = false, mmproj = '', placement = null, extraFitMB = 0, moeCache = null } = {}) {
  const s = { ...DEFAULTS, ...settings };
  // A placement plan means helper PCs take layers, even when this PC itself runs on the CPU.
  const offload = settings.gpuOffload !== false && (backend !== 'cpu' || placement);
  // With the MoE cache every layer goes to the GPU and only the routed experts stay in RAM.
  const gpuLayers = offload ? (s.gpuLayers ?? (allLayers || moeCache ? 'all' : 'auto')) : 0;
  const args = [
    '-m', modelPath,
    '-c', String(s.contextSize || 8192),
    '--parallel', String(s.parallel),
    '-ngl', String(gpuLayers),
    '-t', String(s.threads || defaultThreads()),
    '-b', String(s.batchSize),
    '-ub', String(s.ubatchSize),
    '-ctk', s.cacheTypeK,
    '-ctv', s.cacheTypeV,
    '-fa', s.flashAttn,
    '-ctxcp', String(s.ctxCheckpoints),
    '--jinja',
    '-lv', '4',
  ];
  // extraFitMB leaves room on the GPUs for a draft model that runs beside this one.
  if (gpuLayers === 'auto') args.push(...(placement?.length ? placement : ['--fit-target', String(300 + Math.round(extraFitMB))]));
  if (moeCache && offload) args.push('-cmoe', '--moe-cache-mib', String(moeCache.mib), '--moe-cache-cpu-share', String(moeCache.share));
  if (mmproj) args.push('--mmproj', mmproj);
  if (s.threadsBatch) args.push('-tb', String(s.threadsBatch));
  if (s.kvUnified) args.push('--kv-unified');
  if (s.loadMode !== 'auto') args.push('--load-mode', s.loadMode);
  if (s.reasoningBudget >= 0) args.push('--reasoning-budget', String(s.reasoningBudget));
  if (s.reasoningBudgetMessage) args.push('--reasoning-budget-message', s.reasoningBudgetMessage);
  args.push(...parseExtraArgs(s.extraArgs));
  return args;
}

/**
 * Cache types the GPUs cannot use, changed to q4_0, which takes the same memory, with the reason.
 *
 * llama.cpp's NVIDIA (CUDA) code has two gaps with an iq4_nl cache (b12102, still in b12212):
 * - flash attention has no iq4_nl kernel at all (fattn.cu: GGML_ABORT "fatal error"). Alone,
 *   llama.cpp checks this and turns flash attention off; with helper PCs it cannot, because the RPC
 *   backend reports every operation as supported, so a helper's GPU stops mid-load;
 * - models with a sparse-attention "indexer" (qwen4exp, DeepSeek V3.2 and GLM-5 style) keep an extra
 *   key cache of the K type and read rows of it with get_rows, through views whose rows are not a
 *   multiple of 256 values, which CUDA's iq4_nl get_rows rejects (getrows.cu: ne00 % QK_K == 0).
 * K and V change together: CUDA flash attention has no kernel for q4_0 keys with iq4_nl values.
 * Seen with Qwen3.8-Flash-Next on a laptop helper (RTX 2070), 2026-11-09.
 */
function cacheTypeFixes(settings, info = null, { helpers = false } = {}) {
  const s = { ...DEFAULTS, ...settings };
  const indexer = info?.indexerHeads > 0;
  const unsafe = s.cacheTypeK === 'iq4_nl' || s.cacheTypeV === 'iq4_nl';
  if (!unsafe || (!indexer && !helpers)) return { settings, notes: [], changed: '' };
  const swap = (type) => (type === 'iq4_nl' ? 'q4_0' : type);
  const fixed = { ...settings, cacheTypeK: swap(s.cacheTypeK), cacheTypeV: swap(s.cacheTypeV) };
  const why = indexer
    ? "this model has an attention indexer, whose iq4_nl cache rows llama.cpp's NVIDIA code cannot read"
    : "helper PCs take part, and llama.cpp's NVIDIA flash attention has no iq4_nl kernel (it cannot check a helper first)";
  return {
    settings: fixed,
    notes: [`KV cache iq4_nl -> q4_0 (same memory): ${why}`],
    changed: 'iq4_nl>q4_0',
  };
}

/**
 * Why `draft` cannot guess words for `target`, or '' when it can. llama.cpp refuses a draft model
 * unless both use the same vocabulary (same kind, same start and end tokens, sizes within 128), and
 * stops with an error when it does, so Uma checks first.
 */
function draftCompatibility(target, draft) {
  const a = target?.tokenizer;
  const b = draft?.tokenizer;
  if (!a?.size || !b?.size) return 'unknown vocabulary';
  if (a.model !== b.model || (a.pre && b.pre && a.pre !== b.pre)) return `different tokenizer (${b.pre || b.model} instead of ${a.pre || a.model})`;
  if (Math.abs(a.size - b.size) > 128) return `different vocabulary size (${b.size} instead of ${a.size})`;
  if (a.addBos !== b.addBos || (a.addBos && a.bos !== b.bos)) return 'different start token';
  if (a.eos !== null && b.eos !== null && a.eos !== b.eos) return 'different end token';
  return '';
}

/**
 * llama-server arguments for speculative decoding: the draft model guesses `tokens` words ahead and
 * the big model checks them all in one step. `device` names where the draft runs, such as a helper
 * PC's GPU ("RPC1"); without one it follows the big model's devices.
 */
const DRAFT_P_MIN = 0.75;

function draftArgs({ path: draftPath, tokens = DEFAULTS.draftTokens, device = '' }) {
  return [
    '--spec-type', 'draft-simple',
    '-md', draftPath,
    '--spec-draft-n-max', String(tokens),
    // The draft stops guessing as soon as it is unsure of its next word, so the length adjusts by
    // itself at every step. Measured with b12131: when the draft is often wrong, 4.0 -> 9.1-9.4 tok/s
    // (threshold 0.6-0.8); when it agrees, the same speed as without it.
    '--spec-draft-p-min', String(DRAFT_P_MIN),
    '-ngld', 'all',
    // Half the memory of the default f16, and a type every GPU's flash attention supports.
    '-ctkd', 'q8_0',
    '-ctvd', 'q8_0',
    ...(device ? ['-devd', device] : []),
  ];
}

// Draft models known to work for a tokenizer, offered when none is installed. Checked against
// llama.cpp b12102: Qwen3.5-0.8B shares the Qwen3.5/3.8 vocabulary (248,320 tokens) and writes sense.
const SUGGESTED_DRAFTS = {
  qwen35: { repo: 'ggml-org/Qwen3.5-0.8B-GGUF', quant: 'Q8_0', name: 'Qwen3.5 0.8B', sizeBytes: 834 * 1024 * 1024 },
};

/**
 * The share of MoE cache misses the CPU computes. Memory-mapped experts (the default) upload slowly,
 * so the CPU should take most misses: measured with b12318 on an RTX 2070, a 1 GB cache wrote 28.4
 * tok/s at share 0 and 60.1 at 0.95, a 3 GB one 108.5 and 117.8. Pinned experts (loading mode none
 * or mlock) upload at the full speed of the link, where llama.cpp's notes say the share rarely helps.
 */
function moeCacheShare(loadMode = 'auto') {
  return ['none', 'mlock'].includes(loadMode) ? 0 : 0.95;
}

module.exports = { moeCacheShare,
  FIELDS, DEFAULTS, CACHE_TYPES, sanitizeModelSettings, buildServerArgs, parseExtraArgs, defaultThreads, cacheTypeFixes,
  draftCompatibility, draftArgs, SUGGESTED_DRAFTS,
};
