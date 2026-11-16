// Picks the physical batch size (-ub) by itself. A model reads a message in blocks of that many
// tokens; with a helper PC every block crosses the network between the GPUs, so fewer, larger
// blocks can read faster, at the cost of more GPU memory. Which size is fastest depends on the
// model, the PCs and how the model is split, so Uma measures it: every reply already reports how
// fast its new text was read, and each load uses the best size so far or tries one not yet
// measured. Nothing is reloaded for this; a size only changes when the model loads anyway.
const path = require('node:path');
const fsp = require('node:fs/promises');

const CANDIDATES = [512, 1024, 2048];
// A reply counts when it read at least this much new text; shorter ones measure overhead, not reading.
const MIN_PROMPT_TOKENS = 400;
// A size is known once it has read this much over at least this many replies.
const ENOUGH_TOKENS = 3000;
const ENOUGH_REPLIES = 2;
// A larger size must be this much faster than a smaller one to be chosen: it costs GPU memory.
const WORTH_IT = 1.05;

class BatchTuner {
  constructor({ file }) {
    this.file = file;
    this.data = {};
    this.loaded = null;
    this.saving = null;
  }

  load() {
    if (!this.loaded) {
      this.loaded = fsp.readFile(this.file, 'utf8')
        .then((text) => { this.data = JSON.parse(text) || {}; })
        .catch(() => { this.data = {}; });
    }
    return this.loaded;
  }

  save() {
    this.saving = (this.saving || Promise.resolve())
      .then(() => fsp.mkdir(path.dirname(this.file), { recursive: true }))
      .then(() => fsp.writeFile(this.file, JSON.stringify(this.data, null, 1)))
      .catch(() => {});
    return this.saving;
  }

  entry(key) {
    if (!this.data[key]) this.data[key] = { sizes: {}, failed: [] };
    return this.data[key];
  }

  static measured(stat) {
    return Boolean(stat) && stat.tokens >= ENOUGH_TOKENS && stat.replies >= ENOUGH_REPLIES;
  }

  static speed(stat) {
    return stat && stat.ms > 0 ? (stat.tokens / stat.ms) * 1000 : 0;
  }

  /**
   * The size for this load: a candidate that still needs measuring, smallest first, or else the
   * fastest (a larger one only when it is clearly faster). `key` names the model, the helpers and
   * the engine, because a result only holds for that combination.
   */
  async choose(key) {
    await this.load();
    const entry = this.entry(key);
    const usable = CANDIDATES.filter((size) => !entry.failed.includes(size));
    const unknown = usable.find((size) => !BatchTuner.measured(entry.sizes[size]));
    if (unknown) return { size: unknown, exploring: true };
    return { size: this.best(key), exploring: false };
  }

  /** The fastest measured size, or 512 while nothing is known. */
  best(key) {
    const entry = this.entry(key);
    let best = CANDIDATES[0];
    for (const size of CANDIDATES) {
      if (entry.failed.includes(size) || !BatchTuner.measured(entry.sizes[size])) continue;
      if (size === best || !BatchTuner.measured(entry.sizes[best])
        || BatchTuner.speed(entry.sizes[size]) > BatchTuner.speed(entry.sizes[best]) * WORTH_IT) best = size;
    }
    return best;
  }

  /** One model call's reading: `tokens` new tokens in `ms`. */
  record(key, size, tokens, ms) {
    if (!key || !size || !(tokens >= MIN_PROMPT_TOKENS) || !(ms > 0)) return false;
    const entry = this.entry(key);
    const stat = entry.sizes[size] || { tokens: 0, ms: 0, replies: 0 };
    entry.sizes[size] = { tokens: stat.tokens + tokens, ms: stat.ms + ms, replies: stat.replies + 1 };
    this.save();
    return true;
  }

  /** The model did not load with this size (not enough GPU memory): it is not tried again. */
  fail(key, size) {
    const entry = this.entry(key);
    if (size > CANDIDATES[0] && !entry.failed.includes(size)) entry.failed.push(size);
    this.save();
  }

  async forget(key) {
    await this.load();
    delete this.data[key];
    await this.save();
  }

  /** For the model's settings: every size with its speed, and the one in use. */
  async report(key) {
    await this.load();
    const entry = this.entry(key);
    return {
      best: this.best(key),
      done: CANDIDATES.every((size) => entry.failed.includes(size) || BatchTuner.measured(entry.sizes[size])),
      sizes: CANDIDATES.map((size) => ({
        size,
        failed: entry.failed.includes(size),
        measured: BatchTuner.measured(entry.sizes[size]),
        replies: entry.sizes[size]?.replies || 0,
        tokensPerSecond: Math.round(BatchTuner.speed(entry.sizes[size]) * 10) / 10,
      })),
    };
  }
}

module.exports = { BatchTuner, CANDIDATES, MIN_PROMPT_TOKENS };
