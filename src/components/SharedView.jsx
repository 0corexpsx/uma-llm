import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Copy, Cpu, Network, Power, Settings2, Users } from 'lucide-react';
import { api } from '../api.js';
import { Button, umaLogo } from './ui.jsx';
import { t, tn } from '../i18n.js';

const PHASES = {
  connected: 'Connected',
  loading: 'Receiving model data',
  computing: 'Computing model layers',
  idle: 'Waiting for its next request',
};

const KINDS = {
  info: 'Info',
  connect: 'Connected',
  disconnect: 'Left',
  work: 'Working',
  warn: 'Warning',
  engine: 'Engine',
};

function size(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function since(iso) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  return minutes < 1 ? t('just now') : minutes < 60 ? t('{0} min', [minutes]) : t('{0} h {1} min', [Math.floor(minutes / 60), minutes % 60]);
}

/**
 * Shown instead of the chat while this PC is shared as a helper: the local assistant is paused,
 * and this screen reports who is using the PC and what they are doing.
 */
export default function SharedView({ sharing, onOpenSettings, showToast }) {
  const [stopping, setStopping] = useState(false);
  const logRef = useRef(null);
  const followRef = useRef(true);
  const clients = sharing.clients || [];
  const activity = sharing.activity || [];
  const endpoint = `${sharing.address}:${sharing.port}`;
  const working = clients.some((client) => client.phase === 'loading' || client.phase === 'computing');

  // Keep the newest lines in view, unless the user scrolled up to read older ones.
  useEffect(() => {
    const box = logRef.current;
    if (box && followRef.current) box.scrollTop = box.scrollHeight;
  }, [activity.length]);

  const stop = async () => {
    setStopping(true);
    try {
      await api.setSharing(false);
    } catch (err) {
      showToast?.(err.message, 'error');
      setStopping(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(endpoint);
      showToast?.(t('Address copied'), 'success');
    } catch {}
  };

  let statusLabel = t('Starting the helper service…');
  if (sharing.state === 'on') {
    statusLabel = !clients.length
      ? t('Ready · waiting for a main PC')
      : working
        ? t('Working for {0}', [clients.map((client) => client.address).join(', ')])
        : t('Connected to {0}', [clients.map((client) => client.address).join(', ')]);
  }

  return (
    <div className="shared-view">
      <section className="shared-hero">
        <div className="uma-stage">
          <div className="uma-band" />
          <img className="uma-portrait" src={umaLogo} width={152} height={152} alt={t('Uma')} draggable={false} />
        </div>
        <span className={`shared-status ${working ? 'is-working' : ''} ${sharing.state === 'starting' ? 'is-starting' : ''}`}>
          <span className="shared-dot" />
          {t('Shared ·')}{' '}{statusLabel}
        </span>
        <h1>{t('This PC is working as a helper')}</h1>
        <p>
          {t('Uma has made this computer\'s graphics card and memory available to other Uma workstations on your local network. While sharing is active, the local assistant is paused so that every resource stays dedicated to the computers that rely on it. Your files, conversations, and models are never shared: connected PCs can only send this computer the model layers they need processed, and receive the results.')}
        </p>
        <div className="shared-actions">
          <Button variant="primary" icon={Power} onClick={stop} disabled={stopping}>
            {stopping ? t('Stopping…') : t('Stop sharing and use the chat')}
          </Button>
          <Button variant="ghost" icon={Settings2} onClick={onOpenSettings}>{t('Network settings')}</Button>
        </div>
      </section>

      <div className="shared-grid">
        <div className="shared-card">
          <span className="shared-card-label"><Network size={13} />{' '}{t('Address')}</span>
          <strong>{endpoint}</strong>
          <button type="button" className="shared-link" onClick={copy}><Copy size={12} />{' '}{t('Copy for the main PC')}</button>
        </div>
        <div className="shared-card">
          <span className="shared-card-label"><Cpu size={13} />{' '}{t('Shared hardware')}</span>
          {sharing.devices.length ? sharing.devices.map((device) => (
            <React.Fragment key={device.id}>
              <strong>{device.name}</strong>
              <span>{t('{0} free of {1}', [size(device.freeMB * 1024 ** 2), size(device.totalMB * 1024 ** 2)])}</span>
            </React.Fragment>
          )) : <span>{t('Reading devices…')}</span>}
        </div>
        <div className="shared-card">
          <span className="shared-card-label"><Users size={13} />{' '}{t('Connected PCs')}</span>
          <strong>{clients.length}</strong>
          {clients.length ? clients.map((client) => (
            <span key={client.address + client.since}>{client.address} · {t(PHASES[client.phase] || client.phase)} · {since(client.since)}</span>
          )) : <span>{sharing.totals?.sessions ? tn(sharing.totals.sessions, '{count} session so far', '{count} sessions so far') : t('No main PC has connected yet')}</span>}
        </div>
        <div className="shared-card">
          <span className="shared-card-label"><ArrowDownToLine size={13} />{' '}{t('Data exchanged')}</span>
          <strong>{t('{0} in · {1} out', [size(sharing.totals?.received || 0), size(sharing.totals?.sent || 0)])}</strong>
          <span>
            <ArrowDownToLine size={11} /> {size(clients.reduce((sum, client) => sum + client.receiveRate, 0))}/s
            {'  '}
            <ArrowUpFromLine size={11} /> {size(clients.reduce((sum, client) => sum + client.sendRate, 0))}/s
          </span>
        </div>
      </div>

      <section className="shared-log">
        <div className="shared-log-head">
          <strong>{t('Activity')}</strong>
          <span className="shared-live"><span className="shared-dot" />{' '}{t('Live · updated every 5 seconds')}</span>
        </div>
        <ol
          ref={logRef}
          onScroll={(event) => {
            const box = event.currentTarget;
            followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
          }}
        >
          {activity.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className={`log-${entry.kind}`}>
              <time>{clock(entry.at)}</time>
              <span className="log-kind">{t(KINDS[entry.kind] || entry.kind)}</span>
              <span className="log-text">{t(entry.text, entry.values)}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
