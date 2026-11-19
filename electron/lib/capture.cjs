// Pictures for a model that can see: a screenshot of one window or of the whole screen, and a web
// page or HTML file drawn in a hidden window. The full picture goes to the model once; a small
// copy is kept in the chat so the user sees what the model saw. Nothing leaves this PC.
const { desktopCapturer, BrowserWindow, screen } = require('electron');
const { pathToFileURL } = require('node:url');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

// Wide enough to read interface text, small enough to cost a local model about a thousand tokens.
const MODEL_WIDTH = 1280;
const THUMB_WIDTH = 420;
const PAGE_SIZE = { width: 1280, height: 900 };
const PAGE_TIMEOUT_MS = 25000;

function pack(image, name, width = MODEL_WIDTH) {
  const size = image.getSize();
  if (!size.width || !size.height) throw new Error(`The picture of ${name} came out empty.`);
  const forModel = size.width > width ? image.resize({ width, quality: 'best' }) : image;
  const thumb = image.resize({ width: Math.min(THUMB_WIDTH, size.width), quality: 'good' });
  const shown = forModel.getSize();
  return {
    name,
    width: shown.width,
    height: shown.height,
    image: `data:image/jpeg;base64,${forModel.toJPEG(82).toString('base64')}`,
    thumbnail: `data:image/jpeg;base64,${thumb.toJPEG(70).toString('base64')}`,
  };
}

/**
 * One part of a picture at full sharpness. The whole screen is shown to the model 1280 pixels wide,
 * which blurs small text; `zoom` is [x0, y0, x1, y1] in that picture, and the same part is cut out
 * of the screen's real pixels, so a quarter of the screen comes out twice as sharp for the same cost.
 */
function closer(image, zoom, name) {
  const size = image.getSize();
  const scale = size.width > MODEL_WIDTH ? size.width / MODEL_WIDTH : 1;
  const whole = { width: Math.round(size.width / scale), height: Math.round(size.height / scale) };
  const numbers = zoom.map((value) => Math.round(Number(value)));
  if (numbers.length !== 4 || numbers.some((value) => !Number.isFinite(value))) throw new Error('Give "zoom" as four numbers: [left, top, right, bottom], positions in the picture of ' + name + '.');
  const left = Math.max(0, Math.min(numbers[0], numbers[2]));
  const top = Math.max(0, Math.min(numbers[1], numbers[3]));
  const right = Math.min(whole.width, Math.max(numbers[0], numbers[2]));
  const bottom = Math.min(whole.height, Math.max(numbers[1], numbers[3]));
  if (right - left < 40 || bottom - top < 40) throw new Error(`That part is too small or outside the picture, which is ${whole.width}×${whole.height}. Give "zoom" as [left, top, right, bottom] inside it, at least 40 wide and high.`);
  let part = image.crop({ x: Math.round(left * scale), y: Math.round(top * scale), width: Math.round((right - left) * scale), height: Math.round((bottom - top) * scale) });
  // A small part is also drawn twice as large: a model reads small letters better when they are big,
  // and the picture still costs no more than one of the whole screen.
  const cut = part.getSize();
  if (cut.width < 800) part = part.resize({ width: Math.min(MODEL_WIDTH, cut.width * 2), quality: 'best' });
  const shot = pack(part, `part of ${name}`);
  return { ...shot, zoom: { left, top, right, bottom, times: Math.round((shot.width / (right - left)) * 10) / 10 } };
}

/** A window whose title contains `title` (any case), or the main screen when no title is given. */
async function captureScreen(title = '', zoom = null, width = MODEL_WIDTH) {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: title ? ['window'] : ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
    fetchWindowIcons: false,
  });
  if (!title) {
    const main = sources.find((source) => String(source.display_id) === String(display.id)) || sources[0];
    if (!main) throw new Error('The screen could not be captured.');
    return zoom ? closer(main.thumbnail, zoom, 'the whole screen') : pack(main.thumbnail, 'the whole screen', width);
  }
  const wanted = title.toLowerCase();
  const match = sources.find((source) => source.name.toLowerCase() === wanted)
    || sources.find((source) => source.name.toLowerCase().includes(wanted));
  if (!match) {
    const open = sources.map((source) => source.name).filter(Boolean).slice(0, 20);
    throw new Error(`No open window has "${title}" in its title. Open windows: ${open.length ? open.join(' | ') : 'none'}. A program must be running (start it with run_command and Start-Process) and not minimized.`);
  }
  if (match.thumbnail.isEmpty()) throw new Error(`The window "${match.name}" is minimized or hidden, so there is nothing to see. Ask the user to bring it to the front.`);
  return zoom ? closer(match.thumbnail, zoom, `the window "${match.name}"`) : pack(match.thumbnail, `the window "${match.name}"`);
}

/** A web page (url) or an HTML file (file), drawn in a window nobody sees. */
async function capturePage({ url = '', file = '' }) {
  const target = url || pathToFileURL(file).toString();
  const win = new BrowserWindow({
    ...PAGE_SIZE,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'uma-page-preview', backgroundThrottling: false },
  });
  try {
    // The page is only looked at: no downloads, no pop-ups, no camera or location, no leaving the page's own scheme.
    win.webContents.session.on('will-download', (event) => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await Promise.race([
      win.loadURL(target),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('The page took too long to load.')), PAGE_TIMEOUT_MS)),
    ]);
    // Fonts, images and first scripts get a moment to finish.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const title = win.webContents.getTitle();
    return pack(await win.webContents.capturePage(), `the page ${url || file}${title ? ` ("${title}")` : ''}`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * A PDF of a page, printed on A4 in a window nobody sees: `html` (a whole HTML document, as
 * markdown.cjs makes it) or an HTML `file` of the project. Returns the bytes of the PDF. This is
 * how Uma makes a PDF with no other program: the same engine that shows its own window prints it.
 */
async function printPdf({ html = '', file = '' }) {
  // The text goes through a file of its own, so that its length is no limit.
  const own = file ? '' : path.join(os.tmpdir(), `uma-print-${process.pid}-${Date.now()}.html`);
  if (own) await fsp.writeFile(own, html, 'utf8');
  const win = new BrowserWindow({
    ...PAGE_SIZE,
    show: false,
    // A page Uma wrote itself runs no script; a page of the project may need its own to draw.
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: Boolean(file), partition: 'uma-page-preview', backgroundThrottling: false },
  });
  try {
    win.webContents.session.on('will-download', (event) => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await Promise.race([
      win.loadURL(pathToFileURL(file || own).toString()),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('The page took too long to load.')), PAGE_TIMEOUT_MS)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, file ? 900 : 150));
    return await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'A4' });
  } finally {
    if (!win.isDestroyed()) win.destroy();
    if (own) await fsp.rm(own, { force: true }).catch(() => {});
  }
}

/** What ToolRunner calls: { window } for the screen, { page: { url } | { file } } for a page. */
// `width`: a smaller picture of the whole screen (the glance that comes back with an action).
async function capture({ window: title, page, zoom = null, width = MODEL_WIDTH } = {}) {
  return page ? capturePage(page) : captureScreen(String(title || '').trim(), zoom, Math.max(320, Math.min(MODEL_WIDTH, Number(width) || MODEL_WIDTH)));
}

module.exports = { capture, printPdf };
