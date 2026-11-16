// How hard a shared PC works for the main PC. While it is shared its chat is locked, so by default it
// gives everything: every CPU thread, all but a small RAM reserve, a higher priority, and (on Windows)
// no background power saving. A clock watch notices when the PC itself slows its CPU down under load,
// which no setting in Uma can undo, and says so on the Shared screen.
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');

// RAM a helper keeps free for itself. The helper engine needs about 2 GB on top of the model layers
// it holds (network transfer buffers and the CUDA runtime), which llama.cpp's planning does not
// count; with less free, the engine runs out of memory and stops. 0.2.10 kept only 1.5 GB, and a
// 16 GB laptop helper stopped during loads.
const RESERVE = {
  full: { minMB: 3072, share: 0.12, maxMB: 6144 },
  // "Full power" off: the PC stays comfortable to use while it helps.
  gentle: { minMB: 5120, share: 0.25, maxMB: Infinity },
};

function logicalCpus() {
  return Math.max(1, os.availableParallelism?.() || os.cpus().length || 1);
}

/** Threads for the helper's CPU work and the RAM it keeps for itself. */
function helperBudget({ fullPower = true, cpus = logicalCpus(), ramMB = Math.round(os.totalmem() / 1024 ** 2) } = {}) {
  const reserve = fullPower ? RESERVE.full : RESERVE.gentle;
  return {
    threads: fullPower ? cpus : Math.max(1, cpus > 4 ? Math.floor(cpus / 2) : cpus),
    reserveMB: Math.round(Math.min(reserve.maxMB, Math.max(reserve.minMB, ramMB * reserve.share))),
  };
}

// Windows 11 may run windowless background processes in its power-saving mode (EcoQoS), which on
// laptops lowers the clock and on Intel hybrid CPUs moves the work to the efficiency cores. This opts
// the helper engine out: ControlMask EXECUTION_SPEED with StateMask 0 means "never throttle".
const WINDOWS_NO_THROTTLE = (pid) => `
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class UmaHelperPower {
  [StructLayout(LayoutKind.Sequential)] public struct State { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool SetProcessInformation(IntPtr process, int infoClass, ref State info, int size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static bool NeverThrottle(int pid) {
    IntPtr handle = OpenProcess(0x0200, false, pid);
    if (handle == IntPtr.Zero) return false;
    State state = new State(); state.Version = 1; state.ControlMask = 1; state.StateMask = 0;
    bool ok = SetProcessInformation(handle, 4, ref state, Marshal.SizeOf(state));
    CloseHandle(handle);
    return ok;
  }
}
"@
[Console]::Out.WriteLine([UmaHelperPower]::NeverThrottle(${Number(pid)}))`;

function encoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Raises the helper engine's priority and, on Windows, turns off power throttling for it.
 * Resolves to what was done; nothing here is required for the helper to work.
 */
async function boostProcess(pid) {
  const done = { priority: false, noThrottle: false };
  if (!pid) return done;
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
    done.priority = true;
  } catch {
    // Linux and macOS need admin rights to raise a priority; the engine still runs at normal priority.
  }
  if (process.platform === 'win32') {
    done.noThrottle = await new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(WINDOWS_NO_THROTTLE(pid))], { windowsHide: true, timeout: 20000 }, (error, stdout) => {
        resolve(!error && /True/.test(String(stdout)));
      });
    });
  }
  return done;
}

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

/** Average current clock of all cores in MHz on Linux, or 0. */
async function linuxClockMHz() {
  try {
    const values = [...(await fs.readFile('/proc/cpuinfo', 'utf8')).matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map((match) => Number(match[1]));
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  } catch {
    return 0;
  }
}

// A CPU that works at less than this share of the clock it reaches when idle is being held back.
const SLOW_SHARE = 0.55;
const BUSY_PERCENT = 30;
// Readings in a row before Uma says so, and how often it repeats it.
const SLOW_READINGS = 3;
const REPEAT_MS = 10 * 60 * 1000;

/**
 * Watches the CPU clock while this PC is shared. Windows has no fast clock reading, so one
 * PowerShell process stays open and prints the processor performance (percent of the nominal
 * clock) through WMI, whose class names are the same in every Windows language. Linux reads
 * /proc/cpuinfo. macOS gives no clock reading without admin rights, so it is not watched there.
 */
class ClockWatch {
  constructor({ onSlow, onRecovered, intervalMs = 5000 } = {}) {
    this.onSlow = onSlow || (() => {});
    this.onRecovered = onRecovered || (() => {});
    this.intervalMs = intervalMs;
    this.reader = null;
    this.timer = null;
    this.latestMHz = 0;
    this.peakMHz = 0;
    this.previous = cpuTimes();
    this.slowCount = 0;
    this.slow = false;
    this.lastWarned = 0;
  }

  async start() {
    this.stop();
    if (process.platform === 'win32') {
      // The nominal clock, so a CPU that is held back from the start is noticed too.
      this.peakMHz = os.cpus()[0]?.speed || 0;
      this.startWindowsReader();
    } else if (process.platform === 'linux') {
      const maxKHz = Number(await fs.readFile('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq', 'utf8').catch(() => 0));
      this.peakMHz = maxKHz > 0 ? Math.round(maxKHz / 1000) : 0;
    } else {
      return;
    }
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  startWindowsReader() {
    const nominal = os.cpus()[0]?.speed || 0;
    const script = `$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  if (-not (Get-Process -Id ${process.pid})) { exit }
  $row = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'"
  if ($row) { [Console]::Out.WriteLine("$($row.PercentProcessorPerformance) $($row.ProcessorFrequency)"); [Console]::Out.Flush() }
  Start-Sleep -Seconds 3
}`;
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      this.reader = child;
      child.unref();
      child.stdout.unref?.();
      let buffer = '';
      child.stdout.on('data', (data) => {
        buffer += data;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          const [percent, frequency] = line.trim().split(/\s+/).map(Number);
          const base = frequency || nominal;
          if (percent > 0 && base > 0) this.latestMHz = Math.round((percent * base) / 100);
        }
      });
      child.on('error', () => { this.reader = null; });
      child.on('exit', () => { if (this.reader === child) this.reader = null; });
    } catch {
      this.reader = null;
    }
  }

  busyPercent() {
    const now = cpuTimes();
    const total = now.total - this.previous.total;
    const idle = now.idle - this.previous.idle;
    this.previous = now;
    return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
  }

  async tick() {
    const busy = this.busyPercent();
    const mhz = process.platform === 'linux' ? await linuxClockMHz() : this.latestMHz;
    this.check(mhz, busy);
  }

  /** One reading: the average clock in MHz and how busy the CPU is in percent. */
  check(mhz, busy, now = Date.now()) {
    if (!mhz) return;
    // Idle readings show how fast this CPU can run; the busiest work is compared with that.
    this.peakMHz = Math.max(this.peakMHz, mhz);
    if (busy < BUSY_PERCENT) return;
    const slow = this.peakMHz > 0 && mhz < this.peakMHz * SLOW_SHARE;
    this.slowCount = slow ? this.slowCount + 1 : 0;
    this.fastCount = slow ? 0 : (this.fastCount || 0) + 1;
    if (this.slowCount >= SLOW_READINGS && now - this.lastWarned > REPEAT_MS) {
      this.lastWarned = now;
      this.slow = true;
      this.onSlow({ mhz, peakMHz: this.peakMHz, busy });
    } else if (this.slow && this.fastCount >= SLOW_READINGS) {
      this.slow = false;
      this.onRecovered({ mhz, peakMHz: this.peakMHz, busy });
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    try { this.reader?.kill(); } catch {}
    this.reader = null;
  }
}

module.exports = { helperBudget, boostProcess, ClockWatch, logicalCpus, RESERVE };
