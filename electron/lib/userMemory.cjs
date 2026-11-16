// Memory: lasting facts about the user (preferences, projects, how they like to work) that Uma
// keeps across chats. The user adds them in Settings → Memory, imports them from other assistants
// (ChatGPT, Claude, Gemini, other local agents) or exports them, and the model can save one with
// the `remember` tool. Imported text is data: it is shown to the model as information about the
// user, never as instructions.
const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

// How much memory goes into the instructions of a chat (about 1,500 tokens).
const PROMPT_CHARS = 6000;
const MAX_ITEM_CHARS = 600;
const MAX_ITEMS = 2000;

/** Same fact, different spacing, case or punctuation. */
function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** One line of an export, without list marks, numbering or wrapping quotes. */
function cleanLine(line) {
  return String(line)
    .replace(/^\s*(?:[-*•·▪◦‣–—>]+|\d{1,3}[.)]|\[[ x]\])\s+/i, '')
    .replace(/^\s*["“”']|["“”']\s*$/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A long paragraph becomes sentences that each fit an item. */
function splitLong(text) {
  if (text.length <= MAX_ITEM_CHARS) return [text];
  const out = [];
  let current = '';
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (current && current.length + sentence.length + 1 > MAX_ITEM_CHARS) {
      out.push(current);
      current = '';
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) out.push(current);
  return out.map((item) => item.slice(0, MAX_ITEM_CHARS));
}

// JSON exports: the text of a memory is under one of these names (Open WebUI, LibreChat, mem0 and
// most memory tools), or the file is a plain list of strings.
const TEXT_KEYS = ['memory', 'content', 'text', 'value', 'fact', 'note', 'description'];

function stringsFromJson(value, out = [], depth = 0) {
  if (depth > 8 || out.length > MAX_ITEMS) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsFromJson(item, out, depth + 1));
  else if (value && typeof value === 'object') {
    const key = TEXT_KEYS.find((name) => typeof value[name] === 'string');
    if (key) out.push(value[key]);
    else for (const child of Object.values(value)) if (child && typeof child === 'object') stringsFromJson(child, out, depth + 1);
  }
  return out;
}

/**
 * Turns an export (pasted text, Markdown, or a JSON file) into separate memories. Headings, empty
 * lines and the export's own framing ("Here is everything I remember…") are left out.
 */
function parseImport(text) {
  const raw = String(text || '').replace(/^﻿/, '').trim();
  if (!raw) return [];
  let pieces = null;
  if (/^[[{]/.test(raw)) {
    try {
      pieces = stringsFromJson(JSON.parse(raw)).flatMap((item) => String(item).split(/\r?\n/));
    } catch {}
  }
  if (!pieces) pieces = raw.split(/\r?\n/);
  const items = [];
  const seen = new Set();
  for (const piece of pieces) {
    if (/^\s*#{1,6}\s/.test(piece) || /^\s*(```|---+|===+)\s*$/.test(piece)) continue;
    const line = cleanLine(piece);
    if (line.length < 4) continue;
    // The framing the other assistant writes around the list, not facts about the user.
    if (/^(here(?:'s| is| are)|sure[,!]|certainly|of course|below (?:is|are)|this is (?:everything|what)|i (?:remember|know) the following|let me know)/i.test(line) && line.length < 160) continue;
    if (/:$/.test(line) && line.length < 60) continue;
    for (const part of splitLong(line)) {
      const key = normalize(part);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(part);
    }
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

// What to ask another assistant so it writes its memory out in a form Uma can read.
const EXPORT_PROMPT = 'List everything you remember about me: my name, work and projects, preferences, the way I like answers, tools and languages I use, and any instructions I have given you. Write one fact per line, each starting with "- ", with no introduction and no closing remarks.';

class UserMemory {
  constructor({ file }) {
    this.file = file;
    this.items = [];
    this.loaded = null;
  }

  load() {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const data = JSON.parse(await fsp.readFile(this.file, 'utf8'));
          this.items = Array.isArray(data.items) ? data.items.filter((item) => item && item.id && item.text) : [];
        } catch {
          this.items = [];
        }
      })();
    }
    return this.loaded;
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify({ items: this.items }, null, 1));
    await fsp.rename(temp, this.file);
  }

  async list() {
    await this.load();
    return this.items.map((item) => ({ ...item }));
  }

  /** Adds facts that are not there yet; returns how many were added. */
  async add(texts, source = 'you') {
    await this.load();
    const known = new Set(this.items.map((item) => normalize(item.text)));
    let added = 0;
    for (const text of [].concat(texts)) {
      for (const part of splitLong(String(text || '').replace(/\s+/g, ' ').trim())) {
        const key = normalize(part);
        if (!key || known.has(key) || this.items.length >= MAX_ITEMS) continue;
        known.add(key);
        this.items.push({ id: crypto.randomBytes(6).toString('hex'), text: part, source, createdAt: new Date().toISOString() });
        added += 1;
      }
    }
    if (added) await this.save();
    return added;
  }

  async update(id, text) {
    await this.load();
    const item = this.items.find((entry) => entry.id === id);
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS);
    if (!item || !clean) return false;
    item.text = clean;
    item.updatedAt = new Date().toISOString();
    await this.save();
    return true;
  }

  async remove(id) {
    await this.load();
    const before = this.items.length;
    this.items = id === '*' ? [] : this.items.filter((item) => item.id !== id);
    if (this.items.length !== before) await this.save();
  }

  /** Which of the parsed facts Uma already has, for the import preview. */
  async preview(texts) {
    await this.load();
    const known = new Set(this.items.map((item) => normalize(item.text)));
    return texts.map((text) => ({ text, known: known.has(normalize(text)) }));
  }

  /** Markdown that another assistant (or Uma on another PC) can import. */
  async exportText() {
    await this.load();
    return `# What Uma remembers about me\n\n${this.items.map((item) => `- ${item.text}`).join('\n')}\n`;
  }

  /**
   * The memory for the instructions of a new chat: the newest facts that fit, oldest first, and
   * the ids included (a chat keeps this text for its whole life, so the engine's saved reading of
   * the chat stays valid; see AgentRunner).
   */
  async forPrompt(limit = PROMPT_CHARS) {
    await this.load();
    const picked = [];
    let used = 0;
    for (const item of [...this.items].reverse()) {
      const line = `- ${item.text}`;
      if (used + line.length + 1 > limit) break;
      picked.unshift(item);
      used += line.length + 1;
    }
    return {
      ids: picked.map((item) => item.id),
      text: picked.map((item) => `- ${item.text}`).join('\n'),
      left: this.items.length - picked.length,
    };
  }
}

module.exports = { UserMemory, parseImport, normalize, EXPORT_PROMPT, PROMPT_CHARS };
