// ============================================================================
// Workflows — the DëvSec-style fragility-map browser, wired to real maps.
//
// Data: GET /api/workflows (the repos that host a registered campaign, walked for
// docs/workflows/**). Each map's Mermaid `flowchart` + JSON sidecar is converted
// live into this viewer's positioned chart by ./workflow-chart.js — so every map
// /workflow-map produces, today and future, renders in this style with no
// regeneration step. Undrawn stubs show their authored entry points instead.
//
// Self-contained: own state, own theme, own render. The Campaigns app mounts it
// full-bleed for ?view=workflows and renders nothing behind it.
//
// (Recreated from the Claude Design handoff Workflows.dc.html — the "calm by
// default, detail on interaction" pass. Sample data was Phase 1; this is the wire-up.)
// ============================================================================

import { mermaidToChart } from './workflow-chart.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const UNITLESS = new Set([
  'opacity', 'z-index', 'font-weight', 'line-height', 'flex', 'flex-grow',
  'flex-basis', 'order', 'zoom',
]);

// ---------------------------------------------------------------------------
// DOM helpers — the design is inline-style driven; theme = CSS vars on the root.
// ---------------------------------------------------------------------------
function setStyle(node, obj) {
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue;
    if (key.startsWith('--')) { node.style.setProperty(key, String(value)); continue; }
    const prop = key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    const out = typeof value === 'number' && !UNITLESS.has(prop) ? value + 'px' : String(value);
    node.style.setProperty(prop, out);
  }
}

function E(tag, opts = {}) {
  const n = document.createElement(tag);
  if (opts.style) setStyle(n, opts.style);
  if (opts.text != null) n.textContent = opts.text;
  if (opts.html != null) n.innerHTML = opts.html;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) if (v != null) n.setAttribute(k, String(v));
  if (opts.on) for (const [k, v] of Object.entries(opts.on)) n.addEventListener(k, v);
  if (opts.hover) {
    const baseCss = n.style.cssText;
    n.addEventListener('mouseenter', () => setStyle(n, opts.hover));
    n.addEventListener('mouseleave', () => { n.style.cssText = baseCss; });
  }
  for (const c of opts.kids || []) if (c != null && c !== false) n.append(c);
  return n;
}

function S(tag, attrs = {}, kids = []) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  for (const c of kids) if (c) n.append(c);
  return n;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
// Initial theme follows the OS (prefers-color-scheme); the Light/Dark toggle then
// overrides it for the session. Declared as a function so it's hoisted for the
// literal below; defaults to dark only if matchMedia is somehow unavailable.
function systemTheme() {
  if (!window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const state = {
  theme: systemTheme(),
  themeManual: false, // true once the user clicks the toggle — stops following the OS
  view: 'home',
  lastProjectId: null,
  projectId: null,
  selectedFlowId: null,
  expanded: {},
  filters: { persona: [], source: [], kind: [] },
  projOpen: false,
  filtersOpen: false,
  tintIssues: false,    // "heatmap" toggle — tint folders/files red/amber where workflows have issues
  sidebarScroll: 0,     // remembered tree scroll, restored after each re-render
  hoverNode: null,
  pinnedNode: null,
};

let PROJECTS = null;
let mountEl = null;

// ---------------------------------------------------------------------------
// ADAPTER — GET /api/workflows discovery shape → project / area / sub / flow.
//   repo            → project       (one card on the home map)
//   categories[0]   → area          (bold folder)
//   categories[1..] → sub           (folder; deep paths fold into one label)
//   the .md map      → flow          (file; drawn → chart, undrawn → stub)
// Facets (actor / data_source / kind), the plain-language glosses, and the desc
// are read from the map's JSON sidecar — all client-side, no server changes.
// ---------------------------------------------------------------------------
const arr = (x) => (Array.isArray(x) ? x.filter((v) => v != null && v !== '') : x == null || x === '' ? [] : [x]);
const nfc = (value) => String(value || '').normalize('NFC');
const repoKey = (item) => nfc(item.repoRoot || item.repoName || '').trim();

function parseSidecar(markdown) {
  const fence = /```json\s+([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(markdown || '')) !== null) {
    try {
      const data = JSON.parse(match[1]);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch { /* not this fence */ }
  }
  return {};
}

function extractMermaidFence(markdown) {
  const m = (markdown || '').match(/```mermaid\s+([\s\S]*?)```/);
  return m ? m[1] : null;
}

// One-sentence description: the sidecar's `what`, else the map's intro blockquote
// prose (skipping the **metadata** and "generated lens" lines), else nothing.
function extractDesc(markdown, sidecar) {
  if (typeof sidecar.what === 'string' && sidecar.what.trim()) return sidecar.what.trim();
  const prose = (markdown || '')
    .split('\n')
    .filter((l) => l.trim().startsWith('>'))
    .map((l) => l.replace(/^\s*>\s?/, '').trim())
    .filter((l) => l && !l.startsWith('**') && !/generated lens/i.test(l));
  return prose.join(' ').trim();
}

function worstSev(score) {
  if (!score || typeof score !== 'object') return 'grey';
  if (Number(score.red) > 0) return 'red';
  if (Number(score.amber) > 0) return 'amber';
  // accepted (🟢✻ green-with-reason) rolls up as green at the tree/flow level —
  // it is healthy (not silent), just footnoted; only red+amber are "fragility".
  if (Number(score.green) > 0 || Number(score.accepted) > 0) return 'green';
  return 'grey';
}

const GLYPHS = ['reticle', 'grid', 'stack', 'columns', 'relay', 'tripwire', 'ledger'];
function glyphFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GLYPHS[h % GLYPHS.length];
}

function buildFromApi(items) {
  const byRepo = new Map();
  const seenFlows = new Set();
  for (const it of items) {
    const sidecar = parseSidecar(it.markdown);
    const cats = Array.isArray(it.categories) ? it.categories : [];
    const area = cats[0] || '(root)';
    const sub = cats.length > 1 ? cats.slice(1).join(' / ') : '(general)';
    const drawn = it.status === 'drawn';
    const projectKey = repoKey(it);
    const projectName = nfc(it.repoName || projectKey);
    const projectRoot = nfc(it.repoRoot || '');
    const ref = it.ref || [...cats, it.slug].join('/');
    const flowKey = `${projectKey}\0${nfc(ref)}`;
    if (seenFlows.has(flowKey)) continue;
    seenFlows.add(flowKey);
    const flow = {
      id: ref,
      _ref: ref, // path relative to docs/workflows — the copy-ref leaf
      name: it.title || it.slug,
      desc: extractDesc(it.markdown, sidecar),
      purpose: typeof sidecar.purpose === 'string' ? sidecar.purpose.trim() : '', // plain "used when X" — leads the header
      sev: drawn ? worstSev(it.score) : 'grey',
      drawn,
      personas: arr(sidecar.actor),
      sources: arr(sidecar.data_source),
      kind: typeof sidecar.kind === 'string' ? sidecar.kind : '',
      entryPoints: arr(sidecar.entry_points),
      endsWith: typeof sidecar.ends_with === 'string' ? sidecar.ends_with : '',
      _mermaid: drawn ? extractMermaidFence(it.markdown) : null,
      _sidecar: sidecar,
      chart: undefined, // converted lazily on first view, then cached here
    };
    if (!byRepo.has(projectKey)) {
      byRepo.set(projectKey, { id: slug(projectName), name: projectName, repo: projectName, repoRoot: projectRoot, glyph: glyphFor(projectName), areas: new Map() });
    }
    const proj = byRepo.get(projectKey);
    flow._project = proj.name; flow._projectId = proj.id; flow._area = area; flow._sub = sub;
    flow._areaKey = area; flow._subKey = area + '/' + sub;
    if (!proj.areas.has(area)) proj.areas.set(area, new Map());
    const subs = proj.areas.get(area);
    if (!subs.has(sub)) subs.set(sub, []);
    subs.get(sub).push(flow);
  }

  const byName = (a, z) => String(a[0]).localeCompare(String(z[0]));
  const projects = [...byRepo.values()].map((proj) => ({
    id: proj.id, name: proj.name, repo: proj.repo, repoRoot: proj.repoRoot, glyph: proj.glyph, role: '',
    areas: [...proj.areas.entries()].sort(byName).map(([aname, subs]) => ({
      name: aname,
      subs: [...subs.entries()].sort(byName).map(([sname, flows]) => ({
        name: sname, flows: flows.sort((a, b) => a.name.localeCompare(b.name)),
      })),
    })),
  }));
  for (const p of projects) {
    const fs = allFlows(p);
    const drawn = fs.filter((f) => f.drawn).length;
    p.role = `${fs.length} workflow${fs.length === 1 ? '' : 's'} across ${p.areas.length} area${p.areas.length === 1 ? '' : 's'} — ${drawn} mapped, ${fs.length - drawn} still ${fs.length - drawn === 1 ? 'a stub' : 'stubs'}.`;
  }
  projects.sort((a, b) => allFlows(b).length - allFlows(a).length || a.name.localeCompare(b.name));
  return projects;
}

// ---------------------------------------------------------------------------
// THEME — dark (default) + light, from the design.
// ---------------------------------------------------------------------------
function themeTokens() {
  if (state.theme === 'dark') return {
    paper: 'radial-gradient(ellipse 90% 60% at 50% -12%, rgba(255,255,255,0.05), transparent 58%), linear-gradient(180deg, #141414 0%, #0a0a0a 62%, #060606 100%), #07070a',
    panel: 'rgba(255,255,255,0.025)', card: 'rgba(255,255,255,0.012)', pop: '#0d0d0d',
    ink: '#ffffff', ink2: 'rgba(255,255,255,0.62)', ink3: 'rgba(255,255,255,0.40)',
    onInk: '#08130d',
    rule: 'rgba(255,255,255,0.08)', rule2: 'rgba(255,255,255,0.16)',
    hover: 'rgba(255,255,255,0.05)', sel: 'rgba(255,255,255,0.10)',
    chip: 'rgba(255,255,255,0.045)', stub: 'rgba(255,255,255,0.03)', edge: 'rgba(255,255,255,0.26)',
  };
  return {
    paper: 'radial-gradient(ellipse 90% 60% at 50% -12%, #ffffff, transparent 60%), linear-gradient(180deg, #f4f4f3 0%, #ededec 100%), #efefee',
    panel: 'rgba(255,255,255,0.58)', card: 'rgba(255,255,255,0.40)', pop: '#ffffff',
    ink: '#0b0d0c', ink2: 'rgba(11,13,12,0.60)', ink3: 'rgba(11,13,12,0.40)', onInk: '#f3f6f4',
    rule: 'rgba(11,13,12,0.10)', rule2: 'rgba(11,13,12,0.16)',
    hover: 'rgba(11,13,12,0.04)', sel: 'rgba(11,13,12,0.07)',
    chip: 'rgba(255,255,255,0.85)', stub: 'rgba(11,13,12,0.02)', edge: 'rgba(11,13,12,0.32)',
  };
}
function pal() {
  if (state.theme === 'dark') return {
    green: { ink: '#34d399', bd: 'rgba(16,185,129,0.55)', fill: 'linear-gradient(155deg, rgba(16,185,129,0.24), rgba(16,185,129,0.07))', dot: '#10b981' },
    accepted: { ink: '#5eead4', bd: 'rgba(20,184,166,0.5)', fill: 'linear-gradient(155deg, rgba(45,212,191,0.18), rgba(16,185,129,0.05))', dot: '#2dd4bf' },
    amber: { ink: '#fbbf24', bd: 'rgba(217,119,6,0.6)', fill: 'linear-gradient(155deg, rgba(217,119,6,0.26), rgba(217,119,6,0.08))', dot: '#d97706' },
    red: { ink: '#f87171', bd: 'rgba(239,68,68,0.6)', fill: 'linear-gradient(155deg, rgba(220,38,38,0.27), rgba(220,38,38,0.08))', dot: '#ef4444' },
    grey: { ink: '#d4d4d8', bd: 'rgba(255,255,255,0.2)', fill: 'linear-gradient(155deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))', dot: '#a1a1aa' },
  };
  return {
    green: { ink: '#047857', bd: '#7fd0ad', fill: 'linear-gradient(155deg, rgba(16,185,129,0.17), rgba(16,185,129,0.05))', dot: '#10b981' },
    accepted: { ink: '#0f766e', bd: '#8fd3c8', fill: 'linear-gradient(155deg, rgba(45,212,191,0.13), rgba(16,185,129,0.04))', dot: '#14b8a6' },
    amber: { ink: '#b45309', bd: '#e6bd80', fill: 'linear-gradient(155deg, rgba(217,119,6,0.16), rgba(217,119,6,0.05))', dot: '#d97706' },
    red: { ink: '#c0271f', bd: '#e29b98', fill: 'linear-gradient(155deg, rgba(220,38,38,0.14), rgba(220,38,38,0.045))', dot: '#dc2626' },
    grey: { ink: '#52525b', bd: '#d2d2d8', fill: 'linear-gradient(155deg, rgba(11,13,12,0.05), rgba(11,13,12,0.02))', dot: '#71717a' },
  };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
const project = () => PROJECTS.find((p) => p.id === state.projectId) || PROJECTS[0];
function allFlows(p) { const o = []; p.areas.forEach((a) => a.subs.forEach((s) => s.flows.forEach((f) => o.push(f)))); return o; }
function flow() { const all = allFlows(project()); return all.find((f) => f.id === state.selectedFlowId) || all[0]; }
function filtersActive() { const f = state.filters; return f.persona.length + f.source.length + f.kind.length > 0; }
function matchFlow(f) {
  const F = state.filters;
  if (F.persona.length && !F.persona.some((v) => f.personas.includes(v))) return false;
  if (F.source.length && !F.source.some((v) => f.sources.includes(v))) return false;
  if (F.kind.length && !F.kind.includes(f.kind)) return false;
  return true;
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Heatmap tint — the worst severity a folder *contains* (red beats amber; green/grey
// don't tint). Used only when the "Heatmap" toggle is on. Escalating intensity by
// depth so the signal sharpens as you drill in: area (faint) → sub → file (marked).
function worstOf(flows) {
  let amber = false;
  for (const f of flows) { if (f.sev === 'red') return 'red'; if (f.sev === 'amber') amber = true; }
  return amber ? 'amber' : null;
}
const TINT_RGB = { red: '239,68,68', amber: '217,119,6' };
const TINT_A = { area: 0.07, sub: 0.15, flow: 0.22 };
const TINT_HOVER_A = { area: 0.13, sub: 0.21, flow: 0.28 };
const tintBg = (sev, lvl) => `rgba(${TINT_RGB[sev]},${TINT_A[lvl]})`;
const tintHoverBg = (sev, lvl) => `rgba(${TINT_RGB[sev]},${TINT_HOVER_A[lvl]})`;

// Filter groups are derived from the current project's flows, so they only ever
// offer values that actually match something.
function filterGroupsFor(p) {
  const flows = allFlows(p);
  const uniq = (xs) => [...new Set(xs)].sort();
  return [
    { label: 'Who uses it', key: 'persona', values: uniq(flows.flatMap((f) => f.personas)) },
    { label: 'Data source', key: 'source', values: uniq(flows.flatMap((f) => f.sources)) },
    { label: 'Kind', key: 'kind', values: uniq(flows.map((f) => f.kind).filter(Boolean)) },
  ].filter((g) => g.values.length);
}

// Lucide-style line icons (the brand's icon set), as small SVG leaves.
function ic(name, color, size) {
  const sz = size || 16;
  const base = { width: sz, height: sz, viewBox: '0 0 24 24', fill: 'none', stroke: color, 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: 'display:block' };
  const P = (d) => S('path', { d });
  if (name === 'folder') return S('svg', base, [P('M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z')]);
  if (name === 'folder-open') return S('svg', base, [P('m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2')]);
  if (name === 'file') return S('svg', base, [P('M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z'), P('M14 2v6h6'), P('M8.5 13h7'), P('M8.5 16.5h4.5')]);
  if (name === 'file-stub') { const b2 = { ...base, 'stroke-dasharray': '2.6 2.4', style: 'display:block;opacity:0.85' }; return S('svg', b2, [P('M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z'), P('M14 2v6h6')]); }
  if (name === 'filter') return S('svg', base, [P('M3 6h18'), P('M7 12h10'), P('M11 18h2')]);
  if (name === 'copy') return S('svg', base, [S('rect', { x: 9, y: 9, width: 10, height: 10, rx: 2 }), P('M5 15V7a2 2 0 0 1 2-2h8')]); // matches the Campaigns tab's copy glyph
  if (name === 'check') return S('svg', base, [P('M20 6 9 17l-5-5')]);
  return null;
}

// Per-repo marks — distinct motifs in the brand's square/line geometry.
function glyph(name, color, size) {
  const sz = size || 20;
  const svg = (ch) => S('svg', { width: sz, height: sz, viewBox: '0 0 24 24', style: 'display:block' }, ch);
  const r = (x, y, w, h, extra) => S('rect', { x, y, width: w, height: h, fill: color, ...(extra || {}) });
  switch (name) {
    case 'reticle': return svg([r(9, 1, 6, 6), r(1, 9, 6, 6), r(17, 9, 6, 6), r(9, 17, 6, 6)]);
    case 'grid': return svg([r(2, 2, 8, 8), r(14, 2, 8, 8), r(2, 14, 8, 8), r(14, 14, 8, 8)]);
    case 'stack': return svg([r(3, 3, 18, 4), r(3, 10, 18, 4), r(3, 17, 11, 4)]);
    case 'columns': return svg([r(3, 7, 4, 13), r(10, 3, 4, 17), r(17, 7, 4, 13), r(1, 21, 22, 2)]);
    case 'relay': return svg([r(1, 9, 6, 6), r(17, 9, 6, 6), r(7, 11, 10, 2)]);
    case 'tripwire': return svg([r(8, 8, 8, 8), r(2, 2, 3.6, 3.6), r(18.4, 2, 3.6, 3.6), r(2, 18.4, 3.6, 3.6), r(18.4, 18.4, 3.6, 3.6)]);
    case 'ledger': return svg([r(11, 2, 2, 20), r(3, 5, 6, 2), r(15, 5, 6, 2), r(3, 11, 6, 2), r(15, 11, 6, 2), r(3, 17, 6, 2), r(15, 17, 6, 2)]);
    default: return svg([r(9, 1, 6, 6), r(1, 9, 6, 6), r(17, 9, 6, 6), r(9, 17, 6, 6)]);
  }
}

// ---------------------------------------------------------------------------
// ACTIONS
// ---------------------------------------------------------------------------
function toggleTheme() { state.themeManual = true; state.theme = state.theme === 'light' ? 'dark' : 'light'; render(); }
function toggleProjOpen() { state.projOpen = !state.projOpen; render(); }
function toggleFilters() { state.filtersOpen = !state.filtersOpen; render(); }
function defaultFlow(p) { const fs = allFlows(p); return fs.find((f) => f.drawn) || fs[0] || null; }
function switchProject(id) {
  const p = PROJECTS.find((x) => x.id === id); const first = defaultFlow(p);
  state.projectId = id; state.selectedFlowId = first ? first.id : null; state.projOpen = false;
  state.expanded = first ? { [first._areaKey]: true, [first._subKey]: true } : {};
  state.filters = { persona: [], source: [], kind: [] };
  state.sidebarScroll = 0; // new project → fresh tree, start at the top
  state.pinnedNode = null; state.hoverNode = null; render();
}
function openProject(id) { switchProject(id); state.view = 'project'; state.lastProjectId = id; render(); }
function goHome() { state.view = 'home'; state.projOpen = false; render(); }
function toggleExpand(key) { state.expanded = { ...state.expanded, [key]: !state.expanded[key] }; render(); }
function allTreeKeys(p) {
  const keys = [];
  p.areas.forEach((area) => { keys.push(area.name); area.subs.forEach((sub) => keys.push(area.name + '/' + sub.name)); });
  return keys;
}
function allExpanded(p) { const keys = allTreeKeys(p); return keys.length > 0 && keys.every((k) => state.expanded[k]); }
function toggleAllExpand() {
  const p = project();
  if (allExpanded(p)) { state.expanded = {}; }
  else { const e = {}; allTreeKeys(p).forEach((k) => { e[k] = true; }); state.expanded = e; }
  render();
}
function toggleTint() { state.tintIssues = !state.tintIssues; render(); }
function selectFlow(f) {
  state.expanded = { ...state.expanded, [f._areaKey]: true, [f._subKey]: true };
  state.selectedFlowId = f.id; state.pinnedNode = null; state.hoverNode = null; render();
}
function toggleTag(group, value) {
  const g = [...state.filters[group]]; const i = g.indexOf(value);
  if (i >= 0) g.splice(i, 1); else g.push(value);
  state.filters = { ...state.filters, [group]: g }; render();
}
function clearFilters() { state.filters = { persona: [], source: [], kind: [] }; render(); }

// ---------------------------------------------------------------------------
// COPY REFERENCE — a clipboard hand-off an AI agent can act on cold. Two scopes,
// mirroring the Campaigns tab: the whole collection (every linked repo) and one
// repo. Both point at real on-disk folders so "go read these" actually resolves.
// ---------------------------------------------------------------------------
function workflowsFolder(p) {
  return p.repoRoot ? `${p.repoRoot}/docs/workflows` : `<${p.name}>/docs/workflows`;
}

function repoReferenceText(p) {
  const flows = allFlows(p);
  const drawn = flows.filter((f) => f.drawn).length;
  const stubs = flows.length - drawn;
  return [
    `Workflow maps for "${p.name}" — fragility maps of how this repo's key flows work and where they can break. Each map is a Mermaid flowchart plus a JSON sidecar in one Markdown file.`,
    '',
    `Folder: ${workflowsFolder(p)}`,
    '',
    `${flows.length} map${flows.length === 1 ? '' : 's'} (${drawn} drawn, ${stubs} stub${stubs === 1 ? '' : 's'}) — paths relative to that folder:`,
    ...flows.map((f) => `- ${f._ref}${f.drawn ? '' : '  · stub'}`),
  ].join('\n');
}

function flowReferenceText(p, f) {
  const blurb = f.purpose || f.desc || '';
  return [
    `Workflow map: "${f.name}" — in repo "${p.name}"${blurb ? ` — ${blurb}` : ''}`,
    '',
    `File: ${workflowsFolder(p)}/${f._ref}`,
    '',
    f.drawn
      ? 'A fragility map (Mermaid flowchart + JSON sidecar). Read it to see how this flow works step by step and where it can break.'
      : 'A workflow stub (not yet drawn). It records the flow’s entry points and intent — read it for what’s known so far.',
  ].join('\n');
}

function collectionReferenceText() {
  return [
    `Workflow maps across all linked repos — fragility maps (a Mermaid flowchart + JSON sidecar per Markdown file) of how each repo's key flows work and where they can break. They live under docs/workflows/ inside each repo.`,
    '',
    `Repos (${PROJECTS.length}):`,
    ...PROJECTS.map((p) => {
      const n = allFlows(p).length;
      return `- ${p.name} — ${workflowsFolder(p)}  (${n} map${n === 1 ? '' : 's'})`;
    }),
    '',
    `Open a repo's folder and read the .md files to see its workflows.`,
  ].join('\n');
}

// Self-contained copy button (this module never reaches into the Campaigns app, so
// it carries its own copy→check confirmation instead of the app's toast). `variant`
// 'ghost' = icon-only square (cards/sidebar); default = labelled pill (page header).
function buildCopyButton(t, { label, title, getText, variant }) {
  const mono = { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase' };
  const base = variant === 'ghost'
    ? { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, padding: 0, background: t.panel, border: '1px solid ' + t.rule2, borderRadius: 5, cursor: 'pointer', color: t.ink2, flex: 'none' }
    : { display: 'inline-flex', alignItems: 'center', gap: 7, height: 30, padding: '0 12px', background: 'transparent', border: '1px solid ' + t.rule2, borderRadius: 5, cursor: 'pointer', color: t.ink2, whiteSpace: 'nowrap', flex: 'none', ...mono };

  const iconWrap = E('span', { style: { width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }, kids: [ic('copy', 'currentColor', 14)] });
  const labelEl = label ? E('span', { text: label }) : null;

  let resetTimer = null;
  const btn = E('button', {
    attrs: { type: 'button', title: title || 'Copy reference', 'aria-label': title || 'Copy reference' },
    style: base,
    hover: { ...base, color: t.ink, background: t.hover, borderColor: t.ink },
    on: {
      click: async (e) => {
        e.preventDefault(); e.stopPropagation();
        const ok = await (async () => {
          try { await navigator.clipboard.writeText(getText()); return true; } catch { return false; }
        })();
        iconWrap.replaceChildren(ic(ok ? 'check' : 'copy', 'currentColor', 14));
        if (labelEl) labelEl.textContent = ok ? 'Copied' : 'Copy failed';
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          iconWrap.replaceChildren(ic('copy', 'currentColor', 14));
          if (labelEl) labelEl.textContent = label;
        }, 1500);
      },
    },
    kids: [iconWrap, labelEl],
  });
  return btn;
}

// ---------------------------------------------------------------------------
// ENTRY + RENDER
// ---------------------------------------------------------------------------
export async function renderWorkflowsV2(mount) {
  if (!mount) return;
  mountEl = mount;
  renderMessage('Loading workflow maps…');
  let items = [];
  try {
    const res = await fetch('/api/workflows');
    if (!res.ok) throw new Error('Could not load workflow maps.');
    const payload = await res.json();
    items = Array.isArray(payload.workflows) ? payload.workflows : [];
  } catch (error) {
    renderMessage(error.message || 'Could not load workflow maps.');
    return;
  }
  PROJECTS = buildFromApi(items);
  if (PROJECTS.length === 0) { renderEmpty(); return; }

  const p = PROJECTS[0];
  const first = defaultFlow(p);
  state.projectId = p.id;
  state.selectedFlowId = first ? first.id : null;
  state.expanded = first ? { [first._areaKey]: true, [first._subKey]: true } : {};
  state.view = PROJECTS.length === 1 ? 'project' : 'home';
  state.lastProjectId = PROJECTS.length === 1 ? p.id : null;
  render();
}

function applyRootStyle(t) {
  setStyle(mountEl, {
    '--paper': t.paper, '--panel': t.panel, '--card': t.card, '--ink': t.ink, '--ink2': t.ink2,
    '--ink3': t.ink3, '--rule': t.rule, '--rule2': t.rule2, '--hover': t.hover, '--sel': t.sel,
    '--chip': t.chip, '--stub': t.stub, '--edge': t.edge, '--pop': t.pop, '--onInk': t.onInk,
    display: 'flex', flexDirection: 'column', height: '100%', width: '100%',
    background: t.paper, color: t.ink, fontFamily: 'var(--font-sans)', overflow: 'hidden',
  });
}

function renderMessage(text) {
  const t = themeTokens();
  applyRootStyle(t);
  mountEl.replaceChildren(buildHeader(t), E('div', {
    style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 },
    kids: [E('p', { text, style: { fontFamily: 'var(--font-sans)', fontSize: 14, color: t.ink2 } })],
  }));
}

function renderEmpty() {
  const t = themeTokens();
  applyRootStyle(t);
  mountEl.replaceChildren(buildHeader(t), E('div', {
    style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0, padding: '40px' },
    kids: [E('div', { style: { maxWidth: 460, textAlign: 'center' }, kids: [
      E('div', { text: 'No workflow maps yet', style: { fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 500, color: t.ink, marginBottom: 12 } }),
      E('p', { html: 'Run <code>/workflow-map</code> in a repo with a registered campaign to chart its first flow. Each map lands under <code>docs/workflows/…/&lt;slug&gt;.md</code> and shows up here, grouped by repo.', style: { fontFamily: 'var(--font-sans)', fontSize: 14, lineHeight: 1.6, color: t.ink2 } }),
    ] })],
  }));
}

function render() {
  const t = themeTokens();
  const p = pal();
  applyRootStyle(t);
  mountEl.replaceChildren(buildHeader(t), state.view === 'home' ? buildHome(t, p) : buildProject(t, p));
  // render() rebuilds the whole tree, so the sidebar's scroll resets to 0. Restore the
  // remembered position so clicking a workflow / toggling a folder doesn't yank you up.
  const sc = mountEl.querySelector('[data-wf-tree]');
  if (sc) sc.scrollTop = state.sidebarScroll || 0;
}

// ---- top bar: logo + app tabs + theme toggle ----
function buildHeader(t) {
  const logo = E('button', {
    attrs: { title: 'Workspace home' },
    style: { display: 'flex', alignItems: 'center', gap: 11, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit' },
    on: { click: goHome },
    kids: [
      E('div', { style: { position: 'relative', width: 18, height: 18 }, kids: [
        E('span', { style: { position: 'absolute', left: 6, top: 0, width: 6, height: 6, background: t.ink } }),
        E('span', { style: { position: 'absolute', left: 0, top: 6, width: 6, height: 6, background: t.ink } }),
        E('span', { style: { position: 'absolute', right: 0, top: 6, width: 6, height: 6, background: t.ink } }),
        E('span', { style: { position: 'absolute', left: 6, bottom: 0, width: 6, height: 6, background: t.ink } }),
      ] }),
      E('span', { text: 'DëvSec', style: { fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: '0.02em', color: t.ink, fontWeight: 500 } }),
    ],
  });

  const tabStyle = (active) => ({
    fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase',
    color: active ? t.ink : t.ink3, padding: '6px 9px', background: 'transparent', border: 'none',
    borderRadius: 4, cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap',
  });
  const tab = (label, href, active) => E('a', {
    text: label, attrs: { href }, style: tabStyle(active),
    hover: active ? null : { ...tabStyle(false), color: t.ink2, background: t.hover },
  });
  const tabs = E('nav', {
    attrs: { 'aria-label': 'Views' },
    style: { display: 'flex', alignItems: 'center', gap: 2 },
    kids: [tab('Campaigns', '?library', false), E('span', { text: 'Workflows', style: tabStyle(true) })],
  });

  const themeBtn = E('button', {
    style: { display: 'flex', alignItems: 'center', gap: 7, height: 30, padding: '0 11px', background: 'transparent', border: '1px solid ' + t.rule2, borderRadius: 4, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: t.ink2 },
    on: { click: toggleTheme },
    kids: [E('span', { text: state.theme === 'light' ? 'Light' : 'Dark' })],
  });

  return E('header', {
    style: { display: 'flex', alignItems: 'center', gap: 18, height: 54, flex: 'none', padding: '0 20px', borderBottom: '1px solid ' + t.rule, background: t.panel },
    kids: [logo, E('div', { style: { width: 1, height: 20, background: t.rule } }), tabs, E('div', { style: { flex: 1 } }), themeBtn],
  });
}

// ---- HOME: workspace map of every linked repo ----
function buildHome(t, pal) {
  const sevOrder = ['red', 'amber', 'green', 'grey'];
  const cards = PROJECTS.map((pr) => {
    const flows = allFlows(pr);
    const counts = { red: 0, amber: 0, green: 0, grey: 0 };
    flows.forEach((f) => counts[f.sev]++);
    const total = flows.length;
    const drawn = flows.filter((f) => f.drawn).length;
    const isLast = pr.id === state.lastProjectId;
    const segments = sevOrder.filter((k) => counts[k] > 0).map((k) =>
      E('span', { style: { flexGrow: counts[k], flexBasis: 0, background: pal[k].dot } }));
    let headline, hc;
    if (counts.red > 0) { headline = counts.red + (counts.red === 1 ? ' untested map' : ' untested maps'); hc = pal.red; }
    else if (counts.amber > 0) { headline = counts.amber + ' to watch'; hc = pal.amber; }
    else if (counts.green > 0) { headline = 'all clear'; hc = pal.green; }
    else { headline = 'not yet mapped'; hc = pal.grey; }
    const cardBase = { display: 'flex', flexDirection: 'column', width: '100%', padding: '18px 18px 14px', background: t.panel, border: '1px solid ' + t.rule2, borderRadius: 6, cursor: 'pointer', transition: 'border-color 150ms, background 150ms, box-shadow 150ms', textAlign: 'left', font: 'inherit', color: 'inherit' };

    const titleRow = E('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12 }, kids: [
      E('span', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, flex: 'none', marginTop: 1 }, kids: [glyph(pr.glyph, t.ink, 20)] }),
      E('div', { style: { flex: 1, minWidth: 0 }, kids: [
        E('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, kids: [
          E('span', { text: pr.name, style: { fontFamily: 'var(--font-sans)', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: t.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }),
          isLast ? E('span', { text: 'Last opened', style: { fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 3, background: t.sel, color: t.ink2, flex: 'none' } }) : null,
        ] }),
        E('span', { text: 'repo', style: { display: 'block', marginTop: 3, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: t.ink3 } }),
      ] }),
      E('span', { text: '→', style: { fontFamily: 'var(--font-mono)', fontSize: 15, color: t.ink3, flex: 'none', lineHeight: 1 } }),
    ] });

    const bar = E('div', { style: { display: 'flex', height: 6, borderRadius: 9999, overflow: 'hidden', margin: '16px 0 11px', background: t.rule }, kids: segments });

    const headlineRow = E('div', { style: { display: 'flex', alignItems: 'center', gap: 10 }, kids: [
      E('span', { text: headline, style: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: hc.ink } }),
      E('span', { style: { flex: 1 } }),
      E('span', { text: drawn + '/' + total + ' maps drawn', style: { fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: t.ink3 } }),
    ] });

    const footRow = E('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 11, paddingTop: 11, borderTop: '1px solid ' + t.rule }, kids: [
      E('span', { text: pr.areas.length + (pr.areas.length === 1 ? ' area · ' : ' areas · ') + total + ' flows', style: { fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: t.ink3 } }),
    ] });

    const card = E('button', {
      style: cardBase,
      hover: { ...cardBase, borderColor: t.ink, background: t.hover, boxShadow: '0 10px 34px rgba(0,0,0,0.16)' },
      on: { click: () => openProject(pr.id) },
      kids: [
        titleRow,
        E('p', { text: pr.role, style: { margin: '13px 0 0', fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.5, color: t.ink2 } }),
        bar, headlineRow, footRow,
      ],
    });

    // Per-repo copy lives as a sibling overlay, not a child — the card is itself a
    // <button>, and buttons can't nest. Reveal on card hover/focus (keyboard-safe).
    const copyBtn = buildCopyButton(t, { variant: 'ghost', title: `Copy ${pr.name} workflow reference`, getText: () => repoReferenceText(pr) });
    setStyle(copyBtn, { position: 'absolute', bottom: 12, right: 12, zIndex: 2, opacity: 0, transition: 'opacity 140ms' });
    copyBtn.addEventListener('focus', () => { copyBtn.style.opacity = '1'; });
    copyBtn.addEventListener('blur', () => { copyBtn.style.opacity = '0'; });
    return E('div', {
      style: { position: 'relative', display: 'flex' },
      on: {
        mouseenter: () => { copyBtn.style.opacity = '1'; },
        mouseleave: () => { copyBtn.style.opacity = '0'; },
      },
      kids: [card, copyBtn],
    });
  });

  const legend = [
    ['untested', pal.red.dot], ['watch', pal.amber.dot], ['solid', pal.green.dot], ['plain / stub', pal.grey.dot],
  ].map(([label, dot]) => E('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 }, kids: [
    E('span', { style: { width: 8, height: 8, borderRadius: 2, background: dot, flex: 'none' } }),
    E('span', { text: label, style: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: t.ink3 } }),
  ] }));

  const titleBlock = E('div', { style: { minWidth: 0 }, kids: [
    E('h1', { text: 'Your linked repos', style: { margin: '0 0 13px', fontFamily: 'var(--font-display)', fontSize: 34, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.06, color: t.ink } }),
    E('p', { text: "Every repository you've connected, scanned on your machine. Open one to walk its workflows. Maps that haven't been drawn yet are shown directly — never hidden behind a single safety score.", style: { margin: 0, maxWidth: '62ch', fontFamily: 'var(--font-sans)', fontSize: 15, lineHeight: 1.6, color: t.ink2 } }),
  ] });

  const inner = E('div', { style: { maxWidth: 1120, margin: '0 auto', padding: '54px 40px 96px' }, kids: [
    E('div', { text: 'DëvSec / Workspace', style: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.22em', textTransform: 'uppercase', color: t.ink3, marginBottom: 18 } }),
    E('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }, kids: [
      titleBlock,
      buildCopyButton(t, { label: 'Copy reference for AI', title: 'Copy a reference to every linked repo’s workflow maps', getText: collectionReferenceText }),
    ] }),
    E('div', { style: { display: 'flex', alignItems: 'center', gap: 18, margin: '32px 0 22px' }, kids: [
      E('span', { text: PROJECTS.length + (PROJECTS.length === 1 ? ' repo' : ' repos'), style: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: t.ink3, flex: 'none' } }),
      E('span', { style: { height: 1, flex: 1, background: t.rule } }),
      E('div', { style: { display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }, kids: legend }),
    ] }),
    E('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(332px,1fr))', gap: 16 }, kids: cards }),
  ] });

  return E('div', { attrs: { 'data-screen-label': 'Workspace home' }, style: { flex: 1, overflowY: 'auto', minHeight: 0, background: t.card }, kids: [inner] });
}

// ---- PROJECT: sidebar + viewer ----
function buildProject(t, pal) {
  return E('div', { style: { flex: 1, display: 'flex', minHeight: 0 }, kids: [buildSidebar(t, pal), buildViewer(t, pal)] });
}

function buildSidebar(t, pal) {
  const p = project();
  const fa = filtersActive();

  const projBtn = E('button', {
    style: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 8px', background: 'transparent', border: 'none', borderRadius: 8, cursor: 'pointer' },
    hover: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 8px', background: t.hover, border: 'none', borderRadius: 8, cursor: 'pointer' },
    on: { click: toggleProjOpen },
    kids: [
      E('span', { style: { position: 'relative', width: 17, height: 17, flex: 'none' }, kids: [
        E('span', { style: { position: 'absolute', left: 6, top: 1, width: 5, height: 5, background: t.ink } }),
        E('span', { style: { position: 'absolute', left: 1, top: 6, width: 5, height: 5, background: t.ink } }),
        E('span', { style: { position: 'absolute', right: 1, top: 6, width: 5, height: 5, background: t.ink } }),
        E('span', { style: { position: 'absolute', left: 6, bottom: 1, width: 5, height: 5, background: t.ink } }),
      ] }),
      E('span', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left' }, kids: [
        E('span', { text: p.name, style: { fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', color: t.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }),
        E('span', { text: allFlows(p).length + ' flows', style: { fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: t.ink3 } }),
      ] }),
      E('span', { text: state.projOpen ? '▴' : '▾', style: { fontFamily: 'var(--font-mono)', fontSize: 11, color: t.ink3, flex: 'none' } }),
    ],
  });

  const repoCopy = buildCopyButton(t, { variant: 'ghost', title: `Copy ${p.name} workflow reference`, getText: () => repoReferenceText(p) });
  const switcher = E('div', { style: { flex: 'none', padding: '10px 10px 9px', borderBottom: '1px solid ' + t.rule, position: 'relative' }, kids: [
    E('div', { style: { display: 'flex', alignItems: 'center', gap: 6 }, kids: [
      E('div', { style: { flex: 1, minWidth: 0 }, kids: [projBtn] }),
      repoCopy,
    ] }),
  ] });
  if (state.projOpen) {
    switcher.append(E('div', {
      style: { position: 'absolute', left: 10, right: 10, top: 60, zIndex: 30, background: t.pop, border: '1px solid ' + t.rule2, borderRadius: 8, boxShadow: '0 16px 44px rgba(0,0,0,0.4)', overflow: 'hidden', animation: 'wffade 140ms ease', maxHeight: 360, overflowY: 'auto' },
      kids: PROJECTS.map((pr) => {
        const active = pr.id === state.projectId;
        return E('button', {
          style: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 12px', background: active ? t.sel : 'transparent', border: 'none', borderBottom: '1px solid ' + t.rule, cursor: 'pointer', textAlign: 'left' },
          on: { click: () => switchProject(pr.id) },
          kids: [
            E('span', { style: { width: 6, height: 6, background: active ? t.ink : t.rule2, flex: 'none' } }),
            E('span', { text: pr.name, style: { flex: 1, fontFamily: 'var(--font-sans)', fontSize: 13, color: t.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }),
            E('span', { text: allFlows(pr).length + '', style: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.08em', color: t.ink3 } }),
          ],
        });
      }),
    }));
  }

  const scroll = E('div', {
    attrs: { 'data-wf-tree': '1' },
    style: { flex: 1, overflowY: 'auto', minHeight: 0, padding: '8px 8px 24px' },
    on: { scroll: (e) => { state.sidebarScroll = e.currentTarget.scrollTop; } },
  });

  const groups = filterGroupsFor(p);
  const activeCount = state.filters.persona.length + state.filters.source.length + state.filters.kind.length;
  if (groups.length) {
    const filterBtnBase = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 8px', background: 'transparent', border: 'none', borderRadius: 6, cursor: 'pointer' };
    scroll.append(E('button', {
      style: filterBtnBase, hover: { ...filterBtnBase, background: t.hover },
      on: { click: toggleFilters },
      kids: [
        E('span', { style: { width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', color: t.ink3 }, kids: [ic('filter', t.ink3, 15)] }),
        E('span', { text: 'Filter', style: { flex: 1, textAlign: 'left', fontFamily: 'var(--font-sans)', fontSize: 13, color: t.ink2 } }),
        fa ? E('span', { text: String(activeCount), style: { minWidth: 16, height: 16, padding: '0 5px', borderRadius: 9999, background: t.ink, color: t.onInk, fontFamily: 'var(--font-mono)', fontSize: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' } }) : null,
        E('span', { text: state.filtersOpen ? '▾' : '▸', style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: t.ink3 } }),
      ],
    }));

    if (state.filtersOpen) {
      const panel = E('div', { style: { padding: '8px 6px 12px' } });
      groups.forEach((g) => {
        panel.append(E('div', { style: { marginBottom: 12 }, kids: [
          E('div', { text: g.label, style: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: t.ink3, marginBottom: 7 } }),
          E('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 }, kids: g.values.map((v) => {
            const active = state.filters[g.key].includes(v);
            return E('button', {
              text: v,
              style: { padding: '4px 9px', borderRadius: 4, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', background: active ? t.ink : t.chip, color: active ? t.onInk : t.ink2, border: '1px solid ' + (active ? t.ink : t.rule2) },
              on: { click: () => toggleTag(g.key, v) },
            });
          }) }),
        ] }));
      });
      if (fa) panel.append(E('button', { text: 'Clear all filters', style: { marginTop: 2, padding: '6px 11px', background: 'transparent', border: '1px solid ' + t.rule2, borderRadius: 6, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12, color: t.ink2 }, on: { click: clearFilters } }));
      scroll.append(panel);
    }
  }

  let matchCount = 0; allFlows(p).forEach((f) => { if (matchFlow(f)) matchCount++; });

  // Tiny mono control used for the tree's "Expand/Collapse all" and "Heatmap" toggles.
  const treeCtl = (label, active, onClick, title) => {
    const base = { fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '3px 7px', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap', flex: 'none', background: active ? t.ink : 'transparent', color: active ? t.onInk : t.ink3, border: '1px solid ' + (active ? t.ink : t.rule2) };
    return E('button', {
      text: label, attrs: { type: 'button', title }, style: base,
      hover: active ? null : { ...base, color: t.ink2, background: t.hover, borderColor: t.rule2 },
      on: { click: onClick },
    });
  };

  scroll.append(E('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '14px 8px 6px' }, kids: [
    E('span', { text: 'Workflows', style: { flex: 1, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: t.ink3 } }),
    fa ? E('span', { text: matchCount + ' match' + (matchCount === 1 ? '' : 'es'), style: { fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: t.ink2, flex: 'none' } })
       : treeCtl(allExpanded(p) ? 'Collapse all' : 'Expand all', false, toggleAllExpand, allExpanded(p) ? 'Collapse every folder' : 'Expand every folder'),
    treeCtl('Heatmap', state.tintIssues, toggleTint, 'Tint folders & files red/amber where workflows have issues'),
  ] }));

  buildTreeRows(t, pal).forEach((row) => scroll.append(row));

  return E('aside', { style: { width: 320, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: '1px solid ' + t.rule, background: t.panel }, kids: [switcher, scroll] });
}

// Finder/Xcode-style file browser: hierarchy from indentation + folder/file icons +
// weight. One neutral selection pill; STUB tag on undrawn leaves.
function buildTreeRows(t, pal) {
  const p = project();
  const fa = filtersActive();
  const isExp = (k) => (fa ? true : !!state.expanded[k]);
  const tint = state.tintIssues;
  const rows = [];
  const labelBase = { flex: 1, minWidth: 0, fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
  const iconWrap = (c) => ({ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', color: c });

  p.areas.forEach((area, ai) => {
    const areaFlowsAll = []; area.subs.forEach((s) => s.flows.forEach((f) => areaFlowsAll.push(f)));
    const areaFlows = areaFlowsAll.filter((f) => !fa || matchFlow(f));
    if (fa && areaFlows.length === 0) return;
    const aExp = isExp(area.name);
    const aSev = tint ? worstOf(areaFlows) : null;
    const aRow = { display: 'flex', alignItems: 'center', gap: 7, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', marginTop: ai === 0 ? 0 : 7,
      ...(aSev ? { background: tintBg(aSev, 'area'), boxShadow: 'inset 3px 0 0 ' + pal[aSev].dot } : {}) };
    rows.push(E('div', {
      style: aRow, hover: { ...aRow, background: aSev ? tintHoverBg(aSev, 'area') : t.hover },
      on: { click: () => toggleExpand(area.name) },
      kids: [
        E('span', { text: aExp ? '▾' : '▸', style: { width: 12, flex: 'none', textAlign: 'center', fontFamily: 'var(--font-mono)', color: t.ink3, fontSize: 9 } }),
        E('span', { style: iconWrap(t.ink2), kids: [ic(aExp ? 'folder-open' : 'folder', t.ink2, 16)] }),
        E('span', { text: area.name, style: { ...labelBase, fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.01em', color: t.ink } }),
      ],
    }));
    if (!aExp) return;

    area.subs.forEach((sub) => {
      const subFlows = sub.flows.filter((f) => !fa || matchFlow(f));
      if (fa && subFlows.length === 0) return;
      const sKey = area.name + '/' + sub.name;
      const sExp = isExp(sKey);
      const sSev = tint ? worstOf(subFlows) : null;
      const sRow = { display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px', borderRadius: 6, cursor: 'pointer', marginLeft: 16,
        ...(sSev ? { background: tintBg(sSev, 'sub'), boxShadow: 'inset 3px 0 0 ' + pal[sSev].dot } : {}) };
      rows.push(E('div', {
        style: sRow, hover: { ...sRow, background: sSev ? tintHoverBg(sSev, 'sub') : t.hover },
        on: { click: () => toggleExpand(sKey) },
        kids: [
          E('span', { text: sExp ? '▾' : '▸', style: { width: 12, flex: 'none', textAlign: 'center', fontFamily: 'var(--font-mono)', color: t.ink3, fontSize: 8 } }),
          E('span', { style: iconWrap(t.ink3), kids: [ic(sExp ? 'folder-open' : 'folder', t.ink3, 15)] }),
          E('span', { text: sub.name, style: { ...labelBase, fontSize: 12.5, fontWeight: 500, color: t.ink2 } }),
        ],
      }));
      if (!sExp) return;

      subFlows.forEach((f) => {
        const sel = f.id === state.selectedFlowId;
        const fSev = tint && (f.sev === 'red' || f.sev === 'amber') ? f.sev : null;
        const fRow = { display: 'flex', alignItems: 'center', gap: 7, padding: '5px 8px', borderRadius: 6, cursor: 'pointer', marginLeft: 32,
          background: sel ? t.sel : (fSev ? tintBg(fSev, 'flow') : 'transparent'),
          ...(fSev ? { boxShadow: 'inset 3px 0 0 ' + pal[fSev].dot } : {}) };
        const icColor = sel ? t.ink : t.ink3;
        rows.push(E('div', {
          style: fRow, hover: { ...fRow, background: sel ? t.sel : (fSev ? tintHoverBg(fSev, 'flow') : t.hover) },
          on: { click: () => selectFlow(f) },
          kids: [
            E('span', { style: { width: 12, flex: 'none' } }),
            E('span', { style: iconWrap(icColor), kids: [ic(f.drawn ? 'file' : 'file-stub', icColor, 16)] }),
            E('span', { text: f.name, style: { ...labelBase, fontSize: 12.5, fontWeight: sel ? 600 : 400, letterSpacing: '-0.005em', color: sel ? t.ink : (f.drawn ? t.ink2 : t.ink3) } }),
            fSev ? E('span', { style: { width: 7, height: 7, borderRadius: 9999, background: pal[fSev].dot, flex: 'none' } }) : null,
            !f.drawn ? E('span', { text: 'STUB', style: { fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '0.14em', color: t.ink3, flex: 'none' } }) : null,
          ],
        }));
      });
    });
  });
  return rows;
}

function buildViewer(t, pal) {
  const p = project();
  const f = flow();
  if (!f) {
    return E('main', { style: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: t.card }, kids: [
      E('p', { text: 'No workflow selected.', style: { fontFamily: 'var(--font-sans)', fontSize: 14, color: t.ink2 } }),
    ] });
  }

  const chipBase = { display: 'inline-flex', gap: 6, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '5px 10px', borderRadius: 4, background: t.chip, border: '1px solid ' + t.rule2, color: t.ink2 };
  const metaChips = [];
  if (f.personas.length) metaChips.push(['Used by ', f.personas.join(', ')]);
  if (f.sources.length) metaChips.push(['Source ', f.sources.join(', ')]);
  if (f.kind) metaChips.push(['Kind ', f.kind]);
  const chips = metaChips.map(([k, v]) => E('span', { style: chipBase, kids: [
    E('span', { text: k, style: { opacity: 0.55 } }), document.createTextNode(v),
  ] }));

  const header = E('div', { style: { flex: 'none', padding: '22px 30px 18px', borderBottom: '1px solid ' + t.rule }, kids: [
    E('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 13, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: t.ink3, flexWrap: 'wrap' }, kids: [
      E('span', { text: p.name }), E('span', { text: '/' }), E('span', { text: f._area }), E('span', { text: '/' }), E('span', { text: f._sub, style: { color: t.ink2 } }),
    ] }),
    E('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 16 }, kids: [
      E('div', { style: { flex: 1, minWidth: 0 }, kids: [
        E('h1', { text: f.name, style: { margin: '0 0 8px', fontFamily: 'var(--font-display)', fontSize: 27, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.12, color: t.ink } }),
        // Plain "used when X" leads; the precise one-liner follows in a muted tone.
        // No purpose authored (older maps) → the desc leads, as before.
        (f.purpose || f.desc) ? E('p', { text: f.purpose || f.desc, style: { margin: 0, fontFamily: 'var(--font-sans)', fontSize: 15, lineHeight: 1.6, color: t.ink, maxWidth: '62ch' } }) : null,
        (f.purpose && f.desc) ? E('p', { text: f.desc, style: { margin: '7px 0 0', fontFamily: 'var(--font-sans)', fontSize: 13.5, lineHeight: 1.55, color: t.ink3, maxWidth: '62ch' } }) : null,
      ] }),
      // Copy a reference to this one workflow map (its file path + what it is).
      buildCopyButton(t, { variant: 'ghost', title: `Copy "${f.name}" workflow reference`, getText: () => flowReferenceText(p, f) }),
    ] }),
    chips.length ? E('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 15 }, kids: chips }) : null,
  ] });

  const body = f.drawn ? buildChart(f, t, pal) : buildStub(f, t);
  return E('main', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: t.card }, kids: [header, body] });
}

// Drawn flow: the Mermaid map, converted to positioned nodes + orthogonal edges by
// workflow-chart.js (lazily, cached on the flow). Hover/pin handled imperatively so
// the SVG stays stable under the pointer; the tooltip shows for pinnedNode || hoverNode.
function buildChart(flow, t, pal) {
  if (flow.chart === undefined) {
    flow.chart = flow._mermaid ? mermaidToChart(flow._mermaid, flow._sidecar) : null;
  }
  const c = flow.chart;
  if (!c || !c.nodes.length) {
    return E('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0, padding: '40px', textAlign: 'center' }, kids: [
      E('p', { text: "This map is marked drawn, but its diagram couldn't be read. Regenerate it with /workflow-map.", style: { fontFamily: 'var(--font-sans)', fontSize: 14, lineHeight: 1.6, color: t.ink2, maxWidth: '44ch' } }),
    ] });
  }
  const NW = 200, NH = 64;

  const defs = S('defs', {}, [
    S('marker', { id: 'wfarrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, [
      S('path', { d: 'M0 1 L9 5 L0 9', fill: 'none', stroke: t.edge, 'stroke-width': 1.4 }),
    ]),
  ]);
  const svg = S('svg', { width: c.w, height: c.h, style: 'position:absolute;left:0;top:0;pointer-events:none;overflow:visible' },
    [defs, ...c.edges.map((d) => S('path', { d, fill: 'none', stroke: t.edge, 'stroke-width': 1.5, 'marker-end': 'url(#wfarrow)' }))]);

  const canvas = E('div', { style: { position: 'relative', width: c.w, height: c.h, minWidth: c.w, margin: '0 auto' } });
  canvas.append(svg);

  const tip = E('div', { style: { display: 'none' } });
  const tipBody = E('div', { style: { fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.5, color: t.ink } });
  tip.append(tipBody);
  canvas.append(tip);

  const nodeEls = c.nodes.map((n) => {
    const cp = pal[n.sev];
    const box = E('div', {
      style: { position: 'absolute', left: n.x, top: n.y, width: NW, height: NH, padding: '9px 11px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5, cursor: 'pointer', background: cp.fill, border: '1px solid ' + cp.bd, borderRadius: 3, boxShadow: '0 1px 0 rgba(0,0,0,0.03)', transition: 'box-shadow 150ms, outline 100ms', zIndex: 1 },
      on: {
        mouseenter: () => { state.hoverNode = n.id; sync(); },
        mouseleave: () => { state.hoverNode = null; sync(); },
        click: () => { state.pinnedNode = state.pinnedNode === n.id ? null : n.id; sync(); },
      },
      kids: [E('div', { text: n.label, style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 500, lineHeight: 1.25, color: t.ink } })],
    });
    canvas.append(box);
    return { n, cp, box };
  });

  function sync() {
    const activeId = state.pinnedNode || state.hoverNode;
    nodeEls.forEach(({ n, cp, box }) => {
      const active = n.id === activeId;
      box.style.outline = active ? '2px solid ' + cp.dot : 'none';
      box.style.outlineOffset = '1px';
      box.style.boxShadow = active ? '0 6px 22px rgba(0,0,0,0.13)' : '0 1px 0 rgba(0,0,0,0.03)';
      box.style.zIndex = active ? '5' : '1';
    });
    const an = activeId ? c.nodes.find((x) => x.id === activeId) : null;
    if (!an || !an.exp) { tip.style.display = 'none'; return; }
    const cp = pal[an.sev];
    let left = an.x + NW + 16;
    if (an.x + NW + 16 + 264 > c.w) left = an.x - 280;
    if (left < 0) left = an.x;
    let top = an.y - 6; if (top < 0) top = 0; if (top + 120 > c.h) top = c.h - 122;
    // Tooltip body: the plain description, and for a flagged (amber/red) node a
    // divider + a one-sentence "why it's flagged" — the earned-colour reason, in
    // the same hover box. Greens/neutrals show the description alone.
    // A flagged (red/amber) node shows "why it's flagged"; an accepted (green✻) node
    // shows its footnote — "why it's not a plain green". Plain greens/neutrals: desc only.
    const noted = an.why && (an.sev === 'red' || an.sev === 'amber' || an.sev === 'accepted');
    const noteHeader = an.sev === 'red' ? "Why it's red" : an.sev === 'amber' ? "Why it's amber" : "Why it's green ✻";
    tipBody.replaceChildren(
      E('div', { text: an.exp, style: { fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.5, color: t.ink } }),
      ...(noted ? [
        E('div', { style: { height: 1, background: t.rule, margin: '10px 0 9px' } }),
        E('div', { text: noteHeader, style: { fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.13em', textTransform: 'uppercase', color: cp.dot, marginBottom: 5 } }),
        E('div', { text: an.why, style: { fontFamily: 'var(--font-sans)', fontSize: 12.5, lineHeight: 1.5, color: t.ink2 } }),
      ] : []),
    );
    setStyle(tip, { display: 'block', position: 'absolute', left, top, width: 264, padding: '12px 14px', background: t.pop, backdropFilter: 'blur(8px)', border: '1px solid ' + cp.bd, borderLeft: '3px solid ' + cp.dot, borderRadius: 4, boxShadow: '0 14px 40px rgba(0,0,0,0.18)', zIndex: 20, animation: 'wffade 130ms ease', pointerEvents: 'none' });
  }
  sync();

  // ---- Zoom: Fit / − / + buttons, trackpad pinch, and per-flow persistence ----
  // The canvas is the content layer; we scale it with one CSS transform and size a
  // `stage` wrapper to the scaled box so the scroll container scrolls the whole map.
  setStyle(canvas, { position: 'absolute', left: 0, top: 0, margin: 0, transformOrigin: '0 0' });
  const stage = E('div', { style: { position: 'relative', width: c.w, height: c.h, margin: '0 auto', transformOrigin: '0 0' }, kids: [canvas] });
  const viewport = E('div', { style: { flex: 1, overflow: 'auto', minHeight: 0, position: 'relative', padding: '34px 30px 60px' }, kids: [stage] });

  const ZMIN = 0.2, ZMAX = 3, STEP = 1.2;
  const clampZ = (z) => Math.min(ZMAX, Math.max(ZMIN, z));
  const firstOpen = typeof flow._zoom !== 'number'; // auto-fit only the first time this map is viewed
  let zoom = firstOpen ? 1 : flow._zoom;
  let zlabel = null;
  let userTouched = false; // set once the user zooms — suppresses the deferred auto-fit

  function setZoom(z) {
    zoom = clampZ(z);
    flow._zoom = zoom; // persist across re-renders (theme toggle, node select) and flow revisits
    canvas.style.transform = `scale(${zoom})`;
    stage.style.width = (c.w * zoom) + 'px';
    stage.style.height = (c.h * zoom) + 'px';
    if (zlabel) zlabel.textContent = Math.round(zoom * 100) + '%';
  }

  // Zoom while keeping the point under (clientX,clientY) fixed — read the scaled
  // canvas rect before and after so centring, padding and scroll are all handled.
  function zoomAt(clientX, clientY, factor) {
    userTouched = true;
    const r1 = canvas.getBoundingClientRect();
    const fx = r1.width ? (clientX - r1.left) / r1.width : 0.5;
    const fy = r1.height ? (clientY - r1.top) / r1.height : 0.5;
    setZoom(zoom * factor);
    const r2 = canvas.getBoundingClientRect();
    viewport.scrollLeft += r2.left - (clientX - fx * r2.width);
    viewport.scrollTop += r2.top - (clientY - fy * r2.height);
  }

  function zoomFromButton(factor) {
    const r = viewport.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
  }

  function fitToView() {
    const r = viewport.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const z = Math.min((r.width - 64) / c.w, (r.height - 96) / c.h);
    setZoom(Math.min(1, z)); // fit shrinks to show the whole map, but never magnifies past 100%
    viewport.scrollTop = 0;  // margin:auto re-centres horizontally
  }

  // Trackpad pinch arrives as wheel + ctrlKey (also Ctrl+scroll on a mouse). Plain
  // wheel / two-finger scroll is left untouched so it still pans the map.
  viewport.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const factor = Math.min(1.25, Math.max(0.8, Math.exp(-e.deltaY * 0.01))); // cap so one mouse notch isn't a leap
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false });

  // ---- Floating zoom control, bottom-right of the viewport ----
  const mono = { fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.04em' };
  const ctlBtn = (label, title, on, big) => {
    const s = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 30, height: 30, padding: '0 9px', background: 'transparent', border: 'none', cursor: 'pointer', color: t.ink2, ...mono, fontSize: big ? 16 : 11, lineHeight: 1 };
    return E('button', {
      text: label, attrs: { type: 'button', title, 'aria-label': title }, style: s,
      hover: { ...s, background: t.hover, color: t.ink },
      on: { click: (e) => { e.preventDefault(); e.stopPropagation(); on(); } },
    });
  };
  zlabel = E('span', {
    text: '100%', attrs: { title: 'Reset to 100%', role: 'button', tabindex: '0' },
    style: { minWidth: 46, textAlign: 'center', cursor: 'pointer', color: t.ink2, ...mono },
    on: { click: () => setZoom(1), keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setZoom(1); } } },
  });
  const sep = () => E('span', { style: { width: 1, height: 18, background: t.rule2, flex: 'none' } });
  viewport.append(E('div', {
    style: { position: 'absolute', right: 22, bottom: 18, zIndex: 10, display: 'flex', alignItems: 'center', gap: 2, padding: '3px 4px', background: t.pop, border: '1px solid ' + t.rule2, borderRadius: 8, boxShadow: '0 8px 26px rgba(0,0,0,0.18)' },
    kids: [
      ctlBtn('Fit', 'Fit map to view', fitToView),
      sep(),
      ctlBtn('−', 'Zoom out', () => zoomFromButton(1 / STEP), true),
      zlabel,
      ctlBtn('+', 'Zoom in', () => zoomFromButton(STEP), true),
    ],
  }));

  setZoom(zoom);
  // First view of a map opens fitted to overview. The viewport is still detached here
  // and mount/layout can lag a frame, so poll across animation frames until it has a
  // real size, then fit once — skipped if the user has already zoomed in the meantime.
  if (firstOpen) {
    let tries = 0;
    const attemptFit = () => {
      if (userTouched) return;
      const r = viewport.getBoundingClientRect();
      if (r.width && r.height) { fitToView(); return; }
      if (tries++ < 60) requestAnimationFrame(attemptFit); // ~1s of frames, then give up at 100%
    };
    requestAnimationFrame(attemptFit);
  }
  return viewport;
}

// Undrawn flow: the "map not yet drawn" stub + the real entry points / ending from
// the authored record (the design's "intended steps", filled with what we actually have).
function buildStub(flow, t) {
  const dashBox = () => E('span', { style: { width: 34, height: 20, border: '1.5px dashed ' + t.rule2 } });
  const arrow = () => E('span', { text: '→', style: { alignSelf: 'center', color: t.ink3 } });

  const placeholder = E('div', { style: { border: '1.5px dashed ' + t.rule2, borderRadius: 4, padding: '42px 32px', textAlign: 'center', background: t.stub }, kids: [
    E('div', { style: { display: 'inline-flex', gap: 5, marginBottom: 18 }, kids: [dashBox(), arrow(), dashBox(), arrow(), dashBox()] }),
    E('div', { text: 'Map not yet drawn', style: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: t.ink3, marginBottom: 10 } }),
    E('p', { text: "This workflow is on the backlog. A flowchart hasn't been mapped for it yet — drawing one will surface its fragility like the others.", style: { margin: '0 auto 22px', fontFamily: 'var(--font-sans)', fontSize: 14, lineHeight: 1.55, color: t.ink2, maxWidth: '42ch' } }),
    E('button', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 18px', background: t.ink, color: t.onInk, border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 500 }, kids: [
      document.createTextNode('Start drawing this map'), E('span', { text: '+', style: { fontFamily: 'var(--font-mono)' } }),
    ] }),
  ] });

  const innerKids = [placeholder];
  if (flow.entryPoints.length) {
    innerKids.push(E('div', { style: { marginTop: 30 }, kids: [
      E('div', { text: 'Where it starts · from the stub', style: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: t.ink3, marginBottom: 13 } }),
      E('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 }, kids: flow.entryPoints.map((s, i) =>
        E('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', border: '1px solid ' + t.rule, borderRadius: 4, background: t.stub }, kids: [
          E('span', { text: String(i + 1).padStart(2, '0'), style: { fontFamily: 'var(--font-mono)', fontSize: 10, color: t.ink3, width: 18, flex: 'none' } }),
          E('span', { style: { width: 7, height: 7, borderRadius: 9999, background: t.rule2, flex: 'none' } }),
          E('span', { text: s, style: { fontFamily: 'var(--font-sans)', fontSize: 13.5, color: t.ink2 } }),
        ] })) }),
      flow.endsWith ? E('p', { style: { margin: '14px 2px 0', fontFamily: 'var(--font-sans)', fontSize: 13, lineHeight: 1.5, color: t.ink2 }, kids: [
        E('span', { text: 'Ends with — ', style: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.ink3 } }),
        document.createTextNode(flow.endsWith),
      ] }) : null,
    ] }));
  }

  return E('div', { style: { flex: 1, overflow: 'auto', minHeight: 0, padding: '38px 30px 60px', display: 'flex', flexDirection: 'column', alignItems: 'center' }, kids: [
    E('div', { style: { width: '100%', maxWidth: 560 }, kids: innerKids }),
  ] });
}

// ---------------------------------------------------------------------------
// OS THEME FOLLOW — keep tracking the system setting live, until the user picks a
// side with the toggle. Registered once at import; re-renders only while mounted.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (state.themeManual) return; // user has chosen — don't yank it back
    const next = mq.matches ? 'dark' : 'light';
    if (next === state.theme) return;
    state.theme = next;
    if (mountEl) render();
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange); // Safari < 14
}
