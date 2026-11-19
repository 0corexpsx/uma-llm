import React, { useEffect, useState } from 'react';
import { ArrowDownToLine, RefreshCw } from 'lucide-react';
import { api } from '../api.js';
import { Button, SectionLabel, SettingRow, Toggle } from './ui.jsx';
import { t } from '../i18n.js';

// Settings → Updates: whether Uma looks for a newer version, and what it found (updater.cjs).
export default function UpdateSection({ settings, update, showToast }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let alive = true;
    api.getUpdateState?.().then((value) => { if (alive) setState(value); }).catch(() => {});
    const off = api.onUpdateChanged?.((value) => setState(value));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  const run = async (name, action) => {
    setBusy(name);
    try {
      await action();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const status = state?.status || 'idle';
  const found = ['available', 'downloading', 'ready'].includes(status);
  const description = {
    checking: t('Looking for a newer version…'),
    current: t('This is the newest version.'),
    available: state?.canInstall
      ? t('Download it here, then install it when you are ready. Your models, chats and settings stay as they are.')
      : t('Open the download page to get it. Your models, chats and settings stay as they are.'),
    downloading: t('Downloading… {0}%', [state?.progress || 0]),
    ready: t('Downloaded. Installing closes Uma and opens the installer.'),
    error: state?.error || '',
  }[status] || t('Uma has not looked for a newer version yet.');

  return (
    <section className="settings-section" id="settings-updates">
      <div className="settings-section-head">
        <SectionLabel>{t('Updates')}</SectionLabel>
        <h3>{t('Keeping Uma up to date')}</h3>
      </div>
      <div className="settings-card">
        <SettingRow
          icon={RefreshCw}
          title={t('Look for a newer Uma once a day')}
          description={t('Uma asks its download page which version is the newest. Nothing about you, your chats or your files is sent, and nothing is installed without your click.')}
        >
          <Toggle
            checked={settings.checkForUpdates !== false}
            label={t('Look for a newer Uma once a day')}
            onChange={(value) => update({ checkForUpdates: value }, 'check-updates')}
          />
        </SettingRow>
        <SettingRow
          icon={ArrowDownToLine}
          title={found ? t('Uma {0} is available', [state.version]) : t('Uma {0} is installed', [state?.current || ''])}
          description={description}
        >
          <div className="skill-controls">
            {status === 'available' && state.canInstall && (
              <Button size="sm" variant="primary" loading={busy === 'download'} disabled={Boolean(busy)} onClick={() => run('download', () => api.downloadUpdate())}>{t('Download')}</Button>
            )}
            {status === 'available' && !state.canInstall && (
              <Button size="sm" variant="primary" onClick={() => api.openExternal(state.page)}>{t('Open the download page')}</Button>
            )}
            {status === 'ready' && (
              <Button size="sm" variant="primary" loading={busy === 'install'} disabled={Boolean(busy)} onClick={() => run('install', () => api.installUpdate())}>{t('Install and restart')}</Button>
            )}
            {!found && (
              <Button size="sm" variant="ghost" loading={busy === 'check' || status === 'checking'} disabled={Boolean(busy)} onClick={() => run('check', () => api.checkForUpdates())}>{t('Check now')}</Button>
            )}
          </div>
        </SettingRow>
        {status === 'available' && state.error && <p className="chat-memory-warning">{state.error}</p>}
        {found && state.notes && <p className="update-notes">{state.notes.length > 1200 ? `${state.notes.slice(0, 1200)}…` : state.notes}</p>}
      </div>
    </section>
  );
}
