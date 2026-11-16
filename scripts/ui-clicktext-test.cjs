// click_text for real: a small test window this script opens shows a list of "videos" (links), and
// the same InputController the AI uses finds them by name through Windows UI Automation and clicks
// the one asked for with the real mouse. The pointer is put back where it was.
//   node_modules\electron\dist\electron.exe scripts\ui-clicktext-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, screen } = require('electron');
const { InputController } = require('../electron/lib/input.cjs');

const shots = path.join(__dirname, '..', '.shots');
fs.mkdirSync(shots, { recursive: true });
const logFile = path.join(shots, 'ui-clicktext.log');
fs.rmSync(logFile, { force: true });
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function screenGeometry() {
  const display = screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  return {
    pixelWidth: Math.round(display.size.width * scale),
    pixelHeight: Math.round(display.size.height * scale),
    inputWidth: Math.round(display.size.width * scale),
    inputHeight: Math.round(display.size.height * scale),
    originX: Math.round(display.bounds.x * scale),
    originY: Math.round(display.bounds.y * scale),
  };
}

const TITLES = ['HD Dubstep - Earthquake (Fytch Remix)', 'Ellie Goulding - Lights (Dubstep Remix) [HD]', 'The Beauty of Dubstep HD', 'Best Female Vocal Dubstep Mix 3 HOURS'];
const PAGE = `<!doctype html><meta charset="utf-8"><title>Uma click test</title><body style="margin:0;font:15px sans-serif;background:#fff;padding:16px">
${TITLES.map((title, index) => `<p><a href="#v${index}" data-i="${index}" style="display:inline-block;padding:6px">${title}</a></p>`).join('')}
<button onclick="window.clicked='Subscribe'">Subscribe</button><div style="height:2400px"></div><form onsubmit="event.preventDefault();window.sent=document.getElementById('em').value"><label for="em">Indirizzo Email *</label> <input id="em" type="email"><button type="submit">Invia Richiesta di Contatto</button></form>
<script>window.clicked='';const titles=${JSON.stringify(TITLES)};document.querySelectorAll('a').forEach((link)=>link.addEventListener('click',(event)=>{event.preventDefault();window.clicked=titles[Number(link.dataset.i)];}));</script></body>`;

async function run() {
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ x: area.x + 220, y: area.y + 140, width: 520, height: 360, alwaysOnTop: true, show: false, title: 'Uma click test', webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  win.show();
  win.focus();
  await sleep(900);
  const controller = new InputController({ geometry: screenGeometry });
  const before = await controller.backend.pointer();
  let ok = true;
  try {
    const items = await controller.findItems('Uma click test');
    log(`items found by name: ${items.length} (${items.map((item) => `${item.kind} "${item.name}"`).join(', ')})`);
    if (!TITLES.every((title) => items.some((item) => item.name === title))) throw new Error('not every link was found by name');
    for (const [asked, expected] of [['The Beauty of Dubstep HD', TITLES[2]], ['ellie goulding lights', TITLES[1]], ['Subscribe', 'Subscribe']]) {
      const item = await controller.clickItem(asked, 'Uma click test');
      await sleep(300);
      const clicked = await win.webContents.executeJavaScript('window.clicked');
      log(`click_text "${asked}" -> clicked ${item.kind} "${item.name}", the page got: "${clicked}" ${clicked === expected ? 'OK' : 'WRONG'}`);
      if (clicked !== expected) ok = false;
    }
    // Further down the page: found by name although out of view, scrolled to, typed into, sent.
    const all = await controller.findItems('Uma click test', { all: true });
    const below = all.find((item) => item.name === 'Invia Richiesta di Contatto');
    log(`the form's button is found below the fold: ${below ? `yes (hidden: ${below.hidden})` : 'NO'}`);
    if (!below || !below.hidden) ok = false;
    const field = await controller.clickItem('Indirizzo Email', 'Uma click test');
    await controller.backend.type('mario@example.org');
    await sleep(200);
    const sendButton = await controller.clickItem('Invia Richiesta di Contatto', 'Uma click test');
    await sleep(300);
    const sent = await win.webContents.executeJavaScript('window.sent || ""');
    log(`click_text "${field.name}" + typing + click_text "${sendButton.name}" -> the form sent: "${sent}" ${sent === 'mario@example.org' ? 'OK' : 'WRONG'}`);
    if (sent !== 'mario@example.org') ok = false;
    await controller.clickItem('Not on this page at all', 'Uma click test').then(() => { ok = false; log('a missing name was clicked: WRONG'); }, (err) => log(`missing name: refused (${err.message.slice(0, 90)}…) OK`));
  } finally {
    await controller.backend.move(before.x, before.y).catch(() => {});
    controller.backend.stop?.();
    win.destroy();
  }
  if (!ok) throw new Error('a click went to the wrong place');
  log('click_text with the real mouse: OK');
}

app.whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((err) => { log(`UI TEST FAILED: ${err.message}`); app.exit(1); });
