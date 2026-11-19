// The closer look (look_at_screen with "zoom") on the real screen: a small window of this script's
// own, half red and half blue, is found in the picture of the whole screen and then looked at
// closer. The cut-out must be that window, larger than in the whole picture. Nothing is saved but
// one picture of the cut-out in .shots; no model is used.
//   node_modules\electron\dist\electron.exe scripts\ui-zoom-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, screen, nativeImage } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
fs.mkdirSync(shots, { recursive: true });
const logFile = path.join(shots, 'ui-zoom.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
const check = (ok, text) => { log(`${ok ? 'OK  ' : 'FAIL'} ${text}`); if (!ok) process.exitCode = 1; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The colour at a point of a picture given as a data: address, as [red, green, blue]. */
function colourAt(dataUrl, x, y) {
  const image = nativeImage.createFromDataURL(dataUrl);
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const at = (Math.min(size.height - 1, Math.max(0, Math.round(y))) * size.width + Math.min(size.width - 1, Math.max(0, Math.round(x)))) * 4;
  return [bitmap[at + 2], bitmap[at + 1], bitmap[at]];
}
const isRed = ([r, g, b]) => r > 180 && g < 90 && b < 90;
const isBlue = ([r, g, b]) => b > 180 && r < 90 && g < 90;

async function main() {
  app.setPath('userData', path.join(root, '.testdata', 'ui-zoom', 'electron-data'));
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const { capture } = require('../electron/lib/capture.cjs');
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const area = display.workArea;
  const bounds = { x: area.x + 200, y: area.y + 150, width: 480, height: 320 };
  const win = new BrowserWindow({ ...bounds, frame: false, alwaysOnTop: true, show: false, resizable: false });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<body style="margin:0;display:flex;height:100vh"><div style="flex:1;background:#e00000"></div><div style="flex:1;background:#0000e0"></div></body>')}`);
  win.show();
  win.moveTop();
  // The window may take a moment to be on the screen (longer when another test has just ended).
  let whole = null;
  const seen = (shot) => {
    const shrinkNow = (display.size.width * scale) / shot.width;
    const at = (value) => Math.round((value * scale) / shrinkNow);
    return isRed(colourAt(shot.image, at(bounds.x + bounds.width * 0.25), at(bounds.y + bounds.height / 2)));
  };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(600);
    whole = await capture({});
    if (seen(whole)) break;
  }
  // Where the window is in the picture the model gets: the screen's real pixels, shrunk to the picture's width.
  const shrink = (display.size.width * scale) / whole.width;
  const inPicture = (value) => Math.round((value * scale) / shrink);
  const left = inPicture(bounds.x);
  const top = inPicture(bounds.y);
  const right = inPicture(bounds.x + bounds.width);
  const bottom = inPicture(bounds.y + bounds.height);
  log(`whole screen ${whole.width}×${whole.height}; the window is at (${left}, ${top}) to (${right}, ${bottom}) in it`);
  check(isRed(colourAt(whole.image, left + (right - left) * 0.25, (top + bottom) / 2)) && isBlue(colourAt(whole.image, left + (right - left) * 0.75, (top + bottom) / 2)), 'the window is where it should be in the picture of the whole screen');

  const part = await capture({ zoom: [left, top, right, bottom] });
  fs.writeFileSync(path.join(shots, 'zoom-part.jpg'), Buffer.from(part.image.split(',')[1], 'base64'));
  log(`closer look ${part.width}×${part.height}, ${part.zoom.times} times larger`);
  check(isRed(colourAt(part.image, part.width * 0.25, part.height / 2)) && isBlue(colourAt(part.image, part.width * 0.75, part.height / 2)), 'the closer look is that window: red on the left, blue on the right');
  // (A few pixels in: the outermost ones are blended with what lies beside the window when it is enlarged.)
  const inset = Math.round(part.width * 0.02);
  check(isRed(colourAt(part.image, inset, inset)) && isBlue(colourAt(part.image, part.width - inset, part.height - inset)), 'cut at its edges, not around it');
  check(part.width >= (right - left) && part.zoom.times >= 1, `it is at least as large as in the whole picture (${part.width} wide for ${right - left})`);
  check(shrink <= 1.01 || part.zoom.times > 1.05, `on a screen wider than the picture it is sharper (screen shrunk ${shrink.toFixed(2)} times, closer look ${part.zoom.times} times larger)`);

  // Corners given in the other order, and a part outside the picture.
  const swapped = await capture({ zoom: [right, bottom, left, top] });
  check(swapped.width === part.width && swapped.height === part.height, 'the corners may be given in either order');
  const outside = await capture({ zoom: [whole.width + 50, 10, whole.width + 300, 200] }).then(() => '', (err) => err.message);
  check(/too small or outside the picture/.test(outside), `a part outside the picture is refused: ${outside.slice(0, 70)}`);
  win.destroy();
}
main().catch((err) => { log(`UI TEST FAILED: ${err.stack}`); process.exitCode = 1; }).finally(() => app.exit(process.exitCode || 0));
