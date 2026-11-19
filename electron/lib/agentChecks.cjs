// How Uma reads a request and a reply: what kind of task it is, whether an answer claims something
// that did not happen, repeats itself, or shows a file it never opened. Everything here is a pattern or
// a small function with no state; the loop that uses them is AgentRunner in agent.cjs, which these
// lines were part of until it passed 2,500 lines.
const { newId, truncate } = require('./util.cjs');
const fsp = require('node:fs/promises');
const nodePath = require('node:path');
const { t } = require('./i18n.cjs');
const { englishGist, readings } = require('./gist.cjs');
const {
  INSPECT_TOOLS, EDIT_TOOLS, allowedTools, toolCallSchema, stripThink, extractToolCall, cutOffWrite, hasToolAttempt, StreamFilter, INPUT_TOOLS, TOOL_ARGUMENTS,
} = require('./toolcall.cjs');

const MUTATING_TOOLS = ['write_file', 'append_file', 'replace_in_file', 'create_folder', 'move_file', 'delete_file', 'run_command', 'save_document'];
const LARGE_FILE_BYTES = 2 * 1024 * 1024;
// Streamed text is sent to the window at most this often (about 25 times a second).
const DELTA_FLUSH_MS = 40;
// More created or deleted files than this are not listed one by one: the prompt's file index is rewritten.
const MAX_LISTED_CHANGES = 40;
// When a task's messages reach the context limit they are shrunk to this share of it (see fitMessages).
const FIT_HEADROOM = 0.65;

// "did you fix…?", "what does this do?": a question that asks to know, not to change. ("could you add…?" asks for work.)
const ASKS_ONLY_RE = /^\s*(did|has|have|had|was|were|is|are|does|do|what|why|when|where|who|which|how)\b/i;
const POLITE_REQUEST_RE = /\b(please|can you|could you|would you|will you|i want|i need|go ahead)\b/i;
// The tools that change files: not used to answer a plain question.
const FILE_CHANGE_TOOLS = ['write_file', 'append_file', 'replace_in_file', 'create_folder', 'move_file', 'delete_file', 'save_document'];
// The user asks for a file, a folder or a save, or names one: then a reply may write files.
const FILE_REQUEST_RE = /\b(?:files?|folders?|directory|save|saved|salva|salvare|file di testo|documents?|pdf|docx|word (?:file|doc)|write (?:it|them|this) (?:to|in|into)|put (?:it|them|this) (?:in|into)|export|scarica|download)\b|[\w-]+\.[a-z][a-z0-9]{0,4}\b|[\\/]\w/i;
// "yes", "ok do it", "sì": an answer to the offer in the previous reply.
const AGREES_RE = /^\s*(?:yes|yeah|yep|ok(?:ay)?|sure|go ahead|do it|please do|s[iì]|certo|va bene|vai|procedi|fallo)\b[\s,.!]*(?:please|thanks|grazie|do it|go ahead|fallo|vai)?[\s.!]*$/i;
// Tools that work on the user's files (reading or changing them).
const FILE_WORK_TOOLS = ['list_files', 'read_file', 'search_files', 'file_info', 'write_file', 'append_file', 'replace_in_file', 'create_folder', 'move_file', 'delete_file', 'save_document'];
// A request about something on the internet rather than the user's files.
const WEB_LOOKUP_RE = /\b(?:google|online|internet|on the web|web search|search (?:for|the web)|their (?:web ?site|site|page|address)|(?:official|company'?s?) (?:web ?site|site)|look (?:it )?up)\b/i;
// "Would you like me to build it?": the reply asks the user before doing something.
const OFFERS_RE = /(?:would you like me to|do you want me to|shall i|should i|want me to|vuoi che|devo)\b[^?]{0,300}\?|(?:just tell me|let me know) (?:what|which|if|whether)[^.\n]{0,120}(?:\.|$)/i;
// Installing software on the PC. Only when the user asks for it: a model told to open Gmail in Brave
// tried "winget install Brave", with Brave already installed and commands set to run unasked.
const SYSTEM_INSTALL_RE = /\b(?:winget|choco|scoop)\s+(?:install|upgrade|add)\b|\bmsiexec\b|\bAdd-AppxPackage\b|\bInstall-(?:Package|Module|Script)\b|\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\b[^\n]*\s(?:-g|--global)\b|\bbrew\s+install\b|\bapt(?:-get)?\s+install\b/i;
const ASKS_INSTALL_RE = /\b(?:install|installa|setup|set up|download|scarica|update|upgrade|aggiorna|winget|choco|scoop|brew|apt)\b/i;
const CONTINUE_RE = /^\s*(continue|keep going|go on|finish|proceed|resume|retry|try again)\b/i;
const ACTION_RE = /\b(analy[sz]e|review|fix|debug|patch|refactor|build|implement|audit|update|make|create|add|change|optimi[sz]e|rewrite|rebuild|redesign|edit|improve|clean|rename|remove|delete|inspect|explain|summari[sz]e|find|check|look|read|list|write|style|map|search|organi[sz]e|tidy|commit|test|compile|restyle|document)\b/i;
const EDIT_RE = /\b(fix|patch|refactor|build|implement|update|make|create|add|change|optimi[sz]e|rewrite|rebuild|redesign|edit|improve|clean|rename|remove|delete|write|style|restyle|compile|document)\b/i;
const QUESTION_RE = /^\s*(how|what|why|when|where|who|which|is|are|does|do|did|has|have|had|was|were|should|could|would)\b/i;
const SKILL_HINT_RE = /\b(web|online|internet|look up|latest)\b/i;
const WEB_REQUEST_RE = /\b(search|look|find|check|browse)\b.*\b(web|online|internet)\b|\blook up\b|\bgoogle\b/i;
// A request to be told something, with no word that asks for a change: "run test.js and tell me
// what it prints", "what does calc.js do?".
// A question at the start is task.asksOnly; this is the same asked in the middle of a sentence.
const REPORT_ONLY_RE = /\b(?:tell me|show me|let me know)\b/i;
const SAVE_REQUEST_RE = /\b(?:save|store|export|put (?:it|them|this|that) (?:in|into)|write (?:it|them|this|that)|sav(?:a|e)|salva(?:re|lo|la)?|guarda(?:r|lo)?)\b/i;
// "run test.js", "execute the build", "esegui i test" (through its gist): something to be run.
const RUN_REQUEST_RE = /\b(?:run|execute|launch)\b[^.?!\n]{0,60}?(?:[\w-]+\.(?:js|cjs|mjs|ts|py|sh|ps1|bat|cmd|exe|rb|go|php|jar)\b|\b(?:tests?|scripts?|commands?|build|program|app|server|npm|node|python|pytest|cargo|make|it)\b)/i;
// "the test passes", "all tests passed", "it runs without errors": said of a command.
const CLAIMS_PASS_RE = /\b(?:tests? (?:now |all )?pass(?:es|ed)?\b|all (?:the )?tests? (?:have |are )?pass(?:ed|ing)?|(?:it|the (?:test|script|command|program|file)) (?:now )?(?:passes|runs? (?:successfully|without (?:any )?errors?)|works now)|(?:fix|it) is (?:now )?confirmed|ran successfully|exit(?:ed)? (?:with )?(?:code )?0)\b/i;
// A request for something to be done on the PC, as against a story, a joke or a question: only then
// is "I clicked the button" in the answer a claim to have done it.
const ASKS_ACTION_RE = /\b(?:click|type|press|scroll|open|play|search|go to|close|start|launch|watch|find|look|browse|navigate|select|fill|log ?in|sign ?in|show me|run|put on|turn (?:on|off|up|down)|pause|stop|skip|next|download|install|screen|mouse|keyboard|browser|youtube|video|music|song)\b/i;
const TERMINAL_OFF_RE = /\bterminal\b[^.\n]{0,60}\b(?:off|disabled|not (?:enabled|available|allowed|on))\b|\b(?:enable|turn on|allow)\b[^.\n]{0,40}\bterminal\b/i;
const INTERNET_OFF_RE = /\b(?:internet|web)\b[^.\n]{0,60}\b(?:off|disabled|not (?:enabled|available|allowed|on))\b|\b(?:enable|turn on|allow)\b[^.\n]{0,40}\binternet\b|\b(?:cannot|can't|can not|unable to)\b[^.\n]{0,30}\b(?:search|browse|access)\b[^.\n]{0,20}\b(?:web|internet|online)\b/i;
const WORKSPACE_RE = /\b(files?|folders?|pdf|docx|documents?|word (?:file|doc)|director(?:y|ies)|code|codebase|source|projects?|repo|repository|git|commits?|workspace|website|site|web ?pages?|pages?|apps?|application|program|scripts?|functions?|methods?|class(?:es)?|modules?|components?|bugs?|crash(?:es)?|errors?|readme|exe|compile|css|html|javascript|typescript|python|stylesheet)\b|[\w-]+\.[a-z][a-z0-9]{0,4}\b|[\\/]\w/i;
const OWNED_RE = /\b(this|my|our|the (?:project|code|repo|app|site|website|workspace|file|folder))\b/i;
const HYPOTHETICAL_RE = /^\s*(if (?:i|we)\b|what if\b|(?:are|would) you able\b|(?:is|would) it (?:be )?possible\b|do you (?:know|think)\b)/i;
const ASKS_ABILITY_RE = /^\s*(can|could|would|will) you\b[^.!]*\?\s*$/i;
const NAMED_FILE_RE = /[\w-]+\.[a-z][a-z0-9]{0,4}\b|[\\/]\w/i;
const FOLLOW_UP_RE = /\b(this|that|it|them|these|those)\b/i;
const LONG_CODE_BLOCK_RE = /```[^\n]*\n(?:[^\n]*\n){14}/;
// A report that what the work produced does not behave ("I still can't see the list"). In a chat
// that has been working on files it asks for a fix, even without a file or code word in it.
const PROBLEM_RE = /\b(?:can'?t|can`t|cannot|doesn'?t|dosent|does not|don'?t|won'?t|isn'?t|not (?:working|showing|shown|visible|loading|opening|starting|updating)|still|same (?:problem|issue|error)|broken|bug|crash(?:es|ed)?|errors?|fails?|failed|wrong|missing|empty|blank|white|nothing (?:happens|shows)|look(?:s)? (?:bad|nice|wrong|ugly))\b/i;
// "The build succeeded", "has been rebuilt": only true when a command that ran said so.
const CLAIMS_BUILD_RE = /\b(?:(?:the )?build (?:succeeded|was successful|is successful|completed)|(?:has|have) been (?:rebuilt|compiled|built)|(?:compiles|builds) (?:successfully|without errors))\b/i;
// The note Uma adds to earlier replies in the history; a model sometimes starts writing one itself.
const HISTORY_NOTE_RE = /\(Tools Uma ran for this reply:[\s\S]*$|\(Uma: in this reply no file[\s\S]*$/;
// The reply says the CODE was changed ("I added…", "the fix has been compiled"): true only when a
// file was really written in this reply. Running a build does not make it true.
const CLAIMS_EDIT_RE = /\b(?:i(?:'ve| have)? (?:fixed|added|moved|changed|modified|updated|removed|replaced|rewrote|edited|created|inserted)|(?:has|have) been (?:updated|fixed|modified|changed|added|moved|created)|(?:is|are) now fixed|both issues are now fixed|(?:the |this |my )?(?:[\w-]+ ){0,3}(?:fix|change)(?:es)? (?:has|have) been (?:compiled|applied|made|added)|with the (?:[\w-]+ ){0,3}fix\b)/i;
// Folders that hold programs, not the user's work: a tool's path in a message (…\MSBuild\Current\Bin\
// MSBuild.exe) must not become the folder a chat works in.
const PROGRAM_FOLDER_RE = /^(?:[A-Za-z]:\\(?:Program Files(?: \(x86\))?|Windows|ProgramData)(?:\\|$)|\/(?:usr|bin|sbin|opt|System|Library|Applications)(?:\/|$))/i;
const PROGRAM_FILE_RE = /\.(?:exe|dll|com|msi|bat|cmd|ps1|sh|app|dylib|so)$/i;
// Web addresses in a message.
const LINK_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;
// "I can see the page is open in Brave", "the screen shows…": only true after a picture was taken.
const CLAIMS_SIGHT_RE = /\b(?:i (?:can )?see (?:the|that|your|a|an) [^.\n]{0,50}?\b(?:page|screen|window|browser|tab|desktop|site|website|screenshot|display|monitor|taskbar|interface|wallpaper)\b|here is (?:a summary of )?what i (?:can )?see\b|is open in (?:brave|chrome|edge|firefox|safari|the browser|your browser)|the (?:[\w-]+ ){0,3}(?:page|screen|window|screenshot|display|desktop) shows)\b/i;
// What a reply about the user's screen talks about: for a model that cannot see, it is invented.
const SCREEN_WORDS_RE = /\b(?:screen|display|desktop|monitor|taskbar|wallpaper|task manager|window[s]? (?:is|are) open)\b/i;
// "what do you see?", "can you see my screen?", "look at my display": a question only eyes can answer.
const ASKS_SIGHT_RE = /\b(?:what (?:do|can) you see|can you see|do you see|are you able to see|look at (?:my|the) (?:screen|display|desktop|monitor|pc)|what(?:'s| is) on (?:my|the) (?:screen|display|desktop|monitor)|see (?:my|the) (?:screen|display|desktop|monitor))\b/i;
/** Whether the user asks what is on the screen ("what do you see?" alone counts; "what do you see in this code" does not). */
function asksToSee(text) {
  // Asked in another language, it is read through its English gist.
  const value = englishGist(String(text || '').trim());
  if (!ASKS_SIGHT_RE.test(value)) return false;
  if (SCREEN_WORDS_RE.test(value)) return true;
  return value.split(/\s+/).length <= 6 && !/\b(?:in|on) (?:this|the|that|it|my) (?!screen|display|desktop|monitor)/i.test(value);
}
/** Uma's own answer when a model without a vision file is asked to look. */
function blindAnswer(model) {
  return t('I cannot see your screen: the model in use ({0}) has no vision file, so it cannot look at pictures. Anything I described about the screen would be invented. To let me see it, open Models, choose this model\'s settings and use Download vision file, or switch to a model that can see (for example Qwen3.8, Qwen3.5 or Gemma 3). Until then, tell me what you see and I will help from that.', [model.name]);
}

/**
 * The name of a file whose "contents" the text shows in a code block, when the block is not what
 * the file holds and no tool has touched the file in this reply. A real model, asked to run test.js,
 * began with "Here is the content of test.js:" and thirty lines it had made up, and they stayed in
 * the answer. The block is compared with the file itself, so the check reads no language: a real
 * quote, or a version with a few lines changed, shares most of its lines with the file.
 * `touched` is the text of the tool calls so far: a file a tool read, ran or wrote is left alone
 * (the block may then be a command's output, or the new version being saved).
 */
async function inventedListing(text, workspace, touched = '') {
  const fence = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let match;
  while ((match = fence.exec(String(text || '')))) {
    const lines = match[1].split('\n').map((line) => line.trim()).filter((line) => line.length >= 4);
    if (lines.length < 5) continue;
    const name = (text.slice(Math.max(0, match.index - 160), match.index).match(/[\w./\\-]+\.[A-Za-z0-9]{1,8}(?![\w])/g) || []).at(-1);
    if (!name || touched.includes(name.split(/[\\/]/).at(-1))) continue;
    try {
      const file = await workspace.resolve(name.replace(/\\/g, '/'));
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > 400000) continue;
      const held = new Set((await fsp.readFile(file, 'utf8')).split('\n').map((line) => line.trim()));
      if (lines.filter((line) => held.has(line)).length < lines.length * 0.2) return name;
    } catch {
      // Not a file of the workspace: nothing to compare with.
    }
  }
  return '';
}

// The file extensions a code block of each language may be saved under.
const FENCE_EXTENSIONS = {
  html: ['html', 'htm'], xml: ['xml', 'svg', 'html'], svg: ['svg'], css: ['css'], scss: ['scss'],
  javascript: ['js', 'mjs', 'cjs', 'jsx'], js: ['js', 'mjs', 'cjs', 'jsx'], jsx: ['jsx', 'js'], typescript: ['ts', 'tsx'], ts: ['ts', 'tsx'], tsx: ['tsx'],
  python: ['py'], py: ['py'], json: ['json'], yaml: ['yml', 'yaml'], yml: ['yml', 'yaml'], markdown: ['md'], md: ['md'],
  c: ['c', 'h'], cpp: ['cpp', 'cc', 'cxx', 'h', 'hpp'], 'c++': ['cpp', 'cc', 'cxx', 'h', 'hpp'], csharp: ['cs'], cs: ['cs'], java: ['java'], go: ['go'], rust: ['rs'], rs: ['rs'],
  php: ['php'], ruby: ['rb'], rb: ['rb'], sql: ['sql'], bash: ['sh'], sh: ['sh'], shell: ['sh'], powershell: ['ps1'], ps1: ['ps1'], batch: ['bat', 'cmd'], bat: ['bat', 'cmd'], toml: ['toml'], ini: ['ini'],
};
const FILE_NAME_RE = /(?<![\w./\\-])[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?![\w])/g;
const SAVABLE_NAME_RE = /\.(?:html?|css|js|ts|py|json|md|txt|c|cpp|h|cs|java|go|rs|php|rb|sql|sh|ps1|bat|xml|svg|ya?ml|toml|ini)$/i;

/**
 * A new file that the model pasted into the chat instead of saving: { path, content, before,
 * closed }, or null. Asked for faq.html, a real model wrote the whole page into the chat, used up
 * the reply, and then had to write all of it a second time as a tool call, with 8,000 characters of
 * HTML left in the answer. When it is plain which file the code is, Uma saves it as that file itself.
 * That is plain when the reply has one long code block (short ones beside it, such as the command
 * to open the page, do not count) and the request names one file of the block's language (or,
 * failing that, the words just before the block do), or the block is a whole HTML document and no
 * name is given anywhere (index.html). `exists` says whether a path is already in the workspace:
 * a file that is there is never replaced this way.
 */
async function pastedFile(text, request, { cut = false, exists = async () => false } = {}) {
  const value = String(text || '');
  // Every code block of the reply: where it starts, its language, its text, and whether it ends.
  const blocks = [];
  const fence = /^```([\w+#-]*)[^\n]*\n/gm;
  let open;
  while ((open = fence.exec(value))) {
    const start = open.index + open[0].length;
    const end = value.indexOf('\n```', start - 1);
    blocks.push({ at: open.index, language: open[1].toLowerCase(), text: end >= 0 ? value.slice(start, Math.max(start, end)) : value.slice(start), closed: end >= 0 });
    if (end < 0) break;
    fence.lastIndex = end + 4;
  }
  const size = (block) => block.text.split('\n').filter((line) => line.trim()).length;
  const long = blocks.filter((block) => size(block) >= 15);
  if (long.length !== 1 || blocks.some((block) => block !== long[0] && size(block) > 5)) return null;
  const [block] = long;
  // A block with no end is the file only when the end of the reply cut it off.
  if (!block.closed && !cut) return null;
  const content = block.closed ? `${block.text}\n` : block.text.slice(0, block.text.lastIndexOf('\n') + 1);
  const allowed = FENCE_EXTENSIONS[block.language] || null;
  const fits = (name) => (allowed ? allowed.includes(name.split('.').at(-1).toLowerCase()) : SAVABLE_NAME_RE.test(name));
  const named = (source) => [...new Set(String(source || '').match(FILE_NAME_RE) || [])].filter(fits);
  let names = named(request);
  if (names.length !== 1) names = named(value.slice(Math.max(0, block.at - 200), block.at));
  if (!names.length && /^\s*(?:<!doctype html|<html[\s>])/i.test(content) && (!block.language || block.language === 'html')) names = ['index.html'];
  if (names.length !== 1 || await exists(names[0])) return null;
  return { path: names[0], content, before: value.slice(0, block.at).trim(), closed: block.closed };
}

/** Links the user gave earlier in the chat that the new message does not repeat (newest first, at most 4). */
function earlierLinks(conversation, userMessage) {
  const now = new Set((String(userMessage.content || '').match(LINK_RE) || []).map((link) => link.replace(/[.,;:!?]+$/, '')));
  const found = [];
  for (const message of [...conversation.messages].reverse()) {
    if (message.role !== 'user' || message.id === userMessage.id) continue;
    for (const link of String(message.content || '').match(LINK_RE) || []) {
      const clean = link.replace(/[.,;:!?]+$/, '');
      if (!now.has(clean) && !found.includes(clean)) found.push(clean);
    }
    if (found.length >= 4) break;
  }
  return now.size ? [] : found.slice(0, 4);
}

// A GitHub repository address, and the words that make an earlier link the subject of a request.
const GITHUB_REPO_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[/?#\s]|$)/i;
const COMPARE_RE = /\b(?:differen\w*|compar\w*|versus|vs\.?|similar\w*|same as|better than)\b/i;

/** owner/repo from a GitHub link in the message, or from an earlier link when the message compares. */
function githubRepoFor(request, links) {
  const here = String(request || '').match(GITHUB_REPO_RE);
  if (here) return { owner: here[1], repo: here[2] };
  if (!says(COMPARE_RE, request || '')) return null;
  for (const link of links) {
    const earlier = link.match(GITHUB_REPO_RE);
    if (earlier) return { owner: earlier[1], repo: earlier[2] };
  }
  return null;
}

/** The folders and files at the top of a repository, from GitHub's contents listing (JSON text). */
function repoOutline(contentsJson) {
  try {
    const entries = JSON.parse(contentsJson);
    if (!Array.isArray(entries) || !entries.length) return '';
    const names = (type) => entries.filter((entry) => (entry.type === 'dir') === (type === 'dir')).map((entry) => String(entry.name || '')).filter(Boolean);
    return [
      `Folders: ${names('dir').map((name) => `${name}/`).join(', ') || 'none'}`,
      `Files at the top: ${names('file').slice(0, 60).join(', ') || 'none'}`,
    ].join('\n');
  } catch {
    return '';
  }
}

/** A README without its HTML decoration (badges, centred logos) and empty lines. */
function plainReadme(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<\/?(?:p|div|a|span|br|h\d|picture|source|details|summary|table|tr|td|th|tbody|thead|sub|sup|kbd|b|i|em|strong|center)\b[^>]*>/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Letters and digits only, so two replies can be compared whatever their spacing. */
function sameWords(a, b) {
  const plain = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const left = plain(a);
  return left.length >= 60 && left === plain(b);
}

// The reply says it clicked, typed or pressed a key in another program. Uma has no tool for that.
// "I can't click it myself", "I have no tool to click", "I'm unable to type there".
const CANNOT_INPUT_RE = /\b(?:can(?:'|’)?t|cannot|can not|unable to|not able to|no (?:tool|way) to|don(?:'|’)t have (?:a |any )?(?:tool|way) to)\b[^.\n]{0,40}\b(?:click|type|press|scroll|control (?:the |your )?(?:mouse|keyboard|pc|computer)|use (?:the |your )?(?:mouse|keyboard))/i;
const PRETENDS_INPUT_RE = /\b(?:let me (?:click|type|press|scroll|find the search box|close (?:it|the popup))|i(?:'ll| will| am going to)? (?:click|type|press|scroll)\b|i (?:clicked|typed|pressed|scrolled)|the search box is (?:now )?focused|press(?:ing)? enter to|want me to (?:close|click))/i;

/** A line of 30 characters or more written three times in one reply: the model is going in circles. */
function repeatsItself(text) {
  const end = text.lastIndexOf('\n');
  if (end < 0) return false;
  const lines = text.slice(0, end).split('\n').map((line) => line.trim()).filter((line) => line.length >= 30);
  const last = lines[lines.length - 1];
  return Boolean(last) && lines.filter((line) => line === last).length >= 3;
}

// A short piece written over and over inside one line ("1.5-1.5-1.5-…", "256k-256k-…"): a small or
// strongly quantised model stuck in a loop. 300 characters of at least 10 copies, at the end of the text.
const LOOP_AT_END_RE = /(.{1,60}?)\1{9,}$/s;
const LOOP_RE = /(.{1,60}?)\1{9,}/gs;
/** Whether the text ends in such a loop (only the last 900 characters are looked at). */
function loopsInLine(text) {
  const match = LOOP_AT_END_RE.exec(text.slice(-900));
  return Boolean(match) && match[0].length >= 300 && match[1].trim().length > 0;
}
/** The text with each such loop shortened to three copies and "…". */
function withoutLoops(text) {
  let out = '';
  let from = 0;
  for (const match of text.matchAll(LOOP_RE)) {
    const [whole, piece] = match;
    if (match.index < from || whole.length < 300 || !piece.trim()) continue;
    // The copy the reply was cut in the middle of ("256k-256k-25") goes too.
    let end = match.index + whole.length;
    let partial = 0;
    while (partial < piece.length - 1 && text[end + partial] === piece[partial]) partial += 1;
    end += partial;
    out += `${text.slice(from, match.index)}${piece.repeat(3)}…`;
    from = end;
  }
  return out + text.slice(from);
}

/** The same text with every such line kept once, and loops inside a line cut short. */
function withoutRepeats(text) {
  const seen = new Set();
  return withoutLoops(text).split('\n').filter((line) => {
    const key = line.trim();
    if (key.length < 30) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// "I then used focus_window", "I called `fetch_url` on…": the reply names a tool as something it did.
const TOOL_NAMES_RE = Object.keys(TOOL_ARGUMENTS).map((name) => name.replace(/_/g, '[_ ]')).join('|');
const CLAIMS_TOOL_RE = new RegExp(`\\bi(?:'ve| have)?(?: then| also| first| now| just)? (?:used|called|ran|executed|invoked) (?:the )?\`?(${TOOL_NAMES_RE})\`?(?![\\w])`, 'gi');
/** The tools a reply says it used, by their names. */
function toolsClaimed(text) {
  const names = new Set();
  for (const reading of readings(text)) {
    for (const match of reading.matchAll(CLAIMS_TOOL_RE)) names.add(match[1].toLowerCase().replace(/ /g, '_'));
  }
  return [...names];
}

/**
 * Whether the text says what the pattern describes, as written or in its English gist: the patterns
 * are English, and a model answering in Italian, Spanish, Chinese or Japanese says the same things.
 */
function says(pattern, text) {
  return readings(text).some((reading) => pattern.test(reading));
}

// "If you're asking whether the bug has been fixed…", "I haven't fixed any bug": a sentence that is a
// question, a condition or a denial does not say that something was done.
const NOT_A_CLAIM_RE = /\?\s*$|\b(?:if|whether|not|never|no|nothing|cannot|can't|haven't|hasn't|didn't|wasn't|weren't|isn't|aren't|won't|would|could|should)\b|n't\b/i;
/** Whether some sentence of the text says, plainly, what the pattern describes. */
function claims(pattern, text) {
  return readings(text).some((reading) => reading.split(/(?<=[.!?])\s+|\n+/).some((sentence) => pattern.test(sentence) && !NOT_A_CLAIM_RE.test(sentence)));
}

// "electron/main.cjs does not exist", "the file is missing": a path the answer itself says is not there.
const SAYS_MISSING_RE = /\b(?:does ?n[o']?t exist|do not exist|doesn't exist|don't exist|missing|not found|no such|not present|is empty|isn't there|is not there|absent)\b/i;
/** The text of the assistant's reply before the one being written (what a "yes" answers). */
function previousReplyText(conversation, currentId) {
  const before = conversation.messages.filter((message) => message.role === 'assistant' && message.id !== currentId);
  return String(before.at(-1)?.content || '');
}

/** Whether the text names this path only to say that it is not there. */
function saysMissing(text, path) {
  const name = path.split('/').pop();
  return readings(text).some((reading) => reading.split(/(?<=[.!?])\s+|\n+/).some((sentence) => (sentence.includes(path) || sentence.includes(name)) && SAYS_MISSING_RE.test(sentence)));
}

// Words that carry the meaning of an answer, for telling whether two answers say the same thing.
function meaningWords(text) {
  return new Set((String(text || '').toLowerCase().match(/[a-z0-9_.\/-]{4,}/g) || []));
}
/**
 * Earlier answers in one reply that a later one says again (a small model concludes, looks once
 * more, and writes the same conclusion): they are folded, and only the last one is the answer.
 */
function foldRepeatedAnswers(blocks) {
  const texts = blocks.filter((block) => block.type === 'text' && block.text?.trim() && !block.unchecked);
  let folded = 0;
  for (let i = 0; i < texts.length - 1; i += 1) {
    const words = meaningWords(texts[i].text);
    if (words.size < 15) continue;
    for (const later of texts.slice(i + 1)) {
      const other = meaningWords(later.text);
      if (other.size < 15) continue;
      let shared = 0;
      for (const word of words) if (other.has(word)) shared += 1;
      if (shared / Math.min(words.size, other.size) >= 0.5) {
        texts[i].superseded = true;
        folded += 1;
        break;
      }
    }
  }
  return folded;
}

// "the video is now playing", "The task is complete": a result on the screen that only a look can confirm.
const CLAIMS_DONE_RE = /\b(?:task is (?:now )?complete|is (?:now )?playing|now playing|started playing|i (?:have )?(?:opened|played|clicked|searched|started)|(?:has|have) been (?:opened|played|started))\b/i;
const BROWSERS = { brave: 'brave', chrome: 'chrome', edge: 'msedge', firefox: 'firefox' };
/**
 * "open youtube and search for HD dubstep and play the 3rd video": the site's own search address,
 * worked out by Uma. A small model typed the words into the browser's address bar instead, which
 * searched the web, not YouTube.
 */
function siteSearch(text) {
  const value = String(text || '');
  const site = /\byou ?tube\b/i.test(value) ? 'youtube' : /\bgoogle\b/i.test(value) ? 'google' : '';
  if (!site) return null;
  const match = /\bsearch(?:\s+(?:on\s+)?(?:you ?tube|google))?\s+(?:for\s+)?["“']?(.+?)["”']?(?=\s+(?:and|then)\b|\s+(?:on|in)\s+(?:you ?tube|google|brave|chrome|edge|firefox|the browser)\b|\s*[,.!?]|$)/i.exec(value)
    // "metti su youtube la canzone still alive", "play on youtube lofi"
    || /\b(?:play|watch|put on|metti|riproduci|guarda)\s+(?:on|in|su)\s+you ?tube\s+(?:the\s+|a\s+|il\s+|lo\s+|la\s+|un[ao]?\s+)?["“']?(.+?)["”']?(?=\s+(?:and|then|e|poi)\b|\s*[,.!?]|$)/i.exec(value)
    || /\b(?:play|find|look up|watch|put on|metti|riproduci|cerca)\s+(?:some\s+)?["“']?(.+?)["”']?\s+(?:on|in|su)\s+you ?tube\b/i.exec(value)
    // "open youtube and play the best mirrors edge music video": the words after "play".
    || (site === 'youtube' ? /\b(?:play|watch|put on|find|metti|riproduci|guarda)\s+(?:me\s+)?(?:the\s+|a\s+|an\s+|some\s+|il\s+|la\s+|un[ao]?\s+)?["“']?(.+?)["”']?(?=\s+(?:and|then|e|poi)\b|\s*[,.!?]|$)/i.exec(value) : null);
  const words = match?.[1]?.trim();
  if (!words || /^(?:it|this|that|you ?tube|google)$/i.test(words)) return null;
  const query = encodeURIComponent(words).replace(/%20/g, '+');
  const url = site === 'youtube' ? `https://www.youtube.com/results?search_query=${query}` : `https://www.google.com/search?q=${query}`;
  const named = Object.keys(BROWSERS).find((name) => new RegExp(`\\b${name}\\b`, 'i').test(value));
  return { site, words, url, browser: named ? BROWSERS[named] : '' };
}
/** The note added to the request: the address, and how to open it as a tab of the open browser. */
function siteSearchNote(found, settings) {
  if (!found) return '';
  const label = found.site === 'youtube' ? 'YouTube' : 'Google';
  const open = process.platform === 'win32'
    ? `Start-Process ${found.browser ? `${found.browser} ` : ''}"${found.url}"`
    : process.platform === 'darwin' ? `open "${found.url}"` : `xdg-open "${found.url}"`;
  if (found.video) {
    const what = `Uma read the YouTube results for "${found.words}" and found the video the user wants: "${found.video.title}" (${found.video.viewsText || 'views unknown'}), ${found.video.why}. Its address is ${found.url}.`;
    if (settings.allowShell) return `[${what} Open it with run_command: ${open} — when the browser is already open this adds a new tab to it. Do not search or click through the results. Then wait 3 seconds, look at the whole screen once to check that it plays, and tell the user its title.]`;
    if (settings.allowInput) return `[${what} Open it as a new tab: focus_window {"window":"${found.browser || 'Brave'}"}, keyboard {"keys":"ctrl+t"}, keyboard {"text":"${found.url}"}, keyboard {"keys":"enter"}, wait 3 seconds, then look at the whole screen once to check that it plays, and tell the user its title.]`;
    return '';
  }
  if (settings.allowShell) {
    return `[The ${label} search address for "${found.words}" is ${found.url}. Open it with run_command: ${open} — when the browser is already open this adds a new tab to it, it does not open another window. Do not type the words into the address bar: that searches the web, not ${label}. Then wait 3 seconds; to open a result, find_on_screen reads the titles and click_text clicks one by its title.]`;
  }
  if (settings.allowInput) {
    return `[The ${label} search address for "${found.words}" is ${found.url}. Open it as a new tab: focus_window {"window":"${found.browser || 'Brave'}"}, keyboard {"keys":"ctrl+t"}, keyboard {"text":"${found.url}"}, keyboard {"keys":"enter"}, wait 3 seconds, then look at the screen.]`;
  }
  return '';
}

// "send this to their email using my gmail": the model is given Gmail's own "new message" address,
// already filled in, so it does not have to find and click the Compose button.
const EMAIL_REQUEST_RE = /\b(?:send|write|compose|reply|forward|scrivi|invia|manda|rispondi)\b[^.?!]{0,80}\b(?:e-?mails?|mail|gmail|posta)\b|\b(?:e-?mail|gmail)\b[^.?!]{0,60}\b(?:send|to|a)\b/i;
function emailNote(request, settings) {
  if (!EMAIL_REQUEST_RE.test(String(request || '')) || !(settings.allowShell || settings.allowInput)) return '';
  const browser = Object.keys(BROWSERS).find((name) => new RegExp(`\\b${name}\\b`, 'i').test(request));
  const open = settings.allowShell
    ? `run_command: Start-Process ${browser ? `${BROWSERS[browser]} ` : ''}"https://mail.google.com/mail/?view=cm&fs=1&to=ADDRESS&su=SUBJECT&body=TEXT" (it opens as a new tab of the open browser)`
    : 'focus_window on the browser, keyboard ctrl+t, type that address, enter';
  return `[To write an email in Gmail, open its new-message address with the fields filled in: https://mail.google.com/mail/?view=cm&fs=1&to=ADDRESS&su=SUBJECT&body=TEXT, each part URL-encoded (spaces as %20, a new line as %0A). Open it with ${open}. Do not install anything: the browser is already on this PC. Take the recipient and the text from this chat; if the recipient's address is not known, read their website with fetch_url: Uma lists at the top of the page the email addresses, contact forms and contact links it finds (follow a "Contatti", "Contact" or "Chi siamo" link if the first page has none). If they have no email address but a contact form, tell the user and offer to fill in the form instead: on the page, click_text on each field by its name and type into it. Never invent the user's name, phone number or email address: ask the user for any the form requires, and show them what you will send before pressing the form's send button. After opening, wait 4 seconds and look at the screen to check the message; Ctrl+Enter sends it. Say only what the screen shows.]`;
}

// "cosa ricordi di questa chat?", "what do you remember?", "riassumi la chat": a question about this
// conversation, answered from Uma's own record of it (a model replied "I have no memory between
// chats" and invented the rest).
const RECALL_RE = /\b(?:(?:che )?cosa ricordi|ti ricordi|ricordi (?:di )?(?:questa|la|quella) (?:chat|conversazione)|riassumi (?:la|questa) (?:chat|conversazione)|di cosa abbiamo parlato|cosa abbiamo fatto|what do you remember|do you remember|summari[sz]e (?:this|the|our) (?:chat|conversation)|what (?:did|have) we (?:do|done|talk(?:ed)? about|discuss(?:ed)?))\b/i;

/**
 * A short record of chat messages: each request, what Uma did (its tools) and the start of each
 * answer, oldest first, within `budget` characters (the newest are kept when it does not fit).
 */
function chatRecap(messages, budget) {
  const lines = [];
  let used = 0;
  let turn = messages.filter((message) => message.role === 'user').length;
  for (const message of [...messages].reverse()) {
    let line;
    if (message.role === 'user') {
      line = `${turn}. The user: "${truncate(String(message.content || '').replace(/\s+/g, ' ').trim(), 220)}"`;
      turn -= 1;
    } else {
      const tools = (message.blocks || []).filter((block) => block.type === 'tool' && block.status === 'done').map((block) => block.title || block.name);
      const text = String(message.content || '').replace(/^⚠ .*$/gm, '').replace(/\s+/g, ' ').trim();
      line = `   Uma${tools.length ? ` (${truncate(tools.slice(0, 6).join('; '), 240)})` : ''}: ${truncate(text, 260) || '(no text)'}`;
    }
    if (used + line.length > budget) break;
    used += line.length + 1;
    lines.unshift(line);
  }
  return lines.join('\n');
}

// The reply says it changed or built something ("I moved the call…", "The build succeeded").
const CLAIMS_CHANGE_RE = /\b(?:i(?:'ve| have)? (?:fixed|added|moved|changed|modified|updated|removed|replaced|rewrote|edited|created|rebuilt|built|compiled|inserted)|(?:has|have) been (?:rebuilt|updated|fixed|modified|changed|added|compiled|moved|created)|(?:the )?build (?:succeeded|was successful|is successful|completed)|(?:is|are) now fixed|both issues are now fixed)\b/i;
// "...Let's do that." as a reply's last sentence: the model has stopped before doing the step it named.
const ANNOUNCES_NEXT_STEP_RE = /(?:^|[.!:\n]\s*)(?:(?:now |next,? |so |first,? )?(?:let'?s|i'?ll|i will|i need to|we need to|let me(?! know)))\b[^.!?\n]*[.!:]?\s*$/i;

/**
 * Decides whether a message is about the workspace. A wrong "yes" costs one tool call;
 * a wrong "no" lets the model answer from memory, so ordinary chat must stay out.
 */
function classifyTask(original, { priorTask = '', priorUsedTools = false, attachmentNames = [] } = {}) {
  // The checks below look for English words: a request in Italian or Spanish is read through its gist.
  const text = englishGist(original);
  const isContinue = CONTINUE_RE.test(text);
  if (attachmentNames.length) {
    // The attached file is what this is about, unless the message also points at the project.
    const rest = attachmentNames.reduce((remaining, name) => remaining.split(name).join(' '), text);
    if (!/\b(project|workspace|repo|repository|codebase|folder)\b/i.test(rest) && !NAMED_FILE_RE.test(rest)) {
      return { isContinue, agentic: false, wantsEdit: false, priorTask: '' };
    }
  }
  if (isContinue) {
    const prior = priorTask ? classifyTask(priorTask) : { agentic: false, wantsEdit: false };
    return {
      isContinue,
      agentic: prior.agentic || priorUsedTools,
      wantsEdit: prior.wantsEdit,
      priorTask,
    };
  }
  // "If I give you X, can you make Y?" asks whether something is possible. Let the model answer it.
  const asksAbility = HYPOTHETICAL_RE.test(text)
    || (ASKS_ABILITY_RE.test(text) && !OWNED_RE.test(text) && !NAMED_FILE_RE.test(text));
  if (asksAbility) return { isContinue, agentic: false, wantsEdit: false, priorTask: '' };
  const question = QUESTION_RE.test(text);
  // "find their website", "search google for…": something on the internet, not the user's project.
  const webLookup = WEB_LOOKUP_RE.test(text) && !NAMED_FILE_RE.test(text) && !/\b(?:my|our)\s+(?:web ?site|site|project|app|code)\b/i.test(text);
  const about = !webLookup && (WORKSPACE_RE.test(text) || (priorUsedTools && FOLLOW_UP_RE.test(text)));
  // "What is this project?" names no action, but it can only be answered by looking.
  // In a chat that has been working on files, "fix the task manager" or "I still can't see the
  // processes" belongs to that work, though it names no file.
  const followsWork = priorUsedTools && (ACTION_RE.test(text) || PROBLEM_RE.test(text));
  // A question about a named file ("did you fix the bug in main.cpp?") is answered by looking at it.
  const agentic = (about && (question ? OWNED_RE.test(text) || NAMED_FILE_RE.test(text) : ACTION_RE.test(text))) || followsWork;
  return {
    isContinue,
    agentic,
    wantsEdit: agentic && !question && (EDIT_RE.test(text) || (priorUsedTools && PROBLEM_RE.test(text))),
    asksOnly: ASKS_ONLY_RE.test(text) && !POLITE_REQUEST_RE.test(text),
    priorTask: '',
  };
}

const READ_ONLY_COMMAND_RE = /^\s*(?:get-childitem|gci|dir|ls|get-content|gc|type|cat|test-path|get-location|pwd|get-command|get-item|resolve-path|where(?:\.exe)?|select-string|findstr|echo|write-output|winget\s+(?:search|list|show)|[\w.-]+\s+(?:--version|-v))(?:\s|$)/i;
const READ_ONLY_PIPE_RE = /^\s*(?:select-object|select|where-object|where|sort-object|sort|format-\w+|ft|fl|measure-object|out-string|findstr|select-string)(?:\s|$)/i;

/** True only for commands that clearly change nothing. Anything unrecognised counts as a change. */
function isReadOnlyCommand(command) {
  const clean = String(command).replace(/\d?>&\d|\b2>\s*(?:\$null|nul)\b/gi, ' ');
  if (clean.includes('>')) return false;
  return clean.split(/;|&&|\|\|/).every((statement) => {
    const [first, ...piped] = statement.split('|');
    return READ_ONLY_COMMAND_RE.test(first) && piped.every((part) => READ_ONLY_PIPE_RE.test(part));
  });
}

function maxOutputTokens(contextSize) {
  return Math.max(1024, Math.min(8192, Math.floor(contextSize * 0.25)));
}

function toolTitle(name, args) {
  const p = args?.path || args?.from || '';
  switch (name) {
    case 'list_files': return `Listed ${p && p !== '.' ? p : 'workspace'}`;
    case 'read_file': return `Read ${p}`;
    case 'file_info': return `Inspected ${p}`;
    case 'write_file': return `Wrote ${p}`;
    case 'save_document': return `Made ${p}`;
    case 'append_file': return `Updated ${p}`;
    case 'replace_in_file': return `Edited ${p}`;
    case 'create_folder': return `Created ${p}`;
    case 'move_file': return `Moved ${p}`;
    case 'delete_file': return `Deleted ${p}`;
    case 'search_files': return `Searched “${args?.query || ''}”`;
    case 'run_command': return `Ran ${String(args?.command || '').slice(0, 70)}`;
    case 'web_search': return `Searched the web for “${args?.query || ''}”`;
    case 'fetch_url': return `Fetched ${args?.url || ''}`;
    case 'look_at_screen': return args?.window ? `Looked at the window "${args.window}"` : 'Looked at the screen';
    case 'look_at_page': return `Looked at the page ${args?.url || p}`;
    case 'mouse': return `Mouse: ${String(args?.action || 'click').replace('_', ' ')}${args?.x !== undefined ? ` at ${args.x}, ${args.y}` : ''}`;
    case 'keyboard': return args?.text ? `Typed “${String(args.text).slice(0, 50)}”${args?.keys ? ` and pressed ${args.keys}` : ''}` : `Pressed ${args?.keys || ''}`;
    case 'focus_window': return `Brought “${args?.window || ''}” to the front`;
    case 'click_text': return `Clicked “${String(args?.text || '').slice(0, 60)}”`;
    case 'find_on_screen': return args?.text ? `Looked for “${String(args.text).slice(0, 40)}” on the screen` : 'Listed what is on the screen';
    case 'wait': return `Waited ${args?.seconds || 1} s`;
    case 'check_environment': return 'Checked installed tools';
    case 'load_skill': return `Loaded skill ${args?.name || ''}`;
    case 'read_skill_file': return `Read ${p} from skill ${args?.name || ''}`;
    default: return name;
  }
}

// Absolute paths written in a message: Windows (C:\..., \\server\share) and Unix (/home/...).
// A path may contain spaces and be followed by more words, so the longest prefix that exists wins.
const WINDOWS_PATH_RE = /(?:^|[\s"'`(<\[])((?:[A-Za-z]:[\\/]|\\\\)[^\n"'`<>|?*]*)/g;
const UNIX_PATH_RE = /(?:^|[\s"'`(<\[])(\/(?:[^\s/"'`<>|]+\/)*[^\n"'`<>|]*)/g;

/** The folder an existing path in the message points to (a file's own folder), outside `workspaceRoot`. */
async function namedFolder(text, workspaceRoot = '') {
  const pattern = process.platform === 'win32' ? WINDOWS_PATH_RE : UNIX_PATH_RE;
  const inside = (candidate) => {
    if (!workspaceRoot) return false;
    const relative = nodePath.relative(workspaceRoot, candidate);
    return !relative || (!relative.startsWith('..') && !nodePath.isAbsolute(relative));
  };
  for (const match of String(text || '').matchAll(pattern)) {
    const words = match[1].trim().split(/\s+/);
    for (let count = words.length; count > 0; count -= 1) {
      const candidate = words.slice(0, count).join(' ').replace(/[.,;:!?)\]>]+$/, '').replace(/[\\/]+$/, '') || words[0];
      if (!candidate || candidate.length < 3) continue;
      const stat = await fsp.stat(candidate).catch(() => null);
      if (!stat) continue;
      // A program (in a command the user pasted) or a system folder is not what the chat is about.
      if ((stat.isFile() && PROGRAM_FILE_RE.test(candidate)) || PROGRAM_FOLDER_RE.test(nodePath.resolve(candidate))) break;
      const folder = nodePath.resolve(stat.isDirectory() ? candidate : nodePath.dirname(candidate));
      if (inside(folder)) return '';
      return folder;
    }
  }
  return '';
}

module.exports = {
  CLAIMS_PASS_RE, ASKS_ACTION_RE,
  MUTATING_TOOLS, LARGE_FILE_BYTES, DELTA_FLUSH_MS, MAX_LISTED_CHANGES, FIT_HEADROOM, ASKS_ONLY_RE, POLITE_REQUEST_RE, FILE_CHANGE_TOOLS,
  FILE_REQUEST_RE, AGREES_RE, FILE_WORK_TOOLS, WEB_LOOKUP_RE, OFFERS_RE, SYSTEM_INSTALL_RE, ASKS_INSTALL_RE, CONTINUE_RE, ACTION_RE, EDIT_RE,
  QUESTION_RE, SKILL_HINT_RE, WEB_REQUEST_RE, REPORT_ONLY_RE, SAVE_REQUEST_RE, RUN_REQUEST_RE, TERMINAL_OFF_RE, INTERNET_OFF_RE, WORKSPACE_RE, OWNED_RE,
  HYPOTHETICAL_RE, ASKS_ABILITY_RE, NAMED_FILE_RE, FOLLOW_UP_RE, LONG_CODE_BLOCK_RE, PROBLEM_RE, CLAIMS_BUILD_RE, HISTORY_NOTE_RE, CLAIMS_EDIT_RE,
  PROGRAM_FOLDER_RE, PROGRAM_FILE_RE, LINK_RE, CLAIMS_SIGHT_RE, SCREEN_WORDS_RE, ASKS_SIGHT_RE, asksToSee, blindAnswer, inventedListing,
  FENCE_EXTENSIONS, FILE_NAME_RE, SAVABLE_NAME_RE, pastedFile, earlierLinks, GITHUB_REPO_RE, COMPARE_RE, githubRepoFor, repoOutline, plainReadme,
  sameWords, CANNOT_INPUT_RE, PRETENDS_INPUT_RE, repeatsItself, LOOP_AT_END_RE, LOOP_RE, loopsInLine, withoutLoops, withoutRepeats, TOOL_NAMES_RE,
  CLAIMS_TOOL_RE, toolsClaimed, says, NOT_A_CLAIM_RE, claims, SAYS_MISSING_RE, previousReplyText, saysMissing, meaningWords, foldRepeatedAnswers,
  CLAIMS_DONE_RE, BROWSERS, siteSearch, siteSearchNote, EMAIL_REQUEST_RE, emailNote, RECALL_RE, chatRecap, CLAIMS_CHANGE_RE, ANNOUNCES_NEXT_STEP_RE,
  classifyTask, READ_ONLY_COMMAND_RE, READ_ONLY_PIPE_RE, isReadOnlyCommand, maxOutputTokens, toolTitle, WINDOWS_PATH_RE, UNIX_PATH_RE, namedFolder,
};
