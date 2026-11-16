const path = require('node:path');
const fsp = require('node:fs/promises');
const { downloadFile, ensureDir, newId, formatBytes, isInside, sleep } = require('./util.cjs');
const { readGguf, readModelInfo, fileSource } = require('./gguf.cjs');
const { t } = require('./i18n.cjs');

/**
 * Texts shared by the cards in catalog-extra.json (made by scripts/build-catalog.cjs), so the
 * library can list every size of every family without a unique text to translate for each card.
 */
const CARD_TEXTS = {
  tiny: {
    tagline: 'Small and fast, for simple tasks.',
    description: 'Runs on almost any PC, even without a graphics card. Good for short answers, sorting and quick drafts; keep tasks small.',
  },
  small: {
    tagline: 'A light, quick everyday helper.',
    description: 'Runs well on laptops and small graphics cards. Good for notes, summaries and simple file edits.',
  },
  medium: {
    tagline: 'A solid all-rounder for 8 GB graphics cards.',
    description: 'Good quality for chat, code and documents, and fast on a graphics card with 8 GB or more.',
  },
  large: {
    tagline: 'More knowledge, for 12–16 GB graphics cards.',
    description: 'Noticeably smarter than the 7–9B models. Fits a 12–16 GB graphics card, or runs partly on the processor.',
  },
  xl: {
    tagline: 'High quality, for a large graphics card.',
    description: 'Close to the best one PC can run. Needs a 24 GB graphics card for full speed; with less it runs partly on the processor.',
  },
  moe: {
    tagline: 'Big-model quality at small-model speed.',
    description: 'A mixture-of-experts model: only part of it works on each word, so it stays quick even when most of it is in RAM.',
  },
  huge: {
    tagline: 'For a powerful PC or several PCs together.',
    description: 'Larger than one ordinary PC. Choose a version to see what it needs; helper PCs on your network can lend their memory.',
  },
  coder: {
    tagline: 'Made for programming.',
    description: 'Trained to write, fix and explain code. A good choice for coding projects.',
  },
  reasoning: {
    tagline: 'Thinks step by step before answering.',
    description: 'A reasoning model: it works through the problem first, so answers take longer but are better at maths, logic and code.',
  },
  bonsai: {
    tagline: 'Extreme 1-bit compression.',
    description: 'A very small file for its size, thanks to 1-bit or ternary weights. Needs an engine that supports these weights and may not load. Experimental.',
  },
  abliterated: {
    tagline: 'Abliterated: answers without refusing.',
    description: 'A modified version with its refusals removed. It answers requests the original model declines, so check what it produces. Made by the community, not the original publisher.',
  },
  community: {
    tagline: 'A community model built from another.',
    description: 'Distilled, fine-tuned or merged by the community from another model, not made by its original publisher. Quality varies: read its model card.',
  },
};

const HANDWRITTEN = [
  {
    id: 'qwen38-27b-iq4',
    name: 'Qwen3.8 27B',
    family: 'Qwen3.8',
    params: '27B',
    quant: 'IQ4_XS',
    sizeBytes: 14_247_000_000,
    sizeLabel: '13.3 GB',
    filename: 'Qwen3.8-27B-UD-IQ4_XS.gguf',
    repo: 'unsloth/Qwen3.8-27B-GGUF',
    url: 'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-IQ4_XS.gguf',
    license: 'See model card',
    context: 262144,
    tier: 'Heavy',
    tagline: 'A newer, larger Qwen generation.',
    description: 'Larger than most GPUs in this quality, so it usually runs partly on the CPU. All versions offers every size, from 6 GB (IQ1_S) to full BF16 (55 GB).',
    minRamGB: 24,
    minVramGB: 16,
    tools: 'Unknown',
    // Every version of this repository can be chosen from the card (All versions).
    versionsRepo: 'unsloth/Qwen3.8-27B-GGUF',
  },
  {
    id: 'qwen38-flash-next',
    name: 'Qwen3.8 Flash Next',
    family: 'Qwen3.8',
    params: 'MoE',
    quant: 'IQ1_S – BF16',
    sizeBytes: 66_400_000_000,
    sizeLabel: '66–354 GB',
    repo: 'unsloth/Qwen3.8-Flash-Next-GGUF',
    license: 'See model card',
    context: 262144,
    tier: 'Server-class',
    tagline: 'Qwen3.8 large mixture-of-experts model.',
    description: 'Bigger than one PC in most versions: helper PCs shared on your network can lend their RAM and GPU memory. Choose a version to see whether it fits.',
    minRamGB: 72,
    minVramGB: 80,
    tools: 'Unknown',
    // No single file: the version (and its parts) is chosen from the card.
    versionsRepo: 'unsloth/Qwen3.8-Flash-Next-GGUF',
    versionsOnly: true,
  },
  {
    id: 'qwen38-2t-a95b',
    name: 'Qwen3.8 2.4T A95B',
    family: 'Qwen3.8',
    params: '2.4T',
    quant: 'Q1_0 – BF16',
    sizeBytes: 397_300_000_000,
    sizeLabel: '397 GB – 4.9 TB',
    repo: 'unsloth/Qwen3.8-2.4T-A95B-GGUF',
    license: 'See model card',
    context: 262144,
    tier: 'Server-class',
    tagline: 'The largest Qwen3.8, for many PCs together.',
    description: 'Even its smallest version needs about 400 GB of memory, so it only runs with several helper PCs or a server. Choose a version to see what it needs.',
    minRamGB: 420,
    minVramGB: 400,
    tools: 'Unknown',
    versionsRepo: 'unsloth/Qwen3.8-2.4T-A95B-GGUF',
    versionsOnly: true,
  },
  {
    id: 'qwen25-05b',
    name: 'Qwen2.5 0.5B',
    family: 'Qwen2.5',
    params: '0.5B',
    quant: 'Q4_K_M',
    sizeBytes: 397_000_000,
    sizeLabel: '0.4 GB',
    filename: 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Qwen2.5-0.5B-Instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 32768,
    tier: 'Featherweight',
    tagline: 'Instant answers for tiny machines.',
    description: 'Great for testing, sorting, and short drafts. It can follow the file-tool protocol, but keep tasks small.',
    minRamGB: 2,
    minVramGB: 0,
    tools: 'Basic',
  },
  {
    id: 'qwen25-15b',
    name: 'Qwen2.5 1.5B',
    family: 'Qwen2.5',
    params: '1.5B',
    quant: 'Q4_K_M',
    sizeBytes: 988_000_000,
    sizeLabel: '1.0 GB',
    filename: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 32768,
    tier: 'Light',
    tagline: 'A nimble everyday helper.',
    description: 'Snappy on laptops without a discrete GPU. Good for notes, summaries, and simple file edits.',
    minRamGB: 4,
    minVramGB: 0,
    tools: 'Good',
  },
  {
    id: 'qwen25-3b',
    name: 'Qwen2.5 3B',
    family: 'Qwen2.5',
    params: '3B',
    quant: 'Q4_K_M',
    sizeBytes: 1_932_000_000,
    sizeLabel: '1.9 GB',
    filename: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Qwen2.5-3B-Instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 32768,
    tier: 'Balanced',
    tagline: 'The CPU-friendly all-rounder.',
    description: 'A strong balance of quality and speed on ordinary hardware. A dependable first local model.',
    minRamGB: 8,
    minVramGB: 2,
    tools: 'Good',
  },
  {
    id: 'qwen3-4b',
    name: 'Qwen3 4B',
    family: 'Qwen3',
    params: '4B',
    quant: 'Q4_K_M',
    sizeBytes: 2_497_280_256,
    sizeLabel: '2.3 GB',
    filename: 'Qwen3-4B-Q4_K_M.gguf',
    repo: 'Qwen/Qwen3-4B-GGUF',
    url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 32768,
    tier: 'Recommended',
    tagline: 'The sweet spot for a local workspace.',
    description: 'Current-generation reasoning and writing quality that still fits comfortably on an 8 GB GPU.',
    minRamGB: 8,
    minVramGB: 4,
    tools: 'Great',
  },
  {
    id: 'qwen25-7b',
    name: 'Qwen2.5 7B',
    family: 'Qwen2.5',
    params: '7B',
    quant: 'Q4_K_M',
    sizeBytes: 4_683_000_000,
    sizeLabel: '4.4 GB',
    filename: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 32768,
    tier: 'Capable',
    tagline: 'The most reliable tool caller.',
    description: 'Excellent instruction following and multi-step file work. Needs roughly 6 GB of free GPU memory.',
    minRamGB: 16,
    minVramGB: 6,
    tools: 'Excellent',
  },
  {
    id: 'qwen3-8b',
    name: 'Qwen3 8B',
    family: 'Qwen3',
    params: '8B',
    quant: 'Q4_K_M',
    sizeBytes: 5_027_000_000,
    sizeLabel: '4.7 GB',
    filename: 'Qwen3-8B-Q4_K_M.gguf',
    repo: 'Qwen/Qwen3-8B-GGUF',
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 32768,
    tier: 'Heavy',
    tagline: 'More depth, if your machine can carry it.',
    description: 'Stronger reasoning and longer, more careful work. Best with 8 GB or more of VRAM.',
    minRamGB: 16,
    minVramGB: 8,
    tools: 'Great',
  },
  {
    id: 'llama32-1b',
    name: 'Llama 3.2 1B',
    family: 'Llama',
    params: '1B',
    quant: 'Q4_K_M',
    sizeBytes: 810_000_000,
    sizeLabel: '0.8 GB',
    filename: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    license: 'Llama 3.2 Community',
    context: 131072,
    tier: 'Featherweight',
    tagline: 'Meta’s smallest chat model.',
    description: 'Runs on almost anything, including CPU-only laptops. Good for quick tasks, testing, and sorting; keep coding tasks small.',
    minRamGB: 2,
    minVramGB: 0,
    tools: 'Basic',
  },
  {
    id: 'llama32-3b',
    name: 'Llama 3.2 3B',
    family: 'Llama',
    params: '3B',
    quant: 'Q4_K_M',
    sizeBytes: 2_050_000_000,
    sizeLabel: '2.0 GB',
    filename: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    license: 'Llama 3.2 Community',
    context: 131072,
    tier: 'Light',
    tagline: 'A fast, friendly Llama for everyday work.',
    description: 'Strong instruction following at a small size. A solid alternative to Qwen2.5 3B for summaries, notes, and light edits.',
    minRamGB: 6,
    minVramGB: 2,
    tools: 'Good',
  },
  {
    id: 'llama31-8b',
    name: 'Llama 3.1 8B',
    family: 'Llama',
    params: '8B',
    quant: 'Q4_K_M',
    sizeBytes: 4_920_000_000,
    sizeLabel: '4.9 GB',
    filename: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    license: 'Llama 3.1 Community',
    context: 131072,
    tier: 'Capable',
    tagline: 'Meta’s dependable 8B generalist.',
    description: 'Balanced writing and reasoning with long context. Needs about 6 GB of free GPU memory for comfortable speed.',
    minRamGB: 16,
    minVramGB: 6,
    tools: 'Good',
  },
  {
    id: 'mistral-7b-v03',
    name: 'Mistral 7B v0.3',
    family: 'Mistral',
    params: '7B',
    quant: 'Q4_K_M',
    sizeBytes: 4_400_000_000,
    sizeLabel: '4.4 GB',
    filename: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
    repo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF',
    url: 'https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 32768,
    tier: 'Capable',
    tagline: 'The classic fast instruction follower.',
    description: 'Very reliable at following multi-step instructions and concise tool use. A well-tested alternative to the Qwen family.',
    minRamGB: 16,
    minVramGB: 6,
    tools: 'Excellent',
  },
  {
    id: 'mistral-nemo-12b',
    name: 'Mistral Nemo 12B',
    family: 'Mistral',
    params: '12B',
    quant: 'Q4_K_M',
    sizeBytes: 7_200_000_000,
    sizeLabel: '7.2 GB',
    filename: 'Mistral-Nemo-Instruct-2407-Q4_K_M.gguf',
    repo: 'bartowski/Mistral-Nemo-Instruct-2407-GGUF',
    url: 'https://huggingface.co/bartowski/Mistral-Nemo-Instruct-2407-GGUF/resolve/main/Mistral-Nemo-Instruct-2407-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 131072,
    tier: 'Heavy',
    tagline: 'Mistral’s 12B workhorse.',
    description: 'Noticeably stronger than 7B for code and long documents. Prefer it if you have 8 GB or more of VRAM.',
    minRamGB: 24,
    minVramGB: 8,
    tools: 'Great',
  },
  {
    id: 'gemma2-2b',
    name: 'Gemma 2 2B',
    family: 'Gemma',
    params: '2B',
    quant: 'Q4_K_M',
    sizeBytes: 1_600_000_000,
    sizeLabel: '1.6 GB',
    filename: 'gemma-2-2b-it-Q4_K_M.gguf',
    repo: 'bartowski/gemma-2-2b-it-GGUF',
    url: 'https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf',
    license: 'Gemma License',
    context: 8192,
    tier: 'Light',
    tagline: 'Google’s compact assistant.',
    description: 'Surprisingly readable output for 2B parameters. Good for short answers and drafts on modest hardware.',
    minRamGB: 4,
    minVramGB: 2,
    tools: 'Basic',
  },
  {
    id: 'gemma2-9b',
    name: 'Gemma 2 9B',
    family: 'Gemma',
    params: '9B',
    quant: 'Q4_K_M',
    sizeBytes: 5_500_000_000,
    sizeLabel: '5.5 GB',
    filename: 'gemma-2-9b-it-Q4_K_M.gguf',
    repo: 'bartowski/gemma-2-9b-it-GGUF',
    url: 'https://huggingface.co/bartowski/gemma-2-9b-it-GGUF/resolve/main/gemma-2-9b-it-Q4_K_M.gguf',
    license: 'Gemma License',
    context: 8192,
    tier: 'Capable',
    tagline: 'Google’s mid-size all-rounder.',
    description: 'Strong writing and reasoning. Note the shorter 8k context — keep code sessions focused.',
    minRamGB: 16,
    minVramGB: 6,
    tools: 'Good',
  },
  {
    id: 'phi35-mini',
    name: 'Phi-3.5 Mini',
    family: 'Phi',
    params: '3.8B',
    quant: 'Q4_K_M',
    sizeBytes: 2_400_000_000,
    sizeLabel: '2.4 GB',
    filename: 'Phi-3.5-mini-instruct-Q4_K_M.gguf',
    repo: 'bartowski/Phi-3.5-mini-instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf',
    license: 'MIT',
    context: 128000,
    tier: 'Balanced',
    tagline: 'Microsoft’s dense mini reasoner.',
    description: 'Compact but punches above its weight for reasoning and code. A good Qwen alternative on mid-range hardware.',
    minRamGB: 6,
    minVramGB: 4,
    tools: 'Good',
  },
  {
    id: 'qwen25-coder-7b',
    name: 'Qwen2.5 Coder 7B',
    family: 'Qwen2.5-Coder',
    params: '7B',
    quant: 'Q4_K_M',
    sizeBytes: 4_680_000_000,
    sizeLabel: '4.4 GB',
    filename: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 131072,
    tier: 'Recommended',
    tagline: 'Purpose-built for code tasks.',
    description: 'The best catalog pick for reading and editing source. Great at function-level work, less ideal for pure chat.',
    minRamGB: 16,
    minVramGB: 6,
    tools: 'Excellent',
  },
  {
    id: 'deepseek-r1-llama-8b',
    name: 'DeepSeek R1 Distill 8B',
    family: 'DeepSeek',
    params: '8B',
    quant: 'Q4_K_M',
    sizeBytes: 4_920_000_000,
    sizeLabel: '4.9 GB',
    filename: 'DeepSeek-R1-Distill-Llama-8B-Q4_K_M.gguf',
    repo: 'bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF',
    url: 'https://huggingface.co/bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF/resolve/main/DeepSeek-R1-Distill-Llama-8B-Q4_K_M.gguf',
    license: 'MIT',
    context: 131072,
    tier: 'Heavy',
    tagline: 'Reasoning-first distilled model.',
    description: 'Long chain-of-thought reasoning distilled into 8B. Excellent for analysis; slower and more verbose for simple edits.',
    minRamGB: 16,
    minVramGB: 8,
    tools: 'Good',
  },
  {
    id: 'qwen25-14b',
    name: 'Qwen2.5 14B',
    family: 'Qwen2.5',
    params: '14B',
    quant: 'Q4_K_M',
    sizeBytes: 8_571_700_000,
    sizeLabel: '8.6 GB',
    filename: 'Qwen2.5-14B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Qwen2.5-14B-Instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Qwen2.5-14B-Instruct-GGUF/resolve/main/Qwen2.5-14B-Instruct-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 131072,
    tier: 'Heavy',
    tagline: 'A big step up in reasoning and code.',
    description: 'Strong multi-step work and long-context editing. Needs a larger GPU or fast RAM; expect it to spill to CPU on 8 GB cards.',
    minRamGB: 24,
    minVramGB: 10,
    tools: 'Excellent',
  },
  {
    id: 'qwen3-14b',
    name: 'Qwen3 14B',
    family: 'Qwen3',
    params: '14B',
    quant: 'Q4_K_M',
    sizeBytes: 8_600_000_000,
    sizeLabel: '8.6 GB',
    filename: 'Qwen3-14B-Q4_K_M.gguf',
    repo: 'Qwen/Qwen3-14B-GGUF',
    url: 'https://huggingface.co/Qwen/Qwen3-14B-GGUF/resolve/main/Qwen3-14B-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 131072,
    tier: 'Heavy',
    tagline: 'Current-gen depth at 14B.',
    description: 'Stronger than Qwen2.5 14B for reasoning-heavy work. Ideal when the 8B model keeps repeating itself or losing the thread.',
    minRamGB: 24,
    minVramGB: 10,
    tools: 'Great',
  },
  {
    id: 'qwen25-coder-14b',
    name: 'Qwen2.5 Coder 14B',
    family: 'Qwen2.5-Coder',
    params: '14B',
    quant: 'Q4_K_M',
    sizeBytes: 8_571_700_000,
    sizeLabel: '8.6 GB',
    filename: 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 131072,
    tier: 'Recommended',
    tagline: 'The serious coding workhorse.',
    description: 'The best catalog pick for reading, editing, and reasoning about a whole codebase. Prefer it when 8B is not enough.',
    minRamGB: 24,
    minVramGB: 10,
    tools: 'Excellent',
  },
  {
    id: 'qwen25-32b',
    name: 'Qwen2.5 32B',
    family: 'Qwen2.5',
    params: '32B',
    quant: 'Q4_K_M',
    sizeBytes: 19_500_000_000,
    sizeLabel: '19.5 GB',
    filename: 'Qwen2.5-32B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Qwen2.5-32B-Instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Qwen2.5-32B-Instruct-GGUF/resolve/main/Qwen2.5-32B-Instruct-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 131072,
    tier: 'Heavy',
    tagline: 'Big-model quality, still local.',
    description: 'Approaches cloud-chat quality for long documents and hard reasoning. Requires substantial RAM/VRAM and patience.',
    minRamGB: 40,
    minVramGB: 20,
    tools: 'Great',
  },
  {
    id: 'mistral-small-24b',
    name: 'Mistral Small 24B',
    family: 'Mistral',
    params: '24B',
    quant: 'Q4_K_M',
    sizeBytes: 13_669_900_000,
    sizeLabel: '13.7 GB',
    filename: 'Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf',
    repo: 'bartowski/Mistral-Small-24B-Instruct-2501-GGUF',
    url: 'https://huggingface.co/bartowski/Mistral-Small-24B-Instruct-2501-GGUF/resolve/main/Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 131072,
    tier: 'Heavy',
    tagline: 'Mistral’s 24B multilingual model.',
    description: 'Excellent at long instruction following and code. A strong non-Qwen option for 16 GB+ GPUs.',
    minRamGB: 32,
    minVramGB: 16,
    tools: 'Great',
  },
  {
    id: 'deepseek-r1-qwen-14b',
    name: 'DeepSeek R1 Distill 14B',
    family: 'DeepSeek',
    params: '14B',
    quant: 'Q4_K_M',
    sizeBytes: 8_571_700_000,
    sizeLabel: '8.6 GB',
    filename: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf',
    repo: 'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF',
    url: 'https://huggingface.co/bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF/resolve/main/DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf',
    license: 'MIT',
    context: 131072,
    tier: 'Heavy',
    tagline: 'Long chain-of-thought at 14B.',
    description: 'Best for analysis and hard problems that benefit from step-by-step reasoning. Slow and verbose for simple edits.',
    minRamGB: 24,
    minVramGB: 10,
    tools: 'Good',
  },
  {
    id: 'llama33-70b',
    name: 'Llama 3.3 70B',
    family: 'Llama',
    params: '70B',
    quant: 'Q4_K_M',
    sizeBytes: 40_400_000_000,
    sizeLabel: '40 GB',
    filename: 'Llama-3.3-70B-Instruct-Q4_K_M.gguf',
    repo: 'bartowski/Llama-3.3-70B-Instruct-GGUF',
    url: 'https://huggingface.co/bartowski/Llama-3.3-70B-Instruct-GGUF/resolve/main/Llama-3.3-70B-Instruct-Q4_K_M.gguf',
    license: 'Llama 3.3 Community',
    context: 131072,
    tier: 'Extreme',
    tagline: 'The largest open option here.',
    description: '70B-class quality for long-form and hard reasoning. Download only with 64 GB+ RAM or a 48 GB GPU; it will be slow otherwise.',
    minRamGB: 64,
    minVramGB: 40,
    tools: 'Great',
  },
  {
    id: 'bonsai-8b',
    name: 'Bonsai 8B',
    family: 'Bonsai',
    params: '8B',
    quant: 'Q1_0',
    sizeBytes: 1_105_000_000,
    sizeLabel: '1.1 GB',
    filename: 'Bonsai-8B-Q1_0.gguf',
    repo: 'prism-ml/Bonsai-8B-gguf',
    url: 'https://huggingface.co/prism-ml/Bonsai-8B-gguf/resolve/main/Bonsai-8B-Q1_0.gguf',
    license: 'Apache-2.0',
    context: 32768,
    tier: 'Experimental',
    tagline: 'Ternary 1.58-bit model.',
    description: 'PrismML Bonsai, an extreme-quantization model. Requires a llama.cpp build with ternary support; this engine may reject Q1_0. Experimental.',
    minRamGB: 4,
    minVramGB: 0,
    tools: 'Unknown',
  },
  {
    id: 'bonsai-27b',
    name: 'Bonsai 27B',
    family: 'Bonsai',
    params: '27B',
    quant: 'Q1_0',
    sizeBytes: 3_627_300_000,
    sizeLabel: '3.6 GB',
    filename: 'Bonsai-27B-Q1_0.gguf',
    repo: 'prism-ml/Bonsai-27B-gguf',
    url: 'https://huggingface.co/prism-ml/Bonsai-27B-gguf/resolve/main/Bonsai-27B-Q1_0.gguf',
    license: 'Apache-2.0',
    context: 32768,
    tier: 'Experimental',
    tagline: 'Large ternary 1.58-bit model.',
    description: 'PrismML Bonsai 27B in Q1_0. Very compact for its size, but needs ternary-enabled llama.cpp; may not load on the bundled engine. Experimental.',
    minRamGB: 8,
    minVramGB: 4,
    tools: 'Unknown',
  },
  {
    id: 'qwen3-30b-a3b',
    name: 'Qwen3 30B (A3B MoE)',
    family: 'Qwen3',
    params: '30B · 3B active',
    quant: 'Q3_K_M',
    sizeBytes: 14_030_000_000,
    sizeLabel: '14 GB',
    filename: 'Qwen3-30B-A3B-Instruct-2507-Q3_K_M.gguf',
    repo: 'DhruvalLabs/Qwen3-30B-A3B-Instruct-2507-GGUF',
    url: 'https://huggingface.co/DhruvalLabs/Qwen3-30B-A3B-Instruct-2507-GGUF/resolve/main/Qwen3-30B-A3B-Instruct-2507-Q3_K_M.gguf',
    license: 'Apache-2.0',
    context: 131072,
    tier: 'MoE',
    tagline: 'Big-model quality on modest VRAM.',
    description: 'A 30B mixture-of-experts with only ~3B active per token, so it stays responsive while feeling much larger. Q3_K_M; Q2_K (10.7 GB) is the lighter variant if RAM is tight.',
    minRamGB: 24,
    minVramGB: 6,
    tools: 'Great',
  },
  {
    id: 'qwen35-9b',
    name: 'Qwen3.5 9B',
    family: 'Qwen3.5',
    params: '9B',
    quant: 'Q4_K_M',
    sizeBytes: 5_417_000_000,
    sizeLabel: '5.4 GB',
    filename: 'Qwen3.5-9B-Q4_K_M.gguf',
    repo: 'unsloth/Qwen3.5-9B-GGUF',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf',
    license: 'Apache-2.0',
    context: 131072,
    tier: 'Capable',
    tagline: 'The newest Qwen generation.',
    description: 'Qwen3.5 9B with strong reasoning and code. Fits an 8 GB GPU comfortably and is a solid step up from Qwen3 8B.',
    minRamGB: 16,
    minVramGB: 6,
    tools: 'Great',
  },
  {
    id: 'deepseek-v32-distill-8b',
    name: 'DeepSeek V3.2 Distill 8B',
    family: 'DeepSeek',
    params: '8B',
    quant: 'Q4_K_M',
    sizeBytes: 4_795_000_000,
    sizeLabel: '4.8 GB',
    filename: 'Qwen3-8B-DeepSeek-v3.2-Speciale-Distill.q4_k_m.gguf',
    repo: 'TeichAI/Qwen3-8B-DeepSeek-v3.2-Speciale-Distill-GGUF',
    url: 'https://huggingface.co/TeichAI/Qwen3-8B-DeepSeek-v3.2-Speciale-Distill-GGUF/resolve/main/Qwen3-8B-DeepSeek-v3.2-Speciale-Distill.q4_k_m.gguf',
    license: 'MIT',
    context: 32768,
    tier: 'Capable',
    tagline: 'Latest DeepSeek, distilled to 8B.',
    description: 'A community distill trained on DeepSeek V3.2 reasoning, sized for 8 GB GPUs. The full V3.2 (671B) is far too large for this PC.',
    minRamGB: 16,
    minVramGB: 6,
    tools: 'Good',
  },
  {
    id: 'bonsai2-9b',
    name: 'Bonsai 2 9B',
    family: 'Bonsai',
    params: '9B',
    quant: 'PTQ1_0',
    sizeBytes: 1_905_000_000,
    sizeLabel: '1.9 GB',
    filename: 'Ternary-Bonsai-2-9B-PTQ1_0.gguf',
    repo: 'prism-ml/Ternary-Bonsai-2-9B-gguf',
    url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-9B-gguf/resolve/main/Ternary-Bonsai-2-9B-PTQ1_0.gguf',
    license: 'Apache-2.0',
    context: 32768,
    tier: 'Experimental',
    tagline: 'Latest ternary Bonsai.',
    description: 'PrismML Bonsai 2, ternary 1.58-bit. Very compact, but needs a ternary-capable engine; may not load on the bundled llama.cpp. Experimental.',
    minRamGB: 4,
    minVramGB: 0,
    tools: 'Unknown',
  },
];

/** The cards from catalog-extra.json, with their shared texts, after the hand-written ones. */
function loadExtra() {
  let extra = [];
  try {
    extra = require('./catalog-extra.json');
  } catch {
    return [];
  }
  const ids = new Set(HANDWRITTEN.map((model) => model.id));
  const repos = new Set(HANDWRITTEN.map((model) => model.repo));
  return extra
    .filter((model) => !ids.has(model.id) && !repos.has(model.repo) && CARD_TEXTS[model.text])
    .map(({ text, ...model }) => ({ ...model, tagline: CARD_TEXTS[text].tagline, description: CARD_TEXTS[text].description }));
}

const CATALOG = [...HANDWRITTEN, ...loadExtra()];

async function copyModelFile(source, destination) {
  // Wait for the source to stop growing (download still in progress).
  let previous = -1;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const stat = await fsp.stat(source).catch(() => null);
    if (!stat) throw new Error(t('The source file is not available:\n{0}', [source]));
    if (previous >= 0 && stat.size === previous) break;
    previous = stat.size;
    await sleep(700);
  }

  // Copy with retries for transient lock/antivirus scans.
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.copyFile(source, destination);
      return;
    } catch (err) {
      lastError = err;
      if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
        await sleep(1000);
        continue;
      }
      throw err;
    }
  }
  if (lastError?.code === 'EBUSY') {
    throw new Error(
      t('The model file is still locked by another program. This usually means the download is still writing, or antivirus is scanning it. Wait for the download to finish completely, close the browser/torrent/antivirus, then import again.'),
    );
  }
  throw lastError || new Error(t('Could not copy the model file.'));
}

class ModelManager {
  constructor({ store, modelsDir, downloadsDir, emit }) {
    this.store = store;
    this.modelsDir = modelsDir;
    this.downloadsDir = downloadsDir;
    this.emit = emit || (() => {});
    this.active = null;
    this.states = new Map();
    this.infoCache = new Map();
    // What each download was started with (to resume it) and the files it writes (to cancel it).
    this.resumeArgs = new Map();
    this.downloadFiles = new Map();
    // Complete files this download wrote itself; Cancel never deletes a file that was there before.
    this.writtenFiles = new Map();
    this.stopReason = null;
  }

  catalog() {
    return CATALOG.map((model) => ({ ...model }));
  }

  getCatalogModel(id) {
    return CATALOG.find((model) => model.id === id);
  }

  async init() {
    await ensureDir(this.modelsDir);
    const installed = [];
    for (const entry of this.store.getInstalledModels()) {
      try {
        const stat = await fsp.stat(entry.path);
        installed.push({ ...entry, size: stat.size, exists: true });
      } catch {
        // Remove records whose file was moved or deleted outside Uma.
      }
    }
    await this.store.setInstalledModels(installed);
    await this.recoverFromDisk().catch((err) => console.warn('[models] recovery failed:', err.message));
  }

  /**
   * Models whose files are in Uma's model folder but not in the list (the list was lost, for example
   * after a crash) are added back, with the same id, name and vision file they had when downloaded.
   * Returns the names added.
   */
  async recoverFromDisk() {
    const known = new Set();
    for (const entry of this.store.getInstalledModels()) {
      known.add(path.resolve(entry.path));
      for (const part of entry.parts || []) known.add(path.resolve(part.path));
      if (entry.mmproj) known.add(path.resolve(entry.mmproj.path));
    }
    const files = [];
    const walk = async (dir, depth) => {
      for (const item of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (depth < 2) await walk(full, depth + 1);
        } else if (/\.gguf$/i.test(item.name)) {
          files.push(full);
        }
      }
    };
    await walk(this.modelsDir, 0);
    const visionDir = path.join(this.modelsDir, 'vision');
    const isVision = (file) => /mmproj/i.test(path.basename(file)) || isInside(file, visionDir);
    const added = [];
    for (const file of files) {
      if (known.has(path.resolve(file)) || isVision(file)) continue;
      const split = path.basename(file).match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
      if (split && split[2] !== '00001') continue;
      const folder = path.dirname(file);
      const parts = split
        ? files.filter((other) => path.dirname(other) === folder && path.basename(other).startsWith(`${split[1]}-`) && /-\d{5}-of-\d{5}\.gguf$/i.test(other)).sort()
        : [file];
      if (split && parts.length !== Number(split[3])) continue; // an unfinished split download
      const sizes = await Promise.all(parts.map(async (part) => ({ path: part, size: (await fsp.stat(part)).size })));
      const filename = path.basename(file);
      // Downloads from Hugging Face live in hub/<owner>__<repo>/.
      const hubFolder = path.relative(path.join(this.modelsDir, 'hub'), folder);
      const fromHub = !hubFolder.startsWith('..') && !path.isAbsolute(hubFolder) && !hubFolder.includes(path.sep) && hubFolder.includes('__');
      const repo = fromHub ? hubFolder.replace('__', '/') : '';
      const base = repo ? repo.split('/').pop().replace(/-GGUF$/i, '') : '';
      const stem = (split ? split[1] : filename.replace(/\.gguf$/i, ''));
      const quant = base && stem.toLowerCase().startsWith(`${base.toLowerCase()}-`)
        ? stem.slice(base.length + 1)
        : (stem.match(/(UD-)?(I?Q\d[\w]*|BF16|F16|F32)$/i) || [''])[0];
      const id = repo ? `hub:${repo}:${filename}` : undefined;
      // The vision file is next to a Hugging Face download, or in vision/<model id>/.
      const visionCandidates = repo
        ? files.filter((other) => path.dirname(other) === folder && /mmproj/i.test(path.basename(other)))
        : files.filter((other) => id && isInside(other, path.join(visionDir, id.replace(/[^\w.-]/g, '_'))));
      const vision = visionCandidates[0] && !known.has(path.resolve(visionCandidates[0]))
        ? { path: visionCandidates[0], size: (await fsp.stat(visionCandidates[0])).size }
        : null;
      try {
        const entry = await this.registerFile(file, {
          ...(id ? { id } : {}),
          ...(repo ? { name: `${base} ${quant}`.trim(), repo, fromHub: true } : {}),
          quant,
          ...(split ? { parts: sizes } : {}),
          ...(vision ? { mmproj: vision } : {}),
          recovered: true,
        });
        known.add(path.resolve(file));
        if (vision) known.add(path.resolve(vision.path));
        added.push(entry.name);
      } catch (err) {
        console.warn(`[models] could not add back ${filename}: ${err.message}`);
      }
    }
    if (added.length) console.warn(`[models] added back from the model folder: ${added.join(', ')}`);
    return added;
  }

  async list() {
    const installed = this.store.getInstalledModels();
    return {
      catalog: this.catalog().map((model) => {
        const found = installed.find((entry) => entry.catalogId === model.id);
        return {
          ...model,
          installed: Boolean(found),
          installedPath: found?.path || '',
          installedAt: found?.addedAt || '',
          state: this.states.get(model.id) || null,
        };
      }),
      installed: installed.map((entry) => ({
        ...entry,
        catalog: this.getCatalogModel(entry.catalogId) || null,
      })),
      activeDownload: this.active ? this.states.get(this.active) : null,
      modelsDir: this.modelsDir,
    };
  }

  async getModel(id) {
    return this.store.getInstalledModels().find((entry) => entry.id === id) || null;
  }

  async resolveActive() {
    const settings = this.store.getSettings();
    const installed = this.store.getInstalledModels();
    return installed.find((entry) => entry.id === settings.activeModelId) || installed[0] || null;
  }

  async importFile(sourcePath) {
    await ensureDir(this.modelsDir);
    const base = path.basename(sourcePath);
    if (!base.toLowerCase().endsWith('.gguf')) throw new Error(t('Choose a .gguf model file.'));
    const destination = path.join(this.modelsDir, base);
    const exists = await fsp.stat(destination).catch(() => null);
    if (!exists || path.resolve(sourcePath) !== path.resolve(destination)) {
      await copyModelFile(sourcePath, destination);
    }
    const entry = await this.registerFile(destination, {
      name: base.replace(/\.gguf$/i, '').replace(/[-_]/g, ' '),
      imported: true,
    });
    return entry;
  }

  async registerFile(filePath, extra = {}) {
    const stat = await fsp.stat(filePath);
    const header = Buffer.alloc(4);
    const handle = await fsp.open(filePath, 'r');
    try {
      await handle.read(header, 0, 4, 0);
    } finally {
      await handle.close();
    }
    if (header.toString('ascii') !== 'GGUF') {
      throw new Error(t('That file is not a valid GGUF model.'));
    }
    const filename = path.basename(filePath);
    const matching = extra.fromHub ? null : CATALOG.find((model) => model.filename === filename);
    const installed = this.store.getInstalledModels().filter((entry) => entry.path !== filePath);
    const size = extra.parts ? extra.parts.reduce((sum, part) => sum + part.size, 0) : stat.size;
    const entry = {
      id: extra.id || matching?.id || newId('model-'),
      catalogId: matching?.id || '',
      name: extra.name || matching?.name || filename.replace(/\.gguf$/i, ''),
      filename,
      path: filePath,
      ...(extra.parts ? { parts: extra.parts } : {}),
      ...(extra.mmproj ? { mmproj: extra.mmproj } : {}),
      size,
      sizeLabel: formatBytes(size),
      quant: matching?.quant || extra.quant || '',
      params: matching?.params || extra.params || '',
      license: matching?.license || extra.license || 'See model card',
      repo: matching?.repo || extra.repo || '',
      addedAt: new Date().toISOString(),
      imported: Boolean(extra.imported),
    };
    installed.push(entry);
    await this.store.setInstalledModels(installed);
    if (!this.store.getSettings().activeModelId) {
      await this.store.updateSettings({ activeModelId: entry.id });
    }
    this.emit('models:changed', { reason: 'installed', model: entry });
    return entry;
  }

  startDownload(id, overrides = {}) {
    if (this.active) throw new Error(t('Another model download is already running.'));
    const catalog = this.getCatalogModel(id);
    const model = catalog || {
      id,
      name: overrides.name || 'Custom model',
      filename: overrides.filename,
      url: overrides.url,
      sizeBytes: overrides.sizeBytes || 0,
      license: overrides.license || 'See model card',
      repo: overrides.repo || '',
      custom: true,
    };
    if (!model.url) throw new Error(t('This model has no download URL.'));
    if (!model.filename) {
      const clean = new URL(model.url).pathname.split('/').pop();
      model.filename = decodeURIComponent(clean || `${id}.gguf`);
    }
    if (!model.filename.toLowerCase().endsWith('.gguf')) {
      throw new Error(t('The URL must point to a .gguf file.'));
    }
    // The name comes from a decoded URL, so %5C or %2F must not walk out of the models folder.
    if (/[\\/:]|\.\./.test(model.filename)) {
      throw new Error(t('That URL has an unsafe file name.'));
    }

    // A model from the Hub can be several files, and is kept in its own folder because
    // different repositories often use the same file name.
    const fromHub = Boolean(overrides.files);
    const directory = fromHub ? path.join(this.modelsDir, 'hub', overrides.folder) : this.modelsDir;
    const files = fromHub ? overrides.files : [{ url: model.url, filename: model.filename, size: model.sizeBytes || 0 }];
    if (fromHub && !isInside(directory, this.modelsDir)) throw new Error(t('That model has an unsafe folder name.'));
    if (files.some((file) => /[\\/:]|\.\./.test(file.filename) || !file.filename.toLowerCase().endsWith('.gguf'))) {
      throw new Error(t('That model has an unsafe file name.'));
    }
    const installedModels = this.store.getInstalledModels();
    const existing = fromHub
      ? installedModels.find((entry) => entry.id === id)
      : installedModels.find((entry) => entry.catalogId === id || entry.filename === model.filename);
    if (existing) return Promise.resolve(existing);

    const destination = path.join(directory, files[0].filename);
    const vision = overrides.vision || null;
    this.resumeArgs.set(id, overrides);
    this.downloadFiles.set(id, [...files, ...(vision ? [vision] : [])].map((file) => path.join(directory, file.filename)));
    if (!this.writtenFiles.has(id)) this.writtenFiles.set(id, new Set());
    if (vision && /[\\/:]|\.\./.test(vision.filename)) throw new Error(t('That model has an unsafe file name.'));
    const totalBytes = [...files, ...(vision ? [vision] : [])].reduce((sum, file) => sum + (file.size || 0), 0);
    const controller = new AbortController();
    this.activeController = controller;
    this.active = id;
    this.states.set(id, {
      id,
      status: 'connecting',
      percent: 0,
      received: 0,
      total: model.sizeBytes || 0,
      speed: 0,
      error: '',
      model,
    });
    this.emit('models:progress', this.states.get(id));

    const task = (async () => {
      try {
        this.states.set(id, { ...this.states.get(id), status: 'downloading' });
        await this.assertDiskSpace(directory, totalBytes);
        let doneBytes = 0;
        const parts = [];
        let visionPart = null;
        for (const file of [...files, ...(vision ? [vision] : [])]) {
          const target = path.join(directory, file.filename);
          const present = fromHub && file.size ? await fsp.stat(target).catch(() => null) : null;
          let size = present?.size;
          if (!present || present.size !== file.size) {
            const result = await downloadFile(file.url, target, {
              signal: controller.signal,
              expectedSize: file.size,
              label: model.name,
              onProgress: (progress) => {
                const received = doneBytes + (progress.received || 0);
                const total = totalBytes || progress.total;
                const next = {
                  ...this.states.get(id),
                  status: 'downloading',
                  ...progress,
                  received,
                  total,
                  percent: total ? Math.min(100, (received / total) * 100) : progress.percent,
                };
                this.states.set(id, next);
                this.emit('models:progress', next);
              },
            });
            size = result.size;
            this.writtenFiles.get(id)?.add(path.resolve(target));
          }
          if (file === vision) visionPart = { path: target, size };
          else parts.push({ path: target, size });
          doneBytes += size;
        }
        const result = { path: destination, size: doneBytes };
        const entry = await this.registerFile(result.path, {
          id: model.id,
          name: model.name,
          quant: model.quant,
          params: model.params,
          license: model.license,
          repo: model.repo,
          ...(fromHub ? { fromHub, parts } : {}),
          ...(visionPart ? { mmproj: visionPart } : {}),
        });
        const done = {
          ...this.states.get(id),
          status: 'done',
          percent: 100,
          received: result.size,
          total: result.size,
          entry,
        };
        this.states.set(id, done);
        this.emit('models:progress', done);
        return entry;
      } catch (err) {
        const stopped = err.name === 'AbortError' || controller.signal.aborted;
        const paused = stopped && this.stopReason === 'pause';
        // Cancel throws the partial files away; pause keeps them, so Resume continues from there.
        if (stopped && !paused) await this.removePartialFiles(id);
        const failed = {
          ...this.states.get(id),
          status: paused ? 'paused' : stopped ? 'cancelled' : 'error',
          speed: 0,
          error: paused ? '' : stopped ? t('Download cancelled.') : err.message,
        };
        this.states.set(id, failed);
        this.emit('models:progress', failed);
        if (!stopped) throw err;
        return null;
      } finally {
        this.active = null;
        this.activeController = null;
        this.stopReason = null;
      }
    })();

    task.catch(() => {});
    return task;
  }

  /** Stops a download and deletes what it wrote so far. A paused download is cancelled too. */
  async cancelDownload(id) {
    const state = this.states.get(id);
    if (this.active !== id) {
      if (state?.status !== 'paused') return false;
      await this.removePartialFiles(id);
      const cancelled = { ...state, status: 'cancelled', error: t('Download cancelled.') };
      this.states.set(id, cancelled);
      this.emit('models:progress', cancelled);
      return true;
    }
    if (state) this.states.set(id, { ...state, status: 'cancelling' });
    this.stopReason = 'cancel';
    this.activeController?.abort();
    return true;
  }

  /** Stops a download but keeps what it has, so it can continue later (also after closing Uma). */
  pauseDownload(id) {
    if (this.active !== id) return false;
    const state = this.states.get(id);
    if (state) this.states.set(id, { ...state, status: 'pausing' });
    this.emit('models:progress', this.states.get(id));
    this.stopReason = 'pause';
    this.activeController?.abort();
    return true;
  }

  /** Continues a paused download from where it stopped. */
  resumeDownload(id) {
    if (this.active && this.active !== id) throw new Error(t('Another model download is already running.'));
    if (this.active === id) return this.states.get(id) || null;
    const task = this.startDownload(id, this.resumeArgs.get(id) || {});
    task?.catch?.(() => {});
    return this.states.get(id) || null;
  }

  /** The files a stopped download wrote, unless an installed model uses them. */
  async removePartialFiles(id) {
    const used = new Set();
    for (const entry of this.store.getInstalledModels()) {
      used.add(path.resolve(entry.path));
      for (const part of entry.parts || []) used.add(path.resolve(part.path));
      if (entry.mmproj) used.add(path.resolve(entry.mmproj.path));
    }
    const written = this.writtenFiles.get(id) || new Set();
    for (const file of this.downloadFiles.get(id) || []) {
      if (!isInside(file, this.modelsDir)) continue;
      await fsp.rm(`${file}.part`, { force: true }).catch(() => {});
      // Only a complete file this download wrote, and no installed model uses.
      if (written.has(path.resolve(file)) && !used.has(path.resolve(file))) await fsp.rm(file, { force: true }).catch(() => {});
    }
    this.writtenFiles.delete(id);
  }

  async remove(id) {
    const installed = this.store.getInstalledModels();
    const entry = installed.find((model) => model.id === id);
    if (!entry) throw new Error(t('Model not found.'));
    if (!isInside(entry.path, this.modelsDir)) {
      throw new Error(t('Refusing to delete a file outside the Uma model folder.'));
    }
    const parts = entry.parts?.length ? entry.parts.map((part) => part.path) : [entry.path];
    if (entry.mmproj && isInside(entry.mmproj.path, this.modelsDir)) parts.push(entry.mmproj.path);
    if (parts.some((part) => !isInside(part, this.modelsDir))) {
      throw new Error(t('Refusing to delete a file outside the Uma model folder.'));
    }
    await Promise.all(parts.map((part) => fsp.rm(part, { force: true })));
    if (entry.parts?.length) await fsp.rmdir(path.dirname(entry.path)).catch(() => {});
    this.infoCache.delete(id);
    const remaining = installed.filter((model) => model.id !== id);
    await this.store.setInstalledModels(remaining);
    const settings = this.store.getSettings();
    if (settings.activeModelId === id) {
      await this.store.updateSettings({ activeModelId: remaining[0]?.id || '' });
    }
    this.emit('models:changed', { reason: 'removed', model: entry });
  }

  async assertDiskSpace(directory, bytes) {
    if (!bytes) return;
    await ensureDir(directory);
    const stats = await fsp.statfs(directory).catch(() => null);
    if (!stats) return;
    const free = stats.bavail * stats.bsize;
    if (free < bytes + 512 * 1024 * 1024) {
      throw new Error(t('Not enough disk space: this model needs {0}, and the drive has {1} free.', [formatBytes(bytes), formatBytes(free)]));
    }
  }

  /** The real layer sizes and limits of an installed model, read from its file header. */
  async modelInfo(id) {
    if (this.infoCache.has(id)) return this.infoCache.get(id);
    const entry = await this.getModel(id);
    if (!entry) throw new Error(t('Model not found.'));
    const parts = entry.parts?.length ? entry.parts : [{ path: entry.path, size: entry.size }];
    const info = await readModelInfo(parts.map((part) => ({ source: fileSource(part.path), size: part.size })));
    const withVision = { ...info, mmprojBytes: entry.mmproj?.size || 0 };
    this.infoCache.set(id, withVision);
    return withVision;
  }

  async updateVision(id, mmproj) {
    const installed = this.store.getInstalledModels();
    const next = installed.map((entry) => {
      if (entry.id !== id) return entry;
      const { mmproj: _old, ...rest } = entry;
      return mmproj ? { ...rest, mmproj } : rest;
    });
    await this.store.setInstalledModels(next);
    this.infoCache.delete(id);
    this.emit('models:changed', { reason: 'vision' });
  }

  /** Downloads a vision file for a model that is already installed. */
  async downloadVision(id, file, source = {}) {
    const entry = await this.getModel(id);
    if (!entry) throw new Error(t('Model not found.'));
    if (this.active) throw new Error(t('Another model download is already running.'));
    const directory = entry.parts?.length ? path.dirname(entry.path) : path.join(this.modelsDir, 'vision', entry.id.replace(/[^\w.-]/g, '_'));
    const target = path.join(directory, path.basename(file.path));
    const taskId = `${id}:vision`;
    const controller = new AbortController();
    this.active = taskId;
    this.activeController = controller;
    const model = { id: taskId, name: `Vision file for ${entry.name}` };
    const publish = (state) => {
      const next = { id: taskId, model, ...this.states.get(taskId), ...state };
      this.states.set(taskId, next);
      this.emit('models:progress', next);
    };
    try {
      await this.assertDiskSpace(directory, file.size);
      publish({ status: 'downloading', percent: 0, received: 0, total: file.size, speed: 0, error: '' });
      const result = await downloadFile(file.url, target, {
        signal: controller.signal,
        expectedSize: file.size,
        label: model.name,
        onProgress: (progress) => publish({ status: 'downloading', ...progress }),
      });
      // Where it came from, when not the model's own repository (shown in the model's settings).
      await this.updateVision(id, { path: result.path, size: result.size, ...(source.match && source.match !== 'own' ? { from: source.from, match: source.match } : {}) });
      publish({ status: 'done', percent: 100 });
    } catch (err) {
      const cancelled = err.name === 'AbortError' || controller.signal.aborted;
      publish({ status: cancelled ? 'cancelled' : 'error', error: cancelled ? t('Download cancelled.') : err.message });
      if (!cancelled) throw err;
    } finally {
      this.active = null;
      this.activeController = null;
    }
  }

  /** Copies a vision file the user already has, after checking that it really is one. */
  async importVision(id, sourcePath) {
    const entry = await this.getModel(id);
    if (!entry) throw new Error(t('Model not found.'));
    const stat = await fsp.stat(sourcePath);
    const header = await readGguf(fileSource(sourcePath), stat.size);
    const kind = String(header.metadata['general.architecture'] || '');
    const type = String(header.metadata['general.type'] || '');
    if (kind !== 'clip' && type !== 'mmproj') throw new Error(t('That GGUF is not a vision file. Choose a file with “mmproj” in its name.'));
    const directory = path.join(this.modelsDir, 'vision', entry.id.replace(/[^\w.-]/g, '_'));
    await this.assertDiskSpace(directory, stat.size);
    const target = path.join(directory, path.basename(sourcePath));
    await copyModelFile(sourcePath, target);
    await this.updateVision(id, { path: target, size: stat.size });
  }

  async removeVision(id) {
    const entry = await this.getModel(id);
    if (!entry?.mmproj) return;
    if (isInside(entry.mmproj.path, this.modelsDir)) await fsp.rm(entry.mmproj.path, { force: true });
    await this.updateVision(id, null);
  }

  async diskUsage() {
    const installed = this.store.getInstalledModels();
    return installed.reduce((sum, entry) => sum + (entry.size || 0), 0);
  }
}

module.exports = { ModelManager, CATALOG, HANDWRITTEN };
