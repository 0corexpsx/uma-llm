const path = require('node:path');
const fsp = require('node:fs/promises');
const { ensureDir, newId, readJson, writeJsonAtomic } = require('./util.cjs');
const { t } = require('./i18n.cjs');

class ConversationStore {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    this.removed = new Set();
    this.index = null;
    this.indexing = null;
    this.savedMeta = new Map();
  }

  async init() {
    await ensureDir(this.dir);
  }

  fileFor(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(t('Invalid conversation id.'));
    return path.join(this.dir, `${id}.json`);
  }

  /** What the sidebar shows for one conversation. */
  metaOf(data) {
    return {
      id: data.id,
      title: data.title || 'Untitled',
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messageCount: data.messages?.length || 0,
      preview: data.preview || '',
    };
  }

  /**
   * The list is asked for after every reply. Reading and parsing every saved conversation each time
   * grew slower with each chat (a long one is megabytes), so the files are read once, several at a
   * time, and the list is then kept up to date by save and remove.
   */
  async loadIndex() {
    if (this.index) return this.index;
    if (!this.indexing) {
      this.indexing = (async () => {
        const files = (await fsp.readdir(this.dir).catch(() => [])).filter((file) => file.endsWith('.json'));
        const index = new Map();
        for (let start = 0; start < files.length; start += 16) {
          const batch = await Promise.all(files.slice(start, start + 16)
            .map((file) => readJson(path.join(this.dir, file), null).catch(() => null)));
          for (const data of batch) if (data?.id) index.set(data.id, this.metaOf(data));
        }
        // Anything saved or removed while the files were being read is newer than what was read.
        for (const [id, meta] of this.savedMeta) index.set(id, meta);
        for (const id of this.removed) index.delete(id);
        this.index = index;
        return index;
      })().finally(() => { this.indexing = null; });
    }
    return this.indexing;
  }

  async list() {
    const items = [...(await this.loadIndex()).values()];
    items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return items;
  }

  async get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const data = await readJson(this.fileFor(id), null);
    if (!data) return null;
    // A reply still marked as being written when its file is first read was cut off: Uma closed
    // while it ran (often while a big model was loading). It would otherwise show as working forever.
    for (const message of data.messages || []) {
      if (message.role === 'assistant' && message.status === 'streaming') {
        message.status = 'stopped';
        message.interrupted = true;
      }
    }
    this.cache.set(id, data);
    return data;
  }

  async create({ title = 'New conversation' } = {}) {
    const now = new Date().toISOString();
    const conversation = {
      id: newId('c_'),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
      preview: '',
    };
    this.cache.set(conversation.id, conversation);
    await this.save(conversation);
    return conversation;
  }

  async save(conversation) {
    // A run that is still stopping must not bring a deleted conversation back.
    if (this.removed.has(conversation.id)) return conversation;
    conversation.updatedAt = new Date().toISOString();
    const firstUser = conversation.messages.find((message) => message.role === 'user');
    conversation.preview = firstUser ? String(firstUser.content || '').slice(0, 120) : '';
    this.cache.set(conversation.id, conversation);
    const meta = this.metaOf(conversation);
    this.savedMeta.set(conversation.id, meta);
    this.index?.set(conversation.id, meta);
    // Saved after every tool step, so written compactly: indented, a long chat was twice the size.
    await writeJsonAtomic(this.fileFor(conversation.id), conversation, { pretty: false });
    return conversation;
  }

  async rename(id, title) {
    const conversation = await this.get(id);
    if (!conversation) throw new Error(t('Conversation not found.'));
    conversation.title = String(title || '').slice(0, 120) || 'Untitled';
    await this.save(conversation);
    return conversation;
  }

  async remove(id) {
    this.removed.add(id);
    this.cache.delete(id);
    this.savedMeta.delete(id);
    this.index?.delete(id);
    await fsp.rm(this.fileFor(id), { force: true });
  }
}

function titleFromText(text) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[#>*\-\s]+/, '')
    .trim();
  if (!clean) return 'New conversation';
  return clean.length > 58 ? `${clean.slice(0, 57).trimEnd()}…` : clean;
}

module.exports = { ConversationStore, titleFromText };
