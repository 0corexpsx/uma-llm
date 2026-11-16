import React, { memo, useEffect, useState } from 'react';
import { Folder, Minus, Square, X, Copy, ChevronRight } from 'lucide-react';
import { LogoLockup } from './ui.jsx';
import SystemMonitor from './SystemMonitor.jsx';
import { api } from '../api.js';
import { t } from '../i18n.js';

function TitleBar({ workspace, onboarded, server, model, settings }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    api?.isMaximized?.().then(setMaximized).catch(() => {});
  }, []);

  const toggleMaximize = async () => {
    try {
      setMaximized(await api.toggleMaximize());
    } catch {}
  };

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <LogoLockup />
        <span className="titlebar-badge">{t('Local')}</span>
        {settings?.allowSystemAccess && <span className="titlebar-badge full-pc">{t('Full PC')}</span>}
        {settings?.allowInternet && <span className="titlebar-badge web">{t('Web')}</span>}
      </div>

      <div className="titlebar-center">
        {workspace ? (
          <>
            <Folder size={13} strokeWidth={1.8} />
            <span className="titlebar-folder">{workspace.name}</span>
            <ChevronRight size={12} className="muted-icon" />
            <span className={`titlebar-scope ${settings?.allowSystemAccess ? 'is-full-pc' : ''}`}>
              {settings?.allowSystemAccess ? t('full PC access') : t('only this folder')}
            </span>
          </>
        ) : (
          <span className="titlebar-scope">{onboarded ? t('A private workspace') : t('Setting up your workspace')}</span>
        )}
      </div>

      <div className="titlebar-right">
        <SystemMonitor />
        <span className={`titlebar-live ${server?.running ? 'is-live' : ''}`}>
          <span className="status-dot" />
          {!onboarded ? t('Setup') : server?.running ? t('Model awake') : model ? t('Model asleep') : t('No model')}
        </span>
        <div className="window-controls">
          <button type="button" aria-label={t('Minimize')} onClick={() => api.minimizeWindow()}>
            <Minus size={15} />
          </button>
          <button type="button" aria-label={maximized ? t('Restore') : t('Maximize')} onClick={toggleMaximize}>
            {maximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button type="button" aria-label={t('Close')} className="window-close" onClick={() => api.closeWindow()}>
            <X size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}

export default memo(TitleBar, (previous, next) => (
  previous.workspace?.path === next.workspace?.path
  && previous.onboarded === next.onboarded
  && previous.model?.id === next.model?.id
  && previous.server?.running === next.server?.running
  && previous.settings?.allowSystemAccess === next.settings?.allowSystemAccess
  && previous.settings?.allowInternet === next.settings?.allowInternet
));
