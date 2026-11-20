import React, { useState } from 'react';
import { HISTORY_LENGTH, useGpuHistory } from '../gpuHistory.js';
import { t } from '../i18n.js';

// The drawing's own units: the width holds every sample the history can keep, the height is 0-100%.
const WIDTH = 240;
const HEIGHT = 40;
// The first minute is drawn across the whole width; after that the time axis grows to five minutes.
const FULL_WIDTH_FROM = 12;

function gigabytes(bytes) {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** The distance between two samples: a few fill the width, later ones scroll in from the right. */
function stepOf(count) {
  return WIDTH / (Math.min(HISTORY_LENGTH, Math.max(FULL_WIDTH_FROM, count)) - 1);
}

/** Where a sample sits: the newest at the right edge, older ones to its left. */
function xOf(index, count) {
  return WIDTH - (count - 1 - index) * stepOf(count);
}

function yOf(percent) {
  // One unit kept clear at the top and bottom, so a line at 0% or 100% is drawn whole.
  return 1 + (HEIGHT - 2) * (1 - percent / 100);
}

function line(values) {
  return values.map((value, index) => `${xOf(index, values.length).toFixed(1)},${yOf(value).toFixed(1)}`).join(' ');
}

/** One card: its name, the reading now (or under the pointer), and both lines over the last minutes. */
function CardGraph({ index, samples }) {
  const [hover, setHover] = useState(null);
  const latest = samples[samples.length - 1];
  const shown = hover !== null && samples[hover] ? samples[hover] : latest;
  const gpu = samples.map((sample) => sample.card.percent);
  const vram = samples.map((sample) => (sample.card.totalBytes ? (sample.card.usedBytes / sample.card.totalBytes) * 100 : 0));
  const secondsAgo = Math.round((latest.at - shown.at) / 1000);

  const onMove = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    // The pointer picks the nearest sample: nobody has to land on a 2px line.
    const x = ((event.clientX - box.left) / box.width) * WIDTH;
    const fromRight = Math.round((WIDTH - x) / stepOf(samples.length));
    setHover(Math.max(0, Math.min(samples.length - 1, samples.length - 1 - fromRight)));
  };

  return (
    <div className="gpu-card" data-card={index + 1}>
      <div className="gpu-card-head">
        <strong title={latest.card.name}>{index + 1} · {latest.card.name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '')}</strong>
        {hover !== null && secondsAgo > 0 ? (
          <span className="gpu-card-when">{t('{0} s ago', [secondsAgo])}</span>
        ) : latest.card.lanes ? (
          // A card that can use more PCIe lanes than its slot gives it.
          <span className="gpu-card-when gpu-card-lanes" title={t('This card’s slot gives it {0} of the {1} PCIe lanes it can use. Cards that share a model and work at the same time exchange data on every word, so a narrow slot can hold them back. If the PC has a free slot with more lanes, the card may be faster there.', [latest.card.lanes, latest.card.lanesMax])}>
            PCIe ×{latest.card.lanes}/{latest.card.lanesMax}
          </span>
        ) : (
          <span className="gpu-card-when" />
        )}
      </div>
      <div className="gpu-card-values">
        <span><i className="gpu-key is-gpu" />{t('GPU')} <b>{shown.card.percent}%</b></span>
        <span><i className="gpu-key is-vram" />{t('VRAM')} <b>{gigabytes(shown.card.usedBytes)} / {gigabytes(shown.card.totalBytes)} GB</b></span>
      </div>
      <svg
        className="gpu-card-graph"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${latest.card.name}: ${t('GPU')} ${latest.card.percent}%, ${t('VRAM')} ${gigabytes(latest.card.usedBytes)} / ${gigabytes(latest.card.totalBytes)} GB`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <line className="gpu-grid" x1="0" x2={WIDTH} y1={yOf(100)} y2={yOf(100)} />
        <line className="gpu-grid" x1="0" x2={WIDTH} y1={yOf(50)} y2={yOf(50)} />
        <line className="gpu-grid is-base" x1="0" x2={WIDTH} y1={yOf(0)} y2={yOf(0)} />
        {samples.length > 1 ? (
          <>
            <polyline className="gpu-line is-vram" points={line(vram)} />
            <polyline className="gpu-line is-gpu" points={line(gpu)} />
          </>
        ) : (
          <>
            {/* One sample is a point, not a line yet. */}
            <line className="gpu-line is-vram" x1={WIDTH - 3} x2={WIDTH} y1={yOf(vram[0])} y2={yOf(vram[0])} />
            <line className="gpu-line is-gpu" x1={WIDTH - 3} x2={WIDTH} y1={yOf(gpu[0])} y2={yOf(gpu[0])} />
          </>
        )}
        {hover !== null && samples[hover] && (
          <line className="gpu-crosshair" x1={xOf(hover, samples.length)} x2={xOf(hover, samples.length)} y1="0" y2={HEIGHT} />
        )}
      </svg>
    </div>
  );
}

/**
 * A PC with several graphics cards: one small graph per card, GPU use and memory in use as two
 * lines on the same 0-100% scale. Nothing is drawn for one card (the title bar already shows it).
 */
export default function GpuCards() {
  const history = useGpuHistory();
  if (!history.length) return null;
  const count = history[history.length - 1].cards.length;
  return (
    <section className="inspector-card gpu-cards" aria-label={t('Graphics cards')}>
      <div className="gpu-cards-head">
        <strong>{t('Graphics cards')}</strong>
        <span title={t('GPU use and graphics memory in use of each card, all programs')}>{t('Last 5 minutes')}</span>
      </div>
      {Array.from({ length: count }, (_, index) => (
        <CardGraph key={index} index={index} samples={history.map((sample) => ({ at: sample.at, card: sample.cards[index] }))} />
      ))}
    </section>
  );
}
