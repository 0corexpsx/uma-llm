const path = require('node:path');
const fs = require('node:fs/promises');
const { _electron: electron } = require('playwright-core');

const root = path.join(__dirname, '..');
const shots = path.join(root, 'docs', 'screenshots');

async function main() {
  await fs.mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.'],
    cwd: root,
    env: {
      ...process.env,
      UMA_USER_DATA: path.join(root, '.testdata', 'ui', 'data'),
      UMA_TEST_HIDE: '1',
      ELECTRON_RUN_AS_NODE: undefined,
    },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log('PAGE ERROR:', error.message));
  await page.waitForSelector('.shell', { timeout: 30000 });
  await page.waitForTimeout(1100);
  await page.screenshot({ path: path.join(shots, 'chat.png') });

  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.waitForTimeout(500);
  const readme = page.locator('.tree-row', { hasText: 'README.md' }).first();
  await readme.click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(shots, 'workspace.png') });

  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(shots, 'models.png') });

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(shots, 'settings.png') });

  await app.close();
  console.log('Captured docs screenshots');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
