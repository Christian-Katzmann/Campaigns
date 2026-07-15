#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { foldRunJournal, readRunJournal } from '../lib/run-journal.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultJournalPath = path.join(repoRoot, 'replay/hello-run.journal.jsonl');
const defaultOutputDir = path.join(repoRoot, 'dist/replay');
const IMPORT_PATTERN = /(\bimport\s+(?:(?:[^'"\n]|\n)*?\sfrom\s*)?)(['"])([^'"]+)\2/g;

export function buildReplayTimeline(events) {
  const folded = foldRunJournal(events);
  assert.equal(folded.exact_replay, true, 'replay demo requires a native journal');
  let markdown = null;
  let state = null;
  return events.map((event) => {
    if (event.state) state = event.state;
    if (event.type === 'run_initialized' || event.type === 'snapshot_imported') {
      markdown = event.document?.markdown ?? markdown;
    } else if (event.type === 'document_transition') {
      markdown = event.document.markdown;
    }
    assert.equal(typeof markdown, 'string', `journal event ${event.sequence} has no board document`);
    return {
      at: event.at,
      document_hash: event.document?.after_hash ?? event.document?.hash ?? null,
      event: event.type,
      kind: event.document?.kind ?? null,
      markdown,
      review_status: state?.review.status ?? 'not_started',
      run_status: state?.run.status ?? 'pending',
      sequence: event.sequence,
      step_id: event.document?.step_id ?? state?.run.current_step_id ?? state?.cursor.step_id ?? null,
    };
  });
}

export async function buildReplayDemo({
  journalPath = defaultJournalPath,
  outputDir = defaultOutputDir,
} = {}) {
  const [events, productCss, replayCss] = await Promise.all([
    readRunJournal(journalPath, { repairTornTail: false }),
    readFile(path.join(repoRoot, 'public/styles.css'), 'utf8'),
    readFile(path.join(repoRoot, 'replay/replay.css'), 'utf8'),
  ]);
  const points = buildReplayTimeline(events);
  const graph = await loadBrowserModuleGraph(path.join(repoRoot, 'replay/app.mjs'));
  const sourceMarkdown = await readFile(path.join(repoRoot, 'examples/hello-run.md'), 'utf8');
  assert.equal(points[0].markdown, sourceMarkdown, 'recording must start from examples/hello-run.md');
  assert.equal(points.at(-1).run_status, 'completed', 'recording must include approved final review');

  const payload = {
    points,
    recording: {
      event_count: events.length,
      replay_scope: 'native_journal',
      source: 'examples/hello-run.md',
      source_sha256: createHash('sha256').update(sourceMarkdown).digest('hex'),
    },
  };
  const html = renderPage({ graph, payload, productCss, replayCss });
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const indexPath = path.join(outputDir, 'index.html');
  await writeFile(indexPath, html);
  return { bytes: Buffer.byteLength(html), indexPath, points };
}

async function loadBrowserModuleGraph(entryPath) {
  const modules = {};
  const visiting = new Set();

  const visit = async (filePath) => {
    const absolutePath = path.resolve(filePath);
    const id = moduleId(absolutePath);
    if (modules[id]) return id;
    if (visiting.has(id)) throw new Error(`Replay browser module graph contains a cycle at ${id}`);
    visiting.add(id);
    let source = await readFile(absolutePath, 'utf8');
    const imports = [];
    source = source.replace(IMPORT_PATTERN, (statement, prefix, quote, specifier) => {
      if (!specifier.startsWith('.')) throw new Error(`Replay browser module ${id} imports ${specifier}`);
      const dependencyPath = path.resolve(path.dirname(absolutePath), specifier);
      const dependencyId = moduleId(dependencyPath);
      const placeholder = `campaign-module:${dependencyId}`;
      imports.push({ dependencyId, placeholder });
      return `${prefix}${quote}${placeholder}${quote}`;
    });
    for (const { dependencyId } of imports) {
      const dependencyPath = path.join(repoRoot, dependencyId);
      await visit(dependencyPath);
    }
    modules[id] = { imports, source };
    visiting.delete(id);
    return id;
  };

  const entry = await visit(entryPath);
  return { entry, modules };
}

function moduleId(filePath) {
  const relative = path.relative(repoRoot, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Replay browser module escapes the repository: ${filePath}`);
  }
  return relative.split(path.sep).join('/');
}

function renderPage({ graph, payload, productCss, replayCss }) {
  const serializedGraph = inlineJson(graph);
  const serializedPayload = inlineJson(payload);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#ffffff">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline' blob:; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'">
  <title>Campaigns recorded replay</title>
  <style>${safeStyle(productCss)}\n${safeStyle(replayCss)}</style>
</head>
<body class="replay-page">
  <div class="app-shell">
    <header class="topbar">
      <div class="topbar-title">
        <p class="eyebrow">Recorded run</p>
        <h1 id="document-title">Hello run</h1>
        <p id="document-path" class="path-label">examples/hello-run.md</p>
      </div>
      <span class="replay-badge">Static · read only</span>
    </header>
    <main class="workspace">
      <aside class="overview" aria-label="Replay controls">
        <div class="overview-card replay-card">
          <div>
            <p class="overview-kicker">Board progress</p>
            <strong id="progress-label">0 of 0 done</strong>
            <div class="progress-track" aria-hidden="true"><div id="progress-fill"></div></div>
          </div>
          <span id="replay-status" class="replay-status">Running</span>
          <div class="replay-event" aria-live="polite">
            <strong id="replay-event">Run initialized</strong>
            <span id="replay-event-detail">Journal event 1</span>
          </div>
          <div>
            <input id="replay-timeline" class="replay-timeline" type="range" min="0" value="0" aria-label="Replay timeline">
            <div id="replay-sequence" class="replay-sequence">1 / ${payload.points.length}</div>
          </div>
          <div class="replay-controls">
            <button id="replay-play" class="button button-primary" type="button" aria-label="Play replay">Play</button>
            <label class="visually-hidden" for="replay-speed">Replay speed</label>
            <select id="replay-speed" aria-label="Replay speed">
              <option value="0.5">0.5×</option>
              <option value="1" selected>1×</option>
              <option value="2">2×</option>
              <option value="4">4×</option>
            </select>
          </div>
          <p class="replay-note">A native journal folded into the real board renderer. No server, writes, or network access.</p>
        </div>
      </aside>
      <article id="document" class="document" aria-live="polite"></article>
    </main>
  </div>
  <div class="replay-support" aria-hidden="true">
    <button id="save-button"></button><span id="save-status"></span><span id="save-status-inline"></span>
    <button id="focus-button"></button><button id="resume-button"></button><span id="resume-preview"></span>
    <nav id="mobile-bottombar"></nav><div id="phase-banner"></div><div id="toast"></div>
  </div>
  <template id="copy-icon-template"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="9" width="10" height="10" rx="2"></rect><path d="M5 15V7a2 2 0 0 1 2-2h8"></path></svg></template>
  <script>globalThis.__CAMPAIGNS_REPLAY__=${serializedPayload};</script>
  <script>
    (() => {
      const graph = ${serializedGraph};
      const urls = new Map();
      const moduleUrl = (id) => {
        if (urls.has(id)) return urls.get(id);
        const record = graph.modules[id];
        if (!record) throw new Error('Missing replay module: ' + id);
        let source = record.source;
        for (const dependency of record.imports) {
          source = source.split(dependency.placeholder).join(moduleUrl(dependency.dependencyId));
        }
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        urls.set(id, url);
        return url;
      };
      import(moduleUrl(graph.entry)).catch((error) => {
        document.querySelector('#document').textContent = 'Replay failed to start: ' + error.message;
        throw error;
      });
    })();
  </script>
</body>
</html>
`;
}

function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function safeStyle(value) {
  return value.replace(/<\/style/gi, '<\\/style');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputFlag = process.argv.indexOf('--output');
  const outputDir = outputFlag >= 0 ? path.resolve(process.argv[outputFlag + 1]) : defaultOutputDir;
  const result = await buildReplayDemo({ outputDir });
  process.stdout.write(`${result.indexPath}\n${result.bytes} bytes\n`);
}
