// Finds a vision file (mmproj) for a model that has none in its own repository, for one-click
// download: abliterated, uncensored and re-uploaded versions often leave it out, although the vision
// file of the model they were made from works with them.
//
// Where it looks, in order:
//   1. the model's own repository;
//   2. GGUF copies of the original model named in the model file (general.base_model.*);
//   3. GGUF copies of the model's own name and size (Qwen3.8 + 9B -> Qwen3.8-9B);
//   4. close relatives with the same architecture and size (a distill of Qwen3.8 9B built on Qwen3.5
//      9B can use Qwen3.5 9B's), marked "compatible".
// A vision file is used only if it fits: its output size (clip.vision.projection_dim) must equal the
// model's width ({arch}.embedding_length), and the repository's models must have the same
// architecture. A text-only family (Qwen3, Llama 3) finds nothing, and the user is told so.
const { repoVariants } = require('./huggingface.cjs');
const { readGguf, urlSource } = require('./gguf.cjs');

const API = 'https://huggingface.co/api/models';
const PUBLISHERS = (org, name) => [`${org}/${name}-GGUF`, `unsloth/${name}-GGUF`, `ggml-org/${name}-GGUF`, `bartowski/${org}_${name}-GGUF`, `bartowski/${name}-GGUF`, `lmstudio-community/${name}-GGUF`];
// Architectures that are one family across versions, so a vision file can carry over at the same size.
const RELATIVES = {
  qwen35: ['Qwen3.8', 'Qwen3.6', 'Qwen3.5'],
  qwen35moe: ['Qwen3.8', 'Qwen3.6', 'Qwen3.5'],
  gemma3: ['gemma-3'],
  gemma3n: ['gemma-3n'],
  gemma4: ['gemma-4'],
};
const MAX_CANDIDATES = 14;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'UmaLLM/0.2', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** "27B" from "Qwen3.8 27B Abliterated" or a size label; "" if none. */
function sizeOf(...texts) {
  for (const text of texts) {
    const match = String(text || '').match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?[bm])(?:[^a-z0-9]|$)/i);
    if (match) return match[1].toUpperCase();
  }
  return '';
}

/** What the model file says about itself: architecture, width, where it came from. */
function describe(metadata) {
  const arch = String(metadata['general.architecture'] || '');
  const bases = [];
  const count = Number(metadata['general.base_model.count']) || 0;
  for (let index = 0; index < count; index += 1) {
    const url = String(metadata[`general.base_model.${index}.repo_url`] || '');
    const match = url.match(/huggingface\.co\/([\w.-]+)\/([\w.-]+)/i);
    if (match) bases.push({ org: match[1], name: match[2] });
  }
  return {
    arch,
    width: Number(metadata[`${arch}.embedding_length`]) || 0,
    basename: String(metadata['general.basename'] || ''),
    size: sizeOf(metadata['general.size_label'], metadata['general.name'], metadata['general.finetune']),
    bases,
  };
}

/** Repository names to try, best first, with how close each is to the model. */
async function candidates(model, ownRepo) {
  const list = [];
  const add = (repo, match) => {
    if (repo && repo !== ownRepo && !list.some((item) => item.repo.toLowerCase() === repo.toLowerCase())) list.push({ repo, match });
  };
  const search = async (query, match) => {
    try {
      const found = await getJson(`${API}?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&limit=8`);
      for (const item of found) if (item.id.toLowerCase().includes(query.toLowerCase().replace(/\s+/g, '-'))) add(item.id, match);
    } catch {}
  };
  for (const base of model.bases) {
    for (const repo of PUBLISHERS(base.org, base.name)) add(repo, 'original');
    await search(base.name, 'original');
  }
  if (model.basename && model.size) {
    const name = `${model.basename}-${model.size}`;
    for (const repo of PUBLISHERS('Qwen', name)) add(repo, 'same');
    await search(name, 'same');
  }
  for (const family of RELATIVES[model.arch] || []) {
    if (!model.size) break;
    const name = `${family}-${model.size}`;
    for (const repo of PUBLISHERS(family.startsWith('gemma') ? 'google' : 'Qwen', name)) add(repo, 'compatible');
  }
  return list.slice(0, MAX_CANDIDATES);
}

/** Whether a vision file fits the model: its output size must be the model's width. */
async function fits(file, model) {
  try {
    const { metadata } = await readGguf(urlSource(file.url));
    if (metadata['general.architecture'] !== 'clip' || metadata['clip.has_vision_encoder'] === false) return false;
    const out = Number(metadata['clip.vision.projection_dim']) || 0;
    return out > 0 && out === model.width;
  } catch {
    return false;
  }
}

/**
 * The best vision file for a model: { file, repo, match } with match "own", "original", "same" or
 * "compatible", or { file: null, reason } when there is none.
 */
async function findVision({ metadata, ownRepo = '' }) {
  const model = describe(metadata);
  if (!model.arch || !model.width) return { file: null, reason: 'unreadable' };
  if (ownRepo) {
    try {
      const own = await repoVariants(ownRepo);
      if (own.vision && await fits(own.vision, model)) return { file: own.vision, repo: ownRepo, match: 'own' };
    } catch {}
  }
  const tried = [];
  for (const candidate of await candidates(model, ownRepo)) {
    await pause(300);
    let detail;
    try {
      detail = await repoVariants(candidate.repo);
    } catch {
      continue;
    }
    tried.push(candidate.repo);
    if (detail.gated || !detail.vision) continue;
    // Its models must be the same kind as this one, not only the same width.
    if (detail.architecture && detail.architecture !== model.arch) continue;
    if (await fits(detail.vision, model)) return { file: detail.vision, repo: candidate.repo, match: candidate.match };
  }
  return { file: null, reason: 'none', tried, model };
}

module.exports = { findVision, describe, sizeOf };
