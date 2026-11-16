const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { ensureDir, downloadFile, formatBytes } = require('./util.cjs');
const { t } = require('./i18n.cjs');

const FALLBACK_TAGS = ['b11976', 'b11972', 'b11970'];
// CUDA builds published for each OS, newest first. Linux builds bundle the CUDA runtime in one archive.
// Newer releases (b12191 on) publish Windows CUDA 13.5 and 12.4; older ones 13.4 and 12.4.
const CUDA_BUILDS = process.platform === 'linux' ? ['13.5', '12.8'] : ['13.5', '13.4', '12.4'];

const BACKENDS = {
  cuda: { label: 'GPU · CUDA', download: 'about 560 MB' },
  vulkan: { label: 'GPU · Vulkan', download: 'about 36 MB' },
  cpu: { label: 'CPU', download: 'about 25 MB' },
  // Intel Macs: llama.cpp publishes no Metal build for them (and Homebrew does not either), so Uma
  // compiles one on the Mac itself. Apple silicon gets the official Metal build.
  metal: { label: 'GPU · Metal', download: 'built on this Mac, about 15 minutes' },
};

// Where CMake usually is on a Mac: apps started from the Dock do not get the Terminal's PATH.
const MAC_CMAKE = ['/opt/homebrew/bin/cmake', '/usr/local/bin/cmake', '/Applications/CMake.app/Contents/bin/cmake', 'cmake'];

/** Runs a command and passes each output line on as it comes; stops it when `signal` aborts. */
function runStreaming(file, args, { cwd, signal, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true });
    let tail = '';
    const take = (data) => {
      const text = String(data);
      tail = `${tail}${text}`.slice(-4000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        const err = new Error('Install cancelled.');
        err.name = 'AbortError';
        reject(err);
      } else if (code === 0) resolve(tail);
      else reject(new Error(tail.trim().split(/\r?\n/).slice(-12).join('\n')));
    });
  });
}

function exec(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code || 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function findServer(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isFile() && /^llama-server(\.exe)?$/i.test(entry.name)) return abs;
    if (entry.isDirectory()) {
      const found = await findServer(abs);
      if (found) return found;
    }
  }
  return null;
}

function versionAtLeast(version, minimum) {
  const [major, minor] = String(version).split('.').map(Number);
  const [wantMajor, wantMinor] = minimum.split('.').map(Number);
  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}

/**
 * CUDA builds this driver can run, newest first. An unknown driver version gets all of them.
 * On Linux the builds do not include the CUDA runtime, so `libs` lists the CUDA major versions
 * whose libcudart and libcublas are installed, and only those builds count.
 */
function cudaBuildsFor(driverVersion, libs = null) {
  const builds = driverVersion ? CUDA_BUILDS.filter((build) => versionAtLeast(driverVersion, build)) : CUDA_BUILDS;
  return libs ? builds.filter((build) => libs.includes(build.split('.')[0])) : builds;
}

class RuntimeManager {
  constructor({ store, runtimeDir, downloadsDir, emit, hardware, platform = process.platform }) {
    this.platform = platform;
    this.store = store;
    this.runtimeDir = runtimeDir;
    this.downloadsDir = downloadsDir;
    this.emit = emit || (() => {});
    this.hardware = hardware;
    this.installing = false;
    this.catalogCache = new Map();
    this.controller = null;
  }

  cudaLibs() {
    return process.platform === 'linux' ? this.hardware?.cudaLibs || [] : null;
  }

  /** The Mac's real chip: an Intel copy of Uma on Apple silicon runs under Rosetta and says x64. */
  macArch() {
    return this.hardware?.appleSilicon || process.arch === 'arm64' ? 'arm64' : 'x64';
  }

  /** Intel Mac: the official engine runs on the CPU, and a Metal one can be built here. */
  isIntelMac() {
    return this.platform === 'darwin' && this.macArch() === 'x64';
  }

  cudaProblem() {
    if (this.platform === 'darwin') return 'Macs use Metal, not CUDA.';
    if (!this.hardware?.nvidia) return 'CUDA needs an NVIDIA GPU.';
    if (!cudaBuildsFor(this.hardware.cudaVersion).length) {
      return `Your NVIDIA driver supports CUDA ${this.hardware.cudaVersion}, and CUDA ${CUDA_BUILDS[CUDA_BUILDS.length - 1]} or newer is required. Update the driver, or use Vulkan.`;
    }
    if (!cudaBuildsFor(this.hardware.cudaVersion, this.cudaLibs()).length) {
      const major = cudaBuildsFor(this.hardware.cudaVersion).at(-1).split('.')[0];
      return `CUDA on Linux needs NVIDIA's CUDA libraries, which are not installed. Install them with "sudo apt install libcudart${major} libcublas${major}" (or the CUDA toolkit), then restart Uma. Vulkan works without them.`;
    }
    return '';
  }

  backendFor(backend = 'auto') {
    if (this.platform === 'darwin') return this.isIntelMac() && backend !== 'metal' ? 'cpu' : 'metal';
    if (backend === 'cpu' || backend === 'vulkan' || backend === 'cuda') return backend;
    if (!this.cudaProblem()) return 'cuda';
    return this.hardware?.hasGpu ? 'vulkan' : 'cpu';
  }

  assetFor(tag, backend, cudaBuild) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    if (this.platform === 'win32') {
      const flavor = backend === 'cuda' ? `cuda-${cudaBuild}` : backend;
      return {
        name: `llama-${tag}-bin-win-${flavor}-${arch}.zip`,
        kind: 'zip',
        extra: backend === 'cuda' ? `cudart-llama-bin-win-cuda-${cudaBuild}-${arch}.zip` : '',
      };
    }
    if (this.platform === 'darwin') {
      return { name: `llama-${tag}-bin-macos-${this.macArch()}.tar.gz`, kind: 'tar', extra: '' };
    }
    // Linux: ubuntu-x64 (CPU), ubuntu-vulkan-x64, ubuntu-cuda-13.5-x64; they also run on Debian.
    const flavor = backend === 'cuda' ? `cuda-${cudaBuild}-` : backend === 'vulkan' ? 'vulkan-' : '';
    return { name: `llama-${tag}-bin-ubuntu-${flavor}${arch}.tar.gz`, kind: 'tar', extra: '' };
  }

  /**
   * The newest build with an archive for this backend, or exactly `wantedTag` (a helper PC must run
   * the same llama.cpp build as the main PC it serves).
   */
  async findRelease(backend, cudaBuild, wantedTag = '') {
    const cacheKey = `${backend}:${cudaBuild || ''}:${wantedTag}`;
    if (this.catalogCache.has(cacheKey)) return this.catalogCache.get(cacheKey);
    let releases = [];
    try {
      const url = wantedTag
        ? `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${encodeURIComponent(wantedTag)}`
        : 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=25';
      const response = await fetch(url, {
        headers: { 'User-Agent': 'UmaLLM/0.2', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) releases = [].concat(await response.json());
    } catch {}

    const tags = wantedTag ? [wantedTag] : [
      ...releases.filter((release) => /^b\d+$/.test(release.tag_name || '')).map((release) => release.tag_name),
      ...FALLBACK_TAGS,
    ];
    for (const tag of tags) {
      const release = releases.find((item) => item.tag_name === tag);
      const asset = this.assetFor(tag, backend, cudaBuild);
      const match = release?.assets?.find((item) => item.name === asset.name);
      const extra = asset.extra ? release?.assets?.find((item) => item.name === asset.extra) : null;
      if (match && (!asset.extra || extra)) {
        const found = {
          tag,
          backend,
          kind: asset.kind,
          archives: [match, extra].filter(Boolean).map((item) => ({ name: item.name, url: item.browser_download_url, size: item.size })),
        };
        this.catalogCache.set(cacheKey, found);
        return found;
      }
    }
    // The release was read but has no such build (newer releases publish Windows CUDA 13.5 and 12.4,
    // no 13.4): the caller tries the next CUDA build instead of downloading a file that is not there.
    if (wantedTag && releases.some((item) => item.tag_name === wantedTag)) {
      const err = new Error(t('llama.cpp {0} has no {1} build for this PC.', [wantedTag, cudaBuild ? `CUDA ${cudaBuild}` : backend]));
      err.code = 'NO_BUILD';
      throw err;
    }
    // If the GitHub API is rate-limited or unavailable, fall back to the
    // predictable release asset URL for a known build.
    const fallbackTag = wantedTag || FALLBACK_TAGS[0];
    const fallbackAsset = this.assetFor(fallbackTag, backend, cudaBuild);
    const fallback = {
      tag: fallbackTag,
      backend,
      kind: fallbackAsset.kind,
      archives: [fallbackAsset.name, fallbackAsset.extra].filter(Boolean).map((name) => ({
        name,
        url: `https://github.com/ggml-org/llama.cpp/releases/download/${fallbackTag}/${name}`,
        size: 0,
      })),
    };
    this.catalogCache.set(cacheKey, fallback);
    return fallback;
  }

  /** Every installed engine, keyed by backend. Older settings only recorded the active one. */
  installs() {
    const runtime = this.store.getRuntime();
    let installs;
    if (runtime.installs) installs = { ...runtime.installs };
    else if (!runtime.serverPath || !runtime.backend) return {};
    else {
      const { installs: _ignored, ...entry } = runtime;
      installs = { [runtime.backend]: entry };
    }
    // Older versions recorded the official Intel Mac engine, which has no Metal, as "metal".
    if (this.isIntelMac() && installs.metal && !installs.metal.builtLocally) {
      installs.cpu = installs.cpu || { ...installs.metal, backend: 'cpu' };
      delete installs.metal;
    }
    return installs;
  }

  /** The kind of engine in use (an Intel Mac's official engine is the CPU one, whatever older versions recorded). */
  activeBackend() {
    const runtime = this.store.getRuntime();
    if (this.isIntelMac() && runtime.backend === 'metal' && !runtime.builtLocally) return 'cpu';
    return runtime.backend || 'auto';
  }

  /** On an Intel Mac: what is missing to build the Metal engine, or '' when it can be built. */
  async macBuildTools() {
    const clt = await exec('xcode-select', ['-p'], { timeout: 15000 });
    if (!clt.ok) return { problem: t('Building needs Apple\'s Command Line Tools. Open Terminal, run "xcode-select --install", finish the installer, then try again.') };
    for (const candidate of MAC_CMAKE) {
      const found = await exec(candidate, ['--version'], { timeout: 15000 });
      if (found.ok) return { problem: '', cmake: candidate };
    }
    return { problem: t('Building needs CMake. Install it with "brew install cmake" in Terminal, or from cmake.org, then try again.') };
  }

  async status() {
    const runtime = this.store.getRuntime();
    const serverPath = runtime.serverPath || '';
    const exists = serverPath ? Boolean(await fsp.stat(serverPath).catch(() => null)) : false;
    const installs = this.installs();
    const backends = [];
    // Apple silicon has one engine (Metal); an Intel Mac the official CPU one and one built here.
    const choices = this.platform === 'darwin' ? (this.isIntelMac() ? ['cpu', 'metal'] : []) : ['cuda', 'vulkan', 'cpu'];
    for (const id of choices) {
      const info = BACKENDS[id];
      const entry = installs[id];
      const present = entry ? Boolean(await fsp.stat(entry.serverPath).catch(() => null)) : false;
      const problem = id === 'cuda' ? this.cudaProblem() : id === 'vulkan' && !this.hardware?.hasGpu ? 'No GPU was detected.' : '';
      backends.push({
        id,
        label: t(info.label),
        download: t(info.download),
        available: !problem,
        reason: problem,
        installed: present,
        version: present ? entry.version : '',
        active: exists && runtime.serverPath === entry?.serverPath,
        build: id === 'metal' && this.isIntelMac(),
      });
    }
    return {
      installed: Boolean(exists),
      version: runtime.version || '',
      backend: this.isIntelMac() && runtime.backend === 'metal' && !runtime.builtLocally ? 'cpu' : runtime.backend || '',
      serverPath,
      installedAt: runtime.installedAt || '',
      recommendedBackend: this.backendFor('auto'),
      backends,
      hardware: this.hardware,
      installing: this.installing,
    };
  }

  /** Makes an already installed engine the active one. Nothing is downloaded. */
  async use(backend) {
    const entry = this.installs()[backend];
    if (!entry || !(await fsp.stat(entry.serverPath).catch(() => null))) {
      throw new Error(t('The {0} engine is not installed.', [t(BACKENDS[backend]?.label || backend)]));
    }
    await this.store.setRuntime({ ...entry, installs: this.installs() });
    return this.status();
  }

  async install(backend = 'auto', { beforeReplace = async () => {}, tag = '' } = {}) {
    if (this.installing) throw new Error(t('A runtime install is already running.'));
    this.installing = true;
    const resolvedBackend = this.backendFor(backend);
    this.controller = new AbortController();
    const send = (payload) => this.emit('runtime:progress', payload);
    try {
      await ensureDir(this.runtimeDir);
      await ensureDir(this.downloadsDir);
      try {
        await this.installBackend(resolvedBackend, { send, beforeReplace, tag });
      } catch (err) {
        // Only when Uma chose CUDA itself: rather than leave the app with no engine, use Vulkan.
        if (backend !== 'auto' || resolvedBackend !== 'cuda' || err.code !== 'NO_CUDA_DEVICE') throw err;
        const fallback = this.hardware?.hasGpu ? 'vulkan' : 'cpu';
        send({ phase: 'resolving', percent: 2, message: t('CUDA cannot see the GPU, so installing the {0} engine instead…', [t(BACKENDS[fallback].label)]) });
        await this.installBackend(fallback, { send, beforeReplace, tag });
      }
      const status = await this.status();
      send({ phase: 'done', percent: 100, message: t('Local inference engine installed.'), status });
      return status;
    } catch (err) {
      const message = err.name === 'AbortError' ? 'Install cancelled.' : err.message;
      send({ phase: 'error', percent: 0, message });
      throw new Error(message);
    } finally {
      this.installing = false;
      this.controller = null;
    }
  }

  async installBackend(backend, { send, beforeReplace, tag }) {
    if (backend === 'metal' && this.isIntelMac()) return this.buildMetal({ send, beforeReplace, tag });
    let builds = [null];
    if (backend === 'cuda') {
      const problem = this.cudaProblem();
      if (problem) throw new Error(problem);
      builds = cudaBuildsFor(this.hardware.cudaVersion, this.cudaLibs());
    }
    for (let index = 0; ; index += 1) {
      try {
        await this.installBuild(backend, builds[index], { send, beforeReplace, tag });
        return;
      } catch (err) {
        // A driver can advertise a CUDA version whose build still rejects an older GPU, and a
        // release may not publish every CUDA build.
        if (!['NO_CUDA_DEVICE', 'NO_BUILD'].includes(err.code) || index + 1 >= builds.length) throw err;
        send({
          phase: 'resolving',
          percent: 2,
          message: err.code === 'NO_BUILD'
            ? t('This llama.cpp version has no CUDA {0} build. Using CUDA {1}…', [builds[index], builds[index + 1]])
            : t('CUDA {0} cannot see the GPU. Trying CUDA {1}…', [builds[index], builds[index + 1]]),
        });
      }
    }
  }

  async installBuild(backend, cudaBuild, { send, beforeReplace, tag }) {
    send({ phase: 'resolving', percent: 1, message: t('Finding the latest llama.cpp build…') });
    const release = await this.findRelease(backend, cudaBuild, tag);
    const totalBytes = release.archives.reduce((sum, item) => sum + item.size, 0);
    const buildLabel = cudaBuild ? `CUDA ${cudaBuild}` : backend;
    let doneBytes = 0;
    const archivePaths = [];
    for (const item of release.archives) {
      const archive = path.join(this.downloadsDir, item.name);
      archivePaths.push(archive);
      const existing = await fsp.stat(archive).catch(() => null);
      const complete = existing && (item.size ? existing.size === item.size : existing.size > 10 * 1024 * 1024);
      if (!complete) {
        send({
          phase: 'downloading',
          percent: 3,
          message: t('Downloading llama.cpp {0} ({1})…', [release.tag, buildLabel]),
          detail: totalBytes ? formatBytes(totalBytes) : '',
        });
        await downloadFile(item.url, archive, {
          signal: this.controller.signal,
          expectedSize: item.size,
          label: `llama.cpp ${release.tag}`,
          onProgress: (progress) => {
            const received = doneBytes + (progress.received || 0);
            send({
              phase: 'downloading',
              percent: 3 + (totalBytes ? (received / totalBytes) * 100 : progress.percent) * 0.72,
              received,
              total: totalBytes || progress.total,
              speed: progress.speed,
              message: t('Downloading llama.cpp {0} ({1})…', [release.tag, buildLabel]),
              detail: totalBytes ? `${formatBytes(received)} of ${formatBytes(totalBytes)}` : '',
            });
          },
        });
      }
      doneBytes += item.size;
    }

    send({ phase: 'extracting', percent: 78, message: t('Unpacking the local inference engine…') });
    const installDir = path.join(this.runtimeDir, `llama-${release.tag}-${backend}`);
    const tempDir = path.join(this.runtimeDir, `.extract-${Date.now()}`);
    await fsp.rm(tempDir, { recursive: true, force: true });
    await ensureDir(tempDir);
    try {
      for (const archive of archivePaths) {
        const extracted = await exec('tar', ['-xf', archive, '-C', tempDir], { timeout: 600000 });
        if (!extracted.ok) {
          await fsp.rm(archive, { force: true }).catch(() => {});
          throw new Error(t('Could not unpack llama.cpp: {0}', [(extracted.stderr || extracted.stdout).slice(0, 300)]));
        }
      }

      send({ phase: 'verifying', percent: 90, message: t('Checking the inference server…') });
      const foundServer = await findServer(tempDir);
      if (!foundServer) throw new Error(t('The llama.cpp archive did not contain llama-server.'));
      const versionResult = await exec(foundServer, ['--version'], { timeout: 15000 });
      const versionLine = `${versionResult.stdout}\n${versionResult.stderr}`.trim().split(/\r?\n/)[0] || release.tag;
      if (backend === 'cuda') {
        const devices = await exec(foundServer, ['--list-devices'], { timeout: 30000 });
        if (!/CUDA\d+\s*:/i.test(`${devices.stdout}\n${devices.stderr}`)) {
          const err = new Error(t('This CUDA build could not find your GPU, so the install was cancelled. Update the NVIDIA driver, or use Vulkan.\n\n{0}', [`${devices.stdout}\n${devices.stderr}`.trim().slice(0, 400)]));
          err.code = 'NO_CUDA_DEVICE';
          throw err;
        }
      }

      const active = this.store.getRuntime();
      if (active.serverPath && active.serverPath.startsWith(installDir + path.sep)) await beforeReplace();
      await fsp.rm(installDir, { recursive: true, force: true });
      await fsp.rename(tempDir, installDir);
      const finalServer = await findServer(installDir);
      const entry = {
        version: release.tag,
        versionLine,
        backend,
        ...(cudaBuild ? { cudaBuild } : {}),
        serverPath: finalServer,
        installedAt: new Date().toISOString(),
      };
      await this.store.setRuntime({ ...entry, installs: { ...this.installs(), [backend]: entry } });
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    // Engines are large, and the unpacked copy is all that is needed from here on.
    await Promise.all(archivePaths.map((archive) => fsp.rm(archive, { force: true }).catch(() => {})));
  }

  cancel() {
    this.controller?.abort();
  }

  /**
   * Intel Mac: downloads the llama.cpp source of `tag` and compiles it with Metal, so the AMD (or
   * Intel) GPU can be used. It needs Apple's Command Line Tools and CMake; the Metal shaders are
   * built into the program, so Xcode itself is not needed. About 15 minutes on an i9.
   */
  async buildMetal({ send, beforeReplace, tag }) {
    const tools = await this.macBuildTools();
    if (tools.problem) throw new Error(tools.problem);
    const wanted = tag || ENGINE_BUILD;
    const signal = this.controller.signal;
    const archive = path.join(this.downloadsDir, `llama.cpp-${wanted}-source.tar.gz`);
    const message = t('Building llama.cpp {0} with Metal on this Mac…', [wanted]);
    send({ phase: 'downloading', percent: 2, message: t('Downloading the llama.cpp {0} source code…', [wanted]) });
    await downloadFile(`https://github.com/ggml-org/llama.cpp/archive/refs/tags/${wanted}.tar.gz`, archive, {
      signal,
      label: `llama.cpp ${wanted}`,
      onProgress: (progress) => send({ phase: 'downloading', percent: 2 + (progress.percent || 0) * 0.08, speed: progress.speed, message: t('Downloading the llama.cpp {0} source code…', [wanted]), detail: formatBytes(progress.received || 0) }),
    });
    const work = path.join(this.runtimeDir, `.build-${wanted}`);
    await fsp.rm(work, { recursive: true, force: true });
    await ensureDir(work);
    try {
      const unpacked = await exec('tar', ['-xzf', archive, '-C', work], { timeout: 600000 });
      if (!unpacked.ok) throw new Error(t('Could not unpack llama.cpp: {0}', [(unpacked.stderr || unpacked.stdout).slice(0, 300)]));
      const source = path.join(work, (await fsp.readdir(work)).find((name) => !name.startsWith('.')) || '');
      const build = path.join(source, 'build');
      send({ phase: 'extracting', percent: 12, message, detail: t('Preparing the build…') });
      await runStreaming(tools.cmake, ['-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON',
        '-DGGML_RPC=ON', '-DBUILD_SHARED_LIBS=OFF', '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_CURL=OFF'], { cwd: source, signal });
      await runStreaming(tools.cmake, ['--build', build, '--config', 'Release', '-j', String(Math.max(2, os.cpus().length))], {
        cwd: source,
        signal,
        // CMake prints "[ 42%] Building ..." lines: they drive the progress bar.
        onLine: (line) => {
          const step = line.match(/^\[\s*(\d+)%\]/);
          if (step) send({ phase: 'extracting', percent: 15 + Number(step[1]) * 0.75, message, detail: line.replace(/^\[\s*\d+%\]\s*/, '').slice(0, 90) });
        },
      });
      send({ phase: 'verifying', percent: 92, message: t('Checking that Metal can see the GPU…') });
      const builtServer = await findServer(path.join(build, 'bin'));
      if (!builtServer) throw new Error(t('The build finished without llama-server.'));
      const devices = await exec(builtServer, ['--list-devices'], { timeout: 60000 });
      const listed = `${devices.stdout}\n${devices.stderr}`;
      if (!/MTL\d+\s*:/.test(listed)) {
        throw new Error(t('llama.cpp was built, but Metal found no GPU it can use on this Mac, so the CPU engine stays in use.\n\n{0}', [listed.trim().slice(-500)]));
      }
      const versionResult = await exec(builtServer, ['--version'], { timeout: 15000 });
      const installDir = path.join(this.runtimeDir, `llama-${wanted}-metal`);
      const active = this.store.getRuntime();
      if (active.serverPath && active.serverPath.startsWith(installDir + path.sep)) await beforeReplace();
      await fsp.rm(installDir, { recursive: true, force: true });
      await fsp.rename(path.join(build, 'bin'), installDir);
      const entry = {
        version: wanted,
        versionLine: `${versionResult.stdout}\n${versionResult.stderr}`.trim().split(/\r?\n/)[0] || wanted,
        backend: 'metal',
        builtLocally: true,
        serverPath: await findServer(installDir),
        installedAt: new Date().toISOString(),
      };
      await this.store.setRuntime({ ...entry, installs: { ...this.installs(), metal: entry } });
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(archive, { force: true }).catch(() => {});
    }
  }

  /**
   * Removes engine folders no install points to any more (older builds after an update). Run when
   * no engine is running, so none of their files are in use.
   */
  async removeUnused() {
    const keep = new Set([this.store.getRuntime().serverPath, ...Object.values(this.installs()).map((entry) => entry?.serverPath)]
      .filter(Boolean).map((serverPath) => path.relative(this.runtimeDir, serverPath).split(/[\\/]/)[0]));
    const removed = [];
    for (const name of await fsp.readdir(this.runtimeDir).catch(() => [])) {
      if (!/^llama-b\d+-/.test(name) || keep.has(name)) continue;
      await fsp.rm(path.join(this.runtimeDir, name), { recursive: true, force: true })
        .then(() => removed.push(name))
        .catch(() => {});
    }
    return removed;
  }
}

// The llama.cpp build this version of Uma was tested with. An older installed engine is updated to
// it by itself after Uma is updated, so two PCs on the same Uma run the same engine.
const ENGINE_BUILD = 'b12318';

module.exports = { RuntimeManager, findServer, cudaBuildsFor, ENGINE_BUILD };
