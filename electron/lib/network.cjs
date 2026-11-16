// Helper PCs: lend this PC's GPU, CPU, and RAM to another Uma over the local network, or borrow
// theirs. Both sides use llama.cpp's RPC backend: a helper runs ggml-rpc-server, and the main PC
// starts llama-server with --rpc, which spreads the model's layers across every device it can see.
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { t } = require('./i18n.cjs');
const { helperBudget, boostProcess, ClockWatch } = require('./helperPower.cjs');
const { pruneCache } = require('./helperCache.cjs');

const DEFAULT_PORT = 50052;
// helperRamFirst: on the main PC, put layers that fit no GPU into the helpers' RAM before this PC's own (the split used until 0.2.13).
const DEFAULT_NETWORK = { share: false, shareAddress: '', sharePort: DEFAULT_PORT, shareRam: true, fullPower: true, helpers: [], helpersMode: 'auto', helperRamFirst: false };
// Another Uma asks a helper what it offers by sending this line first. llama.cpp's own protocol
// starts with a small command number, so the two can never be confused.
const INFO_REQUEST = 'UMAINFO\n';
const HELPER_MODES = ['auto', 'always', 'off'];

/** 10.x, 172.16-31.x, 192.168.x, and 100.64-127.x (Tailscale and other carrier-grade NAT). */
function isPrivateIPv4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// Virtual switches for WSL, Hyper-V, Docker, and VM apps live only inside this PC; other PCs cannot reach them.
const VIRTUAL_ADAPTER = /vEthernet|WSL|Hyper-V|VirtualBox|vboxnet|VMware|vmnet|docker|br-[0-9a-f]|veth|Loopback/i;
const HYPER_V_MAC = /^00:15:5d/i;

/** This PC's addresses on real local networks, wired first, then Wi-Fi, then VPNs like Tailscale. */
function privateAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal || HYPER_V_MAC.test(entry.mac || '') || !isPrivateIPv4(entry.address)) continue;
      found.push({ address: entry.address, name });
    }
  }
  const rank = (item) => (item.address.startsWith('100.') ? 3 : /wi-?fi|wlan|wireless/i.test(item.name) ? 2 : /ethernet|^eth|^en\d/i.test(item.name) ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b));
}

/** A host name or IPv4 address, without a scheme or port. */
function cleanHost(value) {
  const host = String(value || '').trim();
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || host.startsWith('-')) throw new Error(t('Enter the helper PC\'s IP address, like 192.168.1.20.'));
  return host;
}

function cleanPort(value) {
  const port = Number(value || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(t('The port must be a number from 1024 to 65535.'));
  return port;
}

/** "RPC0: 192.168.1.20:50052 (12288 MiB, 11020 MiB free)" lines from llama-server --list-devices. */
function parseDevices(text, prefix = 'RPC') {
  const devices = [];
  const pattern = new RegExp(`^\\s*(${prefix}\\d+):\\s*(.+?)\\s*\\((\\d+) MiB, (\\d+) MiB free\\)`, 'gm');
  for (const match of String(text).matchAll(pattern)) {
    devices.push({ id: match[1], name: match[2], totalMB: Number(match[3]), freeMB: Number(match[4]) });
  }
  return devices;
}

/** Devices the local llama.cpp engine can use, from llama-server --list-devices (RPC ones excluded). */
function localDevices(serverPath) {
  return new Promise((resolve) => {
    execFile(serverPath, ['--list-devices'], { cwd: path.dirname(serverPath), windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const devices = [];
      for (const match of `${stdout}\n${stderr}`.matchAll(/^\s*(\w+):\s*(.+?)\s*\((\d+) MiB, (\d+) MiB free\)/gm)) {
        if (/^RPC\d/.test(match[1])) continue;
        devices.push({ name: match[1], description: match[2], totalMB: Number(match[3]), freeMB: Number(match[4]), kind: /^CPU/i.test(match[1]) ? 'cpu' : 'gpu' });
      }
      resolve(devices);
    });
  });
}

/** What a helper offers, in the order llama.cpp sees its devices, or null for a helper that does not say. */
// `about` tells the helper about this PC (its llama.cpp build) on a second line, which an older Uma ignores.
function helperInfo(host, port, timeout = 2500, about = null) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let text = '';
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout, () => done(null));
    socket.once('connect', () => socket.write(about ? `${INFO_REQUEST}${JSON.stringify(about)}\n` : INFO_REQUEST));
    socket.on('data', (data) => {
      text += data;
      if (text.includes('\n')) {
        try { done(JSON.parse(text.slice(0, text.indexOf('\n')))); } catch { done(null); }
      }
    });
    socket.once('error', () => done(null));
    socket.once('close', () => done(null));
  });
}

/** Whether something answers on host:port, within the timeout. */
function probe(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Whether this PC reaches the internet: a short connection to a public DNS service, nothing is sent. */
async function internetUp(timeout = 2000) {
  const answers = await Promise.all([probe('1.1.1.1', 443, timeout), probe('8.8.8.8', 53, timeout)]);
  return answers.some(Boolean);
}

/** A number another PC sent, or null. */
function cleanNumber(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) && number >= 0 ? Math.min(number, max) : null;
}

/** Text another PC sent, without control characters and cut. */
function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

/** A helper's own readings (see ownReading), checked field by field: they come from another PC. */
function cleanReading(stats) {
  if (!stats || typeof stats !== 'object') return null;
  const gpu = stats.gpu && typeof stats.gpu === 'object'
    ? { percent: cleanNumber(stats.gpu.percent, 100), used: cleanNumber(stats.gpu.used), total: cleanNumber(stats.gpu.total) }
    : null;
  return {
    cpu: cleanNumber(stats.cpu, 100),
    ramUsed: cleanNumber(stats.ramUsed),
    ramTotal: cleanNumber(stats.ramTotal),
    gpu: gpu && gpu.total ? gpu : null,
    internet: typeof stats.internet === 'boolean' ? stats.internet : null,
    internetDrops: cleanNumber(stats.internetDrops) || 0,
    received: cleanNumber(stats.received) || 0,
    sent: cleanNumber(stats.sent) || 0,
    receiveRate: cleanNumber(stats.receiveRate) || 0,
    sendRate: cleanNumber(stats.sendRate) || 0,
    clients: cleanNumber(stats.clients, 99) || 0,
    phase: ['computing', 'loading', 'idle'].includes(stats.phase) ? stats.phase : '',
    crashes: cleanNumber(stats.crashes, 99) || 0,
    warnings: cleanNumber(stats.warnings, 9999) || 0,
    lastWarning: stats.lastWarning && typeof stats.lastWarning === 'object'
      ? { text: cleanText(stats.lastWarning.text, 300), at: cleanText(stats.lastWarning.at, 30) }
      : null,
    sharedSince: cleanText(stats.sharedSince, 30),
    version: cleanText(stats.version, 20),
  };
}

/** Whether this PC can listen on address:port. Windows reserves blocks of ports for Hyper-V and WSL. */
function canListen(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve(err.code || 'ERROR'));
    server.listen(port, host, () => server.close(() => resolve('')));
  });
}

async function findRpcServer(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && /^(ggml-)?rpc-server(\.exe)?$/i.test(entry.name)) return path.join(dir, entry.name);
  }
  return null;
}

const ACTIVITY_LIMIT = 300;
// The helper engine is started again after it stops, up to this many times in this window.
const CRASH_LIMIT = 3;
const CRASH_WINDOW_MS = 10 * 60 * 1000;

/** Model data flows one way while loading; while computing, activations go back too. */
function isLoading(session) {
  // Loading model parts: a lot comes in and almost nothing goes back. Computing sends results
  // back at about the rate it receives work: reading a long prompt is 15-25 MB/s each way, which
  // the old threshold alone (20 MB/s in) called "loading".
  return session.receiveRate > LOADING_RATE && session.sendRate * 20 < session.receiveRate;
}

/** 12102 for "b12102", or 0. */
function buildNumber(tag) {
  return Number(String(tag || '').match(/^b(\d+)$/)?.[1]) || 0;
}
// Below this a main PC is sending work, not model data.
const LOADING_RATE = 1024 * 1024;

function emptyShare() {
  return { state: 'off', address: '', port: 0, devices: [], error: '', startedAt: '', totals: { received: 0, sent: 0, sessions: 0 } };
}

function sizeLabel(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

function durationLabel(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ${seconds % 60} s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** A free port on 127.0.0.1 for the engine's own server, which only Uma talks to. */
function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

class NetworkManager {
  constructor({ store, emit, cacheDir, logsDir, runtime = null, sampleStats = null, appVersion = '' }) {
    this.store = store;
    // Server status: this PC's own readings, and what was seen of each helper since Uma started.
    this.sampleStats = sampleStats;
    this.appVersion = appVersion;
    this.own = { at: 0, busy: false, stats: null, internet: null, internetAt: 0, checking: false, internetDrops: 0 };
    this.health = new Map();
    this.watchingSince = Date.now();
    this.events = [];
    this.statusPending = null;
    // Installs llama.cpp builds, so a helper can switch to the build the main PC runs.
    this.runtime = runtime;
    this.engineUpdate = null;
    this.engineFailures = new Map();
    this.crashes = [];
    this.emit = emit || (() => {});
    this.cacheDir = cacheDir;
    this.logsDir = logsDir;
    this.child = null;
    this.proxy = null;
    this.sessions = new Map();
    this.activity = [];
    this.share = emptyShare();
    this.stopping = false;
    this.broadcastTimer = null;
    this.monitorTimer = null;
  }

  settings() {
    return { ...DEFAULT_NETWORK, ...(this.store.getSettings().network || {}) };
  }

  async save(patch) {
    const next = { ...this.settings(), ...patch };
    await this.store.updateSettings({ network: next });
    this.broadcast();
    return next;
  }

  isSharing() {
    return this.share.state === 'on' || this.share.state === 'starting';
  }

  status() {
    const settings = this.settings();
    return {
      ...settings,
      addresses: privateAddresses(),
      sharing: {
        ...this.share,
        clients: [...this.sessions.values()].filter((item) => item.announced).map((item) => ({
          address: item.address,
          since: new Date(item.startedAt).toISOString(),
          received: item.received,
          sent: item.sent,
          phase: item.phase,
          receiveRate: item.receiveRate,
          sendRate: item.sendRate,
          busyPercent: item.busyPercent || 0,
        })),
        activity: this.activity.slice(-150),
      },
    };
  }

  broadcast() {
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    this.emit('network:status', this.status());
  }

  /** Log lines can arrive in bursts, so the window is updated at most a few times a second. */
  scheduleBroadcast() {
    if (!this.broadcastTimer) this.broadcastTimer = setTimeout(() => this.broadcast(), 400);
  }

  /** The activity log shown on the Shared screen. Kinds: info, connect, disconnect, work, warn, engine. */
  log(kind, text) {
    const entry = { at: new Date().toISOString(), kind, text };
    this.activity.push(entry);
    if (this.activity.length > ACTIVITY_LIMIT) this.activity.splice(0, this.activity.length - ACTIVITY_LIMIT);
    this.scheduleBroadcast();
    this.writeLog(entry);
  }

  /**
   * The Shared screen's log is also kept in logs/helper.log, so the reason a helper engine stopped
   * is still there after Uma is closed. Writes are queued in order; the file is cut at 5 MB.
   */
  writeLog(entry) {
    if (!this.logsDir) return;
    const file = path.join(this.logsDir, 'helper.log');
    this.logQueue = (this.logQueue || Promise.resolve()).then(async () => {
      const stat = await fsp.stat(file).catch(() => null);
      if (stat && stat.size > 5 * 1024 * 1024) await fsp.rename(file, `${file}.1`).catch(() => {});
      await fsp.appendFile(file, `${entry.at} [${entry.kind}] ${entry.text}\n`);
    }).catch(() => {});
  }

  async rpcServerPath() {
    const serverPath = this.store.getRuntime().serverPath;
    return serverPath ? findRpcServer(path.dirname(serverPath)) : null;
  }

  // ---- sharing this PC ----

  /**
   * Starts llama.cpp's RPC server on 127.0.0.1 and puts Uma's own relay in front of it on the LAN
   * address. The relay is what other PCs reach: it lets Uma show who is connected and what they are
   * doing, ignores the reachability checks other Umas make every few seconds, and keeps the engine
   * itself off the network.
   */
  async startSharing({ address, port, keepLog = false } = {}) {
    await this.stopSharing({ quiet: true, remember: false });
    // A restart after the engine stopped, or after an engine update, keeps the log on screen.
    if (!keepLog) this.crashes = [];
    const previousLog = keepLog ? this.activity : [];
    const settings = this.settings();
    const choices = privateAddresses();
    const wanted = address || settings.shareAddress;
    const bind = choices.find((item) => item.address === wanted)?.address || choices[0]?.address;
    if (!bind) throw new Error(t('This PC is not on a local network (no 192.168.x, 10.x, or 172.16-31.x address), so it cannot be shared.'));
    const bindPort = cleanPort(port || settings.sharePort);
    const executable = await this.rpcServerPath();
    if (!executable) throw new Error(t('The installed llama.cpp engine has no RPC server. Install or update the engine in Models first.'));
    const blocked = await canListen(bind, bindPort);
    if (blocked) {
      throw new Error(blocked === 'EADDRINUSE'
        ? t('Port {0} is already in use on this PC. Choose another port.', [bindPort])
        : t('This PC does not allow port {0} (Windows reserves some port ranges for Hyper-V and WSL). Choose another port, like {1}.', [bindPort, DEFAULT_PORT]));
    }
    await fsp.mkdir(this.cacheDir, { recursive: true });
    const enginePort = await freeLocalPort();

    this.activity = previousLog;
    this.share = { ...emptyShare(), state: 'starting', address: bind, port: bindPort, startedAt: new Date().toISOString() };
    await this.save({ share: true, shareAddress: bind, sharePort: bindPort });
    this.log('info', t('Starting the helper service on {0}:{1}…', [bind, bindPort]));

    // Offer every GPU, and the RAM too unless the user turned that off. The CPU comes first: the main
    // PC orders devices itself, and a helper without a GPU still has its RAM to lend.
    const found = await localDevices(this.store.getRuntime().serverPath);
    const gpus = found.filter((device) => device.kind === 'gpu');
    const offered = [...(settings.shareRam || !gpus.length ? ['CPU'] : []), ...gpus.map((device) => device.name)];
    const ramMB = Math.round(os.totalmem() / 1024 ** 2);
    const { threads, reserveMB } = helperBudget({ fullPower: settings.fullPower !== false, ramMB });
    this.share.fullPower = settings.fullPower !== false;
    this.share.devices = offered.map((name) => (name === 'CPU'
      ? { id: 'CPU', kind: 'cpu', name: os.cpus()[0]?.model?.trim() || 'CPU', totalMB: ramMB, freeMB: Math.round(os.freemem() / 1024 ** 2), reserveMB }
      : { id: name, kind: 'gpu', name: gpus.find((device) => device.name === name).description, totalMB: gpus.find((device) => device.name === name).totalMB, freeMB: gpus.find((device) => device.name === name).freeMB }));
    this.share.threads = threads;
    for (const device of this.share.devices) {
      this.log('info', device.kind === 'cpu'
        ? t('Offering RAM ({0} threads): {1} free of {2}', [threads, sizeLabel(device.freeMB * 1024 ** 2), sizeLabel(device.totalMB * 1024 ** 2)])
        : t('Offering {0}: {1} free of {2}', [device.name, sizeLabel(device.freeMB * 1024 ** 2), sizeLabel(device.totalMB * 1024 ** 2)]));
    }

    // -c keeps the model parts it receives in the cache folder, so the next load skips the transfer.
    // Old parts are removed first so the disk keeps free space; without enough even then, no cache.
    const cache = await this.tidyCache();
    if (!cache.enoughSpace) {
      this.log('warn', t('This PC has only {0} free on its disk, so the helper works without its cache: every load comes over the network. Free some disk space to make loads faster.', [sizeLabel(cache.freeBytes)]));
    }
    const args = ['-H', '127.0.0.1', '-p', String(enginePort), ...(cache.enoughSpace ? ['-c'] : []), '-t', String(threads)];
    if (found.length) args.push('-d', offered.join(','));
    const child = spawn(executable, args, {
      cwd: path.dirname(executable),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LLAMA_CACHE: this.cacheDir },
    });
    this.child = child;
    this.stopping = false;
    this.engineDown = false;
    this.watchdog = this.startWatchdog(child.pid);
    if (this.share.fullPower) {
      this.log('info', t('Full power: all {0} CPU threads, and only {1} of RAM kept free for this PC.', [threads, sizeLabel(reserveMB * 1024 ** 2)]));
      boostProcess(child.pid).then((done) => {
        if (child !== this.child) return;
        if (done.noThrottle) this.log('info', t('Windows power saving is off for the helper engine, so it keeps full CPU speed in the background.'));
      });
    }
    this.startClockWatch();
    const onText = (data) => {
      for (const line of String(data).split(/\r?\n/)) {
        const text = line.trim();
        // Connections are logged by the relay, with the address the engine cannot see.
        if (!text || /^(Accepted client connection|Client connection closed|recv returned 0|!+$)/.test(text)) continue;
        // The device lines repeat what was found above, so they are left out of the log.
        if (/^\w+\d*:\s*.+\(\d+ MiB, \d+ MiB free\)/.test(text)) continue;
        if (!/^(Starting RPC server|endpoint|local cache|transport|Devices:)/i.test(text)) {
          this.log(/error|fail|warning/i.test(text) ? 'warn' : 'engine', text);
        }
      }
    };
    child.stdout.on('data', onText);
    child.stderr.on('data', onText);
    child.on('error', (err) => {
      if (child !== this.child) return;
      this.fail(err.message);
    });
    child.on('exit', (code) => {
      if (child !== this.child || this.stopping) return;
      this.child = null;
      this.engineDown = true;
      // A main PC can make the engine stop (say it sent work this build cannot do). Sharing stays
      // on: the engine starts again, unless it keeps stopping.
      const now = Date.now();
      this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
      if (this.crashes.length > CRASH_LIMIT) {
        // Close the port too: a main PC that connects to a relay with no engine behind it fails at once.
        const log = this.activity;
        this.stopSharing({ quiet: true, remember: false }).then(() => {
          this.activity = log;
          this.fail(t('The llama.cpp helper engine stopped {0} times in a few minutes (last code {1}), so sharing was turned off. Check that both PCs run the same llama.cpp version in Models, then share again.', [this.crashes.length, code]));
        });
        return;
      }
      this.log('warn', t('The llama.cpp helper engine stopped (code {0}). Starting it again…', [code]));
      setTimeout(() => {
        if (this.child || this.stopping || this.engineUpdate) return;
        this.startSharing({ keepLog: true }).catch((err) => this.fail(err.message));
      }, 2000);
    });

    const proxy = net.createServer((socket) => this.relay(socket, enginePort));
    this.proxy = proxy;
    try {
      await new Promise((resolve, reject) => {
        proxy.once('error', reject);
        proxy.listen(bindPort, bind, resolve);
      });
    } catch (err) {
      await this.stopSharing({ quiet: true, remember: false });
      throw new Error(t('Could not open port {0} on {1}: {2}', [bindPort, bind, err.message]));
    }
    proxy.on('error', (err) => this.log('warn', t('Network error: {0}', [err.message])));
    this.monitorTimer = setInterval(() => this.monitor(), 5000);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (this.share.state === 'starting' && this.child === child) {
      this.share.state = 'on';
      this.log('info', t('Ready. Other PCs can now use this one at {0}:{1}.', [bind, bindPort]));
    }
    this.broadcast();
    return this.status();
  }

  fail(message) {
    this.share.state = 'error';
    this.share.error = message;
    this.log('warn', message);
    this.broadcast();
  }

  /** One connection from another PC, passed through to the engine and counted. */
  relay(socket, enginePort) {
    const session = {
      id: crypto.randomUUID(),
      address: String(socket.remoteAddress || '').replace(/^::ffff:/, ''),
      startedAt: Date.now(),
      received: 0,
      sent: 0,
      announced: false,
      phase: 'connected',
      receiveRate: 0,
      sendRate: 0,
      last: { received: 0, sent: 0, at: Date.now(), busyMs: 0, waitMs: 0 },
      // Where the time goes: this PC working on a request, or waiting for the main PC to send the next.
      busyMs: 0,
      waitMs: 0,
      lastAt: Date.now(),
      lastWasReply: false,
      upstream: null,
      socket,
    };
    this.sessions.set(session.id, session);
    socket.setNoDelay(true);
    // Another Uma checking whether this PC is online connects and leaves without sending anything,
    // so the engine is only contacted once data arrives.
    const announceTimer = setTimeout(() => this.announce(session), 3000);
    const close = () => {
      clearTimeout(announceTimer);
      socket.destroy();
      session.upstream?.destroy();
      if (!this.sessions.delete(session.id)) return;
      const length = durationLabel(Date.now() - session.startedAt);
      if (session.announced) {
        this.log('disconnect', t('{0} disconnected after {1}. Received {2}, sent {3}.', [session.address, length, sizeLabel(session.received), sizeLabel(session.sent)]));
      } else if (session.received) {
        // llama.cpp opens several short connections while it plans a model load; log them once.
        const text = t('{0} checked this helper (devices and free memory).', [session.address]);
        const recent = this.activity.findLast((entry) => entry.text === text);
        if (!recent || Date.now() - new Date(recent.at).getTime() > 60000) this.log('info', text);
      }
      this.scheduleBroadcast();
    };
    socket.on('data', (chunk) => {
      if (!session.upstream && !session.received && chunk.toString('latin1', 0, INFO_REQUEST.length) === INFO_REQUEST) {
        // Another Uma asking what this PC offers: answer and close, without involving the engine.
        this.sessions.delete(session.id);
        clearTimeout(announceTimer);
        socket.end(`${JSON.stringify(this.info())}\n`);
        // A newer Uma also says which llama.cpp build it runs; this PC must run the same one.
        let about = null;
        try { about = JSON.parse(chunk.toString('utf8', INFO_REQUEST.length).split('\n')[0]); } catch {}
        if (about?.engine) this.matchEngine(about.engine, session.address);
        if (about?.report) this.noteMainReport(session.address, about.report);
        return;
      }
      session.received += chunk.length;
      this.share.totals.received += chunk.length;
      // After a reply, the time until the next request is the main PC's own work (and the cable).
      const arrived = Date.now();
      if (session.lastWasReply) session.waitMs += arrived - session.lastAt;
      else session.busyMs += arrived - session.lastAt;
      session.lastAt = arrived;
      session.lastWasReply = false;
      if (!session.upstream) {
        // The engine stopped and is starting again: refuse rather than pass work to nothing.
        if (this.engineDown) {
          close();
          return;
        }
        session.upstream = net.connect({ host: '127.0.0.1', port: enginePort });
        session.upstream.setNoDelay(true);
        session.upstream.on('data', (reply) => {
          session.sent += reply.length;
          this.share.totals.sent += reply.length;
          const replied = Date.now();
          session.busyMs += replied - session.lastAt;
          session.lastAt = replied;
          session.lastWasReply = true;
          if (!socket.write(reply)) session.upstream.pause();
        });
        socket.on('drain', () => session.upstream?.resume());
        session.upstream.on('drain', () => socket.resume());
        session.upstream.on('close', close);
        session.upstream.on('error', close);
      }
      if (!session.upstream.write(chunk)) socket.pause();
      if (!session.announced && session.received > 8 * 1024 * 1024) this.announce(session);
    });
    socket.on('close', close);
    socket.on('error', close);
  }

  /** What this helper offers, in the order its engine lists the devices to the main PC. */
  info() {
    return {
      uma: 1,
      host: os.hostname(),
      threads: this.share.threads || 0,
      engine: this.store.getRuntime().version || '',
      engineUpdating: this.engineUpdate?.tag || '',
      devices: this.share.devices.map((device) => ({ kind: device.kind, name: device.name, totalMB: device.totalMB, reserveMB: device.reserveMB || 0 })),
      // For the main PC's Server status screen; an older Uma there ignores it.
      stats: this.ownReading(),
    };
  }

  /**
   * This PC right now: CPU, memory, GPU, internet, and the data it exchanged as a helper. Answers at
   * once with the last readings and refreshes them in the background (at most every 1.5 seconds; the
   * internet check every 15), so asking often costs nothing.
   */
  ownReading() {
    const now = Date.now();
    if (this.sampleStats && !this.own.busy && now - this.own.at > 1500) {
      this.own.busy = true;
      Promise.resolve().then(() => this.sampleStats())
        .then((value) => { if (value) this.own.stats = value; })
        .catch(() => {})
        .finally(() => { this.own.at = Date.now(); this.own.busy = false; });
    }
    if (!this.own.checking && now - this.own.internetAt > 15000) {
      this.own.checking = true;
      internetUp()
        .then((up) => {
          if (this.own.internet === true && !up) {
            this.own.internetDrops += 1;
            this.noteEvent('drop', os.hostname(), t('The internet connection dropped.'));
          } else if (this.own.internet === false && up) {
            this.noteEvent('back', os.hostname(), t('The internet connection is back.'));
          }
          this.own.internet = up;
        })
        .catch(() => {})
        .finally(() => { this.own.internetAt = Date.now(); this.own.checking = false; });
    }
    const stats = this.own.stats;
    const sessions = [...this.sessions.values()].filter((item) => item.announced);
    const warnings = this.activity.filter((entry) => entry.kind === 'warn');
    const last = warnings[warnings.length - 1];
    return {
      cpu: stats?.cpuPercent ?? null,
      ramUsed: stats?.ramUsedBytes ?? null,
      ramTotal: stats?.ramTotalBytes ?? os.totalmem(),
      gpu: stats?.gpu ? { percent: stats.gpu.percent, used: stats.gpu.usedBytes, total: stats.gpu.totalBytes } : null,
      net: stats?.net ? { rx: stats.net.rxBps, tx: stats.net.txBps } : null,
      internet: this.own.internet,
      internetDrops: this.own.internetDrops,
      received: this.share.totals.received,
      sent: this.share.totals.sent,
      receiveRate: sessions.reduce((sum, item) => sum + (item.receiveRate || 0), 0),
      sendRate: sessions.reduce((sum, item) => sum + (item.sendRate || 0), 0),
      clients: sessions.length,
      phase: sessions.some((item) => item.phase === 'computing') ? 'computing'
        : sessions.some((item) => item.phase === 'loading') ? 'loading'
          : sessions.length ? 'idle' : '',
      crashes: this.crashes.length,
      warnings: warnings.length,
      lastWarning: last ? { text: String(last.text).slice(0, 300), at: last.at } : null,
      sharedSince: this.share.state === 'on' ? this.share.startedAt : '',
      version: this.appVersion,
    };
  }

  /** One line for the Server status screen's list of events. Kinds: drop, back, warn. */
  noteEvent(kind, name, text) {
    this.events.push({ at: new Date().toISOString(), kind, name, text });
    if (this.events.length > 60) this.events.splice(0, this.events.length - 60);
  }

  /**
   * Every PC for the Server status screen: this one, then each helper set up here with what it
   * reports about itself right now. A helper that stops answering is counted as a drop.
   */
  serverStatus(inUse = []) {
    if (this.statusPending) return this.statusPending;
    this.statusPending = (async () => {
      const settings = this.settings();
      const helpers = await Promise.all(settings.helpers.map(async (item) => {
        const address = `${item.host}:${item.port}`;
        const name = item.label || address;
        const started = Date.now();
        const info = await helperInfo(item.host, item.port, 2000);
        const latencyMs = info ? Date.now() - started : null;
        // An older Uma, or a busy one, may only accept the connection.
        const online = Boolean(info) || await probe(item.host, item.port, 1200);
        const stats = cleanReading(info?.stats);
        const now = new Date().toISOString();
        const health = this.health.get(item.id) || { online: null, drops: 0, lastDropAt: '', lastSeenAt: '', warningAt: '' };
        if (health.online === true && !online) {
          health.drops += 1;
          health.lastDropAt = now;
          this.noteEvent('drop', name, t('Stopped answering at {0}. Its network or Uma on that PC went down.', [address]));
        } else if (health.online === false && online) {
          this.noteEvent('back', name, t('Answering again.'));
        }
        if (online) health.lastSeenAt = now;
        if (stats?.lastWarning?.text && stats.lastWarning.at !== health.warningAt) {
          // Warnings from before this screen first asked are that PC's history, not news.
          if (health.online !== null && Date.parse(stats.lastWarning.at) > this.watchingSince) this.noteEvent('warn', name, stats.lastWarning.text);
          health.warningAt = stats.lastWarning.at;
        }
        health.online = online;
        this.health.set(item.id, health);
        return {
          id: item.id,
          name,
          host: cleanText(info?.host, 60),
          address,
          enabled: Boolean(item.enabled) && settings.helpersMode !== 'off',
          online,
          inUse: inUse.includes(address),
          latencyMs,
          engine: cleanText(info?.engine, 20),
          engineUpdating: cleanText(info?.engineUpdating, 20),
          mismatch: info ? this.engineMismatch(info, name) : '',
          stats,
          drops: health.drops,
          lastDropAt: health.lastDropAt,
          lastSeenAt: health.lastSeenAt,
        };
      }));
      return {
        at: new Date().toISOString(),
        self: {
          name: os.hostname(),
          engine: this.store.getRuntime().version || '',
          sharing: this.share.state === 'on' ? `${this.share.address}:${this.share.port}` : '',
          stats: this.ownReading(),
        },
        helpers,
        events: this.events.slice(-40).reverse(),
      };
    })().finally(() => { this.statusPending = null; });
    return this.statusPending;
  }

  announce(session) {
    if (session.announced || !this.sessions.has(session.id) || !session.received) return;
    session.announced = true;
    this.share.totals.sessions += 1;
    this.log('connect', t('{0} connected and is using this PC as a helper.', [session.address]));
  }

  /** Every 5 seconds: what each connected PC is doing, from how much data moves each way. */
  monitor() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      const seconds = Math.max(1, (now - session.last.at) / 1000);
      const receivedNow = session.received - session.last.received;
      const sentNow = session.sent - session.last.sent;
      session.receiveRate = Math.round(receivedNow / seconds);
      session.sendRate = Math.round(sentNow / seconds);
      const busyNow = session.busyMs - session.last.busyMs;
      // A request still being worked on, or a wait still going on, counts up to this moment.
      const openMs = now - session.lastAt;
      const workedMs = busyNow + (session.lastWasReply ? 0 : Math.min(openMs, seconds * 1000));
      session.busyPercent = Math.max(0, Math.min(100, Math.round((workedMs / (seconds * 1000)) * 100)));
      session.last = { received: session.received, sent: session.sent, at: now, busyMs: session.busyMs, waitMs: session.waitMs };
      if (!session.announced) continue;
      // Loading sends model parts one way only; computing passes activations both ways. Parts this PC
      // already has in its cache come from its own disk, so a load can look slow on the network.
      const phase = !receivedNow && !sentNow ? 'idle' : isLoading(session) ? 'loading' : 'computing';
      if (phase === 'loading') {
        this.log('work', t("Loading the model for {0}: {1} received over the network so far, {2}/s. Parts already in this PC's cache are read from its disk instead.", [session.address, sizeLabel(session.received), sizeLabel(session.receiveRate)]));
      } else if (phase === 'computing') {
        this.log('work', t('Computing model layers for {0} · in {1}/s, out {2}/s. This PC worked {3}% of that time and waited for the main PC the rest.', [session.address, sizeLabel(session.receiveRate), sizeLabel(session.sendRate), session.busyPercent]));
      } else if (session.phase !== 'idle') {
        this.log('info', t('{0} is connected and waiting for its next request.', [session.address]));
      }
      session.phase = phase;
    }
    // A load can write gigabytes into the cache; keep the disk from filling up while it runs.
    this.monitorTicks = (this.monitorTicks || 0) + 1;
    if (this.monitorTicks % 6 === 0) this.tidyCache();
    this.scheduleBroadcast();
  }

  /**
   * If Uma crashes or is ended from Task Manager, before-quit never runs and the helper server would
   * keep running. A small separate process waits for Uma to exit and then stops the server.
   */
  startWatchdog(serverPid) {
    if (!serverPid) return null;
    const [file, args] = process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue; Stop-Process -Id ${serverPid} -Force -ErrorAction SilentlyContinue`]]
      : ['/bin/sh', ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done; kill ${serverPid} 2>/dev/null`]];
    try {
      const watchdog = spawn(file, args, { windowsHide: true, stdio: 'ignore', detached: process.platform !== 'win32' });
      watchdog.unref();
      return watchdog;
    } catch {
      return null;
    }
  }

  /**
   * The main PC and its helpers must run the same llama.cpp build: an older helper engine stops
   * (crashes) on work a newer main PC sends. When a main PC with a newer build asks about this PC,
   * this PC installs that build and restarts sharing on it. It never moves to an older build: the
   * main PC is told to update instead, so two main PCs cannot make a helper switch back and forth.
   */
  matchEngine(tag, address) {
    if (!this.isSharing()) return;
    const own = this.store.getRuntime();
    this.upgradeEngine(tag, t('{0} runs llama.cpp {1} and this PC runs {2}. Both must run the same version, so this PC is installing {1} now. Sharing continues by itself when it is done.', [address, tag, own.version || '?']));
  }

  /**
   * Installs llama.cpp `tag` in the background when it is newer than this PC's engine (never an
   * older one, so two PCs only ever meet at the newest build). Used by a helper that a newer main
   * PC asks about, by a main PC whose helper is newer, and after Uma itself is updated. A running
   * model keeps its engine; the next load uses the new one. Returns whether it is installing it.
   */
  upgradeEngine(tag, reason = '') {
    const own = this.store.getRuntime();
    if (this.engineUpdate?.tag === tag) return true;
    if (!this.runtime || this.engineUpdate || this.runtime.installing || !own.version) return false;
    if (buildNumber(tag) <= buildNumber(own.version)) return false;
    const failedAt = this.engineFailures.get(tag);
    if (failedAt && Date.now() - failedAt < 30 * 60 * 1000) return false;
    const sharing = this.isSharing();
    this.engineUpdate = { tag };
    if (reason) this.log('info', reason);
    this.runtime.install(this.runtime.activeBackend?.() || own.backend || 'auto', { tag, beforeReplace: () => this.stopSharing({ quiet: true, remember: false }) })
      .then(async () => {
        this.engineUpdate = null;
        this.log('info', sharing ? t('llama.cpp {0} is installed. Restarting the helper service…', [tag]) : t('llama.cpp {0} is installed. The next model load uses it.', [tag]));
        if (sharing) await this.startSharing({ keepLog: true });
      })
      .catch((err) => {
        this.engineUpdate = null;
        this.engineFailures.set(tag, Date.now());
        this.log('warn', t('Could not install llama.cpp {0}: {1} Update the engine in Models on this PC.', [tag, err.message]));
      });
    return true;
  }

  /**
   * On the main PC: tells the helpers a model is spread over what this PC is doing with it (the
   * model and how it was split after a load, the measured speed after a reply). A helper only sees
   * its own share of the work, so without this its Shared screen cannot say why it is waiting.
   * Nothing waits for this, and an older Uma on the helper ignores it.
   */
  reportToHelpers(servers, report) {
    const about = { ...(this.engineAbout() || {}), report };
    for (const address of servers || []) {
      const [host, port] = String(address).split(':');
      helperInfo(host, Number(port), 1500, about).catch(() => {});
    }
  }

  /** On a helper: shows what the main PC reported. The text comes from another PC, so it is cleaned and cut. */
  noteMainReport(address, report) {
    const now = Date.now();
    if (now - (this.lastReportAt || 0) < 1000) return;
    this.lastReportAt = now;
    const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
    const summary = clean(report?.summary, 600);
    if (!summary) return;
    if (report.kind === 'loaded') {
      this.log('info', t('The main PC {0} loaded {1}. {2}', [address, clean(report.model, 100) || '?', summary]));
    } else if (report.kind === 'reply') {
      this.log('info', t('The main PC {0} finished a reply: {1}', [address, summary]));
    }
  }

  /** Why a helper cannot be used with this PC's engine, or '' when it can (or does not say its build). */
  engineMismatch(info, label) {
    const own = this.store.getRuntime().version || '';
    if (!info?.engine || !own || info.engine === own) return '';
    if (info.engineUpdating === own || buildNumber(info.engine) < buildNumber(own)) {
      return t('{0} runs llama.cpp {1} and this PC runs {2}. Both must run the same version: {0} is installing {2} now, which takes a few minutes. Until then models load without it.', [label, info.engine, own]);
    }
    // The helper is newer: this PC catches up by itself.
    if (this.upgradeEngine(info.engine, t('{0} runs llama.cpp {1} and this PC runs {2}, so this PC is installing {1} now.', [label, info.engine, own]))) {
      return t('{0} runs llama.cpp {1} and this PC runs {2}. Both must run the same version: this PC is installing {1} now, which takes a few minutes. Until then models load without {0}.', [label, info.engine, own]);
    }
    return t('{0} runs llama.cpp {1} and this PC runs {2}. Both must run the same version: update the engine on this PC in Models. Until then models load without {0}.', [label, info.engine, own]);
  }

  /** Removes the least recently used cached model parts while the disk is short of free space. */
  async tidyCache() {
    if (this.tidying) return this.tidying;
    this.tidying = pruneCache(this.cacheDir)
      .then((result) => {
        if (result.removed) {
          this.log('info', t('Removed {0} old cached model parts ({1}) so this PC keeps {2} free on its disk. The cache now holds {3}.', [result.removed, sizeLabel(result.freedBytes), sizeLabel(result.keepFreeBytes), sizeLabel(result.cacheBytes)]));
        }
        return result;
      })
      .catch(() => ({ enoughSpace: true, removed: 0 }))
      .finally(() => { this.tidying = null; });
    return this.tidying;
  }

  /** Says on the Shared screen when this PC slows its own CPU down while it works. */
  startClockWatch() {
    this.clockWatch?.stop();
    this.clockWatch = new ClockWatch({
      onSlow: ({ mhz, peakMHz }) => this.log('warn', t('This PC is slowing its CPU down while it works: {0} GHz instead of up to {1} GHz. The PC does this itself, usually because it is too hot or its charger is not powerful enough, and Uma cannot undo it. Use the original charger, keep the vents free, and choose the maximum performance mode in the maker\'s app or in Windows power settings.', [(mhz / 1000).toFixed(1), (peakMHz / 1000).toFixed(1)])),
      onRecovered: ({ mhz }) => this.log('info', t('The CPU is back to full speed ({0} GHz).', [(mhz / 1000).toFixed(1)])),
    });
    this.clockWatch.start().catch(() => {});
  }

  async stopSharing({ quiet = false, remember = true } = {}) {
    try { this.watchdog?.kill(); } catch {}
    this.watchdog = null;
    this.clockWatch?.stop();
    this.clockWatch = null;
    clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    for (const session of this.sessions.values()) {
      session.socket.destroy();
      session.upstream?.destroy();
    }
    this.sessions.clear();
    const proxy = this.proxy;
    this.proxy = null;
    if (proxy) {
      await new Promise((resolve) => {
        proxy.close(() => resolve());
        setTimeout(resolve, 1000);
      });
    }
    const child = this.child;
    this.stopping = true;
    this.child = null;
    if (child) {
      try {
        if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill();
      } catch {}
    }
    this.share = emptyShare();
    if (remember) await this.save({ share: false });
    else if (!quiet) this.broadcast();
    return this.status();
  }

  /** Starts sharing again on launch if it was on when the app closed. */
  async resume() {
    if (this.settings().share) await this.startSharing().catch((err) => this.fail(err.message));
  }

  // ---- using other PCs ----

  async addHelper({ host, port, label }) {
    const helper = { id: crypto.randomUUID(), host: cleanHost(host), port: cleanPort(port), label: String(label || '').trim().slice(0, 60), enabled: true, lastTest: null };
    const helpers = this.settings().helpers;
    if (helpers.some((item) => item.host === helper.host && item.port === helper.port)) throw new Error(t('That helper is already in the list.'));
    await this.save({ helpers: [...helpers, helper] });
    return this.testHelper(helper.id);
  }

  async updateHelper(id, patch) {
    const helpers = this.settings().helpers.map((item) => (item.id === id ? {
      ...item,
      ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
      ...(patch.label !== undefined ? { label: String(patch.label).trim().slice(0, 60) } : {}),
    } : item));
    await this.save({ helpers });
    return this.status();
  }

  async removeHelper(id) {
    await this.save({ helpers: this.settings().helpers.filter((item) => item.id !== id) });
    return this.status();
  }

  /** Whether a shared PC also lends its RAM; a running share restarts to apply it. */
  async setShareRam(on) {
    await this.save({ shareRam: Boolean(on) });
    if (this.isSharing()) await this.startSharing();
    return this.status();
  }

  /** Whether a shared PC gives all its CPU threads and RAM; a running share restarts to apply it. */
  async setFullPower(on) {
    await this.save({ fullPower: Boolean(on) });
    if (this.isSharing()) await this.startSharing();
    return this.status();
  }

  /** Where the main PC puts layers that fit no GPU: its own RAM first, or the helpers' RAM first. */
  async setHelperRamFirst(on) {
    await this.save({ helperRamFirst: Boolean(on) });
    return this.status();
  }

  async setMode(mode) {
    if (!HELPER_MODES.includes(mode)) throw new Error(t('Unknown helper mode.'));
    await this.save({ helpersMode: mode });
    return this.status();
  }

  /**
   * Asks llama.cpp itself to connect: this checks the address, that the helper's engine speaks the
   * same RPC protocol version, and reads how much memory each of its devices has free.
   */
  async testHelper(id) {
    const helper = this.settings().helpers.find((item) => item.id === id);
    if (!helper) throw new Error(t('Helper not found.'));
    const serverPath = this.store.getRuntime().serverPath;
    let result;
    let info = null;
    if (!(await probe(helper.host, helper.port, 2500))) {
      result = { ok: false, error: t('Nothing answered at {0}:{1}. Check that "Share this PC" is on there, the address and port are right, and its firewall allows Uma.', [helper.host, helper.port]) };
    } else if (!serverPath) {
      result = { ok: false, error: t('The helper answers. Install the llama.cpp engine in Models to use it.') };
    } else if ((info = await helperInfo(helper.host, helper.port, 2500, this.engineAbout())) && this.engineMismatch(info, helper.label || helper.host)) {
      // Asking a different build for its devices is already enough to make it stop.
      result = { ok: false, error: this.engineMismatch(info, helper.label || helper.host) };
    } else {
      const output = await new Promise((resolve) => {
        execFile(serverPath, ['--rpc', `${helper.host}:${helper.port}`, '--list-devices'], {
          cwd: path.dirname(serverPath), windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => resolve({ error, text: `${stdout}\n${stderr}` }));
      });
      // The helper's own description says which device is its GPU and which its RAM.
      const devices = parseDevices(output.text).map((device, index) => ({
        ...device,
        kind: info?.devices?.[index]?.kind || 'gpu',
        name: info?.devices?.[index]?.name || device.name,
      }));
      if (devices.length) {
        result = { ok: true, devices, host: info?.host || '' };
      } else {
        const reason = output.text.match(/(version mismatch[^\n]*|protocol[^\n]*|Failed to connect[^\n]*)/i)?.[1];
        result = {
          ok: false,
          error: reason && /version|protocol/i.test(reason)
            ? t('The helper runs a different llama.cpp version ({0}). Update the engine on both PCs in Models.', [reason.trim()])
            : output.error?.killed
              ? t('The helper did not answer in time. It may be busy serving another PC.')
              : t('Could not use the helper. {0}', [(reason || output.text.trim().split(/\r?\n/).slice(-1)[0] || '').trim()]),
        };
      }
    }
    const helpers = this.settings().helpers.map((item) => (item.id === id ? { ...item, lastTest: { ...result, testedAt: new Date().toISOString() } } : item));
    await this.save({ helpers });
    return this.status();
  }

  enabledHelpers() {
    const settings = this.settings();
    return settings.helpersMode === 'off' ? [] : settings.helpers.filter((item) => item.enabled);
  }

  /** What this PC tells a helper about itself. */
  engineAbout() {
    const engine = this.store.getRuntime().version || '';
    return engine ? { engine } : null;
  }

  /** Changes here should reload the model, so they are part of the server's launch key. */
  launchKey() {
    const settings = this.settings();
    return JSON.stringify([settings.helpersMode, this.enabledHelpers().map((item) => `${item.host}:${item.port}`), Boolean(settings.helperRamFirst)]);
  }

  /** Free memory on the enabled helpers at their last successful test, for the memory estimate. */
  helperFreeGB() {
    if (this.settings().helpersMode === 'off') return 0;
    const mb = this.enabledHelpers().reduce((sum, item) => sum + (item.lastTest?.ok
      ? item.lastTest.devices.reduce((total, device) => total + device.freeMB, 0)
      : 0), 0);
    return mb / 1024;
  }

  /**
   * Which enabled helpers answer right now, for the title bar. A helper the loaded model is using
   * counts as connected without a probe: while it serves this PC it may not accept another connection.
   */
  async presence(inUse = []) {
    const settings = this.settings();
    const helpers = this.enabledHelpers();
    const online = await Promise.all(helpers.map(async (item) => {
      const address = `${item.host}:${item.port}`;
      const connected = inUse.includes(address) || await probe(item.host, item.port, 1200);
      return connected ? { name: item.label || address, address, inUse: inUse.includes(address) } : null;
    }));
    return {
      configured: helpers.length,
      online: online.filter(Boolean),
      mode: settings.helpersMode,
      sharing: this.share.state === 'on' ? `${this.share.address}:${this.share.port}` : '',
    };
  }

  /**
   * The helpers to pass to llama-server. llama.cpp stops if any --rpc address does not answer,
   * so unreachable ones are left out (and reported) rather than failing the whole load.
   */
  async helpersForLaunch({ fitsHere }) {
    const mode = this.settings().helpersMode;
    const candidates = this.enabledHelpers();
    if (!candidates.length || (mode === 'auto' && fitsHere)) return { servers: [], skipped: [], details: [] };
    // The info answer also proves the helper is up; an older Uma only answers the plain probe.
    // A helper on a different llama.cpp build would stop on this PC's work and take the load down with
    // it, so it is left out; telling it this PC's build lets it update itself.
    const about = this.engineAbout();
    const checks = await Promise.all(candidates.map(async (item) => {
      const info = await helperInfo(item.host, item.port, 2500, about);
      const label = item.label || item.host;
      const mismatch = this.engineMismatch(info, label);
      return { item, info, label, mismatch, ok: !mismatch && (Boolean(info) || await probe(item.host, item.port)) };
    }));
    const mismatched = checks.filter((check) => check.mismatch);
    if (mismatched.length) {
      const testedAt = new Date().toISOString();
      const helpers = this.settings().helpers.map((item) => {
        const check = mismatched.find((entry) => entry.item.id === item.id);
        return check ? { ...item, lastTest: { ok: false, error: check.mismatch, testedAt } } : item;
      });
      await this.save({ helpers });
    }
    const up = checks.filter((check) => check.ok);
    return {
      servers: up.map((check) => `${check.item.host}:${check.item.port}`),
      details: up.map((check) => ({ address: `${check.item.host}:${check.item.port}`, label: check.label, info: check.info })),
      skipped: checks.filter((check) => !check.ok && !check.mismatch).map((check) => check.item.label || `${check.item.host}:${check.item.port}`),
      mismatched: mismatched.map((check) => check.mismatch),
    };
  }
}

module.exports = { isLoading, cleanReading, NetworkManager, DEFAULT_NETWORK, parseDevices, isPrivateIPv4, cleanHost, cleanPort, helperInfo, localDevices, INFO_REQUEST };
