// A PDF and a Word file made by save_document with the real printer (the app's own engine, in a
// window nobody sees): the files are read back with the reader Uma uses for attachments, and a
// picture of the PDF's first page is saved in .shots. No model is used.
//   node_modules\electron\dist\electron.exe scripts\ui-document-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dir = path.join(root, '.testdata', 'ui-document');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
fs.mkdirSync(shots, { recursive: true });
const logFile = path.join(shots, 'ui-document.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
const check = (ok, text) => { log(`${ok ? 'OK  ' : 'FAIL'} ${text}`); if (!ok) process.exitCode = 1; };

const TEXT = [
  '# Cat care guide', '', 'A short guide with **bold**, *italic* and a [link](https://example.com).', '',
  '## Feeding', '', '1. Fresh water every day', '2. Two meals', '   - morning', '   - evening', '',
  '| Age | Meals | Note |', '| --- | ---: | --- |', '| Kitten | 4 | small portions |', '| Adult | 2 | measured |', '',
  '> Cats sleep twelve to sixteen hours a day.', '', '```', 'weight_kg * 60 = kcal per day', '```', '',
  ...Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1} of the guide, with enough words in it to fill a line of the page and wrap onto the next one as well.\n`),
  '## The end', '', 'Città, naïve, 日本語.',
].join('\n');

async function main() {
  app.setPath('userData', path.join(dir, 'electron-data'));
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const { Store } = require('../electron/lib/store.cjs');
  const { Workspace } = require('../electron/lib/workspace.cjs');
  const { ToolRunner } = require('../electron/lib/tools.cjs');
  const { printPdf } = require('../electron/lib/capture.cjs');
  const { extractDocument } = require('../electron/lib/attachments.cjs');
  const store = new Store(path.join(dir, 'data'));
  await store.init();
  await store.updateSettings({ allowEdits: true });
  const workspace = new Workspace({ root: path.join(dir, 'workspace'), trash: () => {} });
  await workspace.init();
  const tools = new ToolRunner({ workspace, store, onChanged: () => {}, printPdf });

  // PDF from Markdown.
  let result = await tools.run('save_document', { path: 'guide.pdf', content: TEXT });
  log(result.output);
  check(result.ok, 'the PDF is made');
  const pdf = fs.readFileSync(path.join(dir, 'workspace', 'guide.pdf'));
  check(pdf.subarray(0, 5).toString('latin1') === '%PDF-' && pdf.length > 5000, `it is a PDF file (${pdf.length} bytes)`);
  check(result.data.pages >= 2, `it has ${result.data.pages} pages`);
  const read = (await extractDocument('guide.pdf', pdf)).text;
  for (const words of ['Cat care guide', 'Fresh water every day', 'Kitten', 'small portions', 'twelve to sixteen hours', 'Paragraph 60 of the guide', 'Città, naïve']) {
    check(read.includes(words), `the PDF's text holds "${words}"`);
  }
  check(!/\*\*|^#\s/m.test(read), 'no Markdown signs are left in it');

  // PDF from an HTML page of the project, with the page's own look.
  fs.writeFileSync(path.join(dir, 'workspace', 'page.html'), '<!doctype html><html><head><title>Invoice</title><style>h1{color:#b00}</style></head><body><h1>Invoice 42</h1><p>Total: 99 euro</p></body></html>');
  result = await tools.run('save_document', { path: 'out/invoice.pdf', from: 'page.html' });
  check(result.ok, `a PDF from an HTML page: ${result.output.slice(0, 80)}`);
  check((await extractDocument('invoice.pdf', fs.readFileSync(path.join(dir, 'workspace', 'out', 'invoice.pdf')))).text.includes('Invoice 42'), 'it holds the page\'s text');

  // The same text as a Word file.
  result = await tools.run('save_document', { path: 'guide.docx', content: TEXT });
  check(result.ok, `the Word file is made: ${result.output.slice(0, 80)}`);
  const word = (await extractDocument('guide.docx', fs.readFileSync(path.join(dir, 'workspace', 'guide.docx')))).text;
  check(['Cat care guide', 'Fresh water every day', 'small portions', 'Paragraph 60 of the guide', 'Città, naïve, 日本語.'].every((words) => word.includes(words)), 'the Word file holds the text');

  // What the first page looks like: the PDF shown in a window, photographed.
  const win = new BrowserWindow({ width: 900, height: 1200, show: false, webPreferences: { plugins: true } });
  await win.loadURL(`file:///${path.join(dir, 'workspace', 'guide.pdf').replace(/\\/g, '/')}`);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  fs.writeFileSync(path.join(shots, 'document-pdf.png'), (await win.webContents.capturePage()).toPNG());
  win.destroy();
  log('picture of the PDF: .shots/document-pdf.png');
}
main().catch((err) => { log(`UI TEST FAILED: ${err.stack}`); process.exitCode = 1; }).finally(() => app.exit(process.exitCode || 0));
