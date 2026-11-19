// Markdown read into plain parts (headings, paragraphs, lists, tables, code), for the documents Uma
// makes itself: a PDF is printed from the HTML made here, and a Word file is written from the same
// parts (docx.cjs). Only what a document needs is read; anything else stays as the text it was.
//
// A part is one of:
//   { type: 'heading', level, runs }      { type: 'paragraph', runs }      { type: 'rule' }
//   { type: 'list', ordered, items: [{ level, runs }] }
//   { type: 'code', text }                { type: 'quote', runs }
//   { type: 'table', header: [runs], rows: [[runs]] }
// and a run is { text, bold, italic, code, link, br }.

const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The text of one line as runs: **bold**, *italic*, `code`, [text](address). */
function inline(text) {
  const runs = [];
  const add = (value, style = {}) => { if (value) runs.push({ text: value, ...style }); };
  const walk = (value, style) => {
    // The earliest of: code, link, bold, italic.
    const pattern = /(`+)([\s\S]+?)\1|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\5|(\*|_)(?=\S)([\s\S]+?)(?<=\S)\7(?![\w*])|~~(?=\S)([\s\S]+?)(?<=\S)~~/;
    let rest = value;
    while (rest) {
      const match = pattern.exec(rest);
      // "_" inside a word (snake_case) is not emphasis.
      if (match && match[7] === '_' && /\w/.test(rest[match.index - 1] || '')) {
        add(rest.slice(0, match.index + 1), style);
        rest = rest.slice(match.index + 1);
        continue;
      }
      if (!match) { add(rest, style); break; }
      add(rest.slice(0, match.index), style);
      if (match[1]) add(match[2].trim(), { ...style, code: true });
      else if (match[3]) walk(match[3], { ...style, link: match[4] });
      else if (match[5]) walk(match[6], { ...style, bold: true });
      else if (match[7]) walk(match[8], { ...style, italic: true });
      else walk(match[9], style);
      rest = rest.slice(match.index + match[0].length);
    }
  };
  // Two spaces or a backslash at the end of a line break it; a plain line end is a space.
  const lines = String(text).split('\n');
  lines.forEach((line, index) => {
    const hard = /(?: {2,}|\\)$/.test(line);
    walk(line.replace(/(?: {2,}|\\)$/, '').replace(/&nbsp;/g, ' '), {});
    if (index < lines.length - 1) runs.push(hard ? { text: '', br: true } : { text: ' ' });
  });
  return runs;
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
const TABLE_RULE_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_RE = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;

/** Markdown text as parts. */
function parseMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const parts = [];
  let index = 0;
  const blank = (line) => !line.trim();
  while (index < lines.length) {
    const line = lines[index];
    if (blank(line)) { index += 1; continue; }
    // ``` code ```
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) { body.push(lines[index]); index += 1; }
      index += 1;
      parts.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { parts.push({ type: 'heading', level: heading[1].length, runs: inline(heading[2]) }); index += 1; continue; }
    if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line)) { parts.push({ type: 'rule' }); index += 1; continue; }
    // A line of text with === or --- under it is a heading too.
    if (index + 1 < lines.length && /^\s{0,3}(=+|-+)\s*$/.test(lines[index + 1]) && !LIST_RE.test(line) && !line.includes('|')) {
      parts.push({ type: 'heading', level: lines[index + 1].trim()[0] === '=' ? 1 : 2, runs: inline(line.trim()) });
      index += 2;
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && TABLE_RULE_RE.test(lines[index + 1]) && lines[index + 1].includes('-')) {
      const header = cells(line).map(inline);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && !blank(lines[index])) {
        const row = cells(lines[index]).map(inline);
        while (row.length < header.length) row.push([]);
        rows.push(row.slice(0, header.length));
        index += 1;
      }
      parts.push({ type: 'table', header, rows });
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) { body.push(lines[index].replace(/^\s{0,3}>\s?/, '')); index += 1; }
      parts.push({ type: 'quote', runs: inline(body.join('\n')) });
      continue;
    }
    const first = LIST_RE.exec(line);
    if (first) {
      const ordered = Boolean(first[3]);
      const items = [];
      // How far in each open level starts: an item further in than the last opens a level under it.
      const indents = [first[1].length];
      while (index < lines.length) {
        const item = LIST_RE.exec(lines[index]);
        if (item) {
          const indent = item[1].length;
          while (indents.length > 1 && indent < indents.at(-1)) indents.pop();
          if (indent > indents.at(-1) && indents.length < 4) indents.push(indent);
          items.push({ level: indents.length - 1, ordered: Boolean(item[3]), text: item[4] });
          index += 1;
        } else if (!blank(lines[index]) && /^\s{2,}\S/.test(lines[index]) && items.length) {
          // A line set under an item continues it.
          items.at(-1).text += `\n${lines[index].trim()}`;
          index += 1;
        } else if (blank(lines[index]) && index + 1 < lines.length && LIST_RE.test(lines[index + 1])) {
          // After an empty line, bullets under numbers (or numbers under bullets) at the margin are a new list.
          const next = LIST_RE.exec(lines[index + 1]);
          if (next[1].length <= indents[0] && Boolean(next[3]) !== ordered) break;
          index += 1;
        } else {
          break;
        }
      }
      parts.push({ type: 'list', ordered, items: items.map((item) => ({ level: item.level, ordered: item.ordered, runs: inline(item.text.replace(/^\[[ xX]\]\s+/, (box) => (/x/i.test(box) ? '☑ ' : '☐ '))) })) });
      continue;
    }
    // A paragraph runs to the next blank line, or to something that starts another part.
    const body = [line];
    index += 1;
    while (index < lines.length && !blank(lines[index]) && !/^\s*(?:```|~~~|#{1,6}\s|>)/.test(lines[index]) && !LIST_RE.test(lines[index])
      && !(lines[index].includes('|') && index + 1 < lines.length && TABLE_RULE_RE.test(lines[index + 1]))
      && !/^\s{0,3}(=+|-+)\s*$/.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    parts.push({ type: 'paragraph', runs: inline(body.map((item) => item.replace(/^\s+/, '')).join('\n')) });
  }
  return parts;
}

/** The words of some runs, with no styling. */
const plainText = (runs) => (runs || []).map((run) => (run.br ? ' ' : run.text)).join('').replace(/\s+/g, ' ').trim();

/** The first heading, or the first words: what the document is called. */
function titleOf(parts) {
  const heading = parts.find((part) => part.type === 'heading');
  return plainText(heading?.runs || parts.find((part) => part.runs)?.runs || []).slice(0, 120);
}

function runsToHtml(runs) {
  return (runs || []).map((run) => {
    if (run.br) return '<br>';
    let html = escapeHtml(run.text);
    if (run.code) html = `<code>${html}</code>`;
    if (run.bold) html = `<strong>${html}</strong>`;
    if (run.italic) html = `<em>${html}</em>`;
    // Only addresses that open a page or a mailbox become links.
    if (run.link && /^(?:https?:|mailto:|#)/i.test(run.link)) html = `<a href="${escapeHtml(run.link)}">${html}</a>`;
    return html;
  }).join('');
}

const PRINT_CSS = `
  @page { size: A4; margin: 22mm 20mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.5 "Segoe UI", "Helvetica Neue", Arial, "Noto Sans", sans-serif; color: #1b1b1b; margin: 0; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.3em 0 0.5em; page-break-after: avoid; }
  h1 { font-size: 22pt; margin-top: 0; } h2 { font-size: 16pt; } h3 { font-size: 13pt; } h4, h5, h6 { font-size: 11pt; }
  p { margin: 0 0 0.75em; } ul, ol { margin: 0 0 0.75em; padding-left: 1.6em; } li { margin: 0.15em 0; }
  code { font: 9.5pt Consolas, "Cascadia Mono", Menlo, monospace; background: #f1f1f1; padding: 0 0.25em; border-radius: 3px; }
  pre { font: 9.5pt/1.4 Consolas, "Cascadia Mono", Menlo, monospace; background: #f4f4f4; border: 1px solid #ddd; border-radius: 4px; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; margin: 0 0 0.9em; }
  blockquote { margin: 0 0 0.75em; padding: 0.1em 0 0.1em 1em; border-left: 3px solid #bbb; color: #444; }
  table { border-collapse: collapse; margin: 0 0 0.9em; width: 100%; page-break-inside: auto; } tr { page-break-inside: avoid; }
  th, td { border: 1px solid #999; padding: 4px 8px; text-align: left; vertical-align: top; } th { background: #ececec; }
  hr { border: 0; border-top: 1px solid #999; margin: 1.2em 0; } a { color: #0b57d0; }
`;

/** A whole page of HTML for the parts, laid out for printing on A4. */
function toHtml(parts, { title = '' } = {}) {
  const body = parts.map((part) => {
    if (part.type === 'heading') return `<h${part.level}>${runsToHtml(part.runs)}</h${part.level}>`;
    if (part.type === 'paragraph') return `<p>${runsToHtml(part.runs)}</p>`;
    if (part.type === 'rule') return '<hr>';
    if (part.type === 'code') return `<pre>${escapeHtml(part.text)}</pre>`;
    if (part.type === 'quote') return `<blockquote>${runsToHtml(part.runs)}</blockquote>`;
    if (part.type === 'table') {
      return `<table><thead><tr>${part.header.map((cell) => `<th>${runsToHtml(cell)}</th>`).join('')}</tr></thead><tbody>${part.rows.map((row) => `<tr>${row.map((cell) => `<td>${runsToHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    if (part.type === 'list') {
      // Items of a deeper level open a list inside the list.
      let html = '';
      const open = [];
      for (const item of part.items) {
        while (open.length > item.level + 1) html += `</li></${open.pop()}>`;
        if (open.length === item.level + 1) html += '</li>';
        while (open.length < item.level + 1) { const tag = item.ordered ? 'ol' : 'ul'; open.push(tag); html += `<${tag}>`; }
        html += `<li>${runsToHtml(item.runs)}`;
      }
      while (open.length) html += `</li></${open.pop()}>`;
      return html;
    }
    return '';
  }).join('\n');
  return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(title || titleOf(parts) || 'Document')}</title>\n<style>${PRINT_CSS}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

module.exports = { parseMarkdown, toHtml, titleOf, plainText, inline, escapeHtml };
