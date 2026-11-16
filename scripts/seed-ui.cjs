const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..', '.testdata', 'ui');
const workspace = path.join(__dirname, '..', 'demo-workspace');
const data = path.join(root, 'data');
const conversations = path.join(data, 'conversations');
const models = path.join(data, 'models');
const runtimeDir = path.join(data, 'runtime');
const downloads = path.join(data, 'downloads');
const logs = path.join(data, 'logs');

async function main() {
  for (const dir of [workspace, data, conversations, models, runtimeDir, downloads, logs]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  await fsp.rm(conversations, { recursive: true, force: true });
  await fsp.mkdir(conversations, { recursive: true });
  await fsp.rm(path.join(workspace, 'studio-note.md'), { force: true });

  const files = {
    'README.md': `# Fieldnotes

A small, quiet field guide for noticing a city on foot.

Fieldnotes is a static site: plain HTML, CSS, and a little vanilla JavaScript.
Research, drafts, and the published pages live together so a thought can move
from a note to the page without leaving the folder.

## Structure

- \`fieldnotes/\` — the site itself
- \`notes/\` — working notes and questions
- \`research/\` — source material and reading lists
- \`drafts/\` — copy that is not ready for the page
- \`assets/\` — shared images and textures

## Run it

Open \`fieldnotes/index.html\` in a browser. There is no build step.

## Next

- [ ] Tighten the homepage introduction
- [ ] Add a second walk to the map
- [ ] Check the mobile type scale
- [ ] Replace the placeholder cover image
`,
    'fieldnotes/index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fieldnotes — a guide to walking slowly</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header class="masthead">
      <span class="wordmark">Fieldnotes</span>
      <nav>
        <a href="#walks">Walks</a>
        <a href="#about">About</a>
      </nav>
    </header>

    <main>
      <section class="hero">
        <p class="kicker">A GUIDE TO WALKING SLOWLY</p>
        <h1>Notice what the route<br />was trying to hide.</h1>
        <p class="intro">
          Six small walks through the edges of the city — service lanes,
          canal paths, and the hour when shopfronts turn gold.
        </p>
        <a class="cta" href="#walks">Choose a walk <span>→</span></a>
      </section>

      <section id="walks" class="walks">
        <article>
          <span class="index">01</span>
          <h2>The canal at first light</h2>
          <p>Water, bicycle bells, and the smell of bread from the bakery on Vestre.</p>
        </article>
        <article>
          <span class="index">02</span>
          <h2>Service lanes</h2>
          <p>The city's backstage: crates, cats, and hand-painted signs.</p>
        </article>
        <article>
          <span class="index">03</span>
          <h2>The hill after rain</h2>
          <p>A short climb with a long view. Bring a coat.</p>
        </article>
      </section>
    </main>

    <footer>
      <span>Fieldnotes, 2026</span>
      <span>Made slowly.</span>
    </footer>

    <script src="./app.js"></script>
  </body>
</html>
`,
    'fieldnotes/styles.css': `:root {
  --paper: #f2ead9;
  --ink: #242019;
  --soft: #6f6557;
  --accent: #b76533;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: Georgia, 'Times New Roman', serif;
}

.masthead {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24px 6vw;
  border-bottom: 1px solid rgba(36, 32, 25, 0.15);
}

.wordmark {
  font-size: 22px;
  font-style: italic;
}

nav { display: flex; gap: 22px; }
nav a { color: var(--soft); text-decoration: none; font-family: sans-serif; font-size: 12px; }

.hero { padding: 12vh 6vw 8vh; max-width: 900px; }
.kicker { font-family: sans-serif; font-size: 10px; letter-spacing: 0.18em; color: var(--accent); }
h1 { font-size: clamp(40px, 6.4vw, 84px); line-height: 0.98; font-weight: 400; letter-spacing: -0.04em; margin: 18px 0; }
.intro { max-width: 480px; color: var(--soft); font-size: 17px; line-height: 1.6; }
.cta { display: inline-block; margin-top: 18px; color: var(--accent); font-family: sans-serif; font-size: 13px; }

.walks { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: rgba(36,32,25,.15); border-top: 1px solid rgba(36,32,25,.15); }
.walks article { background: var(--paper); padding: 34px 6vw 60px 28px; }
.index { font-family: sans-serif; font-size: 10px; color: var(--accent); }
.walks h2 { font-size: 25px; font-weight: 400; margin: 12px 0 8px; }
.walks p { color: var(--soft); font-size: 14px; line-height: 1.6; }

footer { display: flex; justify-content: space-between; padding: 26px 6vw; font-family: sans-serif; font-size: 11px; color: var(--soft); }
`,
    'fieldnotes/app.js': `const walks = document.querySelectorAll('.walks article');

walks.forEach((walk, index) => {
  walk.addEventListener('click', () => {
    walk.classList.toggle('is-open');
    console.info('walk selected', index + 1);
  });
});
`,
    'notes/welcome.md': `# Welcome to the field notes

This folder is a working desk, not a polished archive.

The rule is simple: put the messy version here first. A half-sentence, a bus
number, the light at 4pm. The page can be edited later; the noticing cannot.

## Open questions

- Which walk has the strongest opening image?
- Is "service lanes" too London-specific?
- Do we need a map, or is the list enough?
`,
    'notes/questions.md': `# Questions for the next walk

- Where does the canal path actually start?
- Is the bakery open on Sundays?
- What is the name of the cat by the loading bay?
- How long is the hill route at an easy pace?

TODO: add timings and a short accessibility note to each walk.
`,
    'research/reading-list.md': `# Reading list

- *The Practice of Everyday Life* — Michel de Certeau
- *A Field Guide to Getting Lost* — Rebecca Solnit
- *The Poetics of Space* — Gaston Bachelard
- London Loop section notes (printed, 2019)

## Fragments

> "The city is a map of what we have noticed."

Look up the term *psychogeography* before the next draft. FIXME: find a better
source than the encyclopedia entry.
`,
    'drafts/homepage-copy.md': `# Homepage copy — draft 02

## Headline options

1. Notice what the route was trying to hide.
2. A guide to walking slowly.
3. Six walks for people who are not in a hurry.

## Intro

Six small walks through the edges of the city — service lanes, canal paths,
and the hour when shopfronts turn gold.
`,
    'assets/cover.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500">
  <rect width="800" height="500" fill="#e8dfcd"/>
  <path d="M0 340 Q180 260 340 330 T800 290 V500 H0Z" fill="#c9b89e"/>
  <path d="M0 380 Q230 310 440 375 T800 350 V500 H0Z" fill="#9d8a72"/>
  <circle cx="620" cy="120" r="46" fill="#c46e3a"/>
  <text x="60" y="90" font-family="Georgia,serif" font-size="44" fill="#2b241c">Fieldnotes</text>
  <text x="62" y="122" font-family="sans-serif" font-size="12" letter-spacing="3" fill="#6f6557">WALKS AT THE EDGE OF THE CITY</text>
</svg>
`,
  };

  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(workspace, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
  }

  await fsp.copyFile(path.join(__dirname, '..', '.testdata', 'e2e', 'data', 'models.json'), path.join(data, 'models.json'));
  await fsp.copyFile(path.join(__dirname, '..', '.testdata', 'e2e', 'data', 'runtime.json'), path.join(data, 'runtime.json'));

  const now = new Date();
  const at = (minutes) => new Date(now.getTime() - minutes * 60000).toISOString();
  const id = 'c_fieldnotes_map';
  const userText = 'Give me a map of this workspace. What is it, how is it organized, and what should I work on next?';
  const assistantText = `This is **Fieldnotes** — a small static field guide for walking slowly through the city. It's plain HTML, CSS, and vanilla JavaScript, with the research and drafts kept right next to the site.

The folder has a clean shape:

- \`fieldnotes/\` is the published site: one page, a stylesheet, and a tiny interaction script.
- \`notes/\` holds the working thinking — questions that are still open.
- \`research/\` keeps sources and fragments.
- \`drafts/\` is where copy waits before it moves into the page.
- \`assets/\` has the cover art.

Three things I'd do next:

1. **Tighten the homepage intro.** The current paragraph is doing too much at once. The headline is strong; the supporting text can be quieter.
2. **Resolve the open questions in \`notes/questions.md\`.** The walk timings and the accessibility note are the two gaps a reader will feel.
3. **Replace the remaining FIXME.** The reading list still points at an encyclopedia entry; that's the only place the research feels thin.`;

  const conversation = {
    id,
    title: 'Map the Fieldnotes workspace',
    createdAt: at(26),
    updatedAt: at(2),
    preview: userText,
    messages: [
      {
        id: 'm_user_map',
        role: 'user',
        content: userText,
        createdAt: at(26),
      },
      {
        id: 'm_assistant_map',
        role: 'assistant',
        content: assistantText,
        createdAt: at(2),
        modelId: 'qwen3-4b',
        modelName: 'Qwen3 4B',
        status: 'done',
        finishedAt: at(2),
        blocks: [
          {
            type: 'text',
            text: `This is **Fieldnotes** — a small static field guide for walking slowly through the city. It's plain HTML, CSS, and vanilla JavaScript, with the research and drafts kept right next to the site.`,
          },
          {
            type: 'tool',
            id: 't_list',
            name: 'list_files',
            args: { path: '.', depth: 2 },
            title: 'Listed workspace',
            status: 'done',
            summary: 'Listed workspace (15 entries)',
            output: `.
├── assets/
│   └── cover.svg
├── drafts/
│   └── homepage-copy.md
├── fieldnotes/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── notes/
│   ├── questions.md
│   └── welcome.md
├── research/
│   └── reading-list.md
└── README.md`,
            startedAt: at(2),
            finishedAt: at(2),
          },
          {
            type: 'text',
            text: `The folder has a clean shape:

- \`fieldnotes/\` is the published site: one page, a stylesheet, and a tiny interaction script.
- \`notes/\` holds the working thinking — questions that are still open.
- \`research/\` keeps sources and fragments.
- \`drafts/\` is where copy waits before it moves into the page.
- \`assets/\` has the cover art.

Three things I'd do next:

1. **Tighten the homepage intro.** The current paragraph is doing too much at once. The headline is strong; the supporting text can be quieter.
2. **Resolve the open questions in \`notes/questions.md\`.** The walk timings and the accessibility note are the two gaps a reader will feel.
3. **Replace the remaining FIXME.** The reading list still points at an encyclopedia entry; that's the only place the research feels thin.`,
          },
        ],
      },
    ],
  };

  await fsp.writeFile(path.join(conversations, `${id}.json`), JSON.stringify(conversation, null, 2));

  const second = {
    id: 'c_homepage_copy',
    title: 'Tighten the homepage copy',
    createdAt: at(190),
    updatedAt: at(180),
    preview: 'Can you make the intro feel less crowded?',
    messages: [
      {
        id: 'm_user_copy',
        role: 'user',
        content: 'Can you make the intro feel less crowded? Keep the headline.',
        createdAt: at(190),
      },
    ],
  };
  await fsp.writeFile(path.join(conversations, `${second.id}.json`), JSON.stringify(second, null, 2));

  const settings = {
    onboarded: true,
    workspacePath: workspace,
    activeModelId: 'qwen3-4b',
    allowEdits: true,
    allowDelete: false,
    allowShell: false,
    contextSize: 8192,
    temperature: 0.3,
    topP: 0.9,
    gpuOffload: true,
    runtimeBackend: 'auto',
    lastConversationId: id,
  };
  await fsp.writeFile(path.join(data, 'settings.json'), JSON.stringify(settings, null, 2));
  console.log('Seeded UI state at', data);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
