// Interface languages. English text is the key: each locale file maps it to a translation, and
// anything not translated yet shows in English. "{name}" or "{0}" marks a value filled in at run time.
const LANGUAGES = require('../locales/languages.json');

const dictionaries = {};
let current = 'en';

function dictionary(language) {
  if (language === 'en') return null;
  if (!(language in dictionaries)) {
    try {
      dictionaries[language] = require(`../locales/${language}.json`);
    } catch {
      dictionaries[language] = null;
    }
  }
  return dictionaries[language];
}

function fill(text, values) {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key) => (values[key] === undefined ? whole : String(values[key])));
}

function translate(language, text, values) {
  return fill(dictionary(language)?.[text] || text, values);
}

/** Text in the language the user chose. */
function t(text, values) {
  return translate(current, text, values);
}

function isLanguage(id) {
  return LANGUAGES.some((language) => language.id === id);
}

function setLanguage(id) {
  current = isLanguage(id) ? id : 'en';
}

function getLanguage() {
  return current;
}

/** The closest supported language to the system's, like "it-IT" → "it" or "zh-Hant-HK" → "zh-TW". */
function systemLanguage(locales = []) {
  for (const locale of locales) {
    const tag = String(locale || '').toLowerCase();
    if (/^zh[-_](tw|hk|mo|hant)/.test(tag)) return 'zh-TW';
    if (tag.startsWith('zh')) return 'zh-CN';
    const base = tag.split(/[-_]/)[0];
    if (['en', 'it', 'es', 'ja'].includes(base)) return base;
  }
  return 'en';
}

/** The Windows installer records the language picked in setup as a Windows language ID. */
function fromWindowsLanguageId(id) {
  return LANGUAGES.find((language) => language.nsis === Number(id))?.id || '';
}

module.exports = { LANGUAGES, t, translate, setLanguage, getLanguage, systemLanguage, fromWindowsLanguageId, isLanguage };
