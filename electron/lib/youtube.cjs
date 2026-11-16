// YouTube search results read by Uma itself (the page's own data, as the browser gets it), so that
// "play the 3rd video" or "the most viewed one" opens that video's address directly. Small models
// that see the results page kept clicking the middle of the screen instead of the video.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** "9,647,247 views" -> 9647247; "1.2M views" -> 1200000; unknown -> 0. */
function viewCount(text) {
  const value = String(text || '').replace(/,/g, '');
  const short = /([\d.]+)\s*([KMB])\b/i.exec(value);
  if (short) return Math.round(Number(short[1]) * { K: 1e3, M: 1e6, B: 1e9 }[short[2].toUpperCase()]);
  const digits = /(\d+)/.exec(value.replace(/[.\s  ']/g, ''));
  return digits ? Number(digits[1]) : 0;
}

/** The videos of a results page, in the order shown (no ads, no Shorts shelves). */
function parseResults(html, limit = 20) {
  const start = html.indexOf('var ytInitialData = ');
  if (start < 0) return [];
  const end = html.indexOf(';</script>', start);
  let data;
  try { data = JSON.parse(html.slice(start + 'var ytInitialData = '.length, end)); } catch { return []; }
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object' || found.length >= limit) return;
    if (node.videoRenderer?.videoId) {
      const video = node.videoRenderer;
      const viewsText = video.viewCountText?.simpleText || video.viewCountText?.runs?.map((run) => run.text).join('') || '';
      found.push({
        id: video.videoId,
        title: video.title?.runs?.map((run) => run.text).join('') || video.title?.simpleText || '',
        viewsText,
        views: viewCount(viewsText),
      });
      return;
    }
    for (const value of Array.isArray(node) ? node : Object.values(node)) walk(value);
  };
  walk(data);
  return found;
}

async function youtubeResults(words, { signal, fetchImpl = fetch, limit = 20 } = {}) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(words).replace(/%20/g, '+')}`;
  const response = await fetchImpl(url, {
    signal,
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SOCS=CAI' },
  });
  if (!response.ok) throw new Error(`YouTube answered ${response.status}`);
  return parseResults(await response.text(), limit);
}

const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, top: 1, primo: 1, secondo: 2, terzo: 3, quarto: 4, quinto: 5 };

/**
 * Which video of the results the request wants: { most: true } for the most viewed, { index } for
 * "the 3rd one", { index: 1 } for "play the video"; null when it only asks to search.
 */
function videoWanted(text) {
  const value = String(text || '').toLowerCase();
  // "the best one" has no measure of its own: the most viewed of the results is the closest.
  if (/\bmost\s+(?:view(?:ed|s)?|watched|popular)\b|\bpiù\s+(?:vist[oi]|visualizzat[oi])\b|\b(?:the\s+)?best\b|\bmigliore\b/.test(value)) return { most: true };
  const number = /\b(\d{1,2})(?:st|nd|rd|th|°|º)?\s+(?:video|result|search|one|from the top)\b|\b(?:number|n\.?|#)\s*(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(value);
  if (number) {
    const index = Number(number[1] || number[2] || number[3]);
    if (index >= 1 && index <= 20) return { index };
  }
  const word = new RegExp(`\\b(${Object.keys(ORDINALS).join('|')})\\b`).exec(value);
  if (word && /\b(?:video|result|search|one|it|play|select|open|watch|run)\b/.test(value)) return { index: ORDINALS[word[1]] };
  if (/\b(?:play|watch|select|open|run|start|metti|riproduci)\b[^.]*\b(?:video|it|song|music|track|one)\b/.test(value)) return { index: 1 };
  // "play lofi on youtube": playing something is the first result.
  if (/\b(?:play|watch|put on|metti|riproduci|guarda)\b/.test(value)) return { index: 1 };
  return null;
}

/** The video the request wants from the results, or null. */
function chooseVideo(results, wanted) {
  if (!wanted || !results.length) return null;
  if (wanted.most) {
    const best = results.reduce((top, video) => (video.views > top.views ? video : top), results[0]);
    return { ...best, why: `the most viewed of the first ${results.length} results` };
  }
  const video = results[wanted.index - 1];
  return video ? { ...video, why: `result number ${wanted.index} from the top` } : null;
}

module.exports = { youtubeResults, parseResults, viewCount, videoWanted, chooseVideo };
