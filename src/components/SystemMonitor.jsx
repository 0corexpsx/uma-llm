import React, { useEffect, useState } from 'react';
import { Monitor } from 'lucide-react';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { recordGpuSample } from '../gpuHistory.js';

function gigabytes(bytes) {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** Bytes per second as a short speed, like 840 KB/s or 12.4 MB/s. */
function speed(bytesPerSecond) {
  if (bytesPerSecond >= 1024 ** 2) return `${(bytesPerSecond / 1024 ** 2).toFixed(bytesPerSecond >= 100 * 1024 ** 2 ? 0 : 1)} MB/s`;
  if (bytesPerSecond >= 1024) return `${Math.round(bytesPerSecond / 1024)} KB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

/** Helper PCs: green with the number connected; shown once helpers are set up or this PC is shared. */
function HelperPcs({ helpers }) {
  if (!helpers || (!helpers.configured && !helpers.sharing)) return null;
  const count = helpers.online.length;
  const lines = [];
  if (helpers.configured) {
    lines.push(count ? t('{0} of {1} helper PCs connected:', [count, helpers.configured]) : t('No helper PCs connected ({0} set up)', [helpers.configured]));
    for (const item of helpers.online) lines.push(`• ${item.name}${item.inUse ? t(' — running part of the model') : ''}`);
    if (helpers.mode === 'off') lines.push(t('Using helpers is turned off in Settings → Network.'));
  }
  if (helpers.sharing) lines.push(t('This PC is shared as a helper at {0}', [helpers.sharing]));
  return (
    <span
      className={`monitor-pcs ${count ? 'is-online' : ''} ${!helpers.configured ? 'is-shared' : ''}`}
      title={lines.join('\n')}
      aria-label={lines.join('. ')}
    >
      <Monitor size={13} strokeWidth={2} />
      {/* A PC that only lends itself has no helpers to count. */}
      <span>{helpers.configured ? count : t('Shared')}</span>
    </span>
  );
}

function Reading({ label, value, percent, title }) {
  const level = percent >= 90 ? 'is-high' : percent >= 70 ? 'is-busy' : '';
  return (
    <span className={`monitor-reading ${level}`} title={title}>
      <span className="monitor-label">{label}</span>
      <span className="monitor-value">{value}</span>
      <span className="monitor-bar"><span style={{ width: `${Math.min(100, percent)}%` }} /></span>
    </span>
  );
}

/** Whole-PC usage, updated by the main process every 5 seconds. */
export default function SystemMonitor() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let active = true;
    // Each reading also goes to the history behind the graph of several graphics cards (GpuCards).
    const take = (next) => { setStats(next); recordGpuSample(next); };
    api?.systemStats?.().then((next) => { if (active) take(next); }).catch(() => {});
    const off = api?.onSystemStats?.(take);
    return () => {
      active = false;
      off?.();
    };
  }, []);

  if (!stats) return null;
  const { gpu } = stats;
  // Several graphics cards: each card's own reading, so it shows whether they all work.
  const cards = gpu?.cards?.length > 1 ? gpu.cards : null;
  const perCard = cards ? `\n${cards.map((card, index) => `${index + 1}. ${card.name}: ${card.percent}% · ${gigabytes(card.usedBytes)}/${gigabytes(card.totalBytes)} GB`).join('\n')}` : '';
  return (
    <div className="system-monitor" aria-label={t('System usage')}>
      <Reading
        label={t('NET')}
        value={stats.net ? `↓${speed(stats.net.rxBps)} ↑${speed(stats.net.txBps)}` : '—'}
        percent={0}
        title={t('Network speed, all programs: download ↓ and upload ↑, updated every 5 seconds')}
      />
      <Reading label={t('CPU')} value={`${stats.cpuPercent}%`} percent={stats.cpuPercent} title={t('CPU use, all programs')} />
      <Reading
        label={t('RAM')}
        value={`${gigabytes(stats.ramUsedBytes)}/${gigabytes(stats.ramTotalBytes)} GB`}
        percent={(stats.ramUsedBytes / stats.ramTotalBytes) * 100}
        title={t('System memory in use, all programs')}
      />
      {gpu ? (
        <>
          <Reading
            label={cards ? `${t('GPU')} ×${cards.length}` : t('GPU')}
            value={cards && cards.length <= 4 ? `${cards.map((card) => card.percent).join(' · ')}%` : `${gpu.percent}%`}
            percent={gpu.percent}
            title={`${t('GPU use, all programs')}${perCard}`}
          />
          <Reading
            label={t('VRAM')}
            value={`${gigabytes(gpu.usedBytes)}/${gigabytes(gpu.totalBytes)} GB`}
            percent={(gpu.usedBytes / gpu.totalBytes) * 100}
            title={`${t('Graphics memory in use, all programs')}${perCard}`}
          />
        </>
      ) : (
        <span className="monitor-reading" title={t('GPU and VRAM readings need an NVIDIA GPU')}>
          <span className="monitor-label">{t('GPU')}</span>
          <span className="monitor-value">n/a</span>
        </span>
      )}
      <HelperPcs helpers={stats.helpers} />
    </div>
  );
}
