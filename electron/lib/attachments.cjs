// Files given to the model through the chat. They are copied into app data and never touch the workspace.
const path = require('node:path');
const zlib = require('node:zlib');
const fsp = require('node:fs/promises');
const { ensureDir, newId, isProbablyBinary } = require('./util.cjs');
const { t } = require('./i18n.cjs');

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
const ID_RE = /^a_[a-z0-9]+$/;

/** Reads one file out of a zip (a .docx is a zip) with no extraction to disk. */
function readZipEntry(buffer, wanted) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error(t('That file is damaged: it is not a valid Word document.'));
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (name === wanted) {
      const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED_BYTES });
      throw new Error(t('That Word document uses a compression type Uma cannot read.'));
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function extractDocx(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml');
  if (!xml) throw new Error(t('That file has no document text. Is it a real .docx file?'));
  const text = xml.toString('utf8')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeXml(text).replace(/\n{3,}/g, '\n\n').trim();
}

async function extractPdf(buffer) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch (err) {
    if (/password/i.test(err.message)) throw new Error(t('That PDF is password-protected. Remove the password, then attach it again.'));
    throw new Error(t('Uma could not read that PDF: {0}', [err.message]));
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((page, index) => `[Page ${index + 1}]\n${String(page).trim()}`);
  const empty = !text.some((page) => String(page).trim());
  if (empty) throw new Error(t('That PDF has no text layer, so it is probably a scan. Attach screenshots of the pages instead, with a vision model.'));
  return { text: pages.join('\n\n').trim(), pages: totalPages };
}

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le', 2);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le');
  if (isProbablyBinary(buffer)) return null;
  return buffer.toString('utf8').replace(/^﻿/, '');
}

/** The readable text of a document, or an error that says what to do instead. */
async function extractDocument(name, buffer) {
  const extension = path.extname(name).toLowerCase();
  if (extension === '.pdf') return extractPdf(buffer);
  if (extension === '.docx') return { text: extractDocx(buffer) };
  if (extension === '.doc') throw new Error(t('Older .doc files are not supported. Save it as .docx or PDF, then attach it again.'));
  if (['.xlsx', '.xls', '.xlsm'].includes(extension)) throw new Error(t('Spreadsheets are not supported yet. Save it as .csv, then attach it again.'));
  if (['.pptx', '.ppt'].includes(extension)) throw new Error(t('Presentations are not supported yet. Export it as a PDF, then attach it again.'));
  const text = decodeText(buffer);
  if (text === null) throw new Error(t('Uma cannot read {0} files. Attach a text file, PDF, Word document, or image.', [extension || 'this kind of']));
  return { text };
}

class AttachmentStore {
  constructor({ dir }) {
    this.dir = dir;
  }

  fileFor(id, extension) {
    if (!ID_RE.test(String(id))) throw new Error(t('Invalid attachment.'));
    return path.join(this.dir, `${id}.${extension}`);
  }

  /** Saves a file. An image must already be a PNG; the window converts and scales images. */
  async add({ name, kind, bytes, thumbnail = '' }) {
    const buffer = Buffer.from(bytes);
    const cleanName = path.basename(String(name || 'attachment')).slice(0, 200);
    if (buffer.length > MAX_INPUT_BYTES) throw new Error(t('{0} is over the 50 MB limit.', [cleanName]));
    if (!buffer.length) throw new Error(`${cleanName} is empty.`);
    await ensureDir(this.dir);
    const id = newId('a_');
    if (kind === 'image') {
      if (buffer.toString('latin1', 1, 4) !== 'PNG') throw new Error(t('{0} could not be read as an image.', [cleanName]));
      await fsp.writeFile(this.fileFor(id, 'png'), buffer);
      return { id, name: cleanName, kind: 'image', size: buffer.length, thumbnail: String(thumbnail).slice(0, 60000) };
    }
    const { text, pages } = await extractDocument(cleanName, buffer);
    if (!text.trim()) throw new Error(t('{0} has no text in it.', [cleanName]));
    const kept = text.slice(0, MAX_TEXT_CHARS);
    await fsp.writeFile(this.fileFor(id, 'txt'), kept, 'utf8');
    return { id, name: cleanName, kind: 'document', size: buffer.length, chars: kept.length, ...(pages ? { pages } : {}), clipped: kept.length < text.length };
  }

  async text(id) {
    return fsp.readFile(this.fileFor(id, 'txt'), 'utf8');
  }

  async imageDataUrl(id) {
    const data = await fsp.readFile(this.fileFor(id, 'png'));
    return `data:image/png;base64,${data.toString('base64')}`;
  }

  async remove(ids) {
    await Promise.all(ids.flatMap((id) => (ID_RE.test(String(id))
      ? ['png', 'txt'].map((extension) => fsp.rm(this.fileFor(id, extension), { force: true }))
      : [])));
  }
}

module.exports = { AttachmentStore, extractDocument, readZipEntry };
