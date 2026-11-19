import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, CircleStop, Globe, Network, Play, WifiOff } from 'lucide-react';
import { api } from '../api.js';
import { Button, SectionLabel, Spinner, formatBytes, formatSpeed, formatTime } from './ui.jsx';
import { t } from '../i18n.js';

/** A monitor with a processor chip on its screen: the Server status icon. */
export function ServerStatusIcon({ size = 19, strokeWidth = 1.65 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="3" width="19" height="14" rx="2" />
      <path d="M8.5 21h7M12 17v4" />
      <rect x="9.25" y="7.25" width="5.5" height="5.5" rx="1" />
      <path d="M11 5.4v1.85M13 5.4v1.85M11 12.75v1.85M13 12.75v1.85M7.4 9h1.85M7.4 11h1.85M14.75 9h1.85M14.75 11h1.85" />
    </svg>
  );
}

function gigabytes(bytes) {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** One reading in the list: a value over a thin bar that turns amber, then red, as it fills. */
function Meter({ value, percent, title }) {
  if (percent === null || percent === undefined || Number.isNaN(percent)) return <span className="status-meter is-empty" title={title}>—</span>;
  const level = percent >= 90 ? 'is-high' : percent >= 70 ? 'is-busy' : '';
  return (
    <span className={`status-meter ${level}`} title={title}>
      <span className="status-meter-value">{value}</span>
      <span className="status-meter-bar"><span style={{ width: `${Math.max(2, Math.min(100, percent))}%` }} /></span>
    </span>
  );
}

/** What is wrong with a PC, most serious first; an empty list means the light is green. */
function problemsOf(pc) {
  const problems = [];
  if (!pc.online) {
    problems.push({ tone: 'bad', text: pc.lastSeenAt ? t('Not answering since {0}', [formatTime(pc.lastSeenAt)]) : t('Not answering') });
    return problems;
  }
  if (pc.mismatch) problems.push({ tone: 'bad', text: pc.mismatch });
  if (pc.engineUpdating) problems.push({ tone: 'warn', text: t('Updating its engine to {0}', [pc.engineUpdating]) });
  if (pc.stats?.internet === false) problems.push({ tone: 'warn', text: t('No internet') });
  if (pc.stats?.crashes) problems.push({ tone: 'warn', text: t('Engine restarted {0}×', [pc.stats.crashes]) });
  if (pc.drops) problems.push({ tone: 'warn', text: t('Dropped {0}×, last at {1}', [pc.drops, formatTime(pc.lastDropAt)]) });
  if (pc.stats?.internetDrops) problems.push({ tone: 'warn', text: t('Internet dropped {0}×', [pc.stats.internetDrops]) });
  return problems;
}

function lightOf(pc, problems) {
  if (pc.enabled === false) return { tone: 'off', label: t('Turned off') };
  if (!pc.online) return { tone: 'bad', label: t('Offline') };
  if (problems.some((item) => item.tone === 'bad')) return { tone: 'bad', label: t('Problem') };
  // Past drops stay in the Problems column; the light shows how the PC is now.
  if (pc.mismatch || pc.engineUpdating || pc.stats?.internet === false) return { tone: 'warn', label: t('Attention') };
  return { tone: 'ok', label: t('Online') };
}

function activityOf(pc, self) {
  if (self) {
    if (pc.serverState === 'starting') return t('Loading the model');
    if (pc.sharing) return pc.stats?.clients ? t('Helping another PC') : t('Shared, waiting for work');
    return pc.serverState === 'ready' ? t('Model loaded') : t('Model not loaded');
  }
  if (!pc.online) return '';
  if (pc.stats?.phase === 'computing') return t('Computing');
  if (pc.stats?.phase === 'loading') return t('Loading the model');
  if (pc.inUse) return t('Holding part of the model');
  return t('Ready');
}

function Row({ pc, self = false }) {
  const stats = pc.online ? pc.stats : null;
  const problems = problemsOf(pc);
  const light = lightOf(pc, problems);
  const old = pc.online && !pc.stats && !self;
  const activity = activityOf(pc, self);
  return (
    <div className={`status-row ${self ? 'is-self' : ''} ${pc.online ? '' : 'is-offline'}`} role="row">
      <div className="status-cell status-cell-light" role="cell">
        <span className={`status-light is-${light.tone}`} title={light.label} aria-label={light.label} />
      </div>
      <div className="status-cell status-cell-pc" role="cell">
        <strong>{pc.name}{self && <em>{t('This PC')}</em>}</strong>
        <span>
          {self ? (pc.sharing ? t('Shared as a helper at {0}', [pc.sharing]) : t('Main PC')) : pc.address}
          {pc.latencyMs !== null && pc.latencyMs !== undefined && !self ? ` · ${pc.latencyMs} ms` : ''}
          {pc.engine ? ` · ${pc.engine}` : ''}
        </span>
        {activity && <span className={`status-activity ${stats?.phase === 'computing' || pc.serverState === 'starting' ? 'is-working' : ''}`}>{activity}</span>}
      </div>
      <div className="status-cell" role="cell" data-label={t('CPU')}>
        <Meter value={`${stats?.cpu}%`} percent={stats?.cpu} title={t('CPU use, all programs')} />
      </div>
      <div className="status-cell" role="cell" data-label={t('RAM')}>
        <Meter
          value={stats?.ramTotal ? `${gigabytes(stats.ramUsed || 0)} / ${gigabytes(stats.ramTotal)} GB` : ''}
          percent={stats?.ramTotal && stats.ramUsed !== null ? (stats.ramUsed / stats.ramTotal) * 100 : null}
          title={t('System memory in use, all programs')}
        />
      </div>
      <div className="status-cell" role="cell" data-label={t('GPU')}>
        <Meter
          value={stats?.gpu?.cards?.length > 1 && stats.gpu.cards.length <= 4 ? `${stats.gpu.cards.map((card) => card.percent).join(' · ')}%` : `${stats?.gpu?.percent}%`}
          percent={stats?.gpu ? stats.gpu.percent : null}
          title={stats && !stats.gpu
            ? t('GPU and VRAM readings need an NVIDIA GPU')
            : `${t('GPU use, all programs')}${(stats?.gpu?.cards || []).map((card, index) => `\n${index + 1}. ${card.name}: ${card.percent}% · ${gigabytes(card.used || 0)} / ${gigabytes(card.total)} GB`).join('')}`}
        />
      </div>
      <div className="status-cell" role="cell" data-label={t('VRAM')}>
        <Meter
          value={stats?.gpu ? `${gigabytes(stats.gpu.used || 0)} / ${gigabytes(stats.gpu.total)} GB` : ''}
          percent={stats?.gpu ? ((stats.gpu.used || 0) / stats.gpu.total) * 100 : null}
          title={t('Graphics memory in use, all programs')}
        />
      </div>
      <div className="status-cell status-cell-data" role="cell" data-label={t('Data')}>
        {self && stats?.net ? (
          <>
            <span title={t('Network speed, all programs: download ↓ and upload ↑, updated every 5 seconds')}><ArrowDown size={11} />{formatSpeed(stats.net.rx)}</span>
            <span><ArrowUp size={11} />{formatSpeed(stats.net.tx)}</span>
          </>
        ) : stats ? (
          <>
            <span title={t('Received from the main PC since this helper was shared, and the speed right now')}><ArrowDown size={11} />{formatBytes(stats.received)}{stats.receiveRate ? <em>{formatSpeed(stats.receiveRate)}</em> : null}</span>
            <span title={t('Sent back to the main PC since this helper was shared, and the speed right now')}><ArrowUp size={11} />{formatBytes(stats.sent)}{stats.sendRate ? <em>{formatSpeed(stats.sendRate)}</em> : null}</span>
          </>
        ) : <span className="status-meter is-empty">—</span>}
      </div>
      <div className="status-cell status-cell-problems" role="cell" data-label={t('Problems')}>
        {stats && (
          <span className={`status-chip ${stats.internet === false ? 'is-bad' : stats.internet ? 'is-ok' : ''}`}>
            {stats.internet === false ? <WifiOff size={11} /> : <Globe size={11} />}
            {stats.internet === false ? t('No internet') : stats.internet ? t('Internet') : t('Checking internet…')}
          </span>
        )}
        {problems.filter((item) => item.text !== t('No internet')).map((item) => (
          <span className={`status-chip is-${item.tone === 'bad' ? 'bad' : 'warn'}`} key={item.text} title={item.text}>{item.text}</span>
        ))}
        {old && <span className="status-chip" title={t('Install this version of Uma on that PC to see its CPU, memory and GPU here.')}>{t('Update Uma there for readings')}</span>}
        {pc.enabled === false && <span className="status-chip">{t('Turned off in Settings')}</span>}
        {pc.online && stats && !problems.length && pc.enabled !== false && <span className="status-none">{t('None')}</span>}
      </div>
    </div>
  );
}

/** Every PC working together, read again every two seconds while this screen is open. */
export default function StatusView({ boot, generating, onOpenSettings, onOpenModels, showToast }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState('');
  const [, setTick] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let timer = null;
    const read = async () => {
      try {
        const next = await api.serverList();
        if (!alive.current) return;
        setData(next);
        setFailed('');
      } catch (err) {
        if (alive.current) setFailed(err.message);
      }
      if (alive.current) timer = setTimeout(read, 2000);
    };
    read();
    const clock = setInterval(() => setTick((value) => value + 1), 1000);
    return () => {
      alive.current = false;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, []);

  const server = boot.server || {};
  const loading = server.state === 'starting';
  const shared = ['on', 'starting'].includes(boot.network?.sharing?.state);

  const power = async (on) => {
    setBusy(on ? 'load' : 'stop');
    try {
      if (on) await api.startServer();
      else {
        await api.stopServer();
        showToast(t('Model stopped and memory freed'), 'success');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      if (alive.current) setBusy('');
    }
  };

  const helpers = data?.helpers || [];
  const counted = helpers.filter((item) => item.enabled);
  const online = counted.filter((item) => item.online).length;
  const self = data ? { ...data.self, online: true, serverState: server.state } : null;
  const everyone = self ? [self, ...counted.filter((item) => item.online)] : [];
  const vramTotal = everyone.reduce((sum, item) => sum + (item.stats?.gpu?.total || 0), 0);
  const vramUsed = everyone.reduce((sum, item) => sum + (item.stats?.gpu?.used || 0), 0);
  const received = helpers.reduce((sum, item) => sum + (item.online ? item.stats?.received || 0 : 0), 0);
  const sent = helpers.reduce((sum, item) => sum + (item.online ? item.stats?.sent || 0 : 0), 0);
  const troubled = counted.filter((item) => !item.online || item.mismatch || item.stats?.internet === false).length + (self?.stats?.internet === false ? 1 : 0);
  const age = data ? Math.max(0, Math.round((Date.now() - new Date(data.at).getTime()) / 1000)) : 0;

  return (
    <div className="status-view">
      <header className="view-header">
        <div>
          <div className="eyebrow">{t('Network')}</div>
          <h2>{t('Server status')}</h2>
        </div>
        <div className="status-header-actions">
          <span className={`status-live ${failed || age > 8 ? 'is-stale' : ''}`}>
            <span className="status-live-dot" />
            {failed ? t('Not updating') : !data ? t('Reading…') : age <= 3 ? t('Live') : t('Updated {0} s ago', [age])}
          </span>
          <Button size="sm" variant="secondary" icon={Network} onClick={onOpenSettings}>{t('Helper PCs')}</Button>
        </div>
      </header>

      <div className="status-scroll">
        <section className="status-tiles">
          <div className={`status-tile ${counted.length && online < counted.length ? 'is-bad' : ''}`}>
            <span className="eyebrow">{t('PCs online')}</span>
            <strong>{data ? online + 1 : '—'}<em>/ {counted.length + 1}</em></strong>
            <small>{counted.length ? (online === counted.length ? t('This PC and every helper answer') : t('{0} of {1} helpers answer', [online, counted.length])) : t('This PC only: no helper PCs set up')}</small>
          </div>
          <div className="status-tile">
            <span className="eyebrow">{t('Graphics memory')}</span>
            <strong>{vramTotal ? gigabytes(vramUsed) : '—'}<em>{vramTotal ? `/ ${gigabytes(vramTotal)} GB` : ''}</em></strong>
            <small>{vramTotal ? t('In use across the PCs that answer') : t('GPU and VRAM readings need an NVIDIA GPU')}</small>
          </div>
          <div className="status-tile">
            <span className="eyebrow">{t('Data exchanged')}</span>
            <strong className="status-tile-data"><span><ArrowUp size={14} />{formatBytes(received)}</span><span><ArrowDown size={14} />{formatBytes(sent)}</span></strong>
            <small>{t('Sent to the helpers and received back since they were shared')}</small>
          </div>
          <div className={`status-tile ${troubled ? 'is-bad' : data ? 'is-ok' : ''}`}>
            <span className="eyebrow">{t('Problems')}</span>
            <strong>{data ? troubled : '—'}</strong>
            <small>{troubled ? t('PCs that need attention right now') : t('Everything is running')}</small>
          </div>
        </section>

        <section className="status-model">
          <span className={`status-light is-${server.running ? 'ok' : loading ? 'warn' : 'off'}`} />
          <div className="status-model-copy">
            <strong>{boot.activeModel?.name || t('No model')}</strong>
            <span>
              {shared ? t('This PC is shared as a helper, so its own model stays unloaded.')
                : loading ? t('Loading into memory…')
                  : server.running ? t('Loaded and ready to answer')
                    : server.error ? server.error
                      : t('Not loaded: memory is free')}
            </span>
          </div>
          <div className="status-model-actions">
            {!boot.activeModel ? (
              <Button size="sm" variant="primary" onClick={onOpenModels}>{t('Choose a model')}</Button>
            ) : server.running || loading ? (
              <Button size="sm" variant="secondary" icon={CircleStop} loading={busy === 'stop'} disabled={generating} onClick={() => power(false)} title={generating ? t('Wait for the current response to finish.') : ''}>
                {t('Stop model and free memory')}
              </Button>
            ) : (
              <Button size="sm" variant="primary" icon={Play} loading={busy === 'load'} disabled={shared || !boot.runtime?.installed} onClick={() => power(true)}>
                {t('Load model')}
              </Button>
            )}
          </div>
        </section>

        <section className="status-table" role="table" aria-label={t('Server status')}>
          <div className="status-row status-head" role="row">
            <span role="columnheader" />
            <span role="columnheader">{t('Computer')}</span>
            <span role="columnheader">{t('CPU')}</span>
            <span role="columnheader">{t('RAM')}</span>
            <span role="columnheader">{t('GPU')}</span>
            <span role="columnheader">{t('VRAM')}</span>
            <span role="columnheader">{t('Data')}</span>
            <span role="columnheader">{t('Problems')}</span>
          </div>
          {!data && !failed && <div className="status-wait"><Spinner size={15} />{' '}{t('Reading every PC…')}</div>}
          {failed && !data && <div className="status-wait is-error"><AlertTriangle size={15} />{' '}{failed}</div>}
          {self && <Row pc={self} self />}
          {helpers.map((pc) => <Row pc={pc} key={pc.id} />)}
          {data && helpers.length === 0 && (
            <div className="status-empty">
              <Network size={18} />
              <div>
                <strong>{t('No helper PCs yet')}</strong>
                <span>{t('Add another PC in Settings → Network and it appears here with its own light and readings.')}</span>
              </div>
              <Button size="sm" variant="secondary" onClick={onOpenSettings}>{t('Add a helper PC')}</Button>
            </div>
          )}
        </section>

        <section className="status-events">
          <SectionLabel>{t('Events since Uma started')}</SectionLabel>
          {data?.events?.length ? (
            <div className="status-event-list">
              {data.events.map((event) => (
                <div className={`status-event is-${event.kind}`} key={`${event.at}${event.name}${event.text}`}>
                  <span className={`status-light is-${event.kind === 'back' ? 'ok' : event.kind === 'drop' ? 'bad' : 'warn'}`} />
                  <time>{formatTime(event.at)}</time>
                  <strong>{event.name}</strong>
                  <span>{event.text}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="status-quiet">{t('No drops or errors. A PC that stops answering, an engine that restarts, or a lost internet connection is listed here with its time.')}</p>
          )}
        </section>
      </div>
    </div>
  );
}
