// Writes a Word document (.docx) from the parts markdown.cjs reads: headings, paragraphs, lists,
// tables, code and quotes, with bold, italic and links. A .docx is a zip of a few XML files; both
// are written here, so making one needs no program and no download. Word, LibreOffice, Pages and
// Google Docs open the result.
const zlib = require('node:zlib');
const { titleOf } = require('./markdown.cjs');

// ---- the zip ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip file holding `files` ([{ name, data }]), each one compressed. */
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  // 1 January 2026, 00:00: the same bytes for the same text, whenever it is made.
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ---- the document ----

// Characters XML does not allow are dropped; the rest is escaped.
const xml = (text) => String(text).replace(/[^\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]/gu, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function style(id, name, { basedOn = 'Normal', next = 'Normal', paragraph = '', run = '', type = 'paragraph', heading = 0 } = {}) {
  return `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${basedOn ? `<w:basedOn w:val="${basedOn}"/>` : ''}${type === 'paragraph' ? `<w:next w:val="${next}"/>` : ''}<w:qFormat/>`
    + `${paragraph || heading ? `<w:pPr>${paragraph}${heading ? `<w:outlineLvl w:val="${heading - 1}"/>` : ''}</w:pPr>` : ''}${run ? `<w:rPr>${run}</w:rPr>` : ''}</w:style>`;
}
const HEADING_SIZES = [36, 28, 24, 22, 22, 22];
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${W}>`
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + HEADING_SIZES.map((size, index) => style(`Heading${index + 1}`, `heading ${index + 1}`, {
    heading: index + 1,
    paragraph: `<w:keepNext/><w:keepLines/><w:spacing w:before="${index ? 240 : 0}" w:after="120"/>`,
    // (Word wants these in its own order: bold, italic, then the size.)
    run: `<w:b/><w:bCs/>${index >= 4 ? '<w:i/><w:iCs/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
  })).join('')
  + style('ListParagraph', 'List Paragraph', { next: 'ListParagraph', paragraph: '<w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/>' })
  + style('Code', 'Code', { next: 'Code', paragraph: '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', run: '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/>' })
  + style('Quote', 'Quote', { paragraph: '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BBBBBB"/></w:pBdr><w:ind w:left="360"/>', run: '<w:i/><w:color w:val="444444"/>' })
  + style('Hyperlink', 'Hyperlink', { type: 'character', basedOn: '', run: '<w:color w:val="0B57D0"/><w:u w:val="single"/>' })
  + '<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:rPr></w:style>'
  + '</w:styles>';

const BULLETS = ['•', '◦', '▪', '•'];
const NUMBER_FORMATS = ['decimal', 'lowerLetter', 'lowerRoman', 'decimal'];
function numbering(orderedLists) {
  const levels = (ordered) => [0, 1, 2, 3].map((level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? NUMBER_FORMATS[level] : 'bullet'}"/>`
    + `<w:lvlText w:val="${ordered ? `%${level + 1}.` : BULLETS[level]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
  // Number 1 is the bullets; every numbered list gets a number of its own, so each starts at 1.
  let nums = '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
  for (let list = 0; list < orderedLists; list += 1) {
    nums += `<w:num w:numId="${list + 2}"><w:abstractNumId w:val="1"/>${[0, 1, 2, 3].map((level) => `<w:lvlOverride w:ilvl="${level}"><w:startOverride w:val="1"/></w:lvlOverride>`).join('')}</w:num>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>${nums}</w:numbering>`;
}

/**
 * The bytes of a .docx file for the parts of a document. `title` is what the file's properties
 * show; without one, the first heading is used.
 */
function toDocx(parts, { title = '' } = {}) {
  const links = [];
  const text = (value) => `<w:t xml:space="preserve">${xml(value)}</w:t>`;
  // `extra` true: every run in bold (the head of a table).
  const runs = (list, extra = false) => (list || []).map((run) => {
    if (run.br) return '<w:r><w:br/></w:r>';
    // One style for a run: a link that is also code is shown as a link.
    const look = run.link ? '<w:rStyle w:val="Hyperlink"/>' : run.code ? '<w:rStyle w:val="CodeChar"/>' : '';
    const props = `${look}${run.bold || extra ? '<w:b/><w:bCs/>' : ''}${run.italic ? '<w:i/><w:iCs/>' : ''}`;
    const body = `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${text(run.text)}</w:r>`;
    // Only addresses that open a page or a mailbox become links.
    if (run.link && /^(?:https?:|mailto:)/i.test(run.link)) {
      links.push(run.link);
      return `<w:hyperlink r:id="rLink${links.length}" w:history="1">${body}</w:hyperlink>`;
    }
    return body;
  }).join('');
  const paragraph = (content, props = '') => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${content}</w:p>`;
  const cell = (list, header) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="ECECEC"/>' : ''}</w:tcPr>${paragraph(runs(list, header), '<w:spacing w:after="0"/>')}</w:tc>`;
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`;

  let orderedLists = 0;
  const body = parts.map((part) => {
    if (part.type === 'heading') return paragraph(runs(part.runs), `<w:pStyle w:val="Heading${Math.min(6, Math.max(1, part.level))}"/>`);
    if (part.type === 'paragraph') return paragraph(runs(part.runs));
    if (part.type === 'quote') return paragraph(runs(part.runs), '<w:pStyle w:val="Quote"/>');
    if (part.type === 'rule') return paragraph('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>');
    if (part.type === 'code') {
      const lines = part.text.split('\n');
      return lines.map((line, index) => paragraph(`<w:r>${text(line)}</w:r>`, `<w:pStyle w:val="Code"/>${index === lines.length - 1 ? '<w:spacing w:after="160" w:line="240" w:lineRule="auto"/>' : ''}`)).join('');
    }
    if (part.type === 'list') {
      // Numbered and bulleted items may be mixed in one list (a numbered list with bullets under an item).
      const numbered = part.items.some((item) => item.ordered) ? (orderedLists += 1) + 1 : 0;
      return part.items.map((item) => paragraph(runs(item.runs), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${item.level}"/><w:numId w:val="${item.ordered ? numbered : 1}"/></w:numPr>`)).join('');
    }
    if (part.type === 'table') {
      const columns = part.header.length;
      return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders>`
        + `<w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${'<w:gridCol/>'.repeat(columns)}</w:tblGrid>`
        + `<w:tr><w:trPr><w:tblHeader/></w:trPr>${part.header.map((item) => cell(item, true)).join('')}</w:tr>`
        + `${part.rows.map((row) => `<w:tr>${row.map((item) => cell(item, false)).join('')}</w:tr>`).join('')}</w:tbl>${paragraph('', '<w:spacing w:after="0"/>')}`;
    }
    return '';
  }).join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body || paragraph('')}`
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1304" w:bottom="1418" w:left="1304" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>';
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PACKAGE_RELS}">`
    + `<Relationship Id="rStyles" Type="${OFFICE_RELS}/styles" Target="styles.xml"/><Relationship Id="rNumbering" Type="${OFFICE_RELS}/numbering" Target="numbering.xml"/>`
    + `${links.map((link, index) => `<Relationship Id="rLink${index + 1}" Type="${OFFICE_RELS}/hyperlink" Target="${xml(link)}" TargetMode="External"/>`).join('')}</Relationships>`;
  const name = xml(title || titleOf(parts) || 'Document');
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
      + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PACKAGE_RELS}">`
      + `<Relationship Id="rId1" Type="${OFFICE_RELS}/officeDocument" Target="word/document.xml"/>`
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
    { name: 'docProps/core.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">'
      + `<dc:title>${name}</dc:title><dc:creator>Uma LLM</dc:creator></cp:coreProperties>` },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: numbering(orderedLists) },
    { name: 'word/_rels/document.xml.rels', data: documentRels },
  ]);
}

module.exports = { toDocx, zip, crc32 };
