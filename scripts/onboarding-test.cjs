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
      UMA_USER_DATA: path.join(root, '.testdata', 'onboard-ui', 'data'),
      UMA_TEST_HIDE: '1',
      ELECTRON_RUN_AS_NODE: undefined,
    },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => console.log('PAGE ERROR:', error.message));
  await page.waitForSelector('.onboarding', { timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(shots, 'onboard-step1.png') });

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(shots, 'onboard-step2.png') });

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(shots, 'onboard-step3.png') });

  await page.getByRole('button', { name: 'Open my Uma' }).click();
  await page.waitForSelector('.shell', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(shots, 'after-onboarding.png') });
  console.log('title:', await page.locator('.chat-title-block h2').innerText().catch(() => '(none)'));
  await app.close();
}

main().catch((err) => {
  console.error('ONBOARDING TEST FAILED:', err);
  process.exit(1);
});
