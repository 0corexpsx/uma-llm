// Takes the three kinds of picture for real (the whole screen, one window, an HTML page) with
// electron/lib/capture.cjs, and saves what the model would be sent in .shots.
//   node_modules\electron\dist\electron.exe scripts\capture-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');
const { capture } = require('../electron/lib/capture.cjs');

const shots = path.join(__dirname, '..', '.shots');
fs.mkdirSync(shots, { recursive: true });
const log = (text) => fs.appendFileSync(path.join(shots, 'capture.log'), `${text}\n`);
fs.rmSync(path.join(shots, 'capture.log'), { force: true });
const save = (name, shot) => {
  fs.writeFileSync(path.join(shots, name), Buffer.from(shot.image.split(',')[1], 'base64'));
  log(`${name}: ${shot.name}, ${shot.width}x${shot.height}, to the model ${Math.round(shot.image.length / 1024)} KB, kept in the chat ${Math.round(shot.thumbnail.length / 1024)} KB`);
};

app.whenReady().then(async () => {
  // A window of our own with a known title and content, to be found by part of its title.
  const page = path.join(shots, 'capture-page.html');
  fs.writeFileSync(page, '<html><head><title>Uma Capture Test Window</title></head><body style="font:28px sans-serif;background:#102040;color:#fff;padding:40px"><h1>Process list</h1><table border="1" cellpadding="8"><tr><th>Name</th><th>PID</th><th>Memory</th></tr><tr><td>explorer.exe</td><td>4321</td><td>120 MB</td></tr><tr><td>chrome.exe</td><td>9876</td><td>850 MB</td></tr></table></body></html>');
  const win = new BrowserWindow({ width: 900, height: 600, title: 'Uma Capture Test Window' });
  await win.loadFile(page);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  save('capture-screen.jpg', await capture({}));
  save('capture-window.jpg', await capture({ window: 'capture test' }));
  save('capture-page.jpg', await capture({ page: { file: page } }));
  try {
    await capture({ window: 'no such window 12345' });
    log('missing window: NO ERROR (wrong)');
  } catch (err) {
    log(`missing window: ${err.message.slice(0, 160)}`);
  }
  log('capture: OK');
  app.exit(0);
}).catch((err) => { log(`CAPTURE FAILED: ${err.message}`); app.exit(1); });
