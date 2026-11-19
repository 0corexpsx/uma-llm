const os = require('node:os');
const { execFile } = require('node:child_process');

function run(file, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? '' : String(stdout || '').trim()),
    );
  });
}

const NVIDIA_QUERY = ['--query-gpu=name,memory.total,memory.free,memory.used,utilization.gpu', '--format=csv,noheader,nounits'];

/**
 * nvidia-smi's answer to NVIDIA_QUERY, one line per card ("Tesla P40, 24576, 24210, 366, 0"), as
 * [{ name, totalMB, freeMB, usedMB, percent }]. A PC can hold several cards, and they need not
 * be alike.
 */
function parseNvidiaCards(text) {
  const cards = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const [name, total, free, used, percent] = line.split(',').map((value) => value.trim());
    const totalMB = Number(total);
    if (!name || !(totalMB > 0)) continue;
    cards.push({ name, totalMB, freeMB: Number(free) || 0, usedMB: Number(used) || 0, percent: Number(percent) || 0 });
  }
  return cards;
}

/** Every NVIDIA card in this PC with its memory and how busy it is, or [] without nvidia-smi. */
async function nvidiaCards(timeout = 5000) {
  if (process.platform === 'darwin') return [];
  return parseNvidiaCards(await run('nvidia-smi', NVIDIA_QUERY, timeout));
}

/** One name for several cards: "NVIDIA GeForce RTX 3060 + 2× Tesla P40". */
function gpuSummary(names) {
  const counts = new Map();
  for (const name of names.filter(Boolean)) counts.set(name, (counts.get(name) || 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${count}× ${name}` : name)).join(' + ');
}

/** AMD and Intel GPUs on Linux report VRAM in sysfs; the card with the most memory wins. */
async function amdVram() {
  const fsp = require('node:fs/promises');
  let best = null;
  for (const card of await fsp.readdir('/sys/class/drm').catch(() => [])) {
    if (!/^card\d+$/.test(card)) continue;
    const dir = `/sys/class/drm/${card}/device`;
    const total = Number(await fsp.readFile(`${dir}/mem_info_vram_total`, 'utf8').catch(() => ''));
    if (!total || (best && best.totalBytes >= total)) continue;
    const used = Number(await fsp.readFile(`${dir}/mem_info_vram_used`, 'utf8').catch(() => '')) || 0;
    const percent = Number(await fsp.readFile(`${dir}/gpu_busy_percent`, 'utf8').catch(() => '')) || 0;
    best = { totalBytes: total, usedBytes: used, percent };
  }
  return best;
}

let cached = null;

async function detectHardware(force = false) {
  if (cached && !force) return cached;
  const cpus = os.cpus();
  const ramGB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  let gpu = '';
  let vramGB = 0;
  let cudaVersion = '';
  let cudaLibs = [];
  let appleSilicon = false;
  // Every graphics card, when there are several: the model can be shared between them.
  let gpus = [];

  if (process.platform !== 'darwin') {
    const cards = await nvidiaCards();
    if (cards.length) {
      gpus = cards.map((card) => ({ name: card.name, vramGB: Math.round((card.totalMB / 1024) * 10) / 10 }));
      gpu = gpuSummary(cards.map((card) => card.name));
      vramGB = Math.round((cards.reduce((sum, card) => sum + card.totalMB, 0) / 1024) * 10) / 10;
      // Newer drivers label this "CUDA UMD Version"; the plain header form is the older one.
      const details = await run('nvidia-smi', [], 8000);
      cudaVersion = details.match(/CUDA(?: UMD)? Version\s*:\s*(\d+\.\d+)/i)?.[1] || '';
    }
    if (gpu && process.platform === 'linux') {
      // llama.cpp's Linux CUDA builds use the system's CUDA runtime; note which major versions are installed.
      const libs = await run('/sbin/ldconfig', ['-p'], 5000);
      cudaLibs = ['12', '13'].filter((major) => libs.includes(`libcudart.so.${major} `) && libs.includes(`libcublas.so.${major} `));
    }
    if (!gpu && process.platform === 'linux') {
      const lspci = await run('sh', ['-c', "lspci 2>/dev/null | grep -Ei 'vga|3d|display' | head -1"]);
      if (lspci) gpu = lspci.replace(/^.*?:\s*/, '').replace(/\s*\(rev [^)]*\)\s*$/, '').slice(0, 80);
      const amd = await amdVram();
      if (amd) vramGB = Math.round((amd.totalBytes / 1024 ** 3) * 10) / 10;
    }
    if (!gpu && process.platform === 'win32') {
      const raw = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress',
      ], 6000);
      try {
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const best = list
          .filter((item) => item && item.Name && !/Microsoft Basic|Remote Display/i.test(item.Name))
          .sort((a, b) => (b.AdapterRAM || 0) - (a.AdapterRAM || 0))[0];
        if (best) {
          gpu = best.Name;
          vramGB = best.AdapterRAM ? Math.round((best.AdapterRAM / 1024 ** 3) * 10) / 10 : 0;
        }
      } catch {}
    }
  } else if (process.platform === 'darwin') {
    // The real chip: an Intel copy of Uma on Apple silicon runs under Rosetta and reports x64.
    appleSilicon = process.arch === 'arm64' || (await run('sysctl', ['-n', 'hw.optional.arm64'])).trim() === '1';
    if (appleSilicon) {
      // Apple silicon shares RAM with the GPU. Metal lets one app use about two thirds of it,
      // three quarters on machines with more than 36 GB.
      const chip = await run('sysctl', ['-n', 'machdep.cpu.brand_string']);
      gpu = `${chip || 'Apple silicon'} GPU`;
      vramGB = Math.round(ramGB * (ramGB > 36 ? 0.75 : 0.66) * 10) / 10;
    } else {
      const raw = await run('system_profiler', ['SPDisplaysDataType', '-json'], 8000);
      try {
        const cards = JSON.parse(raw).SPDisplaysDataType || [];
        const best = cards.find((card) => /AMD|Radeon|NVIDIA/i.test(card.sppci_model || '')) || cards[0];
        if (best) {
          gpu = best.sppci_model || 'Mac GPU';
          const vram = String(best.spdisplays_vram || best.spdisplays_vram_shared || '').match(/(\d+)\s*(GB|MB)/i);
          if (vram) vramGB = vram[2].toUpperCase() === 'GB' ? Number(vram[1]) : Math.round((Number(vram[1]) / 1024) * 10) / 10;
        }
      } catch {}
    }
  }

  const cpu = (cpus[0] && cpus[0].model) || os.arch();
  cached = {
    cpu: cpu.trim(),
    cores: cpus.length,
    ramGB,
    gpu: gpu || '',
    vramGB,
    gpus: gpus.length ? gpus : gpu ? [{ name: gpu, vramGB }] : [],
    hasGpu: Boolean(gpu),
    // nvidia-smi answering is the proof: an older card is named "Tesla P40", without "NVIDIA".
    nvidia: gpus.length > 0 || /nvidia/i.test(gpu),
    cudaVersion,
    cudaLibs,
    appleSilicon,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };
  return cached;
}

/**
 * VRAM free right now, in bytes, or 0 when this GPU cannot report it. With several cards: the one
 * with the most free memory, which is what a model that must sit on one card can count on. (How a
 * model is shared between cards is planned from the engine's own list: see LlamaManager.localGpus.)
 */
async function freeVramBytes() {
  if (process.platform === 'darwin') return 0;
  const mib = Math.max(0, ...(await nvidiaCards()).map((card) => card.freeMB));
  if (mib > 0) return mib * 1024 * 1024;
  const amd = process.platform === 'linux' ? await amdVram() : null;
  return amd ? Math.max(0, amd.totalBytes - amd.usedBytes) : 0;
}

function recommendModel(models, hardware) {
  if (!models.length) return '';
  const hasGpu = hardware.hasGpu && hardware.vramGB >= 4;
  const ram = hardware.ramGB;
  if (hasGpu && hardware.vramGB >= 7) {
    return models.find((model) => model.id === 'qwen3-4b')?.id || models[0].id;
  }
  if (hasGpu && hardware.vramGB >= 5.5) {
    return models.find((model) => model.id === 'qwen25-3b')?.id || models[0].id;
  }
  if (ram >= 15) {
    return models.find((model) => model.id === 'qwen25-3b')?.id || models[0].id;
  }
  return models.find((model) => model.id === 'qwen25-15b')?.id || models[0].id;
}

module.exports = { detectHardware, recommendModel, freeVramBytes, amdVram, nvidiaCards, parseNvidiaCards, gpuSummary };
