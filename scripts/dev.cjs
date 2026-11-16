// `npm run dev`: Vite with hot reload, plus Electron pointed at it.
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const url = 'http://localhost:5173';
const shell = process.platform === 'win32';

const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { cwd: root, stdio: 'inherit', shell });

async function waitForVite() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Vite did not start.');
}

waitForVite().then(() => {
  const env = { ...process.env, VITE_DEV_SERVER_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = spawn('npx', ['electron', '.'], { cwd: root, stdio: 'inherit', shell, env });
  electron.on('exit', (code) => {
    vite.kill();
    process.exit(code ?? 0);
  });
}).catch((err) => {
  console.error(err.message);
  vite.kill();
  process.exit(1);
});
