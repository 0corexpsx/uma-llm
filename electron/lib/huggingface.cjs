// Live search of GGUF models on Hugging Face. Only runs when the user searches or opens a result.
const { readModelInfo, urlSource } = require('./gguf.cjs');
const { t } = require('./i18n.cjs');

const API = 'https://huggingface.co/api/models';
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
// llama-server runs text models. These are other kinds of model that also ship as GGUF.
const OTHER_MEDIA = /^(text-to-image|image-to-image|image-to-video|text-to-video|text-to-speech|text-to-audio|audio-to-audio|automatic-speech-recognition|unconditional-image-generation|video-to-video)$/;
// Not a version of the model: a vision encoder ("mmproj", also in the middle of a name such as
// Model-mmproj-Q8_0.gguf), an importance matrix, a vocabulary, or a small draft model for
// speculative decoding (dspark, dflash, eagle, draft).
const NOT_A_MODEL_FILE = /(^|\/)(mtp-|vocab|ggml-vocab)|imatrix|mmproj|(^|[-_.\/])(dspark|dflash|eagle\d*|draft)([-_.]|$)/i;
const VISION_FILE = /mmproj[^/]*\.gguf$/i;
const SPLIT_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;
const QUANT_RE = /(?:^|[-._])((?:UD-)?(?:IQ\d[\w]*?|P?TQ\d(?:_\d)?|PQ\d_\d|Q\d(?:_[A-Z0-9]+)*|BF16|FP16|FP32|F16|F32))(?=[-.])/i;

/** The last quant word in a file name; a word inside the previous one ("Q4_K_M" in "UD-Q4_K_M") does not count. */
function lastQuant(name) {
  let found = '';
  let foundEnd = 0;
  const pattern = new RegExp(QUANT_RE.source, 'gi');
  for (let match = pattern.exec(name); match; match = pattern.exec(name)) {
    const start = match.index + match[0].indexOf(match[1]);
    if (start >= foundEnd) {
      found = match[1];
      foundEnd = start + match[1].length;
    }
    pattern.lastIndex = match.index + 1;
  }
  return found;
}

async function getJson(url, signal) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'UmaLLM/0.2', Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  if (response.status === 429) throw new Error(t('Hugging Face is rate-limiting searches. Wait a minute and try again.'));
  if (!response.ok) throw new Error(t('Hugging Face returned HTTP {0}.', [response.status]));
  return response.json();
}

async function searchModels({ query = '', sort = 'downloads', limit = 40, signal } = {}) {
  const sortKey = ['downloads', 'likes', 'lastModified', 'trendingScore'].includes(sort) ? sort : 'downloads';
  const params = new URLSearchParams({ filter: 'gguf', sort: sortKey, direction: '-1', limit: String(Math.min(100, limit)) });
  if (String(query).trim()) params.set('search', String(query).trim().slice(0, 120));
  const results = await getJson(`${API}?${params}`, signal);
  return results
    .filter((item) => !OTHER_MEDIA.test(item.pipeline_tag || ''))
    .map((item) => ({
      id: item.id,
      downloads: item.downloads || 0,
      likes: item.likes || 0,
      gated: Boolean(item.gated),
      updatedAt: item.lastModified || item.createdAt || '',
      pipeline: item.pipeline_tag || '',
    }));
}

function encodePath(file) {
  return file.split('/').map(encodeURIComponent).join('/');
}

function fileUrl(repo, file) {
  return `https://huggingface.co/${repo}/resolve/main/${encodePath(file)}`;
}

/** The downloadable versions in a repository. The parts of a split model count as one version. */
async function repoVariants(repo, { signal } = {}) {
  if (!REPO_RE.test(String(repo))) throw new Error(t('That is not a valid model repository name.'));
  const detail = await getJson(`${API}/${repo}?blobs=true`, signal);
  const groups = new Map();
  for (const sibling of detail.siblings || []) {
    const file = sibling.rfilename || '';
    if (!/\.gguf$/i.test(file) || NOT_A_MODEL_FILE.test(file)) continue;
    const key = file.replace(SPLIT_RE, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ path: file, size: sibling.size || sibling.lfs?.size || 0, url: fileUrl(repo, file) });
  }
  const all = [...groups.entries()].map(([key, files]) => {
    files.sort((a, b) => a.path.localeCompare(b.path));
    const base = key.split('/').pop();
    return {
      key,
      // The last quant word wins: "Model-BF16-abliterated-Q4_K_M" is a Q4_K_M file.
      quant: (lastQuant(`${base}.gguf`) || base.replace(/\.gguf$/i, '')).toUpperCase(),
      files,
      sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
    };
  }).sort((a, b) => a.sizeBytes - b.sizeBytes);
  // A file far smaller than the rest is not a version of this model (a patch, a draft or MTP head):
  // even a 1-bit quant is more than 4% of the largest version in a repository.
  const largest = all.length ? all[all.length - 1].sizeBytes : 0;
  const variants = all.filter((variant) => variant.sizeBytes >= largest * 0.04);
  // A vision model's image encoder. F16 is the usual balance of size and quality.
  const visionFiles = (detail.siblings || [])
    .filter((sibling) => VISION_FILE.test((sibling.rfilename || '').split('/').pop()))
    .map((sibling) => ({ path: sibling.rfilename, size: sibling.size || sibling.lfs?.size || 0, url: fileUrl(repo, sibling.rfilename) }))
    .sort((a, b) => Number(/f16/i.test(b.path)) - Number(/f16/i.test(a.path)) || a.size - b.size);
  return {
    id: repo,
    vision: visionFiles[0] || null,
    gated: Boolean(detail.gated),
    license: detail.cardData?.license || '',
    architecture: detail.gguf?.architecture || '',
    contextLength: detail.gguf?.context_length || 0,
    url: `https://huggingface.co/${repo}`,
    variants,
  };
}

/** Reads a version's real layer sizes from its header, without downloading its weights. */
function remoteModelInfo(files, { signal } = {}) {
  return readModelInfo(files.map((file) => ({ source: urlSource(file.url, { signal }), size: file.size })));
}

module.exports = { searchModels, repoVariants, remoteModelInfo, fileUrl };
