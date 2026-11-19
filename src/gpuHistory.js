// The last few minutes of each graphics card's readings, for the graph in the panel on the right.
// The title bar's monitor feeds it (it is always there), so the graph has a history the moment
// the panel opens. Kept only for a PC with several cards: one card is already in the title bar.
import { useSyncExternalStore } from 'react';

/** Samples kept: one arrives every 5 seconds, so 60 is five minutes. */
export const HISTORY_LENGTH = 60;

let history = [];
const listeners = new Set();

/** Adds the reading the main process just sent; a different set of cards starts the history again. */
export function recordGpuSample(stats, at = Date.now()) {
  const cards = stats?.gpu?.cards;
  if (!cards || cards.length < 2) {
    if (!history.length) return;
    history = [];
  } else {
    const same = history.length && history[history.length - 1].cards.length === cards.length
      && history[history.length - 1].cards.every((card, index) => card.name === cards[index].name);
    const sample = {
      at,
      cards: cards.map((card) => ({
        name: card.name,
        percent: Math.max(0, Math.min(100, Number(card.percent) || 0)),
        usedBytes: Number(card.usedBytes) || 0,
        totalBytes: Number(card.totalBytes) || 0,
      })),
    };
    history = [...(same ? history : []), sample].slice(-HISTORY_LENGTH);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The samples so far, oldest first; [] on a PC with one graphics card. */
export function useGpuHistory() {
  return useSyncExternalStore(subscribe, () => history);
}
