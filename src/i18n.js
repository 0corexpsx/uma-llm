// Interface languages for the window. Same locale files as the main process (electron/locales):
// English text is the key, and anything not translated yet shows in English.
import React from 'react';
import LANGUAGES from '../electron/locales/languages.json';
import it from '../electron/locales/it.json';
import es from '../electron/locales/es.json';
import ja from '../electron/locales/ja.json';
import zhCN from '../electron/locales/zh-CN.json';
import zhTW from '../electron/locales/zh-TW.json';

const DICTIONARIES = { it, es, ja, 'zh-CN': zhCN, 'zh-TW': zhTW };
let current = 'en';

export { LANGUAGES };

export function setLanguage(id) {
  current = LANGUAGES.some((language) => language.id === id) ? id : 'en';
  document.documentElement.lang = current;
}

export function getLanguage() {
  return current;
}

/** Text in the chosen language. `values` fills "{name}" or "{0}" placeholders. */
export function t(text, values) {
  const out = DICTIONARIES[current]?.[text] || text;
  if (!values) return out;
  return out.replace(/\{(\w+)\}/g, (whole, key) => (values[key] === undefined ? whole : String(values[key])));
}

/**
 * Like t(), for a sentence with elements inside (a bold name, a button): returns React children,
 * so each language can put the element where its word order needs it.
 */
export function tj(text, values) {
  const out = DICTIONARIES[current]?.[text] || text;
  return out.split(/(\{\w+\})/).map((part, index) => {
    const key = part.match(/^\{(\w+)\}$/)?.[1];
    if (key === undefined || values[key] === undefined) return part;
    const value = values[key];
    return typeof value === 'object' && value !== null ? React.cloneElement(value, { key: index }) : value;
  });
}

/** Singular or plural English key, picked by count; languages without plurals translate both the same. */
export function tn(count, one, many, values = {}) {
  return t(count === 1 ? one : many, { count, ...values });
}
