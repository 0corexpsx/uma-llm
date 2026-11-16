// Builds electron/lib/catalog-extra.json: the library cards beyond the hand-written ones in
// models.cjs. Each model is looked up on Hugging Face (official GGUF first, then the usual GGUF
// publishers), and only repositories that exist and need no login are kept, with their real file
// names and sizes. A second pass finds an abliterated (or otherwise modified) version of each model.
//   node scripts/build-catalog.cjs            (about 2-4 minutes; needs internet)
const fs = require('node:fs');
const path = require('node:path');
const { repoVariants } = require('../electron/lib/huggingface.cjs');
const { HANDWRITTEN: CATALOG } = require('../electron/lib/models.cjs');

const GB = 1e9;

// [family, publisher, model name on Hugging Face, card name, params label, kind]
// kind: chat | coder | reasoning | moe | bonsai
const BASES = [
  ['Qwen3.6', 'Qwen', 'Qwen3.6-27B', 'Qwen3.6 27B', '27B', 'chat'],
  ['Qwen3.6', 'Qwen', 'Qwen3.6-35B-A3B', 'Qwen3.6 35B A3B', '35B · 3B active', 'moe'],
  ['Qwen3.5', 'Qwen', 'Qwen3.5-0.8B', 'Qwen3.5 0.8B', '0.8B', 'chat'],
  ['Qwen3.5', 'Qwen', 'Qwen3.5-2B', 'Qwen3.5 2B', '2B', 'chat'],
  ['Qwen3.5', 'Qwen', 'Qwen3.5-4B', 'Qwen3.5 4B', '4B', 'chat'],
  ['Qwen3.5', 'Qwen', 'Qwen3.5-27B', 'Qwen3.5 27B', '27B', 'chat'],
  ['Qwen3.5', 'Qwen', 'Qwen3.5-35B-A3B', 'Qwen3.5 35B A3B', '35B · 3B active', 'moe'],
  ['Qwen3.5', 'Qwen', 'Qwen3.5-122B-A10B', 'Qwen3.5 122B A10B', '122B · 10B active', 'moe'],
  ['Qwen3.5', 'Qwen', 'Qwen3.5-397B-A17B', 'Qwen3.5 397B A17B', '397B · 17B active', 'moe'],
  ['Qwen3', 'Qwen', 'Qwen3-0.6B', 'Qwen3 0.6B', '0.6B', 'chat'],
  ['Qwen3', 'Qwen', 'Qwen3-1.7B', 'Qwen3 1.7B', '1.7B', 'chat'],
  ['Qwen3', 'Qwen', 'Qwen3-32B', 'Qwen3 32B', '32B', 'chat'],
  ['Qwen3', 'Qwen', 'Qwen3-235B-A22B', 'Qwen3 235B A22B', '235B · 22B active', 'moe'],
  ['Qwen3', 'Qwen', 'Qwen3-Next-80B-A3B-Instruct', 'Qwen3 Next 80B A3B', '80B · 3B active', 'moe'],
  ['Qwen3', 'Qwen', 'Qwen3-Coder-30B-A3B-Instruct', 'Qwen3 Coder 30B A3B', '30B · 3B active', 'coder'],
  ['Qwen3', 'Qwen', 'Qwen3-Coder-Next', 'Qwen3 Coder Next', 'MoE', 'coder'],
  ['Qwen2.5', 'Qwen', 'Qwen2.5-72B-Instruct', 'Qwen2.5 72B', '72B', 'chat'],
  ['Qwen2.5-Coder', 'Qwen', 'Qwen2.5-Coder-0.5B-Instruct', 'Qwen2.5 Coder 0.5B', '0.5B', 'coder'],
  ['Qwen2.5-Coder', 'Qwen', 'Qwen2.5-Coder-1.5B-Instruct', 'Qwen2.5 Coder 1.5B', '1.5B', 'coder'],
  ['Qwen2.5-Coder', 'Qwen', 'Qwen2.5-Coder-3B-Instruct', 'Qwen2.5 Coder 3B', '3B', 'coder'],
  ['Qwen2.5-Coder', 'Qwen', 'Qwen2.5-Coder-32B-Instruct', 'Qwen2.5 Coder 32B', '32B', 'coder'],
  ['Llama', 'meta-llama', 'Llama-4-Scout-17B-16E-Instruct', 'Llama 4 Scout', '109B · 17B active', 'moe'],
  ['Llama', 'meta-llama', 'Llama-4-Maverick-17B-128E-Instruct', 'Llama 4 Maverick', '400B · 17B active', 'moe'],
  ['Llama', 'meta-llama', 'Meta-Llama-3.1-405B-Instruct', 'Llama 3.1 405B', '405B', 'chat'],
  ['Mistral', 'mistralai', 'Ministral-3-3B-Instruct-2512', 'Ministral 3 3B', '3B', 'chat'],
  ['Mistral', 'mistralai', 'Ministral-3-8B-Instruct-2512', 'Ministral 3 8B', '8B', 'chat'],
  ['Mistral', 'mistralai', 'Ministral-3-14B-Instruct-2512', 'Ministral 3 14B', '14B', 'chat'],
  ['Mistral', 'mistralai', 'Mistral-Small-3.2-24B-Instruct-2506', 'Mistral Small 3.2 24B', '24B', 'chat'],
  ['Mistral', 'mistralai', 'Magistral-Small-2509', 'Magistral Small 24B', '24B', 'reasoning'],
  ['Mistral', 'mistralai', 'Devstral-Small-2-24B-Instruct-2512', 'Devstral Small 2 24B', '24B', 'coder'],
  ['Mistral', 'mistralai', 'Mixtral-8x7B-Instruct-v0.1', 'Mixtral 8x7B', '47B · 13B active', 'moe'],
  ['Mistral', 'mistralai', 'Mistral-Small-4-119B-2603', 'Mistral Small 4 119B', '119B · MoE', 'moe'],
  ['Mistral', 'mistralai', 'Mistral-Medium-3.5-128B', 'Mistral Medium 3.5 128B', '128B', 'chat'],
  ['Mistral', 'mistralai', 'Mistral-Large-3-675B-Instruct-2512', 'Mistral Large 3 675B', '675B', 'moe'],
  ['Gemma', 'google', 'gemma-2-27b-it', 'Gemma 2 27B', '27B', 'chat'],
  ['Gemma', 'google', 'gemma-3-270m-it', 'Gemma 3 270M', '0.27B', 'chat'],
  ['Gemma', 'google', 'gemma-3-1b-it', 'Gemma 3 1B', '1B', 'chat'],
  ['Gemma', 'google', 'gemma-3-4b-it', 'Gemma 3 4B', '4B', 'chat'],
  ['Gemma', 'google', 'gemma-3-12b-it', 'Gemma 3 12B', '12B', 'chat'],
  ['Gemma', 'google', 'gemma-3-27b-it', 'Gemma 3 27B', '27B', 'chat'],
  ['Gemma', 'google', 'gemma-3n-E2B-it', 'Gemma 3n E2B', 'E2B', 'chat'],
  ['Gemma', 'google', 'gemma-3n-E4B-it', 'Gemma 3n E4B', 'E4B', 'chat'],
  ['Gemma', 'google', 'gemma-4-E2B-it', 'Gemma 4 E2B', 'E2B', 'chat'],
  ['Gemma', 'google', 'gemma-4-E4B-it', 'Gemma 4 E4B', 'E4B', 'chat'],
  ['Gemma', 'google', 'gemma-4-12B-it', 'Gemma 4 12B', '12B', 'chat'],
  ['Gemma', 'google', 'gemma-4-26B-A4B-it', 'Gemma 4 26B A4B', '26B · 4B active', 'moe'],
  ['Gemma', 'google', 'gemma-4-31B-it', 'Gemma 4 31B', '31B', 'chat'],
  ['Phi', 'microsoft', 'Phi-4-mini-instruct', 'Phi-4 mini', '3.8B', 'chat'],
  ['Phi', 'microsoft', 'phi-4', 'Phi-4', '14B', 'chat'],
  ['Phi', 'microsoft', 'Phi-4-mini-reasoning', 'Phi-4 mini reasoning', '3.8B', 'reasoning'],
  ['Phi', 'microsoft', 'Phi-4-reasoning', 'Phi-4 reasoning', '14B', 'reasoning'],
  ['Phi', 'microsoft', 'Phi-4-reasoning-plus', 'Phi-4 reasoning plus', '14B', 'reasoning'],
  ['DeepSeek', 'deepseek-ai', 'DeepSeek-R1-Distill-Qwen-1.5B', 'DeepSeek R1 Distill 1.5B', '1.5B', 'reasoning'],
  ['DeepSeek', 'deepseek-ai', 'DeepSeek-R1-Distill-Qwen-7B', 'DeepSeek R1 Distill 7B', '7B', 'reasoning'],
  ['DeepSeek', 'deepseek-ai', 'DeepSeek-R1-Distill-Qwen-32B', 'DeepSeek R1 Distill 32B', '32B', 'reasoning'],
  ['DeepSeek', 'deepseek-ai', 'DeepSeek-R1-Distill-Llama-70B', 'DeepSeek R1 Distill 70B', '70B', 'reasoning'],
  ['DeepSeek', 'deepseek-ai', 'DeepSeek-R1-0528-Qwen3-8B', 'DeepSeek R1 0528 8B', '8B', 'reasoning'],
  ['DeepSeek', 'deepseek-ai', 'DeepSeek-R1-0528', 'DeepSeek R1 0528', '671B · 37B active', 'moe'],
  ['DeepSeek', 'deepseek-ai', 'DeepSeek-V3.1', 'DeepSeek V3.1', '671B · 37B active', 'moe'],
  ['DeepSeek', 'deepseek-ai', 'DeepSeek-V3.2', 'DeepSeek V3.2', '671B · 37B active', 'moe'],
  ['DeepSeek', 'deepseek-ai', 'DeepSeek-V4-Flash', 'DeepSeek V4 Flash', 'MoE', 'moe'],
  ['DeepSeek', 'deepseek-ai', 'DeepSeek-V4-Pro', 'DeepSeek V4 Pro', 'MoE', 'moe'],
  ['Bonsai', 'prism-ml', 'Bonsai-1.7B', 'Bonsai 1.7B', '1.7B', 'bonsai'],
  ['Bonsai', 'prism-ml', 'Bonsai-4B', 'Bonsai 4B', '4B', 'bonsai'],
  ['Bonsai', 'prism-ml', 'Ternary-Bonsai-1.7B', 'Ternary Bonsai 1.7B', '1.7B', 'bonsai'],
  ['Bonsai', 'prism-ml', 'Ternary-Bonsai-4B', 'Ternary Bonsai 4B', '4B', 'bonsai'],
  ['Bonsai', 'prism-ml', 'Ternary-Bonsai-8B', 'Ternary Bonsai 8B', '8B', 'bonsai'],
  ['Bonsai', 'prism-ml', 'Ternary-Bonsai-27B', 'Ternary Bonsai 27B', '27B', 'bonsai'],
  ['Bonsai', 'prism-ml', 'Ternary-Bonsai-2-2B', 'Bonsai 2 2B', '2B', 'bonsai'],
  ['Bonsai', 'prism-ml', 'Ternary-Bonsai-2-4B', 'Bonsai 2 4B', '4B', 'bonsai'],
  ['Bonsai', 'prism-ml', 'Ternary-Bonsai-2-27B', 'Bonsai 2 27B', '27B', 'bonsai'],
];

// Community models offered only in the modified view: [family, repo, card name, params, kind]
const COMMUNITY = [
  ['Qwen3.8', 'empero-ai/Qwen3.8-2B-Distill-GGUF', 'Qwen3.8 2B Distill', '2B', 'distill'],
  ['Qwen3.8', 'empero-ai/Qwen3.8-4B-Distill-GGUF', 'Qwen3.8 4B Distill', '4B', 'distill'],
  ['Qwen3.8', 'empero-ai/Qwen3.8-9B-Distill-GGUF', 'Qwen3.8 9B Distill', '9B', 'distill'],
  ['Qwen3.8', 'empero-ai/Qwen3.8-35B-A3B-Distill-GGUF', 'Qwen3.8 35B A3B Distill', '35B · 3B active', 'distill'],
];

// GGUF publishers, in the order they are tried.
function candidates(org, name) {
  if (org === 'prism-ml') return [`prism-ml/${name}-gguf`];
  return [`${org}/${name}-GGUF`, `unsloth/${name}-GGUF`, `bartowski/${org}_${name}-GGUF`, `bartowski/${name}-GGUF`,
    `lmstudio-community/${name}-GGUF`, `ggml-org/${name}-GGUF`, `${org}/${name}-gguf`, `${org}/${name}_gguf`, `mradermacher/${name}-GGUF`];
}

const PREFERRED = ['Q4_K_M', 'Q4_K_XL', 'IQ4_XS', 'Q4_0', 'Q4_K_S', 'Q4_1', 'Q5_K_M', 'Q8_0'];

function pickDefault(variants, kind) {
  const usable = variants.filter((variant) => variant.sizeBytes > 0);
  if (!usable.length) return null;
  if (kind === 'bonsai') return usable[0];
  for (const quant of PREFERRED) {
    const found = usable.find((variant) => variant.quant === quant || variant.quant === `UD-${quant}`);
    if (found) return found;
  }
  // Otherwise the smallest version above about 4.5 bits per weight, or the largest.
  return usable[Math.floor(usable.length / 2)];
}

/** The repository that has this model, with its versions, or null. */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hugging Face limits how fast an app may ask: wait between requests, and longer when told to. */
async function politely(task) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await pause(700);
    try {
      return await task();
    } catch (err) {
      if (!/rate-limiting|HTTP 429|429/.test(String(err.message))) throw err;
      process.stdout.write('~');
      await pause(30000 * (attempt + 1));
    }
  }
  throw new Error('Hugging Face kept refusing: try again later.');
}

async function findRepo(repos) {
  for (const repo of repos) {
    try {
      const detail = await politely(() => repoVariants(repo));
      if (detail.gated || !detail.variants.length) continue;
      return detail;
    } catch (err) {
      if (/kept refusing/.test(err.message)) throw err;
    }
  }
  return null;
}

// Where the search's first pick is not a clean abliterated model (it mixes in other files).
const MODIFIED_REPO = {
  'Qwen3.8-Flash-Next': 'huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-GGUF',
};

async function searchModified(baseName) {
  if (MODIFIED_REPO[baseName]) return [MODIFIED_REPO[baseName]];
  const term = baseName.replace(/-Instruct.*$|-it$/i, '');
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(`${term} abliterated`)}&filter=gguf&sort=downloads&limit=40`;
  try {
    const list = await politely(async () => {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (response.status === 429) throw new Error('HTTP 429');
      return response.json();
    });
    const matches = list.filter((item) => /abliterat/i.test(item.id) && item.id.toLowerCase().includes(term.toLowerCase().replace(/^meta-/, '')) && /gguf/i.test(item.id));
    const trusted = ['huihui-ai/', 'mlabonne/', 'bartowski/', 'mradermacher/', 'unsloth/', 'lmstudio-community/'];
    matches.sort((a, b) => Number(trusted.some((p) => b.id.startsWith(p))) - Number(trusted.some((p) => a.id.startsWith(p))) || (b.downloads || 0) - (a.downloads || 0));
    return matches.slice(0, 3).map((item) => item.id);
  } catch {
    return [];
  }
}

function sizeLabel(bytes) {
  return bytes >= 1000 * GB ? `${(bytes / (1000 * GB)).toFixed(1)} TB` : `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;
}

function textKey(kind, sizeBytes, modified) {
  if (modified === 'abliterated') return 'abliterated';
  if (modified) return 'community';
  if (kind === 'bonsai') return 'bonsai';
  if (sizeBytes > 50 * GB) return 'huge';
  if (kind === 'coder') return 'coder';
  if (kind === 'reasoning') return 'reasoning';
  if (kind === 'moe') return 'moe';
  if (sizeBytes < 1.4 * GB) return 'tiny';
  if (sizeBytes < 3.2 * GB) return 'small';
  if (sizeBytes < 6.5 * GB) return 'medium';
  if (sizeBytes < 12 * GB) return 'large';
  return 'xl';
}

function tools(kind, sizeBytes, modified) {
  if (modified || kind === 'bonsai') return 'Unknown';
  if (sizeBytes < 1.4 * GB) return 'Basic';
  if (sizeBytes < 3.2 * GB) return 'Good';
  return 'Great';
}

function card({ id, family, name, params, kind, detail, modified = '' }) {
  const pick = pickDefault(detail.variants, kind);
  if (!pick) return null;
  const smallest = detail.variants[0].sizeBytes;
  const largest = detail.variants.at(-1).sizeBytes;
  const versionsOnly = pick.files.length > 1 || pick.sizeBytes > 50 * GB;
  const sizeBytes = versionsOnly ? smallest : pick.sizeBytes;
  const gb = sizeBytes / GB;
  return {
    id,
    name,
    family,
    params,
    quant: versionsOnly ? `${detail.variants[0].quant} – ${detail.variants.at(-1).quant}` : pick.quant,
    sizeBytes,
    sizeLabel: versionsOnly ? `${sizeLabel(smallest)} – ${sizeLabel(largest)}` : sizeLabel(pick.sizeBytes),
    ...(versionsOnly ? {} : { filename: pick.files[0].path.split('/').pop(), url: pick.files[0].url }),
    repo: detail.id,
    license: detail.license || 'See model card',
    context: detail.contextLength || 32768,
    tier: versionsOnly ? 'Server-class' : gb < 1.4 ? 'Featherweight' : gb < 6.5 ? 'Capable' : gb < 16 ? 'Heavy' : 'Very heavy',
    text: textKey(kind, sizeBytes, modified),
    minRamGB: Math.ceil(gb * 1.25 + 2),
    minVramGB: kind === 'moe' ? Math.ceil(gb * 0.25) : Math.ceil(gb * 1.15),
    tools: tools(kind, sizeBytes, modified),
    versionsRepo: detail.id,
    ...(versionsOnly ? { versionsOnly: true } : {}),
    ...(modified ? { modified } : {}),
  };
}

async function main() {
  const handwritten = new Set(CATALOG.map((model) => model.repo));
  const out = [];
  const missing = [];
  const bases = [];
  for (const [family, org, hfName, name, params, kind] of BASES) {
    const detail = await findRepo(candidates(org, hfName));
    if (!detail) { missing.push(`${name} (no GGUF without login)`); continue; }
    if (handwritten.has(detail.id)) continue;
    const id = `lib-${hfName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const entry = card({ id, family, name, params, kind, detail });
    if (entry) { out.push(entry); bases.push({ family, hfName, name, params, kind }); }
    process.stdout.write('.');
  }
  // The modified view: an abliterated version of every model, the hand-written ones too.
  const forModified = [
    ...CATALOG.filter((model) => !model.modified).map((model) => ({ family: model.family, hfName: (model.versionsRepo || model.repo).split('/').pop().replace(/-GGUF$|-gguf$/i, '').replace(/^(Qwen|google|meta-llama|mistralai|microsoft)_/, ''), name: model.name, params: model.params, kind: /MoE|active/.test(model.params) ? 'moe' : 'chat' })),
    ...bases,
  ];
  for (const base of forModified) {
    if (base.family === 'Bonsai') continue;
    const repos = await searchModified(base.hfName);
    const detail = repos.length ? await findRepo(repos) : null;
    if (!detail) continue;
    const id = `mod-${detail.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (out.some((item) => item.id === id)) continue;
    const entry = card({ id, family: base.family, name: `${base.name} Abliterated`, params: base.params, kind: base.kind, detail, modified: 'abliterated' });
    if (entry) out.push(entry);
    process.stdout.write('+');
  }
  for (const [family, repo, name, params] of COMMUNITY) {
    const detail = await findRepo([repo]);
    if (!detail) { missing.push(`${name} (${repo})`); continue; }
    const entry = card({ id: `mod-${repo.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, family, name, params, kind: 'chat', detail, modified: 'community' });
    if (entry) out.push(entry);
  }
  const file = path.join(__dirname, '..', 'electron', 'lib', 'catalog-extra.json');
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\n${out.filter((item) => !item.modified).length} more models, ${out.filter((item) => item.modified).length} modified versions -> ${path.basename(file)}`);
  if (missing.length) console.log(`not found: ${missing.join('; ')}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
