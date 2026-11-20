const os = require('node:os');
const { execFile } = require('node:child_process');

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [type, value] of Object.entries(cpu.times)) {
      total += value;
      if (type === 'idle') idle += value;
    }
  }
  return { idle, total };
}

/**
 * One reading for all of a PC's NVIDIA cards: memory is added up, and the percentage is the
 * busiest card's (layers shared between cards run one card after the other, so an average would
 * read low while a card is flat out). `cards` lists each card when there are several.
 */
function gpuReading(cards) {
  if (!cards.length) return null;
  const each = cards.map((card) => ({
    name: card.name, percent: card.percent, usedBytes: card.usedMB * 1024 ** 2, totalBytes: card.totalMB * 1024 ** 2,
    ...(card.lanes > 0 && card.lanesMax > card.lanes ? { lanes: card.lanes, lanesMax: card.lanesMax } : {}),
  }));
  return {
    percent: Math.max(...each.map((card) => card.percent)),
    usedBytes: each.reduce((sum, card) => sum + card.usedBytes, 0),
    totalBytes: each.reduce((sum, card) => sum + card.totalBytes, 0),
    ...(each.length > 1 ? { cards: each } : {}),
  };
}

async function queryNvidia() {
  const { nvidiaCards } = require('./hardware.cjs');
  return gpuReading(await nvidiaCards(4000));
}

function runText(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : String(stdout)));
  });
}

/** Mac GPU busy percent and memory in use, from the accelerator's own statistics (no admin rights needed). */
async function queryAppleGpu() {
  const output = await runText('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator']);
  const percent = Number(output.match(/"Device Utilization %"\s*=\s*(\d+)/)?.[1]);
  const used = Number(output.match(/"In use system memory"\s*=\s*(\d+)/)?.[1] ?? output.match(/"vramUsedBytes"\s*=\s*(\d+)/)?.[1]);
  if (!Number.isFinite(percent)) return null;
  // Apple silicon has no separate VRAM: Metal can use about two thirds of RAM (three quarters above 36 GB).
  const ram = os.totalmem();
  const totalBytes = Math.round(ram * (ram > 36 * 1024 ** 3 ? 0.75 : 0.66));
  return { percent, usedBytes: Number.isFinite(used) ? used : 0, totalBytes };
}

/**
 * Memory in use the way Activity Monitor counts it (app + wired + compressed). os.freemem() on a Mac
 * counts only completely unused pages, so the file cache would look like used memory.
 */
async function macUsedMemory() {
  const output = await runText('vm_stat', []);
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1]) || 16384;
  const pages = (label) => Number(output.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1]) || 0;
  const used = pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor');
  return used > 0 ? used * pageSize : 0;
}

// Virtual adapters (WSL, Hyper-V, Docker, VMs, VPN tunnels) would count the same traffic twice.
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|vboxnet|VMware|vmnet|docker|br-|veth|virbr|Loopback|^lo\d*$|utun|awdl|llw|bridge|gif|stf|anpi|tailscale|wg\d/i;

/**
 * Bytes received and sent so far on the real network adapters, or null when unknown.
 * Windows has no fast command for per-adapter totals (netstat -e also counts loopback), so one
 * PowerShell process stays open and prints Get-NetAdapterStatistics every 2 seconds. It exits by
 * itself when this app's process is gone.
 */
class NetworkCounter {
  constructor() {
    this.latest = null;
    this.reader = null;
    this.failed = false;
  }

  async read() {
    if (process.platform === 'win32') return this.readWindows();
    if (process.platform === 'darwin') return this.readMac();
    return this.readLinux();
  }

  /**
   * netsh lists the bytes in and out of every network interface, for IPv4 and for IPv6. It runs for
   * about a tenth of a second at each sample; the PowerShell reader it replaces stayed in memory
   * (about 140 MB) for as long as Uma ran. The numbers do not depend on the Windows language; the
   * loopback interface is the one whose MTU is 4294967295.
   */
  readWindows() {
    const read = (family) => new Promise((resolve) => {
      execFile('netsh', ['interface', family, 'show', 'subinterfaces'], { timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
        if (error) return resolve(null);
        let rx = 0;
        let tx = 0;
        let rows = 0;
        for (const line of String(stdout).split(/\r?\n/)) {
          const match = line.match(/^\s*(\d+)\s+\d+\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
          if (!match) continue;
          rows += 1;
          if (match[1] === '4294967295' || VIRTUAL_ADAPTER.test(match[4])) continue;
          rx += Number(match[2]);
          tx += Number(match[3]);
        }
        resolve(rows ? { rx, tx } : null);
      });
    });
    return Promise.all([read('ipv4'), read('ipv6')]).then(([v4, v6]) => (v4 || v6
      ? { rx: (v4?.rx || 0) + (v6?.rx || 0), tx: (v4?.tx || 0) + (v6?.tx || 0) }
      : null));
  }

  readMac() {
    // netstat -ib: the <Link#n> row of each interface carries its byte totals.
    return new Promise((resolve) => {
      execFile('netstat', ['-ibn'], { timeout: 3000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve(null);
        let rx = 0;
        let tx = 0;
        for (const line of String(stdout).split('\n')) {
          const cols = line.trim().split(/\s+/);
          if (!/^<Link#\d+>$/.test(cols[2] || '') || VIRTUAL_ADAPTER.test(cols[0])) continue;
          // Name Mtu Network [Address] Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll; Address can be empty.
          const numbers = cols.slice(3).filter((value) => /^\d+$/.test(value)).map(Number);
          if (numbers.length >= 7) {
            rx += numbers[numbers.length - 5];
            tx += numbers[numbers.length - 2];
          }
        }
        resolve({ rx, tx });
      });
    });
  }

  async readLinux() {
    try {
      const text = await require('node:fs/promises').readFile('/proc/net/dev', 'utf8');
      let rx = 0;
      let tx = 0;
      for (const line of text.split('\n').slice(2)) {
        const [name, rest] = line.split(':');
        if (!rest || VIRTUAL_ADAPTER.test(name.trim())) continue;
        const cols = rest.trim().split(/\s+/).map(Number);
        rx += cols[0] || 0;
        tx += cols[8] || 0;
      }
      return { rx, tx };
    } catch {
      return null;
    }
  }

  stop() {
    try { this.reader?.kill(); } catch {}
    this.reader = null;
  }
}

/** Linux: NVIDIA through nvidia-smi, otherwise AMD (and some Intel) cards through sysfs. */
async function queryLinuxGpu() {
  const nvidia = await queryNvidia();
  if (nvidia) return nvidia;
  const { amdVram } = require('./hardware.cjs');
  return amdVram();
}

/** Whole-PC usage since the previous sample. GPU readings need an NVIDIA or AMD GPU or a Mac; otherwise gpu is null. */
class SystemStats {
  constructor({ queryGpu = { darwin: queryAppleGpu, linux: queryLinuxGpu }[process.platform] || queryNvidia, network = new NetworkCounter() } = {}) {
    this.previous = cpuTimes();
    this.queryGpu = queryGpu;
    this.gpuFailures = 0;
    this.network = network;
    this.previousNet = null;
  }

  /** Download and upload speed in bytes per second since the previous sample, or null at first. */
  async networkSpeed() {
    const totals = await this.network.read().catch(() => null);
    const at = Date.now();
    const before = this.previousNet;
    if (totals) this.previousNet = { ...totals, at };
    if (!totals || !before || at <= before.at) return null;
    const seconds = (at - before.at) / 1000;
    // A counter that went backwards (adapter reset or reconnected) gives no reading this time.
    if (totals.rx < before.rx || totals.tx < before.tx) return null;
    return { rxBps: Math.round((totals.rx - before.rx) / seconds), txBps: Math.round((totals.tx - before.tx) / seconds) };
  }

  stop() {
    this.network.stop?.();
  }

  async sample() {
    const now = cpuTimes();
    const total = now.total - this.previous.total;
    const idle = now.idle - this.previous.idle;
    this.previous = now;
    const totalBytes = os.totalmem();
    // After repeated failures there is no NVIDIA GPU to read, so stop launching nvidia-smi every 5 seconds.
    const gpu = this.gpuFailures >= 3 ? null : await this.queryGpu();
    this.gpuFailures = gpu ? 0 : this.gpuFailures + 1;
    const macUsed = process.platform === 'darwin' ? await macUsedMemory() : 0;
    const net = await this.networkSpeed();
    return {
      cpuPercent: total > 0 ? Math.max(0, Math.min(100, Math.round((1 - idle / total) * 100))) : 0,
      ramUsedBytes: macUsed || totalBytes - os.freemem(),
      ramTotalBytes: totalBytes,
      gpu,
      net,
    };
  }
}

module.exports = { SystemStats, NetworkCounter, queryNvidia, queryAppleGpu, gpuReading };
