// A small but real GGUF file for tests: a header a model reader accepts, a tokenizer to step over,
// and a few tensors, so parsing, downloads and the model settings screen can be tried without a model.
//   const { makeGguf } = require('./tiny-gguf.cjs');
//   fs.writeFileSync(file, makeGguf({ architecture: 'qwen35', layers: 4, extra: { 'qwen35.nextn_predict_layers': 1 } }));

/** The bytes of the file. `extra` adds metadata: a string or a whole number for each key. */
function makeGguf({ architecture = 'qwen3', layers = 2, embd = 64, extra = {} } = {}) {
  const u32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const u64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
  const str = (value) => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
  const kvs = {
    'general.architecture': architecture,
    'general.name': 'Test Model',
    [`${architecture}.block_count`]: layers,
    [`${architecture}.context_length`]: 4096,
    [`${architecture}.embedding_length`]: embd,
    [`${architecture}.attention.head_count`]: 4,
    [`${architecture}.attention.head_count_kv`]: 2,
    ...extra,
  };
  const entries = Object.entries(kvs).map(([key, value]) => Buffer.concat([
    str(key),
    typeof value === 'string' ? Buffer.concat([u32(8), str(value)]) : Buffer.concat([u32(4), u32(value)]),
  ]));
  // A long string array stands in for the tokenizer, which the reader must step over.
  entries.push(Buffer.concat([str('tokenizer.ggml.tokens'), u32(9), u32(8), u64(2000), ...Array.from({ length: 2000 }, (_, i) => str(`tok${i}`))]));
  const tensors = [['token_embd.weight', 100], ...Array.from({ length: layers }, (_, i) => [`blk.${i}.attn.weight`, 1000]), ['output.weight', 200]];
  let offset = 0;
  const infos = tensors.map(([name, size]) => {
    const info = Buffer.concat([str(name), u32(1), u64(size), u32(0), u64(offset)]);
    offset += size;
    return info;
  });
  const head = Buffer.concat([Buffer.from('GGUF'), u32(3), u64(tensors.length), u64(entries.length), ...entries, ...infos]);
  const padded = Math.ceil(head.length / 32) * 32;
  return Buffer.concat([head, Buffer.alloc(padded - head.length), Buffer.alloc(offset, 7)]);
}

module.exports = { makeGguf };
