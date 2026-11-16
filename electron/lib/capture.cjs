// Pictures for a model that can see: a screenshot of one window or of the whole screen, and a web
// page or HTML file drawn in a hidden window. The full picture goes to the model once; a small
// copy is kept in the chat so the user sees what the model saw. Nothing leaves this PC.
const { desktopCapturer, BrowserWindow, screen } = require('electron');
const { pathToFileURL } = require('node:url');

// Wide enough to read interface text, small enough to cost a local model about a thousand tokens.
const MODEL_WIDTH = 1280;
const THUMB_WIDTH = 420;
const PAGE_SIZE = { width: 1280, height: 900 };
const PAGE_TIMEOUT_MS = 25000;

function pack(image, name) {
  const size = image.getSize();
  if (!size.width || !size.height) throw new Error(`The picture of ${name} came out empty.`);
  const forModel = size.width > MODEL_WIDTH ? image.resize({ width: MODEL_WIDTH, quality: 'best' }) : image;
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

/** A window whose title contains `title` (any case), or the main screen when no title is given. */
async function captureScreen(title = '') {
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
    return pack(main.thumbnail, 'the whole screen');
  }
  const wanted = title.toLowerCase();
  const match = sources.find((source) => source.name.toLowerCase() === wanted)
    || sources.find((source) => source.name.toLowerCase().includes(wanted));
  if (!match) {
    const open = sources.map((source) => source.name).filter(Boolean).slice(0, 20);
    throw new Error(`No open window has "${title}" in its title. Open windows: ${open.length ? open.join(' | ') : 'none'}. A program must be running (start it with run_command and Start-Process) and not minimized.`);
  }
  if (match.thumbnail.isEmpty()) throw new Error(`The window "${match.name}" is minimized or hidden, so there is nothing to see. Ask the user to bring it to the front.`);
  return pack(match.thumbnail, `the window "${match.name}"`);
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

/** What ToolRunner calls: { window } for the screen, { page: { url } | { file } } for a page. */
async function capture({ window: title, page } = {}) {
  return page ? capturePage(page) : captureScreen(String(title || '').trim());
}

module.exports = { capture };
