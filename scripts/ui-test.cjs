const path = require('node:path');
const fs = require('node:fs/promises');
const { _electron: electron } = require('playwright-core');

const root = path.join(__dirname, '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const shots = path.join(root, '.shots');

async function main() {
  await fs.mkdir(shots, { recursive: true });
  const env = {
    ...process.env,
    UMA_USER_DATA: path.join(root, '.testdata', 'ui', 'data'),
    UMA_TEST_HIDE: '1',
    ELECTRON_RUN_AS_NODE: undefined,
  };
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: root,
    env,
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log('PAGE ERROR:', error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('CONSOLE ERROR:', message.text());
  });
  await page.waitForSelector('.app', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(shots, 'ui-main.png') });
  console.log('main loaded:', await page.locator('.titlebar-center').innerText());

  await page.locator('.new-thread-btn').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, 'ui-empty.png') });

  const prompt = 'Create a file called studio-note.md with a three-line welcome to this workspace, using the write_file tool. Then tell me the path.';
  await page.locator('.composer textarea').fill(prompt);
  await page.locator('.composer textarea').press('Enter');
  console.log('sent prompt; waiting for local model...');

  await page.waitForSelector('.message.assistant', { timeout: 30000 });
  await page.waitForTimeout(1200);
  console.log('assistant so far:', (await page.locator('.message.assistant').last().innerText()).slice(0, 600));
  await page.screenshot({ path: path.join(shots, 'ui-waiting.png') });
  try {
    await page.waitForSelector('.tool-card', { timeout: 180000 });
  } catch (err) {
    console.log('no tool card. current chat:', (await page.locator('.message-list').innerText()).slice(0, 1800));
    await page.screenshot({ path: path.join(shots, 'ui-failed.png') });
    throw err;
  }
  await page.waitForFunction(() => {
    const textarea = document.querySelector('.composer textarea');
    return textarea && !textarea.disabled;
  }, { timeout: 240000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(shots, 'ui-chat.png') });
  console.log('assistant text:', (await page.locator('.message.assistant').last().innerText()).slice(0, 500));

  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.waitForTimeout(700);
  const readme = page.locator('.tree-row', { hasText: 'README.md' }).first();
  if (await readme.count()) {
    await readme.click();
    await page.waitForTimeout(900);
  }
  await page.screenshot({ path: path.join(shots, 'ui-files.png') });

  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shots, 'ui-models.png') });

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shots, 'ui-settings.png') });

  const created = await fs.readFile(path.join(root, 'demo-workspace', 'studio-note.md'), 'utf8').catch(() => '');
  console.log('studio-note.md:', created || '(missing)');

  await app.close();
  process.exit(created ? 0 : 2);
}

main().catch((err) => {
  console.error('UI TEST FAILED:', err);
  process.exit(1);
});
