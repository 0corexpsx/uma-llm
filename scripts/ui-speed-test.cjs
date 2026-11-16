// Opens a saved conversation whose reply carries speed readings, and checks the line under it.
//   node_modules\electron\dist\electron.exe scripts\ui-speed-test.cjs
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');
const dataDir = path.join(root, '.testdata', 'ui-speed', 'data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(path.join(dataDir, 'conversations'), { recursive: true });
fs.mkdirSync(shots, { recursive: true });
const now = new Date().toISOString();
fs.writeFileSync(path.join(dataDir, 'conversations', 'c_speedtest.json'), JSON.stringify({
  id: 'c_speedtest',
  title: 'Speed test',
  createdAt: now,
  updatedAt: now,
  preview: 'what does notes.md say?',
  messages: [
    { id: 'm_1', role: 'user', content: 'what does notes.md say?', createdAt: now },
    {
      id: 'm_2', role: 'assistant', content: 'It says hello.', createdAt: now, finishedAt: now, status: 'done', modelName: 'Test model',
      blocks: [{ type: 'text', text: 'It says hello.' }],
      stats: { calls: 2, promptTokens: 3200, promptMs: 64000, cachedTokens: 3000, outputTokens: 25, outputMs: 12500, firstTokenMs: 61000, totalMs: 79000 },
    },
  ],
}));
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ acceptedTermsVersion: require('../package.json').version, language: 'en', workspacePath: path.join(root, 'demo-workspace'), lastConversationId: 'c_speedtest' }));
process.env.UMA_USER_DATA = dataDir;
process.env.UMA_TEST_HIDE = '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logFile = path.join(shots, 'ui-speed.log');
fs.rmSync(logFile, { force: true });

async function run() {
  let window;
  for (let attempt = 0; attempt < 200 && !window; attempt += 1) {
    await sleep(150);
    [window] = BrowserWindow.getAllWindows();
  }
  const page = window.webContents;
  let text = '';
  for (let attempt = 0; attempt < 150 && !text; attempt += 1) {
    await sleep(200);
    text = await page.executeJavaScript("(document.querySelector('.message-speed') || { innerText: '' }).innerText", true).catch(() => '');
    // The conversation may need a click in the sidebar to open.
    if (!text && attempt === 20) await page.executeJavaScript("[...document.querySelectorAll('button, [role=button], .thread-item')].find((item) => item.textContent.includes('Speed test'))?.click()", true).catch(() => {});
  }
  fs.writeFileSync(path.join(shots, 'reply-speed.png'), (await page.capturePage()).toPNG());
  fs.appendFileSync(logFile, `speed line: ${text || 'NOT FOUND'}\n`);
  if (!text) throw new Error('the speed line is not shown');
}

require('../electron/main.cjs');
app.whenReady().then(() => run()).then(() => app.exit(0)).catch((err) => {
  fs.appendFileSync(logFile, `UI TEST FAILED: ${err.message}\n`);
  app.exit(1);
});
