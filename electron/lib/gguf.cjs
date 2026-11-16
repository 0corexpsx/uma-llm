// Reads a GGUF model's header without loading its weights. Works on a local file, or over HTTP
// with range requests, so a model's real layer sizes are known before it is downloaded.
const fsp = require('node:fs/promises');
const { t } = require('./i18n.cjs');

const WINDOW_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 128 * 1024 * 1024;
const FIXED_SIZES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const STRING = 8;
const ARRAY = 9;

function fileSource(file) {
  return async (offset, length) => {
    const handle = await fsp.open(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  };
}

function urlSource(url, { signal } = {}) {
  return async (offset, length) => {
    const response = await fetch(url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}`, 'User-Agent': 'UmaLLM/0.2' },
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    });
    if (response.status !== 206 && response.status !== 200) {
      throw new Error(t('Could not read the model header (HTTP {0}).', [response.status]));
    }
    if (response.status === 200) {
      // A server that ignores ranges would send the whole model, so read only what was asked for.
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (size < offset + length) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        size += value.length;
      }
      await reader.cancel().catch(() => {});
      return Buffer.concat(chunks).subarray(offset, offset + length);
    }
    return Buffer.from(await response.arrayBuffer());
  };
}

class Reader {
  constructor(source) {
    this.source = source;
    this.buffer = Buffer.alloc(0);
    this.base = 0;
    this.position = 0;
  }

  async need(length) {
    if (this.position + length > MAX_HEADER_BYTES) throw new Error(t('This GGUF header is unexpectedly large.'));
    const end = this.base + this.buffer.length;
    if (this.position >= this.base && this.position + length <= end) return;
    const chunk = await this.source(this.position, Math.max(length, WINDOW_BYTES));
    if (chunk.length < length) throw new Error(t('The GGUF header ended early. The file may be damaged.'));
    this.buffer = chunk;
    this.base = this.position;
  }

  async take(length) {
    await this.need(length);
    const start = this.position - this.base;
    this.position += length;
    return this.buffer.subarray(start, start + length);
  }

  async u32() { return (await this.take(4)).readUInt32LE(0); }

  async u64() {
    const value = (await this.take(8)).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(t('The GGUF header holds an impossible value.'));
    return Number(value);
  }

  async string(keep = 512) {
    const length = await this.u64();
    if (length > keep) {
      this.position += length;
      return '';
    }
    return (await this.take(length)).toString('utf8');
  }

  async scalar(type) {
    if (type === STRING) return this.string();
    const data = await this.take(FIXED_SIZES[type]);
    switch (type) {
      case 0: return data.readUInt8(0);
      case 1: return data.readInt8(0);
      case 2: return data.readUInt16LE(0);
      case 3: return data.readInt16LE(0);
      case 4: return data.readUInt32LE(0);
      case 5: return data.readInt32LE(0);
      case 6: return data.readFloatLE(0);
      case 7: return data.readUInt8(0) !== 0;
      case 10: return Number(data.readBigUInt64LE(0));
      case 11: return Number(data.readBigInt64LE(0));
      case 12: return data.readDoubleLE(0);
      default: throw new Error(t('Unknown GGUF value type {0}.', [type]));
    }
  }

  /** Short arrays are kept (per-layer head counts); long ones (the tokenizer) are only counted. */
  async value(type) {
    if (type !== ARRAY) return this.scalar(type);
    const itemType = await this.u32();
    const count = await this.u64();
    if (itemType === ARRAY) throw new Error(t('Nested GGUF arrays are not supported.'));
    if (count <= 1024) {
      const items = [];
      for (let index = 0; index < count; index += 1) items.push(await this.scalar(itemType));
      return items;
    }
    if (itemType !== STRING) {
      this.position += FIXED_SIZES[itemType] * count;
      return { count };
    }
    for (let index = 0; index < count; index += 1) {
      const length = await this.u64();
      this.position += length;
    }
    return { count };
  }
}

/** Reads one GGUF file's metadata and how many bytes of weights belong to each part of the model. */
async function readGguf(source, fileSize) {
  const reader = new Reader(source);
  if ((await reader.take(4)).toString('ascii') !== 'GGUF') throw new Error(t('That file is not a valid GGUF model.'));
  const version = await reader.u32();
  if (version < 2) throw new Error(t('GGUF version {0} is too old.', [version]));
  const tensorCount = await reader.u64();
  const kvCount = await reader.u64();
  const metadata = {};
  for (let index = 0; index < kvCount; index += 1) {
    const key = await reader.string(1024);
    const type = await reader.u32();
    metadata[key] = await reader.value(type);
  }
  const tensors = [];
  for (let index = 0; index < tensorCount; index += 1) {
    const name = await reader.string(1024);
    const dims = await reader.u32();
    reader.position += dims * 8;
    await reader.u32();
    tensors.push({ name, offset: await reader.u64() });
  }
  const alignment = Number(metadata['general.alignment']) || 32;
  const dataStart = Math.ceil(reader.position / alignment) * alignment;
  const sorted = [...tensors].sort((a, b) => a.offset - b.offset);
  const blocks = {};
  let inputBytes = 0;
  let otherBytes = 0;
  // The routed experts of a mixture-of-experts model (ffn_up_exps, ffn_gate_exps, ffn_down_exps…),
  // which -cmoe keeps in RAM. Shared experts (_shexp) are not among them.
  let expertBytes = 0;
  sorted.forEach((tensor, index) => {
    const next = index + 1 < sorted.length ? sorted[index + 1].offset : fileSize - dataStart;
    const bytes = Math.max(0, next - tensor.offset);
    if (/_exps\./.test(tensor.name)) expertBytes += bytes;
    const block = tensor.name.match(/^blk\.(\d+)\./);
    if (block) blocks[block[1]] = (blocks[block[1]] || 0) + bytes;
    else if (/^(token_embd|pos_embd|tok_embd)/.test(tensor.name)) inputBytes += bytes;
    else otherBytes += bytes;
  });
  return { metadata, blocks, inputBytes, otherBytes, expertBytes, headerBytes: dataStart };
}

/** Combines every part of a split model into one description. `parts` are { source, size }. */
async function readModelInfo(parts) {
  const blocks = {};
  let inputBytes = 0;
  let otherBytes = 0;
  let expertBytes = 0;
  let metadata = null;
  for (const part of parts) {
    const info = await readGguf(part.source, part.size);
    metadata = metadata || info.metadata;
    for (const [layer, bytes] of Object.entries(info.blocks)) blocks[layer] = (blocks[layer] || 0) + bytes;
    inputBytes += info.inputBytes;
    otherBytes += info.otherBytes;
    expertBytes += info.expertBytes || 0;
  }
  const architecture = String(metadata['general.architecture'] || 'unknown');
  const field = (name) => metadata[`${architecture}.${name}`];
  const first = (value, fallback = 0) => {
    if (Array.isArray(value)) return Number(value.find((item) => item > 0)) || fallback;
    return Number(value) || fallback;
  };
  const nEmbd = first(field('embedding_length'));
  const nHead = first(field('attention.head_count'), 1);
  const nHeadKv = first(field('attention.head_count_kv'), nHead);
  const nLayer = first(field('block_count'), Object.keys(blocks).length);
  return {
    architecture,
    name: String(metadata['general.name'] || ''),
    contextLength: first(field('context_length')),
    nLayer,
    nEmbd,
    nHead,
    nHeadKv,
    keyLength: first(field('attention.key_length')) || (nHead ? Math.floor(nEmbd / nHead) : 0),
    valueLength: first(field('attention.value_length')) || (nHead ? Math.floor(nEmbd / nHead) : 0),
    // Hybrid models keep a context cache only on some layers: per-layer head counts, or every Nth.
    attentionLayers: (() => {
      if (Array.isArray(field('attention.head_count_kv'))) return field('attention.head_count_kv').filter((item) => item > 0).length;
      const interval = Number(field('full_attention_interval'));
      return interval > 0 ? Math.ceil(nLayer / interval) : nLayer;
    })(),
    hasStateMemory: Number(field('ssm.state_size')) > 0,
    // Sparse attention (an indexer picks the cache rows each token attends to): DeepSeek V3.2, GLM-5, qwen4exp.
    indexerHeads: Number(field('attention.indexer.head_count')) || 0,
    // What decides whether another model can draft for this one (see modelSettings.draftCompatibility).
    tokenizer: {
      model: String(metadata['tokenizer.ggml.model'] || ''),
      pre: String(metadata['tokenizer.ggml.pre'] || ''),
      size: (() => {
        const tokens = metadata['tokenizer.ggml.tokens'];
        return Array.isArray(tokens) ? tokens.length : Number(tokens?.count) || 0;
      })(),
      eos: metadata['tokenizer.ggml.eos_token_id'] ?? null,
      bos: metadata['tokenizer.ggml.bos_token_id'] ?? null,
      addBos: Boolean(metadata['tokenizer.ggml.add_bos_token']),
    },
    layerBytes: Object.keys(blocks).sort((a, b) => Number(a) - Number(b)).map((layer) => blocks[layer]),
    inputBytes,
    otherBytes,
    // Mixture of experts: how many experts each layer has, and the bytes of all of them.
    expertCount: first(field('expert_count')),
    expertBytes,
    totalBytes: parts.reduce((sum, part) => sum + part.size, 0),
  };
}

module.exports = { readGguf, readModelInfo, fileSource, urlSource };
