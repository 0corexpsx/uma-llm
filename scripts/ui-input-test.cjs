// Real mouse and keyboard, through the same InputController the AI uses, but only inside a small
// test window this script opens: a click on a button, typing into a box, a key press, and the stop
// when the pointer is pushed into the top-left corner. The pointer is put back where it was.
//   node_modules\electron\dist\electron.exe scripts\ui-input-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, screen } = require('electron');
const { InputController, pictureSize } = require('../electron/lib/input.cjs');

const shots = path.join(__dirname, '..', '.shots');
fs.mkdirSync(shots, { recursive: true });
const logFile = path.join(shots, 'ui-input.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The same geometry main.cjs gives the AI's controller.
function screenGeometry() {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const inPoints = process.platform === 'darwin';
  return {
    pixelWidth: Math.round(display.size.width * scale),
    pixelHeight: Math.round(display.size.height * scale),
    inputWidth: inPoints ? display.size.width : Math.round(display.size.width * scale),
    inputHeight: inPoints ? display.size.height : Math.round(display.size.height * scale),
    originX: inPoints ? display.bounds.x : Math.round(display.bounds.x * scale),
    originY: inPoints ? display.bounds.y : Math.round(display.bounds.y * scale),
  };
}

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px sans-serif;background:#f4f4f4">
<button id="b" style="position:absolute;left:40px;top:40px;width:200px;height:60px">Play</button>
<input id="t" style="position:absolute;left:40px;top:140px;width:300px;height:30px">
<script>window.clicks=0;window.enters=0;document.getElementById('b').onclick=()=>{window.clicks++;document.getElementById('t').focus();};
document.getElementById('t').addEventListener('keydown',(e)=>{if(e.key==='Enter')window.enters++;});</script></body>`;

async function run() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const win = new BrowserWindow({ x: area.x + 200, y: area.y + 150, width: 420, height: 260, frame: false, alwaysOnTop: true, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  win.show();
  win.focus();
  await sleep(800);
  const page = win.webContents;
  const geometry = screenGeometry;
  const controller = new InputController({ geometry });
  const g = geometry();
  const picture = pictureSize(g);
  log(`screen: ${g.pixelWidth}×${g.pixelHeight} pixels, scale ${display.scaleFactor}; the AI's picture: ${picture.width}×${picture.height}`);
  let before = await controller.backend.pointer();
  // A pointer left in the corner (the stop gesture) would stop the test before it starts.
  if (before.x - g.originX <= 5 && before.y - g.originY <= 5) {
    before = { x: g.originX + Math.round(g.inputWidth / 2), y: g.originY + Math.round(g.inputHeight / 2) };
    await controller.backend.move(before.x, before.y);
  }

  // Where the button's middle is in the AI's picture: window position (DIP) -> pixels -> picture.
  const bounds = win.getContentBounds();
  const scale = display.scaleFactor || 1;
  const toPicture = (dipX, dipY) => ({
    x: Math.round(((dipX - display.bounds.x) * scale * picture.width) / g.pixelWidth),
    y: Math.round(((dipY - display.bounds.y) * scale * picture.height) / g.pixelHeight),
  });
  const button = toPicture(bounds.x + 140, bounds.y + 70);
  log(`button's middle in the AI's picture: (${button.x}, ${button.y})`);

  log(await controller.act('click', button));
  await sleep(300);
  const clicks = await page.executeJavaScript('window.clicks');
  log(`button clicks counted by the page: ${clicks}`);
  if (clicks !== 1) throw new Error('the click did not reach the button');

  log(await controller.act('type', { text: 'lofi music ☕ è' }));
  log(await controller.act('keys', { keys: 'enter' }));
  await sleep(300);
  const typed = await page.executeJavaScript("document.getElementById('t').value");
  const enters = await page.executeJavaScript('window.enters');
  log(`text in the box: "${typed}"; Enter presses: ${enters}`);
  if (typed !== 'lofi music ☕ è' || enters !== 1) throw new Error('typing or the key press did not arrive');
  fs.writeFileSync(path.join(shots, 'input-window.png'), (await page.capturePage()).toPNG());

  // The emergency stop: the pointer in the top-left corner stops every action until resume().
  await controller.backend.move(g.originX, g.originY);
  await sleep(100);
  try {
    await controller.act('click', button);
    throw new Error('the click ran although the pointer was in the corner');
  } catch (err) {
    if (!/STOPPED/.test(err.message)) throw err;
    log(`pointer in the top-left corner: ${err.message.split(':')[0]}`);
  }
  try {
    await controller.act('keys', { keys: 'enter' });
    throw new Error('a key press ran after the stop');
  } catch (err) {
    if (!/STOPPED/.test(err.message)) throw err;
    log('later actions refused until the next message: OK');
  }
  controller.resume();
  await controller.backend.move(before.x, before.y);
  log(`pointer put back at (${before.x}, ${before.y})`);
  controller.stop();
  win.destroy();
  log('real click, typing, key press and the corner stop: OK');
}

app.whenReady().then(() => run())
  .then(() => app.exit(0))
  .catch((err) => {
    log(`INPUT TEST FAILED: ${err.message}`);
    app.exit(1);
  });
