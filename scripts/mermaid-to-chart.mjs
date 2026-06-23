#!/usr/bin/env node
// ============================================================================
// mermaid-to-chart — turn /workflow-map artifacts into the Workflows viewer's
// positioned chart JSON, on the command line.
//
// The browser viewer does this live (public/workflow-chart.js); this is the same
// converter exposed for inspection, debugging, and pre-baking. A map's Mermaid
// `flowchart` + JSON sidecar in, the laid-out { w, h, nodes, edges } out.
//
//   node scripts/mermaid-to-chart.mjs <map.md> [<map.md> ...]   # convert files
//   node scripts/mermaid-to-chart.mjs --dir <repo>              # every docs/workflows map
//   cat map.md | node scripts/mermaid-to-chart.mjs              # from stdin
//
// Flags: --pretty (indented JSON, default) · --compact · --summary (counts only).
// Undrawn stubs (no Mermaid) report status:"undrawn" and no chart — same as the app.
// ============================================================================

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mermaidToChart } from '../public/workflow-chart.js';

const FENCE_JSON = /```json\s+([\s\S]*?)```/g;
const FENCE_MERMAID = /```mermaid\s+([\s\S]*?)```/;

function extractSidecar(markdown) {
  let match;
  FENCE_JSON.lastIndex = 0;
  while ((match = FENCE_JSON.exec(markdown)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch { /* not this fence */ }
  }
  return null;
}

function extractMermaid(markdown) {
  const m = markdown.match(FENCE_MERMAID);
  return m ? m[1] : null;
}

function convertMarkdown(markdown) {
  const sidecar = extractSidecar(markdown);
  const mermaid = extractMermaid(markdown);
  if (!mermaid || !Array.isArray(sidecar?.nodes)) {
    return { status: 'undrawn', chart: null };
  }
  return { status: 'drawn', chart: mermaidToChart(mermaid, sidecar) };
}

async function* walkMaps(repoRoot) {
  const base = path.join(repoRoot, 'docs', 'workflows');
  async function* walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) yield* walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) yield full;
    }
  }
  yield* walk(base);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  const pretty = !flags.has('--compact');
  const summaryOnly = flags.has('--summary');

  let files = [];
  if (flags.has('--dir')) {
    const i = args.indexOf('--dir');
    const repo = args[i + 1];
    if (!repo) { console.error('--dir needs a repo path'); process.exit(2); }
    for await (const f of walkMaps(repo)) files.push(f);
    files = files.filter((f) => !positional.includes(f));
  } else {
    files = positional;
  }

  const render = (obj) => JSON.stringify(obj, null, pretty ? 2 : 0);

  if (files.length === 0) {
    const markdown = await readStdin();
    const out = convertMarkdown(markdown);
    console.log(summaryOnly ? render({ status: out.status, nodes: out.chart?.nodes.length ?? 0, edges: out.chart?.edges.length ?? 0 }) : render(out.chart ?? out));
    return;
  }

  const results = [];
  for (const file of files) {
    let markdown;
    try { markdown = await readFile(file, 'utf8'); }
    catch (error) { results.push({ file, error: error.message }); continue; }
    const out = convertMarkdown(markdown);
    if (summaryOnly) {
      results.push({ file, status: out.status, nodes: out.chart?.nodes.length ?? 0, edges: out.chart?.edges.length ?? 0, w: out.chart?.w, h: out.chart?.h });
    } else {
      results.push({ file, status: out.status, chart: out.chart });
    }
  }
  console.log(render(results.length === 1 && !flags.has('--dir') ? results[0] : results));
}

// Run only when invoked directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((error) => { console.error(error); process.exit(1); });
}

export { convertMarkdown, extractSidecar, extractMermaid };
