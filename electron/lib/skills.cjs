// Skills: saved instructions the model loads when a task matches, in the same folder format Claude
// uses. A skill is a folder with a SKILL.md (a short header with name and description, then the
// instructions) and, optionally, more files beside it: references to read and scripts to run.
// Only the name and description cost context until a skill is loaded, and its other files cost
// nothing until the model asks for one.
const path = require('node:path');
const fsp = require('node:fs/promises');
const { ensureDir } = require('./util.cjs');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 240;
// The other files of one skill that are listed for the model.
const MAX_SKILL_FILES = 300;
const MAX_SKILL_DEPTH = 4;
// The installed skills are read from disk again at most this often.
const LIST_TTL_MS = 5000;

/** "value", 'value' or value, without the quotes. */
function unquote(value) {
  const text = String(value).trim();
  const quoted = text.match(/^(["'])([\s\S]*)\1$/);
  return quoted ? quoted[2] : text;
}

/**
 * Reads the header of a SKILL.md. It is YAML, but only the shapes skills really use are understood:
 * `key: value`, quoted values, values folded over several lines (`>` or `|`, or just indented), and
 * lists written as `[a, b]` or as `- a` lines. Anything nested deeper is ignored.
 */
function parseHeader(text) {
  const fields = {};
  let key = '';
  let inline = '';
  let extra = [];
  const finish = () => {
    if (!key) return;
    const lines = extra.map((line) => line.trim()).filter(Boolean);
    if (/^[>|][+-]?$/.test(inline)) {
      fields[key] = lines.join(inline.startsWith('|') ? '\n' : ' ');
    } else if (!inline && lines.length && lines.every((line) => line.startsWith('- '))) {
      fields[key] = lines.map((line) => unquote(line.slice(2)));
    } else if (/^\[.*\]$/.test(inline)) {
      fields[key] = inline.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      // Indented lines under a plain value continue it; under an empty value they are a nested map.
      // "description:" with the text on the indented lines below (a plain YAML value over several
      // lines, as Vercel's skills write it) is that text, not a nested map.
      const plain = !inline && lines.length && !lines.some((line) => /^[\w-]+:(\s|$)/.test(line));
      fields[key] = inline ? unquote([inline, ...lines.filter((line) => !/^[\w-]+:\s/.test(line))].join(' ')) : plain ? unquote(lines.join(' ')) : '';
    }
  };
  for (const line of text.split('\n')) {
    const field = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (field) {
      finish();
      key = field[1].toLowerCase();
      inline = field[2].trim();
      extra = [];
    } else if (key && /^\s+\S/.test(line)) {
      extra.push(line);
    }
  }
  finish();
  return fields;
}

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

/** A description short enough for a list, cut at a word. */
function shortDescription(value) {
  const text = String(Array.isArray(value) ? value.join(' ') : value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  const cut = text.slice(0, MAX_DESCRIPTION_CHARS - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX_DESCRIPTION_CHARS - 40)).replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * The connector a skill works through, when it has one: a server of another assistant (MCP) that
 * gives it tools such as RUBE_SEARCH_TOOLS or mcp__github__create_issue. Uma has no connectors, so
 * every step of such a skill calls a tool that is not there. Returns the connector's name ("rube",
 * "FlowStudio", or "mcp" when it has none of its own), or '' for a skill that needs none.
 *
 * What counts, in this order: the header says so ("requires: mcp: [rube]"); the description says the
 * work goes through one ("via Rube MCP (Composio)", "through its hosted MCP server", "using the
 * FlowStudio MCP server"); the skill is named after one ("serply-search-mcp"); it states the need
 * ("Requires the hosted datawebot MCP", "MCP server must already be connected", "the hosted aident
 * MCP server"); or its steps call a connector's tools by name three times or more.
 * What does not: a skill ABOUT connectors (building, auditing or setting one up), one that offers
 * another way in the same breath ("through MCP or CLI", "over MCP or HTTP"), and one that says it
 * needs none ("No MCP server required"). The rule errs towards marking: a skill marked by mistake is
 * only not offered by itself, among five thousand others, and can still be read and installed.
 */
const MCP = "(?<![-\\w])MCP(?![-\\w])";
const NO_CONNECTOR_RE = new RegExp(`\\b(?:no|without(?: an?| any)?|(?:does not|doesn't|do not|don't) (?:need|require)(?: an?| any)?)\\s+(?:[\\w-]+\\s+){0,2}${MCP}`, 'i');
const OTHER_WAY_RE = new RegExp(`\\bor\\b[^.\\n]{0,40}${MCP}|${MCP}[^.\\n]{0,40}\\bor\\b|\\b(?:CLI|SDK|REST|HTTP|curl|command[- ]line)\\b`, 'i');
// Making, checking or setting up a connector is work on one, not through one.
// ("Configure AWS MCP servers", "Audit MCP servers for…"; not "Build flows using the FlowStudio MCP server".)
const ABOUT_CONNECTORS_RE = new RegExp(`\\b(?:build|creat|generat|scaffold|configur|set ?up|setting up|audit|design|develop|implement|writ|troubleshoot|diagnos|scor|evaluat|secur|review)\\w*\\s+(?:(?:an?|the|new|custom|your|own|local|any)\\s+)*(?:[\\w-]+\\s+){0,2}${MCP}\\s+(?:servers?|connectors?|integrations?|extension|endpoints?)|\\bconnectors? with ${MCP}`, 'i');
const VIA_CONNECTOR_RE = new RegExp(`\\b(?:via|through|over|using|with)\\s+((?:[\\w'’-]+(?:\\.\\w+)*\\s+){0,5}?)${MCP}`, 'i');
const NEEDS_CONNECTOR_RE = new RegExp(`(?:^|[.\\n:*>-]\\s*|\\*\\*)(?:Requires?|Needs?)(?::\\*\\*|:)?\\s+((?:(?!\\bno\\b|\\bnot\\b|\\boptional)[^.\\n|]){0,60}?)${MCP}`, 'm');
const MUST_CONNECT_RE = new RegExp(`${MCP}(?:\\s+(?:server|tools?|connection))?\\s+(?:must|needs to|has to)(?: already| first)? be (?:connected|configured|installed|running|enabled|set up|available)`, 'i');
const HOSTED_CONNECTOR_RE = new RegExp(`\\b(?:hosted|connected|remote|authorized)\\s+((?:\`?[\\w.'’-]+\`?\\s+)?)${MCP}\\s+(?:server|tools?|connection|connector|account|bridge)`, 'i');
const CONNECTOR_CALL_RE = /\bmcp__([a-z0-9][a-z0-9_-]*?)__[a-z0-9_]+/gi;

function skillConnector(header, description = '', body = '') {
  const block = /^requires:[ \t]*\n((?:[ \t]+.*(?:\n|$))+)/m.exec(String(header || ''));
  const listed = block && /^[ \t]+mcp:[ \t]*(?:\[([^\]]*)\]|((?:\n[ \t]+-[ \t]*.+)+)|([^\n[]+))/m.exec(block[1]);
  if (listed) {
    const names = (listed[1] || listed[3] || '').split(',').concat((listed[2] || '').split('\n').map((line) => line.replace(/^[ \t]+-[ \t]*/, '')))
      .map((name) => name.trim().replace(/^["']|["']$/g, '').toLowerCase()).filter(Boolean);
    if (names.length) return names[0].slice(0, 40);
  }
  // Its steps call the connector's own tools (RUBE_SEARCH_TOOLS, RUBE_MANAGE_CONNECTIONS).
  if (/\bvia Rube MCP\b|\bRube MCP \(Composio\)|\bthrough (?:the )?(?:Rube|Composio) MCP\b|\bthrough Composio's\b/i.test(description) || /\bRUBE_[A-Z]+_[A-Z_]+\b/.test(body)) return 'rube';

  const about = String(description || '');
  if (NO_CONNECTOR_RE.test(about) || ABOUT_CONNECTORS_RE.test(about)) return '';
  const own = (/^name:[ \t]*["']?([\w-]+)/m.exec(String(header || ''))?.[1] || '').toLowerCase();
  const text = String(body || '');
  const calls = [...text.matchAll(CONNECTOR_CALL_RE)].map((match) => match[1].toLowerCase());
  const called = calls.length >= 3 || /^(?:allowed-tools|tools):.*\bmcp__/im.test(String(header || '')) ? calls[0] || 'mcp' : '';
  // The connector's own name, when the words before "MCP" give one: "the FlowStudio MCP server",
  // "Chrome DevTools MCP", "the apple-notes MCP server" (in the skill apple-notes-search).
  const named = (words) => {
    const picked = [];
    for (const word of String(words || '').trim().split(/\s+/).reverse()) {
      const clean = word.replace(/[`*]/g, '').replace(/['’]s$/, '');
      if (!/^[A-Za-z][\w.-]*$/.test(clean) || !(/[A-Z]/.test(clean) || (clean.length > 3 && own.includes(clean.toLowerCase()))) || picked.length >= 3) break;
      picked.unshift(clean);
    }
    return picked.join(' ').slice(0, 40);
  };
  if (OTHER_WAY_RE.test(about)) return called;
  const via = VIA_CONNECTOR_RE.exec(about);
  if (via) return named(via[1]) || called || 'mcp';
  if (/(?:^|-)mcp$/.test(own)) return called || 'mcp';
  const needs = NEEDS_CONNECTOR_RE.exec(`${about}\n${text}`);
  if (needs) return named(needs[1]) || called || 'mcp';
  // Stated where a skill says what it needs, near its top; a line that offers another way does not count.
  for (const line of text.split('\n').slice(0, 60)) {
    if (OTHER_WAY_RE.test(line)) continue;
    const hosted = HOSTED_CONNECTOR_RE.exec(line);
    if (hosted || MUST_CONNECT_RE.test(line)) return named(hosted?.[1]) || called || 'mcp';
  }
  return called;
}

function parseSkill(raw) {
  const text = String(raw).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { error: 'SKILL.md must start with a --- header holding name and description.' };
  const fields = parseHeader(match[1]);
  const description = shortDescription(fields.description);
  if (!description) return { error: 'The header needs a description, so the model knows when to use this skill.' };
  const body = match[2].trim();
  if (!body) return { error: 'SKILL.md has no instructions below its header.' };
  return {
    description,
    body,
    // The line of SKILL.md the instructions start on, so a part left out can be read by its lines.
    bodyLine: text.slice(0, text.length - match[2].length + match[2].indexOf(body)).split('\n').length,
    requires: asList(fields.requires),
    connector: skillConnector(match[1], description, body),
    // What a skill from a library says about itself. None of it changes what the skill may do.
    meta: {
      risk: String(fields.risk || '').toLowerCase(),
      category: String(fields.category || '').toLowerCase(),
      tags: asList(fields.tags),
      source: String(fields.source || ''),
      license: String(fields.license || ''),
    },
  };
}

/** "rube" as its users know it. */
function connectorName(connector) {
  return connector === 'rube' ? 'Rube (Composio)' : connector === 'mcp' ? 'MCP' : String(connector || '');
}

// Online services people ask an assistant to act in, by the name a request uses and the start of
// the library skill for each. All of those skills work through a connector, which Uma does not have.
// Only names that are not also ordinary words ("box", "linear", "close", "monday" are left out).
const OUTSIDE_SERVICES = [
  ['Jira', 'jira'], ['Slack', 'slack'], ['Trello', 'trello'], ['Notion', 'notion'], ['Asana', 'asana'], ['Airtable', 'airtable'], ['HubSpot', 'hubspot'],
  ['Salesforce', 'salesforce'], ['Zendesk', 'zendesk'], ['Confluence', 'confluence'], ['Discord', 'discord'], ['Telegram', 'telegram'], ['WhatsApp', 'whatsapp'],
  ['Mailchimp', 'mailchimp'], ['SendGrid', 'sendgrid'], ['Shopify', 'shopify'], ['ClickUp', 'clickup'], ['Pipedrive', 'pipedrive'], ['Calendly', 'calendly'],
  ['Dropbox', 'dropbox'], ['DocuSign', 'docusign'], ['Intercom', 'intercom'], ['LinkedIn', 'linkedin'], ['Twitter', 'twitter'], ['Instagram', 'instagram'],
  ['Facebook', 'facebook'], ['TikTok', 'tiktok'], ['Todoist', 'todoist'], ['Basecamp', 'basecamp'], ['Freshdesk', 'freshdesk'], ['PagerDuty', 'pagerduty'],
  ['Outlook', 'outlook'], ['Google Calendar', 'googlecalendar'], ['Google Drive', 'googledrive'], ['Google Docs', 'googledocs'], ['Google Sheets', 'googlesheets'],
  ['Microsoft Teams', 'microsoft-teams'], ['OneDrive', 'one-drive'], ['SharePoint', 'share-point'], ['QuickBooks', 'quickbooks'], ['Wrike', 'wrike'], ['Klaviyo', 'klaviyo'],
];
const SERVICE_ACTION = '(?:post|send|create|add|open|file|schedule|book|assign|update|close|comment|message|invite|upload|share|publish|log|move|put|make|write|reply|notify|tell|ping|remind|sync|push|set up)\\w*';
const SERVICE_THING = '(?:tickets?|issues?|channels?|boards?|cards?|pages?|tasks?|messages?|dms?|events?|meetings?|invites?|contacts?|deals?|leads?|invoices?|posts?|stor(?:y|ies)|workspaces?|projects?|databases?|docs?|sheets?|files?|folders?|campaigns?|lists?|threads?|comments?|reminders?|calendar|server|groups?|accounts?|bug)';

/**
 * The online service a request asks to act in ("post it in my Slack channel", "create a Jira
 * ticket"), or null. Asked for a Jira ticket, a real model wrote a file and answered that the Jira
 * ticket had been created. A request that is only about a service ("write a Slack bot", "how does
 * the Jira API work?") is not one: it takes a word of doing, and the service as the place ("in",
 * "to", "my") or with its thing after it ("Jira ticket").
 */
function outsideService(text) {
  const value = String(text || '');
  // Code that talks to a service is work on this PC: "add a function that posts to Slack".
  if (/\b(?:functions?|scripts?|code|bots?|apis?|webhooks?|integrations?|endpoints?|components?|class(?:es)?|modules?|plugins?|apps?|programs?|features?|buttons?|forms?|library|sdk|cli)\b/i.test(value)) return null;
  for (const [name, start] of OUTSIDE_SERVICES) {
    const word = name.replace(/ /g, '[ -]?');
    const place = new RegExp(`\\b${SERVICE_ACTION}\\b[^.?!\\n]{0,80}?(?:\\b(?:in|on|to|into|via|through|my|our|the|a|an)\\s+(?:(?:my|our|the|a|an|new)\\s+)?${word}(?![\\w-])(?:\\s+${SERVICE_THING}\\b)?)`, 'i').exec(value);
    if (!place) continue;
    // "a Slack bot", "the Notion API": after "a/an/the" the service must be followed by its thing.
    const bare = new RegExp(`\\b(?:the|a|an)\\s+(?:new\\s+)?${word}(?![\\w-])(?!\\s+${SERVICE_THING}\\b)`, 'i');
    const asPlace = new RegExp(`\\b(?:in|on|to|into|via|through|my|our)\\s+(?:(?:my|our|the)\\s+)?${word}(?![\\w-])`, 'i');
    if (bare.test(place[0]) && !asPlace.test(place[0])) continue;
    return { name, start };
  }
  return null;
}

const PERMISSIONS = {
  terminal: { setting: 'allowShell', label: 'Terminal access' },
  internet: { setting: 'allowInternet', label: 'Internet access' },
  edits: { setting: 'allowEdits', label: 'File edits' },
};

/** The switches this skill needs that are off. */
function missingPermissions(requires, settings) {
  return requires.map((item) => PERMISSIONS[item]).filter((item) => item && !settings[item.setting]);
}

/** Names the switch this skill still needs. */
function missingPermission(requires, settings) {
  return missingPermissions(requires, settings)[0]?.label || '';
}

/**
 * Whether a skill can still do part of its work with what is off. Without the terminal it can: it
 * reads and writes the files, and the model tells the user which command to run (write-tests writes
 * the tests; before, with the terminal off, it was hidden and a wrong skill was picked instead).
 * Without internet access or file edits there is nothing left for it to do, so it stays hidden.
 */
function worksInPart(requires, settings) {
  const missing = missingPermissions(requires, settings);
  return missing.length > 0 && missing.every((item) => item === PERMISSIONS.terminal);
}

// ---- finding the skills that fit a request ----

const STOPWORDS = new Set(('a an and are as at be but by can do for from has have how i if in into is it its me my of on or our '
  + 'please so that the their them then there these this to use used using want was we what when which who why will with you your '
  + 'about all any also make need needs get help new some should would could file files code project '
  // Italian and Spanish words that carry no meaning, so they cannot match a skill written in Spanish.
  + 'de la el en un una y para con por que los las del al il di per che le lo gli').split(' '));

/** Words that carry meaning, lowercased, with plural and verb endings removed so "tests" finds "testing". */
function keywords(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.]*[a-z0-9+#]|[a-z0-9]/g) || [];
  return words
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map((word) => (word.length > 4 ? word.replace(/(?:ing|ed|es|s)$/, '') : word));
}

/**
 * The skills that match some text, best first. Each word of the text counts once per skill: most in
 * the name, less in its tags, least in the description, and rarer words count more. This costs no
 * model time, so it can run on every message, however many skills are installed.
 */
function rankSkills(skills, text, limit = 8) {
  const wanted = [...new Set(keywords(text))];
  if (!wanted.length || !skills.length) return [];
  // In how many skills each word of the request appears, and where in each skill.
  const found = new Array(wanted.length).fill(0);
  const matches = [];
  for (const skill of skills) {
    const document = documentFor(skill);
    let weights = null;
    for (let index = 0; index < wanted.length; index += 1) {
      const word = wanted[index];
      const weight = document.name.has(word) ? 4 : document.tags.has(word) ? 2 : document.description.has(word) ? 1 : 0;
      if (!weight) continue;
      found[index] += 1;
      (weights ||= []).push(index, weight);
    }
    matches.push(weights);
  }
  const phrase = ` ${String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const ranked = [];
  for (let position = 0; position < skills.length; position += 1) {
    const skill = skills[position];
    const document = documentFor(skill);
    const weights = matches[position] || [];
    let score = 0;
    let hits = 0;
    let nameHits = 0;
    for (let index = 0; index < weights.length; index += 2) {
      hits += 1;
      if (weights[index + 1] === 4) nameHits += 1;
      score += weights[index + 1] * Math.log(1 + skills.length / found[weights[index]]);
    }
    // "use the code review skill" names it outright. A one-word name ("settings", "scan", "fix") is
    // an ordinary word of many requests, so it counts only when the request calls it a skill.
    const named = phrase.includes(`${document.phrase}skill `);
    if (named || (!document.oneWord && phrase.includes(document.phrase))) {
      score += 20;
      nameHits += 1;
      hits += 1;
    }
    if (score <= 0) continue;
    // The skills installed on this PC were written for Uma's own tools and a small context, or were
    // put there by the user: they go before a library skill that matches about as well.
    if (document.own && hits >= 2) score *= OWN_SKILL_BOOST;
    // A skill that drives another assistant's connectors cannot do its work here.
    if (document.needsOther) score *= OTHER_ASSISTANT_PENALTY;
    ranked.push({ skill, score, hits, nameHits, named });
  }
  ranked.sort((a, b) => b.score - a.score
    || Number(documentFor(b.skill).own) - Number(documentFor(a.skill).own)
    || a.skill.name.localeCompare(b.skill.name));
  return ranked.slice(0, limit);
}

/**
 * Whether a match is worth putting to the model as a skill that may fit. A wrong skill costs more
 * than none: with a real 9B model, loosely matched skills were picked anyway (a Swift skill for
 * JavaScript tests, a Next.js landing-page skill for one small page, a minute slower each time).
 * - One of the skills installed on this PC: two words of the request match it (for a task about the
 *   project), or it matches strongly.
 * - A skill of the library: the request covers its name: two words of a two-word name, three of
 *   three or four; a one-word name ("commit", "scan") must be in the request itself, with two more
 *   words of its description (a skill called "assay" was offered, and picked, for a page of
 *   questions and answers, on three words of its description alone).
 */
function worthAsking(entry, { agentic = false } = {}) {
  const document = documentFor(entry.skill);
  if (document.own) return isStrongMatch(entry) || (agentic && entry.hits >= 2);
  const words = document.name.size;
  if (words <= 1) return entry.nameHits >= 1 && entry.hits >= 3;
  return entry.nameHits >= 2 && entry.nameHits >= Math.ceil(words * 0.7);
}

/**
 * The one skill a request plainly asks for, so that the model need not be asked which fits (that
 * question is a whole extra reply, seconds on a slow PC). Either a skill the request names as one
 * ("use the docker expert skill"), or one of the skills installed on this PC with every word of its
 * name in the request (two or more) and no other skill close to it. Anything less clear is still
 * put to the model.
 */
function clearSkillChoice(ranked) {
  const [first, second] = ranked || [];
  if (!first) return null;
  if (first.named) return first.skill;
  const document = documentFor(first.skill);
  if (!document.own || first.nameHits < 2 || first.nameHits < document.name.size) return null;
  if (second && first.score < second.score * CLEAR_CHOICE_LEAD) return null;
  return first.skill;
}
const CLEAR_CHOICE_LEAD = 1.8;

const OWN_SKILL_BOOST = 1.5;
const OTHER_ASSISTANT_PENALTY = 0.4;
// Connectors (MCP servers) of other assistants: Uma has none, so these skills' steps cannot be run.
const OTHER_ASSISTANT_RE = /\bMCP\b|\bComposio\b|\bRube\b/i;

// A skill's words, worked out once per skill: with a library of thousands this is most of the cost.
const skillDocuments = new WeakMap();
function documentFor(skill) {
  let document = skillDocuments.get(skill);
  if (!document) {
    const spaced = String(skill.name).replace(/-/g, ' ');
    document = {
      name: new Set(keywords(spaced)),
      tags: new Set(keywords([...(skill.meta?.tags || []), skill.meta?.category || ''].join(' '))),
      description: new Set(keywords(skill.description)),
      phrase: ` ${spaced} `,
      oneWord: !spaced.includes(' '),
      own: skill.source === 'project' || skill.source === 'global',
      needsOther: OTHER_ASSISTANT_RE.test(skill.description || ''),
    };
    skillDocuments.set(skill, document);
  }
  return document;
}

// ---- fitting a long skill into a small context ----

// Sections that say what to do, and sections that only frame it.
const STEPS_HEADING_RE = /\b(steps?|workflow|process|procedure|instructions?|how to|usage|quick ?start|getting started|checklist|rules?|guidelines?|core|implementation|commands?|method|approach|phases?|protocol)\b/i;
const FRAME_HEADING_RE = /\b(when (?:not )?to use|overview|introduction|about|background|philosophy|purpose|references?|resources?|see also|related|further reading|changelog|license|credits?|acknowledge?ments?|limitations|faq|triggers?|keywords|metadata|version|author)\b/i;

/**
 * A skill's instructions within `budget` characters. Most library skills are longer than a small
 * model's context allows; cut at a fixed point, the model got the introduction and lost the steps.
 * Here the text is taken apart at its headings: the opening stays, then the sections that say what
 * to do and those that match the request, in their own order. Each part left out is named with its
 * lines in SKILL.md, so the model can read it when a step needs it.
 * Returns { text, left: [{ heading, start, end }] }.
 */
function fitSkillBody(body, budget, request = '', firstLine = 1) {
  const text = String(body || '');
  if (!(budget > 0) || text.length <= budget) return { text, left: [] };
  const sections = [];
  let current = { heading: '', start: 0, lines: [] };
  let fenced = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,4}\s+\S/.test(line)) {
      if (current.lines.length) {
        sections.push(current);
        current = { heading: '', start: index, lines: [] };
      }
      current.heading = line.replace(/^#+\s+/, '').trim();
    }
    current.lines.push(line);
  });
  sections.push(current);
  const label = (section) => (section.heading ? `"${section.heading}"` : 'the opening');
  // The lines of a section that fit in `room` characters.
  const head = (section, room) => {
    let size = 0;
    let count = 0;
    while (count < section.lines.length && size + section.lines[count].length + 1 <= room) {
      size += section.lines[count].length + 1;
      count += 1;
    }
    return count;
  };
  const wanted = new Set(keywords(request));
  const hits = (value) => new Set(keywords(value).filter((word) => wanted.has(word))).size;
  sections.forEach((section, index) => {
    section.size = section.lines.join('\n').length + 1;
    section.score = hits(section.heading) * 4 + Math.min(4, hits(section.lines.join(' ')))
      + (STEPS_HEADING_RE.test(section.heading) ? 3 : 0) - (FRAME_HEADING_RE.test(section.heading) ? 3 : 0) - index * 0.05;
  });
  // Room for the notes that name what was left out.
  let room = budget - Math.min(Math.floor(budget * 0.2), 120 + sections.length * 40);
  const kept = new Map();
  // The opening says what the skill is for: it stays, but may not take the room of the steps.
  const opening = sections[0];
  // A skill with no headings is all opening: it gets all the room.
  const openingRoom = sections.length > 1 ? Math.floor(room * 0.3) : room;
  const openingLines = opening.size <= openingRoom ? opening.lines.length : head(opening, openingRoom);
  if (openingLines) {
    kept.set(opening, openingLines);
    room -= opening.lines.slice(0, openingLines).join('\n').length + 1;
  }
  for (const section of [...sections.slice(1)].sort((a, b) => b.score - a.score)) {
    if (section.size <= room) {
      kept.set(section, section.lines.length);
      room -= section.size;
    } else if (room > 600 && kept.size <= 1) {
      // The best section alone is too long: its start is better than none of it.
      const count = head(section, room);
      if (count > 1) {
        kept.set(section, count);
        room -= section.lines.slice(0, count).join('\n').length + 1;
      }
    }
  }
  const render = () => {
    const parts = [];
    const left = [];
    let skipped = [];
    const flush = () => {
      if (!skipped.length) return;
      // A long run of parts is named by its first few, so the notes do not take the room of the steps.
      const named = skipped.slice(0, 4).map((item) => `${item.heading} (lines ${item.start}-${item.end})`);
      if (skipped.length > 4) named.push(`${skipped.length - 4} more parts (lines ${skipped[4].start}-${skipped[skipped.length - 1].end})`);
      parts.push(`[Left out: ${named.join('; ')}]`);
      left.push(...skipped);
      skipped = [];
    };
    for (const section of sections) {
      const count = kept.get(section) || 0;
      if (!count) {
        skipped.push({ heading: label(section), start: firstLine + section.start, end: firstLine + section.start + section.lines.length - 1 });
        continue;
      }
      flush();
      parts.push(section.lines.slice(0, count).join('\n').trimEnd());
      if (count < section.lines.length) {
        skipped.push({ heading: `the rest of ${label(section)}`, start: firstLine + section.start + count, end: firstLine + section.start + section.lines.length - 1 });
      }
    }
    flush();
    return { text: parts.join('\n\n'), left };
  };
  // The notes take room too: while the result is too long, the least useful section goes.
  let result = render();
  while (result.text.length > budget && kept.size > 1) {
    const weakest = [...kept.keys()].filter((section) => section !== opening).sort((a, b) => a.score - b.score)[0] || opening;
    kept.delete(weakest);
    result = render();
  }
  return result;
}

/** A match good enough to ask the model about, even for a request that is not about the workspace. */
function isStrongMatch(entry) {
  return Boolean(entry) && (entry.nameHits >= 2 || (entry.nameHits >= 1 && entry.hits >= 2) || entry.hits >= 3);
}

/**
 * Finds skills in a project's .uma/skills folder and in the
 * shared folder. Project skills win on a name clash.
 */
class SkillStore {
  constructor({ globalDir, bundledDir = '', store, trash = null, library = null }) {
    this.globalDir = globalDir;
    // The skill library shipped with Uma (skillLibrary.cjs): with "Use the whole skill library" on,
    // its skills are offered to the model without being installed (copied) first.
    this.library = library;
    this.bundledDir = bundledDir;
    this.store = store;
    this.trash = trash;
    // Parsed SKILL.md files, kept while the file's size and time stay the same.
    this.parsed = new Map();
    this.scanned = new Map();
  }

  projectDir(root) {
    return path.join(root, '.uma', 'skills');
  }

  /** Forget what was read, after something changed the skill folders. */
  invalidate() {
    this.scanned.clear();
  }

  async scan(dir, source) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    // One message asks for the skills several times. While the folder holds the same skills, what
    // was read a moment ago is reused; an edit to a SKILL.md is picked up within a few seconds.
    const listing = entries.map((entry) => entry.name).join('\n');
    const recent = this.scanned.get(dir);
    if (recent && recent.listing === listing && Date.now() - recent.at < LIST_TTL_MS) return recent.skills;
    const skills = [];
    for (const entry of entries) {
      // Symlinks are skipped, so a project cannot point a skill at a file elsewhere on the PC.
      if (!entry.isDirectory() || entry.isSymbolicLink() || !NAME_RE.test(entry.name)) continue;
      const file = path.join(dir, entry.name, 'SKILL.md');
      const stat = await fsp.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const base = { name: entry.name, source, path: file, dir: path.join(dir, entry.name) };
      if (stat.size > MAX_FILE_BYTES) {
        skills.push({ ...base, description: '', error: 'SKILL.md is larger than 64 KB. Keep skills short: they use the model\'s context.' });
        continue;
      }
      // With hundreds of skills installed, reading every file again for each message is slow.
      const stamp = `${stat.size}:${stat.mtimeMs}`;
      let known = this.parsed.get(file);
      if (!known || known.stamp !== stamp) {
        known = { stamp, parsed: parseSkill(await fsp.readFile(file, 'utf8')) };
        this.parsed.set(file, known);
      }
      const { parsed } = known;
      skills.push({ ...base, description: parsed.description || '', body: parsed.body, bodyLine: parsed.bodyLine || 1, requires: parsed.requires || [], connector: parsed.connector || '', meta: parsed.meta || {}, error: parsed.error || '' });
    }
    this.scanned.set(dir, { at: Date.now(), listing, skills });
    return skills;
  }

  /** Every skill, including disabled and broken ones, for the Settings panel. */
  async list(root) {
    const settings = this.store.getSettings();
    const disabled = new Set(settings.disabledSkills || []);
    const project = root ? await this.scan(this.projectDir(root), 'project') : [];
    const shared = await this.scan(this.globalDir, 'global');
    const names = new Set(project.map((skill) => skill.name));
    return [...project, ...shared.filter((skill) => !names.has(skill.name))]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => ({
        ...skill,
        enabled: !disabled.has(skill.name),
        needs: missingPermission(skill.requires || [], settings),
        partial: worksInPart(skill.requires || [], settings),
        connector: skill.connector || '',
      }));
  }

  /**
   * The library's skills that are not installed, as skills the model may use. Their instructions
   * are read only when one is loaded. A skill switched off in Settings stays off.
   */
  async librarySkills(installedNames) {
    if (!this.library) return [];
    const index = await this.library.index();
    // Thousands of entries: they are prepared once, and each message reuses the same objects.
    if (this.libraryList?.index !== index) this.libraryList = { index, skills: this.fromLibrary(index.skills) };
    return this.libraryList.skills.filter((skill) => !installedNames.has(skill.name));
  }

  fromLibrary(entries) {
    return entries
      .map((entry) => ({
        name: entry.name,
        source: 'library',
        description: entry.description,
        dir: path.join(this.library.dir, 'skills', entry.name),
        path: path.join(this.library.dir, 'skills', entry.name, 'SKILL.md'),
        requires: [],
        connector: entry.connector || '',
        meta: { risk: entry.risk || 'unknown', category: entry.category || '', tags: entry.tags || [], source: entry.source || '', license: entry.license || '' },
        libraryFiles: entry.files || [],
        enabled: true,
        error: '',
        needs: '',
      }));
  }

  /**
   * The skills the model may use: the installed ones, then the library's. A skill that works only
   * through a connector (skillConnector) is not among them: Uma has none, so its steps cannot run.
   */
  async enabled(root) {
    const all = await this.list(root);
    const installed = all.filter((skill) => skill.enabled && !skill.error && !skill.connector && (!skill.needs || skill.partial));
    return [...installed, ...(await this.librarySkills(new Set(all.map((skill) => skill.name)))).filter((skill) => !skill.connector)];
  }

  /**
   * The online service a request asks to act in, when the library's skill for it needs a connector:
   * { name, skill, connector }. Null without the library, or when the skill is not marked so.
   */
  async serviceFor(text) {
    const found = outsideService(text);
    if (!found || !this.library) return null;
    const { skills } = await this.library.index();
    const skill = skills.find((entry) => entry.connector && (entry.name === `${found.start}-automation` || entry.name.startsWith(`${found.start}-`)));
    return skill ? { name: found.name, skill: skill.name, connector: skill.connector } : null;
  }

  /** The connector a skill of that name needs, installed or in the library; '' when it needs none. */
  async connectorOf(name, root) {
    const wanted = String(name || '').trim();
    const installed = (await this.list(root)).find((skill) => skill.name === wanted);
    if (installed) return installed.connector || '';
    return (await this.library?.get(wanted))?.connector || '';
  }

  async load(name, root) {
    const skills = await this.enabled(root);
    const wanted = String(name || '').trim();
    let skill = skills.find((item) => item.name === wanted);
    if (skill?.source === 'library' && !skill.body) {
      // A library skill's instructions, read from the library when it is used.
      const parsed = parseSkill(await fsp.readFile(skill.path, 'utf8'));
      if (parsed.error) throw new Error(`The skill "${wanted}" could not be read: ${parsed.error}`);
      const needs = missingPermission(parsed.requires || [], this.store.getSettings());
      const partial = worksInPart(parsed.requires || [], this.store.getSettings());
      if (needs && !partial) throw new Error(`The skill "${wanted}" needs ${needs}, which is off. Tell the user they can turn it on in Settings.`);
      skill = { ...skill, needs, partial, body: parsed.body, bodyLine: parsed.bodyLine || 1, requires: parsed.requires || [], meta: { ...skill.meta, ...parsed.meta, risk: skill.meta.risk } };
    }
    if (!skill) {
      const connector = await this.connectorOf(wanted, root);
      if (connector) throw new Error(`The skill "${wanted}" cannot be used here: it works only through ${connector === 'mcp' ? 'a connector (an MCP server)' : `the ${connectorName(connector)} connector`}, a service of other assistants that gives them extra tools. Uma has no connectors, so none of its steps can be run. Tell the user that, in one sentence, and then do what they asked with your own tools if you can.`);
      // With a large library installed, the whole list would not fit in the reply.
      const close = skills.length > 30 ? rankSkills(skills, wanted.replace(/-/g, ' '), 8).map((entry) => entry.skill) : skills;
      const label = skills.length > 30 ? 'Closest skills' : 'Available skills';
      throw new Error(`There is no skill called "${name}". ${label}: ${close.map((item) => item.name).join(', ') || 'none'}.`);
    }
    return skill;
  }

  /** The other files of a skill (references, scripts, templates), as paths inside its folder. */
  async files(skill) {
    // The library lists each skill's files, so nothing inside the app archive has to be listed.
    if (skill.source === 'library') return (skill.libraryFiles || []).map((file) => ({ path: file.path, size: file.size || 0 }));
    const found = [];
    const walk = async (dir, depth, prefix) => {
      if (depth > MAX_SKILL_DEPTH || found.length >= MAX_SKILL_FILES) return;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (found.length >= MAX_SKILL_FILES) return;
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), depth + 1, relative);
        } else if (entry.isFile() && relative !== 'SKILL.md') {
          const stat = await fsp.stat(path.join(dir, entry.name)).catch(() => null);
          found.push({ path: relative, size: stat?.size || 0 });
        }
      }
    };
    await walk(skill.dir, 0, '');
    return found;
  }

  /**
   * Reads part of one file of a skill. The path is confined to the skill's own folder the same way
   * a workspace confines paths, so a skill cannot be used to read anything else on the PC.
   */
  async readFile(name, relative, root, options = {}) {
    const skill = await this.load(name, root);
    const { Workspace } = require('./workspace.cjs');
    const folder = new Workspace({ root: skill.dir, trash: null });
    await folder.init();
    const file = await folder.readFileRange(String(relative || 'SKILL.md'), options);
    return { skill, file };
  }

  async create({ name, description, scope = 'global', root }) {
    const clean = String(name || '').trim().toLowerCase();
    if (!NAME_RE.test(clean)) throw new Error('Use lowercase letters, numbers, and hyphens for the skill name, like fix-build-errors.');
    const summary = String(description || '').replace(/\s+/g, ' ').trim();
    if (!summary) throw new Error('Describe when the model should use this skill.');
    if (scope === 'project' && !root) throw new Error('Choose a workspace folder first.');
    const dir = path.join(scope === 'project' ? this.projectDir(root) : this.globalDir, clean);
    const file = path.join(dir, 'SKILL.md');
    if (await fsp.stat(file).catch(() => null)) throw new Error(`A skill called "${clean}" already exists there.`);
    await ensureDir(dir);
    await fsp.writeFile(file, `---\nname: ${clean}\ndescription: ${summary}\n---\n\n# ${clean}\n\nWrite the steps for the model here, as a short numbered list. Exact commands work best.\n\n1. First step\n2. Second step\n`, 'utf8');
    this.invalidate();
    return { name: clean, path: file };
  }

  /** Removes a skill from the shared folder (to the Recycle Bin when one is available). */
  async remove(name) {
    const clean = String(name || '');
    if (!NAME_RE.test(clean)) throw new Error('That skill no longer exists.');
    const dir = path.join(this.globalDir, clean);
    const stat = await fsp.lstat(dir).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('Only skills in the shared folder can be removed here. Delete a project skill from the project\'s .uma/skills folder.');
    if (this.trash) await this.trash(dir);
    else await fsp.rm(dir, { recursive: true, force: true });
    // A starter skill that was removed must not come back with the next update.
    const settings = this.store.getSettings();
    await this.store.updateSettings({
      seededSkills: [...new Set([...(settings.seededSkills || []), clean])],
      disabledSkills: (settings.disabledSkills || []).filter((item) => item !== clean),
    });
    this.invalidate();
  }

  /**
   * Copies each starter skill into the shared folder once, so it can be edited or deleted.
   * A new app version can add skills, and one the user deleted is never brought back.
   */
  async seed() {
    if (!this.bundledDir) return;
    const settings = this.store.getSettings();
    const seeded = new Set(settings.seededSkills || []);
    // 0.1.29 recorded a single flag, and shipped these two.
    if (settings.skillsSeeded) ['cpp-cmake-project', 'website-restyle'].forEach((name) => seeded.add(name));
    const entries = await fsp.readdir(this.bundledDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || seeded.has(entry.name)) continue;
      const target = path.join(this.globalDir, entry.name, 'SKILL.md');
      if (!(await fsp.stat(target).catch(() => null))) {
        await ensureDir(path.dirname(target));
        // Read and write rather than copy: the source may be inside the packaged app archive.
        await fsp.writeFile(target, await fsp.readFile(path.join(this.bundledDir, entry.name, 'SKILL.md')));
      }
      seeded.add(entry.name);
    }
    await this.store.updateSettings({ seededSkills: [...seeded] });
    this.invalidate();
  }
}

module.exports = { SkillStore, skillConnector, connectorName, outsideService, parseSkill, parseHeader, rankSkills, isStrongMatch, worthAsking, clearSkillChoice, fitSkillBody, keywords, NAME_RE };
