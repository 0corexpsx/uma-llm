const dns = require('node:dns').promises;
const net = require('node:net');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 UmaLLM/0.2';

function isPrivateIp(address) {
  if (!address) return true;
  const lower = address.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) reaches the IPv4 address, so judge it as one.
  const mapped = lower.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  if (lower === '::' || lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  if (/^(?:fc|fd|fe[89a-f]|ff|::ffff:)/.test(lower)) return true;
  if (!net.isIPv4(address)) return false;
  const parts = address.split('.').map(Number);
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
  if (parts[0] >= 224) return true;
  return false;
}

async function assertPublicUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http:// and https:// URLs are allowed.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Local and private addresses are blocked for internet tools.');
  }
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new Error(`Could not resolve ${host}.`);
  if (addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('Local and private addresses are blocked for internet tools.');
  }
  return url;
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripHtml(value) {
  return decodeEntities(
    String(value)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function normalizeDuckDuckGoUrl(href) {
  try {
    const decoded = decodeEntities(href);
    if (decoded.startsWith('//duckduckgo.com/l/')) {
      const url = new URL(`https:${decoded}`);
      return url.searchParams.get('uddg') || decoded;
    }
    if (decoded.startsWith('/l/')) {
      const url = new URL(`https://duckduckgo.com${decoded}`);
      return url.searchParams.get('uddg') || decoded;
    }
    return decoded;
  } catch {
    return href;
  }
}

async function readLimited(response, maxBytes) {
  // A reply with no body (204, or a HEAD-style answer) has nothing to read.
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error(`Page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

// Addresses that are examples, not someone's: placeholders, images, tracking services.
const NOT_AN_ADDRESS_RE = /@(?:example\.|test\.|domain\.|yourdomain|tuaattivita|tuodominio|email\.com$|sentry|wixpress)|\.(?:png|jpe?g|gif|webp|svg)$/i;
/**
 * How a page lets people get in touch: email addresses, phone links, contact forms with their
 * fields, and links to contact pages. Small models scrolled up and down looking for an address
 * that a page did not have (it had a form at the bottom); this tells them at once.
 */
function contactInfo(raw, baseUrl) {
  const html = String(raw || '');
  const withoutPlaceholders = html.replace(/\s(?:placeholder|data-[\w-]*ph|value)="[^"]*"/gi, ' ');
  const emails = new Set();
  for (const match of html.matchAll(/mailto:([^"'?\s>]+)/gi)) emails.add(decodeEntities(match[1]).toLowerCase());
  for (const match of stripHtml(withoutPlaceholders).matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) emails.add(match[0].toLowerCase());
  const phones = new Set([...html.matchAll(/href="tel:([^"]+)"/gi)].map((match) => decodeEntities(match[1])));
  const forms = [];
  for (const form of html.matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
    const body = form[0];
    const labels = [...body.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)].map((match) => stripHtml(match[1]).replace(/\s+/g, ' ').trim()).filter(Boolean);
    const fields = labels.length ? labels : [...body.matchAll(/<(?:input|textarea|select)\b[^>]*(?:placeholder|name)="([^"]+)"/gi)].map((match) => match[1]);
    const submit = /<button\b[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/i.exec(body) || /<input\b[^>]*type="submit"[^>]*value="([^"]*)"/i.exec(body);
    if (fields.length >= 2) forms.push({ fields: fields.slice(0, 12), submit: submit ? stripHtml(submit[1]).replace(/\s+/g, ' ').trim() : '' });
  }
  const links = new Map();
  for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = stripHtml(match[2]).replace(/\s+/g, ' ').trim();
    if (!text || text.length > 60 || !/contatt|contact|kontakt|chi siamo|about|who we are|impressum|scrivici|parla con noi|inizia progetto|get in touch|talk to us/i.test(text)) continue;
    let href = decodeEntities(match[1]);
    try { href = new URL(href, baseUrl).toString(); } catch {}
    if (!links.has(text)) links.set(text, href);
  }
  return {
    emails: [...emails].filter((email) => !NOT_AN_ADDRESS_RE.test(email)).slice(0, 10),
    phones: [...phones].slice(0, 5),
    forms: forms.slice(0, 3),
    links: [...links].slice(0, 8).map(([text, href]) => ({ text, href })),
  };
}

/** The contact details as a note for the model, or ''. */
function contactNote(contact) {
  if (!contact) return '';
  const parts = [];
  parts.push(contact.emails.length ? `email addresses: ${contact.emails.join(', ')}` : 'no email address on this page');
  if (contact.phones.length) parts.push(`phone: ${contact.phones.join(', ')}`);
  for (const form of contact.forms) parts.push(`a contact form with the fields ${form.fields.map((field) => `"${field}"`).join(', ')}${form.submit ? ` and the button "${form.submit}"` : ''}`);
  if (contact.links.length) parts.push(`contact links: ${contact.links.map((link) => `"${link.text}" (${link.href})`).join(', ')}`);
  if (!contact.emails.length && !contact.phones.length && !contact.forms.length && !contact.links.length) return '';
  return `[How to contact them, found on this page: ${parts.join('; ')}.]`;
}

async function fetchUrl(rawUrl) {
  let url = await assertPublicUrl(rawUrl);
  let response;
  for (let redirects = 0; redirects < 6; redirects += 1) {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = await assertPublicUrl(new URL(response.headers.get('location'), url).toString());
      continue;
    }
    break;
  }
  if (!response) throw new Error('No response from website.');
  if (!response.ok) throw new Error(`Website returned ${response.status} ${response.statusText}.`);
  const type = response.headers.get('content-type') || '';
  const allowed = /text\/html|text\/plain|application\/json|application\/xml|text\/xml|text\/markdown/i.test(type);
  if (!allowed) throw new Error(`Unsupported content type: ${type || 'unknown'}. Only text pages can be read.`);
  const raw = await readLimited(response, 2 * 1024 * 1024);
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = /html/i.test(type) ? stripHtml(raw) : raw;
  return {
    url: url.toString(),
    title: titleMatch ? decodeEntities(stripHtml(titleMatch[1])).slice(0, 300) : '',
    text: text.slice(0, 50000),
    truncated: text.length > 50000,
    contact: /html/i.test(type) ? contactInfo(raw, url.toString()) : null,
  };
}

async function webSearch(query, maxResults = 8) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Search query is empty.');
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  await assertPublicUrl(searchUrl);
  const response = await fetch(searchUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Search failed with HTTP ${response.status}.`);
  const html = await readLimited(response, 2 * 1024 * 1024);

  const anchors = [...html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];
  const results = [];
  for (let index = 0; index < anchors.length && results.length < maxResults; index += 1) {
    const anchor = anchors[index];
    const url = normalizeDuckDuckGoUrl(anchor[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: stripHtml(anchor[2]).slice(0, 240),
      url,
      snippet: snippets[index] ? stripHtml(snippets[index][1]).slice(0, 500) : '',
    });
  }
  return results;
}

module.exports = { contactInfo, contactNote, webSearch, fetchUrl, assertPublicUrl, stripHtml, isPrivateIp };
