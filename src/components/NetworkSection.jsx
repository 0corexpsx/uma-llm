import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, MemoryStick, Network, Plus, RefreshCw, Server, Trash2, Zap } from 'lucide-react';
import { api } from '../api.js';
import { Button, IconButton, SectionLabel, SettingRow, Toggle, formatRelative } from './ui.jsx';
import { t } from '../i18n.js';

function gb(mb) {
  return `${(mb / 1024).toFixed(1)} GB`;
}

function deviceSummary(devices) {
  return devices.map((device) => (device.kind === 'cpu'
    ? t('RAM {0} free, keeps {1} for this PC', [gb(device.freeMB), gb(device.reserveMB || 0)])
    : t('GPU {0} ({1} free)', [device.name, gb(device.freeMB)]))).join(', ');
}

function helperDescription(helper) {
  const test = helper.lastTest;
  if (!test) return t('Not tested yet.');
  const when = formatRelative(test.testedAt);
  if (!test.ok) return `${test.error} · ${when}`;
  // GPU and RAM listed apart: they are filled differently (see placement.cjs).
  const offered = test.devices.map((device) => (device.kind === 'cpu'
    ? t('RAM {0} free', [gb(device.freeMB)])
    : t('GPU {0} ({1} free)', [device.name, gb(device.freeMB)])));
  return t('Ready · {0} · tested {1}', [offered.join(' · '), when]);
}

/** Settings → Network: lend this PC to another Uma, or borrow other PCs' GPUs and memory. */
export default function NetworkSection({ boot, showToast }) {
  const [status, setStatus] = useState(boot.network);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ host: '', port: '50052', label: '' });
  const [chosenAddress, setChosenAddress] = useState('');
  const [sharePort, setSharePort] = useState('');

  useEffect(() => {
    // Sharing can switch on while the window is still loading, so ask once as well as listening.
    api.networkStatus?.().then(setStatus).catch(() => {});
    return api.onNetworkStatus?.(setStatus);
  }, []);
  useEffect(() => { if (boot.network) setStatus(boot.network); }, [boot.network]);

  if (!status) return null;
  const sharing = status.sharing;
  const sharingOn = sharing.state === 'on' || sharing.state === 'starting';
  const known = (value) => status.addresses.some((item) => item.address === value) && value;
  const address = sharing.address || known(chosenAddress) || known(status.shareAddress) || status.addresses[0]?.address || '';
  const endpoint = `${address}:${sharing.port || status.sharePort}`;

  const run = async (key, action, done) => {
    setBusy(key);
    try {
      setStatus(await action());
      if (done) showToast(done, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const toggleSharing = (on) => run('share', () => api.setSharing(on, on ? { address, port: sharePort || status.sharePort } : undefined));
  const addHelper = () => run('add', async () => {
    const next = await api.addHelper(form);
    setForm({ host: '', port: '50052', label: '' });
    return next;
  });
  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      showToast(t('Address copied'), 'success');
    } catch {}
  };

  let shareDescription = t('Lets another Uma on your network use this PC\'s GPU and memory while this app is open. There is no password, so only turn it on at home or at work, never on public Wi-Fi.');
  if (sharing.state === 'starting') shareDescription = t('Starting…');
  if (sharing.state === 'on') {
    shareDescription = t('Sharing at {0}{1}. Add this address on the main PC. If Windows asks, allow Uma through the firewall for private networks.', [endpoint, sharing.devices.length ? ` · ${deviceSummary(sharing.devices)}` : '']);
  }
  if (sharing.state === 'error') shareDescription = sharing.error;

  return (
    <section className="settings-section" id="settings-network">
      <div className="settings-section-head">
        <SectionLabel>{t('Network')}</SectionLabel>
        <h3>{t('Pool the PCs on your network')}</h3>
      </div>
      <p className="skills-hint network-intro">
        {t('Run models too big for one PC by borrowing the GPU and memory of other PCs that run Uma on the same network. This makes bigger models possible, not faster: every token travels between the PCs, so use wired Ethernet, and all PCs need the same engine version (update it in Models on each one).')}
      </p>

      <div className="settings-card">
        <SettingRow
          icon={sharing.state === 'error' ? AlertTriangle : Server}
          title={t('Share this PC as a helper')}
          description={shareDescription}
          danger={sharing.state === 'error'}
        >
          <div className="network-share-controls">
            {sharing.state === 'on' ? (
              <Button size="sm" variant="ghost" icon={Copy} onClick={copyEndpoint}>{t('Copy address')}</Button>
            ) : (
              <>
                {status.addresses.length > 1 && (
                  <select
                    className="select network-select"
                    value={address}
                    aria-label={t('Network to share on')}
                    onChange={(event) => setChosenAddress(event.target.value)}
                  >
                    {status.addresses.map((item) => <option key={item.address} value={item.address}>{item.address} · {item.name}</option>)}
                  </select>
                )}
                {!status.addresses.length && <span className="network-note">{t('No local network found')}</span>}
                <input
                  className="input network-port"
                  value={sharePort || String(status.sharePort)}
                  inputMode="numeric"
                  aria-label={t('Port to share on')}
                  title={t('Port')}
                  onChange={(event) => setSharePort(event.target.value.replace(/\D/g, '').slice(0, 5))}
                />
              </>
            )}
            <Toggle
              checked={sharingOn}
              disabled={busy === 'share' || (!sharingOn && !status.addresses.length)}
              onChange={toggleSharing}
              label={t('Share this PC as a helper')}
            />
          </div>
        </SettingRow>
        <SettingRow
          icon={MemoryStick}
          title={t("Lend this PC's RAM too")}
          description={status.fullPower !== false
            ? t("When a model is too big for the GPUs and for the main PC's own RAM, the rest goes into this PC's RAM and this PC's CPU computes it. The main PC fills its own RAM first, because that is faster. At full power Uma keeps about 3–6 GB free, which the helper engine itself needs.")
            : t("When a model is too big for the GPUs and for the main PC's own RAM, the rest goes into this PC's RAM and this PC's CPU computes it. The main PC fills its own RAM first, because that is faster. Uma always keeps at least 5 GB (or a quarter of the RAM) free for you.")}
        >
          <Toggle
            checked={status.shareRam !== false}
            disabled={busy === 'ram'}
            onChange={(value) => run('ram', () => api.setShareRam(value))}
            label={t("Lend this PC's RAM too")}
          />
        </SettingRow>
        <SettingRow
          icon={Zap}
          title={t('Full power while shared')}
          description={t('The chat is locked while this PC is shared, so it can give everything: every CPU thread, all RAM but a small reserve, a higher priority, and no Windows power saving for the helper engine. Turn off to keep this PC comfortable to use.')}
        >
          <Toggle
            checked={status.fullPower !== false}
            disabled={busy === 'power'}
            onChange={(value) => run('power', () => api.setFullPower(value))}
            label={t('Full power while shared')}
          />
        </SettingRow>
      </div>

      <div className="settings-card">
        <SettingRow
          icon={Network}
          title={t('Use helper PCs')}
          description={status.helpersMode === 'always'
            ? t('Every model is spread over this PC and the helpers below.')
            : status.helpersMode === 'off'
              ? t('Models load on this PC only.')
              : t('Helpers join only when a model does not fit on this PC\'s GPU, so small models keep full speed.')}
        >
          <select className="select network-select" value={status.helpersMode} onChange={(event) => run('mode', () => api.setHelpersMode(event.target.value))}>
            <option value="auto">{t('When a model does not fit here')}</option>
            <option value="always">{t('Always')}</option>
            <option value="off">{t('Off')}</option>
          </select>
        </SettingRow>
        {status.helpers.length > 0 && status.helpersMode !== 'off' && (
          <SettingRow
            icon={MemoryStick}
            title={t('Layers that fit no GPU')}
            description={status.helperRamFirst
              ? t('They go into the helpers’ RAM before this PC’s own, and the helpers’ CPUs compute them. Usually slower: every token then waits for a helper’s CPU.')
              : t('They stay in this PC’s RAM, and a helper’s RAM takes only what does not fit here. To see which is faster on your PCs, switch this, send the same message again, and compare the speed line under the two replies.')}
          >
            <select className="select network-select" value={status.helperRamFirst ? 'helpers' : 'here'} disabled={busy === 'ramfirst'} onChange={(event) => run('ramfirst', () => api.setHelperRamFirst(event.target.value === 'helpers'))}>
              <option value="here">{t('This PC’s RAM first')}</option>
              <option value="helpers">{t('Helpers’ RAM first')}</option>
            </select>
          </SettingRow>
        )}
        {status.helpers.map((helper) => (
          <SettingRow
            key={helper.id}
            icon={helper.lastTest?.ok ? Check : helper.lastTest ? AlertTriangle : Server}
            title={helper.label ? `${helper.label} · ${helper.host}:${helper.port}` : `${helper.host}:${helper.port}`}
            description={helperDescription(helper)}
          >
            <div className="skill-controls">
              <Button size="sm" variant="ghost" icon={RefreshCw} disabled={busy === helper.id} onClick={() => run(helper.id, () => api.testHelper(helper.id))}>
                {busy === helper.id ? t('Testing…') : t('Test')}
              </Button>
              <Toggle checked={helper.enabled} onChange={(value) => run(`on-${helper.id}`, () => api.updateHelper(helper.id, { enabled: value }))} label={t('Use {0}', [helper.host])} />
              <IconButton icon={Trash2} label={t('Remove {0}', [helper.host])} onClick={() => run(`rm-${helper.id}`, () => api.removeHelper(helper.id))} />
            </div>
          </SettingRow>
        ))}
        <div className="network-add">
          <input className="input" value={form.host} placeholder={t('Helper IP, like 192.168.1.20')} aria-label={t('Helper IP address')} onChange={(event) => setForm({ ...form, host: event.target.value })} />
          <input className="input network-port" value={form.port} inputMode="numeric" aria-label={t('Port')} onChange={(event) => setForm({ ...form, port: event.target.value })} />
          <input className="input" value={form.label} placeholder={t('Name (optional)')} aria-label={t('Helper name')} onChange={(event) => setForm({ ...form, label: event.target.value })} />
          <Button variant="secondary" icon={Plus} disabled={!form.host.trim() || busy === 'add'} onClick={addHelper}>
            {busy === 'add' ? t('Testing…') : t('Add helper')}
          </Button>
        </div>
      </div>
    </section>
  );
}
