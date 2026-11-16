const path = require('node:path');
const fs = require('node:fs/promises');
const { _electron: electron } = require('playwright-core');

const root = path.join(__dirname, '..');
const shots = path.join(root, '.shots');

async function main() {
  await fs.mkdir(shots, { recursive: true });
  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.'],
    cwd: root,
    env: {
      ...process.env,
      UMA_USER_DATA: path.join(root, '.testdata', 'fresh-ui', 'data'),
      UMA_TEST_HIDE: '1',
      ELECTRON_RUN_AS_NODE: undefined,
    },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log('PAGE ERROR:', error.message));
  await page.waitForSelector('.onboarding', { timeout: 30000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForSelector('.model-picker', { timeout: 15000 });

  const small = page.locator('.model-option', { hasText: 'Qwen2.5 0.5B' }).first();
  await small.click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /Download .*model/ }).click();
  console.log('model download started');
  await page.waitForSelector('.installed-callout', { timeout: 300000 });
  await page.screenshot({ path: path.join(shots, 'onboard-model-downloaded.png') });
  console.log('model downloaded');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.waitForSelector('.engine-card', { timeout: 15000 });
  await page.getByRole('button', { name: 'Install the engine' }).click();
  console.log('engine install started');
  await page.waitForSelector('.engine-card.is-installed', { timeout: 300000 });
  await page.screenshot({ path: path.join(shots, 'onboard-engine-installed.png') });
  console.log('engine installed');

  await page.getByRole('button', { name: 'Open my Uma' }).click();
  await page.waitForSelector('.shell', { timeout: 30000 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(shots, 'fresh-ready.png') });
  console.log('fresh setup complete');
  await app.close();
}

main().catch((err) => {
  console.error('FRESH SETUP TEST FAILED:', err);
  process.exit(1);
});
