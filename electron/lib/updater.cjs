// Tells the user when a newer Uma has been published, and on Windows downloads its installer.
//
// The feed is the "latest release" of Uma's own repository (package.json → updates). One small
// request, once a day at most: it carries no data about the user, their chats or their files.
// Nothing is installed by itself: the user sees the version and presses the button. The installer is
// taken only from the repository's own releases, and it is checked (size, and SHA-256 when the
// release gives one) before it may be started. On a Mac or on Linux Uma is not signed and cannot
// replace itself, so there the button opens the download page.
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { downloadFile, ensureDir } = require('./util.cjs');
const { t } = require('./i18n.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;

/** [0, 2, 88] from "v0.2.88" or "0.2.88", or null. */
function parseVersion(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

/** The file of a release that installs Uma on this kind of computer. */
function assetFor(assets, platform, arch) {
  const wanted = {
    win32: /^Uma-LLM-Setup-[\d.]+\.exe$/i,
    darwin: new RegExp(`-mac-${arch === 'arm64' ? 'arm64' : 'x64'}\\.dmg$`, 'i'),
    linux: new RegExp(`_${arch === 'arm64' ? 'arm64' : 'amd64'}\\.deb$`, 'i'),
  }[platform];
  return (wanted && (assets || []).find((asset) => wanted.test(String(asset?.name || '')))) || null;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

class Updater {
  /**
   * `feed` answers with the newest release as JSON ({ tag_name, html_url, body, assets }), the way
   * GitHub does. `downloads` is the address every installer must start with, and `page` is where a
   * person downloads Uma by hand.
   */
  constructor({ version, feed, downloads, page, dir, platform = process.platform, arch = process.arch, onChange = () => {}, start = null }) {
    this.version = version;
    this.feed = feed || '';
    this.downloads = downloads || '';
    this.page = page || '';
    this.dir = dir;
    this.platform = platform;
    this.arch = arch;
    this.onChange = onChange;
    // Starts the installer; replaced in the tests.
    this.start = start || ((file) => spawn(file, [], { detached: true, stdio: 'ignore' }).unref());
    this.state = { status: 'idle', current: version, version: '', notes: '', page: this.page, progress: 0, error: '', checkedAt: 0, canInstall: platform === 'win32' };
    this.file = '';
    this.asset = null;
    this.busy = null;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
    return this.state;
  }

  /** Whether a check by itself is due: at most one a day. */
  due(lastCheck, now = Date.now()) {
    return Boolean(this.feed) && now - (Number(lastCheck) || 0) >= DAY_MS;
  }

  /** Asks which version is the newest. Never throws: what went wrong is in the state. */
  async check() {
    if (!this.feed) return this.set({ status: 'off' });
    if (this.busy) return this.busy;
    if (['downloading', 'ready'].includes(this.state.status)) return this.state;
    this.busy = this.ask().finally(() => { this.busy = null; });
    return this.busy;
  }

  async ask() {
    this.set({ status: 'checking', error: '' });
    try {
      const response = await fetch(this.feed, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'UmaLLM (+local desktop app)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      // A repository with no release yet answers 404: nothing newer, not an error.
      if (response.status === 404) return this.set({ status: 'current', checkedAt: Date.now() });
      if (!response.ok) throw new Error(t('The update check failed ({0}).', [response.status]));
      const release = await response.json();
      const version = (parseVersion(release?.tag_name) || parseVersion(release?.name) || []).join('.');
      if (!version || release?.draft || release?.prerelease || !isNewer(version, this.version)) {
        return this.set({ status: 'current', version: '', checkedAt: Date.now() });
      }
      const asset = assetFor(release.assets, this.platform, this.arch);
      // Only an installer from Uma's own releases is ever downloaded.
      this.asset = asset && this.downloads && String(asset.browser_download_url || '').startsWith(this.downloads) ? asset : null;
      const page = this.page && String(release.html_url || '').startsWith(this.page) ? release.html_url : this.page;
      return this.set({
        status: 'available',
        version,
        notes: String(release.body || '').trim().slice(0, 4000),
        page,
        canInstall: this.platform === 'win32' && Boolean(this.asset),
        checkedAt: Date.now(),
      });
    } catch (err) {
      return this.set({ status: 'error', error: err?.name === 'TimeoutError' ? t('The update check got no answer. Check the connection and try again.') : String(err?.message || err), checkedAt: Date.now() });
    }
  }

  /** Downloads the installer of the version found and checks it. */
  async download() {
    if (this.state.status === 'ready') return this.state;
    if (this.state.status !== 'available' || !this.state.canInstall || !this.asset) throw new Error(t('There is no update to download.'));
    const asset = this.asset;
    const version = this.state.version;
    const file = path.join(this.dir, path.basename(String(asset.name)));
    this.set({ status: 'downloading', progress: 0, error: '' });
    try {
      await ensureDir(this.dir);
      // Installers of earlier updates are not kept.
      for (const name of await fsp.readdir(this.dir)) {
        if (name !== path.basename(file) && name !== `${path.basename(file)}.part`) await fsp.rm(path.join(this.dir, name), { recursive: true, force: true });
      }
      await downloadFile(asset.browser_download_url, file, {
        expectedSize: Number(asset.size) || 0,
        onProgress: ({ percent }) => { if (Number.isFinite(percent)) this.set({ progress: Math.round(percent) }); },
      });
      const size = (await fsp.stat(file)).size;
      if (Number(asset.size) > 0 && size !== Number(asset.size)) throw new Error(t('The downloaded update is not complete. Try again.'));
      const expected = String(asset.digest || '').match(/^sha256:([0-9a-f]{64})$/i)?.[1];
      if (expected && (await sha256(file)).toLowerCase() !== expected.toLowerCase()) throw new Error(t('The downloaded update does not match the published file, so it was deleted.'));
      this.file = file;
      return this.set({ status: 'ready', version, progress: 100 });
    } catch (err) {
      await fsp.rm(file, { force: true }).catch(() => {});
      await fsp.rm(`${file}.part`, { force: true }).catch(() => {});
      this.set({ status: 'available', progress: 0, error: String(err?.message || err) });
      throw err;
    }
  }

  /** Starts the downloaded installer. The caller then closes Uma, so that its files can be replaced. */
  async install() {
    if (this.state.status !== 'ready' || !this.file) throw new Error(t('There is no update to install.'));
    if (!(await fsp.stat(this.file).catch(() => null))) {
      this.set({ status: 'available', progress: 0 });
      throw new Error(t('The downloaded update is no longer there. Download it again.'));
    }
    this.start(this.file);
    return true;
  }
}

module.exports = { Updater, parseVersion, isNewer, assetFor };
