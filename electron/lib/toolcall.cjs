// Parsing and constraining the tool calls local models produce.
// Small models rarely follow the requested format exactly, so the parser accepts
// the shapes they actually emit, and llama.cpp grammar mode can force a valid one.

const TOOL_NAMES = new Set([
  'list_files', 'read_file', 'file_info', 'write_file', 'append_file', 'replace_in_file',
  'create_folder', 'move_file', 'delete_file', 'search_files', 'run_command', 'check_environment', 'web_search', 'fetch_url', 'load_skill', 'read_skill_file', 'remember', 'look_at_screen', 'look_at_page',
  'mouse', 'keyboard', 'focus_window', 'wait', 'find_on_screen', 'click_text',
]);

const NAME_ALTERNATION = [...TOOL_NAMES].join('|');
const EXPLICIT_MARKER = /```(?:tool_call|tool)\b|<tool_call>|<\|python_tag\|>|\[TOOL_CALLS\]/gi;
const STREAM_STOP = new RegExp(
  '```(?:tool_call|tool)\\b|<tool_call>|<function=|<\\|python_tag\\|>|\\[TOOL_CALLS\\]'
  + '|```(?:json)?\\s*\\{\\s*"(?:name|tool|function)"'
  + '|(?:^|\\n)[ \\t]*\\{\\s*"(?:name|tool|function|tool_call)"\\s*:'
  + `|(?:^|\\n)[ \\t]*(?:${NAME_ALTERNATION})\\s*\\(?\\s*\\{`,
);

const PATH = { type: 'string' };
const TOOL_ARGUMENTS = {
  list_files: { properties: { path: PATH }, required: ['path'] },
  read_file: { properties: { path: PATH, start_line: { type: 'integer' }, max_lines: { type: 'integer' } }, required: ['path'] },
  file_info: { properties: { path: PATH }, required: ['path'] },
  search_files: { properties: { query: { type: 'string' }, path: PATH }, required: ['query'] },
  write_file: { properties: { path: PATH, content: { type: 'string' } }, required: ['path', 'content'] },
  append_file: { properties: { path: PATH, content: { type: 'string' } }, required: ['path', 'content'] },
  replace_in_file: {
    properties: { path: PATH, find: { type: 'string' }, replace: { type: 'string' }, all: { type: 'boolean' } },
    required: ['path', 'find', 'replace'],
  },
  create_folder: { properties: { path: PATH }, required: ['path'] },
  move_file: { properties: { from: PATH, to: PATH }, required: ['from', 'to'] },
  delete_file: { properties: { path: PATH }, required: ['path'] },
  run_command: { properties: { command: { type: 'string' }, cwd: PATH, timeout_seconds: { type: 'integer' } }, required: ['command'] },
  check_environment: { properties: {}, required: [] },
  web_search: { properties: { query: { type: 'string' } }, required: ['query'] },
  fetch_url: { properties: { url: { type: 'string' } }, required: ['url'] },
  read_skill_file: { properties: { name: { type: 'string' }, path: PATH, start_line: { type: 'integer' } }, required: ['name', 'path'] },
  remember: { properties: { text: { type: 'string' } }, required: ['text'] },
  look_at_screen: { properties: { window: { type: 'string' } }, required: [] },
  look_at_page: { properties: { path: PATH, url: { type: 'string' } }, required: [] },
  mouse: {
    properties: {
      action: { enum: ['click', 'double_click', 'right_click', 'middle_click', 'move', 'scroll', 'drag'] },
      x: { type: 'integer' }, y: { type: 'integer' }, to_x: { type: 'integer' }, to_y: { type: 'integer' }, amount: { type: 'integer' }, direction: { enum: ['down', 'up'] },
    },
    required: ['action'],
  },
  keyboard: { properties: { text: { type: 'string' }, keys: { type: 'string' } }, required: [] },
  focus_window: { properties: { window: { type: 'string' } }, required: ['window'] },
  find_on_screen: { properties: { text: { type: 'string' }, window: { type: 'string' } }, required: [] },
  click_text: { properties: { text: { type: 'string' }, window: { type: 'string' } }, required: ['text'] },
  wait: { properties: { seconds: { type: 'number' } }, required: ['seconds'] },
};
const INPUT_TOOLS = ['mouse', 'keyboard', 'focus_window', 'wait', 'click_text'];

const INSPECT_TOOLS = ['list_files', 'search_files', 'read_file', 'file_info'];
const EDIT_TOOLS = ['write_file', 'append_file', 'replace_in_file'];

function allowedTools(settings, skillNames = [], { vision = false } = {}) {
  const names = [...INSPECT_TOOLS, 'check_environment'];
  if (skillNames.length) names.push('load_skill', 'read_skill_file');
  if (settings.allowEdits) names.push(...EDIT_TOOLS, 'create_folder', 'move_file');
  if (settings.allowDelete) names.push('delete_file');
  if (settings.allowShell) names.push('run_command');
  if (settings.allowInternet) names.push('web_search', 'fetch_url');
  if (settings.useMemory !== false) names.push('remember');
  // Only a model with a vision file can use a picture. The screen needs the user's permission;
  // a page of the project is drawn in a hidden window and shows nothing private.
  if (vision) names.push('look_at_page');
  if (vision && settings.allowScreen) names.push('look_at_screen');
  // The mouse and keyboard need the user's permission. Clicking by position needs a model that can
  // see the screen; the keyboard does not.
  if (settings.allowInput) {
    if (vision && settings.allowScreen) names.push('mouse');
    // Finding and clicking things by their name needs no sight: it reads the window's own items.
    names.push('keyboard', 'focus_window', 'wait', 'find_on_screen', 'click_text');
  }
  return names;
}

/** A JSON schema that llama.cpp compiles to a grammar, so the reply must be a valid call. */
function toolCallSchema(names, skillNames = []) {
  const argumentsFor = (name) => (name === 'load_skill'
    ? { properties: { name: { enum: skillNames } }, required: ['name'] }
    : TOOL_ARGUMENTS[name]);
  return {
    anyOf: names.map((name) => ({
      type: 'object',
      properties: {
        name: { const: name },
        arguments: { type: 'object', additionalProperties: false, ...argumentsFor(name) },
      },
      required: ['name', 'arguments'],
      additionalProperties: false,
    })),
  };
}

function stripThink(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    // Some chat templates open the thinking block themselves, so only its end reaches the text.
    .replace(/^[\s\S]*<\/think>/i, '')
    .trimStart();
}

/** Index just past the JSON value starting at `start`, or -1 if it never closes. */
function balancedEnd(text, start) {
  const stack = [];
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      stack.pop();
      if (!stack.length) return index + 1;
    }
  }
  return -1;
}

/** Escape raw newlines, stray backslashes (C:\foo), and unescaped quotes inside JSON strings. */
function repairJson(text) {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
    } else if (char === '\\') {
      const next = text[index + 1];
      if (next !== undefined && '"\\/bfnrtu'.includes(next)) {
        out += char + next;
        index += 1;
      } else {
        out += '\\\\';
      }
    } else if (char === '"') {
      // A real closing quote is followed by JSON structure. Anything else is an unescaped inner quote.
      const next = text.slice(index + 1).match(/\S/)?.[0];
      if (next === undefined || ',}]:'.includes(next)) {
        inString = false;
        out += char;
      } else {
        out += '\\"';
      }
    } else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else out += char;
  }
  return out;
}

function parseLoose(text) {
  try {
    return JSON.parse(text);
  } catch {}
  try {
    // Some models escape the key's own quotes: {"command\":\"dir"}.
    const keysFixed = text.replace(/([{,]\s*"\w+)\\"\s*:\s*\\"/g, '$1":"');
    return JSON.parse(repairJson(keysFixed));
  } catch {
    return undefined;
  }
}

const ESCAPE_LETTERS = { '\b': 'b', '\f': 'f', '\t': 't', '\n': 'n', '\r': 'r' };

/**
 * A model writing "C:\tools\build" in JSON produces a tab and a backspace, because \t and \b are
 * valid escapes. No path contains control characters, so turn them back into what was meant.
 */
function restorePathEscapes(args) {
  const fixed = { ...args };
  for (const key of ['path', 'from', 'to', 'cwd']) {
    if (typeof fixed[key] === 'string') {
      fixed[key] = fixed[key].replace(/[\b\f\t\n\r]/g, (char) => `\\${ESCAPE_LETTERS[char]}`);
    }
  }
  if (typeof fixed.command === 'string') {
    let command = fixed.command.replace(/[\b\f\t]/g, (char) => `\\${ESCAPE_LETTERS[char]}`);
    // Commands can be multi-line, so a line break only counts when it splits a path: C:\new or .\run.
    const splitPath = /((?:[:\\][^\s"']*)|(?:^|\s)\.)([\n\r])(?=[\w.-])/;
    while (splitPath.test(command)) {
      command = command.replace(splitPath, (_match, before, char) => `${before}\\${ESCAPE_LETTERS[char]}`);
    }
    fixed.command = command;
  }
  return fixed;
}

function normalizeCall(value) {
  if (Array.isArray(value)) return normalizeCall(value[0]);
  if (!value || typeof value !== 'object') return null;
  const nested = value.tool_call || value.function_call || (typeof value.function === 'object' ? value.function : null);
  if (nested) return normalizeCall(nested);
  let name = value.name || value.tool || value.tool_name || value.function_name
    || (typeof value.function === 'string' ? value.function : '');
  let args = value.arguments ?? value.args ?? value.parameters ?? value.input;
  if (!name) {
    const keys = Object.keys(value);
    if (keys.length === 1 && TOOL_NAMES.has(keys[0])) {
      [name] = keys;
      args = value[name];
    }
  }
  if (!TOOL_NAMES.has(name)) return null;
  if (args === undefined) {
    const { name: _n, tool: _t, tool_name: _tn, function_name: _fn, function: _f, ...rest } = value;
    args = rest;
  }
  if (typeof args === 'string') args = parseLoose(args);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { name, args: restorePathEscapes(args) };
}

/**
 * Parse a call beginning at `from`: JSON, or the docs' `name {json}` form.
 * Odd stray quotes defeat the bracket scan, so when `complete` the text up to the
 * closing fence or tag is tried as well. A reply cut off by the token limit is not complete.
 */
function callAt(text, from, complete) {
  const window = text.slice(from, from + 200);
  const named = window.match(new RegExp(`^\\s*(${NAME_ALTERNATION})\\s*\\(?\\s*(?=\\{)`));
  const lead = named ? named[0].length : (window.match(/^\s*/)[0].length);
  const start = from + lead;
  if (text[start] !== '{' && text[start] !== '[') return null;
  const candidates = [];
  const end = balancedEnd(text, start);
  if (end > 0) candidates.push(text.slice(start, end));
  if (complete) {
    const closers = [text.indexOf('```', start), text.lastIndexOf('```'), text.indexOf('</tool_call>', start), text.length];
    for (const closer of closers) {
      const body = closer > start ? text.slice(start, closer) : '';
      const last = body.lastIndexOf('}');
      if (last > 0) candidates.push(body.slice(0, last + 1));
    }
  }
  for (const candidate of new Set(candidates)) {
    const parsed = parseLoose(candidate);
    if (parsed === undefined) continue;
    const call = named ? normalizeCall({ name: named[1], arguments: parsed }) : normalizeCall(parsed);
    if (call) return call;
  }
  return null;
}

function blankForeignFences(text) {
  return text.replace(/```([\w+-]*)[^\n]*\n[\s\S]*?```/g, (block, language) => (
    /^(tool|tool_call|json)?$/i.test(language) ? block : ' '.repeat(block.length)
  ));
}

function extractToolCall(rawText, { complete = true } = {}) {
  const text = stripThink(rawText);
  const finish = (call, at) => ({ ...call, cleanText: text.slice(0, at).trim() });

  for (const marker of text.matchAll(EXPLICIT_MARKER)) {
    const call = callAt(text, marker.index + marker[0].length, complete);
    if (call) return finish(call, marker.index);
  }

  const fnTag = text.match(/<function=([\w-]+)>\s*/i);
  if (fnTag && TOOL_NAMES.has(fnTag[1])) {
    const from = fnTag.index + fnTag[0].length;
    const end = text[from] === '{' ? balancedEnd(text, from) : -1;
    const parsed = end > 0 ? parseLoose(text.slice(from, end)) : undefined;
    if (parsed !== undefined) {
      const call = normalizeCall({ name: fnTag[1], arguments: parsed });
      if (call) return finish(call, fnTag.index);
    }
  }

  for (const fence of text.matchAll(/```(?:json)?[ \t]*\r?\n?/gi)) {
    const call = callAt(text, fence.index + fence[0].length, complete);
    if (call) return finish(call, fence.index);
  }

  // Unfenced JSON at the start of a line. Calls shown inside other code blocks do not count.
  const visible = blankForeignFences(text);
  const bare = new RegExp(`^[ \\t]*(?:\\{|\\[\\s*\\{|(?:${NAME_ALTERNATION})\\s*\\(?\\s*\\{)`, 'gm');
  for (const line of visible.matchAll(bare)) {
    const call = callAt(text, line.index, complete);
    if (call) return finish(call, line.index);
  }
  return null;
}

/** True when the text began a tool call that could not be parsed (usually truncated). */
function hasToolAttempt(rawText) {
  const text = stripThink(rawText);
  if (/```(?:tool_call|tool)\b|<tool_call>|<\|python_tag\|>|\[TOOL_CALLS\]/i.test(text)) return true;
  const visible = blankForeignFences(text);
  return new RegExp(`^[ \\t]*\\{\\s*"(?:name|tool)"\\s*:\\s*"(?:${NAME_ALTERNATION})"`, 'm').test(visible);
}

const HOLDBACK = 64;

/**
 * Streams visible text while hiding tool JSON and routing inline <think> blocks to reasoning.
 * A soft match (ordinary JSON that merely looks like a call) is released if no call is found.
 */
class StreamFilter {
  constructor(onText, onReasoning = () => {}) {
    this.onText = onText;
    this.onReasoning = onReasoning;
    this.buffer = '';
    this.blocked = false;
    this.inThink = false;
  }

  push(delta) {
    this.buffer += delta;
    while (true) {
      if (this.blocked) return;
      if (this.inThink) {
        const close = this.buffer.indexOf('</think>');
        if (close < 0) {
          const safe = this.buffer.slice(0, -8);
          if (safe) this.onReasoning(safe);
          this.buffer = this.buffer.slice(safe.length);
          return;
        }
        if (close > 0) this.onReasoning(this.buffer.slice(0, close));
        this.buffer = this.buffer.slice(close + 8);
        this.inThink = false;
        continue;
      }
      const think = this.buffer.indexOf('<think>');
      const stop = this.buffer.search(STREAM_STOP);
      if (think >= 0 && (stop < 0 || think < stop)) {
        if (think > 0) this.onText(this.buffer.slice(0, think));
        this.buffer = this.buffer.slice(think + 7);
        this.inThink = true;
        continue;
      }
      if (stop >= 0) {
        if (stop > 0) this.onText(this.buffer.slice(0, stop));
        this.buffer = this.buffer.slice(stop);
        this.blocked = true;
        return;
      }
      if (this.buffer.length > HOLDBACK) {
        this.onText(this.buffer.slice(0, -HOLDBACK));
        this.buffer = this.buffer.slice(-HOLDBACK);
      }
      return;
    }
  }

  flush() {
    if (this.blocked) return;
    if (this.buffer) (this.inThink ? this.onReasoning : this.onText)(this.buffer);
    this.buffer = '';
  }

  release() {
    if (this.blocked && this.buffer) this.onText(this.buffer);
    this.blocked = false;
    this.buffer = '';
  }
}

module.exports = {
  TOOL_NAMES,
  INSPECT_TOOLS,
  EDIT_TOOLS,
  allowedTools,
  toolCallSchema,
  stripThink,
  extractToolCall,
  hasToolAttempt,
  StreamFilter, INPUT_TOOLS, TOOL_ARGUMENTS,
};
