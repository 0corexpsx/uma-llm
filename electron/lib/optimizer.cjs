// The plans behind "Optimize and benchmark" (benchmark.cjs): what is worth trying for a model on
// this PC, and which of the measured results to keep. No engine and no files here, so every rule
// can be tested with numbers alone (scripts/test-review.cjs).
//
// What is NOT tried, because it was measured on an RTX 3060 with two Tesla P40 (llama.cpp b12428,
// Qwen3.8 27B Q8 on the two P40, 2026-11-20) and made no difference worth a reload:
// - how far the model's own head guesses ahead (--spec-draft-n-max): 24.0 tok/s at the engine's
//   default of 3, then 23.8, 22.9 and 19.8 at 4, 6 and 8;
// - the physical batch size, with every layer on this PC's cards: a 2,500-token text was read at
//   251, 256 and 258 tok/s with 512, 1024 and 2048 (it matters with helper PCs: see batchTuner.cjs);
// - an f16 context cache instead of q8_0: 24.6 against 23.9 tok/s, 3% and within what two runs differ by.
const { chosenCards, cardChoice } = require('./placement.cjs');
const { t } = require('./i18n.cjs');

// A change is kept when it writes at least this much faster than what the model had.
const FASTER = 1.03;
// A larger context is kept when the model writes no slower than this share of its speed before.
const NOT_SLOWER = 0.97;
// Context sizes "Optimize and benchmark" may raise a model to: enough for a long task on files,
// and still read back from disk in seconds when a chat is opened again.
const CONTEXT_STEPS = [32768, 65536];

const short = (name) => String(name || '').replace(/^NVIDIA\s+(GeForce\s+)?/i, '');

/**
 * The ways to place the model that are worth measuring, besides the one it has now (which is
 * measured first, as the baseline). `cards` are this PC's graphics cards as the engine lists them
 * (LlamaManager.cards.all, with the free memory each had before the model was loaded), `needMB`
 * what the whole model needs on cards.
 * - A number of GPU layers set by hand, against Uma's own choice: a hand-set 47 left 19 of 66
 *   layers on the CPU of a PC whose three cards had room for all of them.
 * - With several cards and no helper PCs: all of them one after the other (layer) and at the same
 *   time (tensor), one card of each kind when the model fits on it, and the cards of one kind
 *   together. Cards of the same kind work best together: a 27B wrote 9.0 tok/s on an RTX 3060 with
 *   two Tesla P40 at the same time, and 12.5 on the two P40 alone.
 * Each step is { label, changes, split, devices }: `changes` are the model settings to try (null
 * takes a setting away), `devices` how many cards take part.
 */
function placementSteps({ cards = [], needMB = 0, overrides = {}, effective = {}, helpers = false } = {}) {
  const steps = [];
  const auto = overrides.gpuLayers !== undefined ? { gpuLayers: null } : {};
  if (overrides.gpuLayers !== undefined) steps.push({ label: t('GPU layers chosen by Uma'), changes: auto, split: '', devices: 0 });
  if (cards.length < 2 || helpers) return steps;
  const chosen = chosenCards(cards, effective.gpuCards);
  const now = chosen.length ? chosen : cards;
  const tensorNow = effective.splitMode === 'tensor';
  const add = (devices, split, label) => {
    // What the model has now is the baseline (or the step above): it is not measured twice.
    const sameCards = devices.length === now.length && devices.every((device) => now.includes(device));
    if (sameCards && (devices.length === 1 || (split === 'tensor') === tensorNow)) return;
    const all = devices.length === cards.length;
    steps.push({ label, split, devices: devices.length, all, changes: { ...auto, gpuCards: all ? null : cardChoice(devices), splitMode: split === 'tensor' ? 'tensor' : null } });
  };
  add(cards, 'layer', t('All cards, one after the other'));
  add(cards, 'tensor', t('All cards at the same time'));
  const kinds = new Map();
  for (const device of cards) kinds.set(device.card, [...(kinds.get(device.card) || []), device]);
  for (const [card, group] of kinds) {
    // One card of this kind alone: the one with the most free memory, which is also the one a load picks.
    const roomiest = [...group].sort((a, b) => b.freeMB - a.freeMB)[0];
    if (needMB > 0 && needMB <= roomiest.freeMB * 0.92) add([roomiest], 'layer', t('{0} alone', [short(card)]));
    const room = group.reduce((sum, device) => sum + device.freeMB, 0);
    if (group.length > 1 && group.length < cards.length && needMB > 0 && needMB <= room * 0.85) {
      const title = `${group.length}× ${short(card)}`;
      add(group, 'layer', t('{0}, one after the other', [title]));
      add(group, 'tensor', t('{0} at the same time', [title]));
    }
  }
  return steps;
}

/**
 * Whether a step for some of the cards can be left out, given what all the cards together already
 * showed: when they were measured both ways, a group of them is only tried the way that won.
 * `allSpeeds` is { layer, tensor } in tokens per second, a missing one not measured.
 */
function skipStep(step, allSpeeds = {}) {
  if (!step.split || step.all || step.devices < 2) return false;
  if (!(allSpeeds.layer > 0) || !(allSpeeds.tensor > 0)) return false;
  const winner = allSpeeds.tensor > allSpeeds.layer ? 'tensor' : 'layer';
  return step.split !== winner;
}

/**
 * The numbers of CPU threads to try besides the one in use. None when every layer is on a graphics
 * card: the threads then only hand tokens over (28, 14 and 8 threads wrote 12.54, 12.54 and 12.55
 * tok/s with a 27B on two Tesla P40).
 */
function threadCounts({ logical, now, allOnGpu }) {
  if (allOnGpu || !(logical > 0)) return [];
  return [...new Set([Math.max(1, Math.floor(logical / 2)), Math.min(8, logical)])].filter((count) => count !== now);
}

/** The fastest of `entries` when it writes clearly faster than `than`, else `than`. */
function fastest(entries, than) {
  return entries
    .filter((entry) => entry.write > 0)
    .reduce((best, entry) => (entry.write > best.write * FASTER ? entry : best), than);
}

/**
 * The context size to try instead of the one a model has: the largest step that is larger, that
 * the model was trained for, and that `fits` (a function of the size; without one, any does).
 * 0 when there is none. A larger context costs little memory with a model that keeps a cache on a
 * few of its layers (Qwen3.8 27B: 29.0 GB at 20,480 tokens, 30.6 GB at 65,536), and a task on files
 * fills a small one: a chat of 2026-11-20 reached 13,890 of 20,480 tokens, was trimmed, and the
 * engine read 33,229 tokens in all, most of them a second time.
 */
function contextTarget({ current, trained = 0, fits = () => true }) {
  for (const size of [...CONTEXT_STEPS].sort((a, b) => b - a)) {
    if (size > current && (!trained || size <= trained) && fits(size)) return size;
  }
  return 0;
}

/** Whether a larger context is kept: it loaded with every layer still on the cards, and writes no slower. */
function keepContext(entry, best, { allOnGpuBefore = true } = {}) {
  if (!entry || entry.failed || !(entry.write > 0)) return false;
  if (allOnGpuBefore && entry.allOnGpu === false) return false;
  return entry.write >= best.write * NOT_SLOWER;
}

module.exports = { placementSteps, skipStep, threadCounts, fastest, contextTarget, keepContext, FASTER, NOT_SLOWER, CONTEXT_STEPS };
