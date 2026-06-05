// Campaign Companion — a compact, read-only status surface.
//
// Polls /api/companion-state for the campaign feed and /api/companion-pet for
// Kro's sprite. Everything here is observe-only: it never mutates state, and it
// throttles itself to near-nothing when the window is hidden so a parked popup
// (or a future always-on-top panel) never burns cycles in the background.
//
// Conventions mirror app.js: a small `element()` builder, `relativeTime()` for
// human elapsed strings, and the same status vocabulary the server emits.

const STATE_URL = '/api/companion-state';
const PET_URL = '/api/companion-pet';

// Poll cadence. The state feed changes on the order of seconds while work runs,
// so 4s feels live without hammering. The pet package effectively never changes
// at runtime, so we fetch it once on load and only re-check lazily.
const STATE_POLL_MS = 4_000;

// Companion statuses sort into four bands. Order = visual priority top-to-bottom:
// things that need a human first, live work next, resting work, then the quiet
// tail. Mirrors the server's COMPANION_STATUSES vocabulary.
const STATUS_BAND = {
  stalled: 'attention',
  failed: 'attention',
  halted: 'attention',
  running: 'active',
  queued: 'active',
  paused: 'resting',
  stale: 'resting',
  idle: 'quiet',
  completed: 'quiet',
};
const BAND_ORDER = { attention: 0, active: 1, resting: 2, quiet: 3 };

// Compact summary chips, in display order, each rolling up one band.
const BAND_CHIPS = [
  { band: 'attention', label: 'attention', color: 'var(--stalled)' },
  { band: 'active', label: 'running', color: 'var(--running)' },
  { band: 'resting', label: 'resting', color: 'var(--paused)' },
  { band: 'quiet', label: 'idle', color: 'var(--idle)' },
];

const els = {
  pet: document.getElementById('companion-pet'),
  petSprite: document.getElementById('companion-pet-sprite'),
  title: document.getElementById('companion-title'),
  counts: document.getElementById('companion-counts'),
  list: document.getElementById('companion-list'),
  empty: document.getElementById('companion-empty'),
  footDot: document.getElementById('companion-foot-dot'),
  footText: document.getElementById('companion-foot-text'),
};

const runtime = {
  pollTimer: null,
  petFrameTimer: null,
  petFrameCount: 0,
  petFrameIndex: 0,
  petActive: false, // whether any campaign is live, drives sprite tempo
};

init();

function init() {
  loadPet();
  startPolling();
  document.addEventListener('visibilitychange', handleVisibility);
}

/* ------------------------------ Polling ------------------------------------- */

// Self-scheduling poll: each tick fetches, renders, then queues the next. Using
// a chained timeout (not setInterval) means a slow response can't stack requests
// and a hidden page simply never re-arms.
function startPolling() {
  if (runtime.pollTimer) return;
  tick();
}

function stopPolling() {
  if (runtime.pollTimer) {
    clearTimeout(runtime.pollTimer);
    runtime.pollTimer = null;
  }
}

async function tick() {
  await refreshState();
  // Only re-arm while visible; visibilitychange restarts us when the page shows.
  if (!document.hidden) {
    runtime.pollTimer = setTimeout(tick, STATE_POLL_MS);
  } else {
    runtime.pollTimer = null;
  }
}

function handleVisibility() {
  if (document.hidden) {
    stopPolling();
    stopPetLoop();
  } else {
    startPetLoop();
    startPolling();
  }
}

/* ------------------------------ State feed ---------------------------------- */

async function refreshState() {
  let data;
  try {
    const response = await fetch(STATE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch {
    setFooter('error', 'Offline — retrying');
    return;
  }

  renderState(data);
}

function renderState(data) {
  const campaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
  renderCounts(data.counts ?? {}, campaigns);
  renderList(campaigns);

  // Sprite tempo follows whether any real work is live.
  runtime.petActive = campaigns.some((c) => c.status === 'running');
  if (!document.hidden) startPetLoop();

  const liveCount = campaigns.filter((c) => STATUS_BAND[c.status] === 'active').length;
  setFooter(
    'live',
    liveCount > 0 ? `${liveCount} active · updated ${clockNow()}` : `Idle · updated ${clockNow()}`,
  );
}

function renderCounts(counts, campaigns) {
  // Roll the per-status server counts up into the four bands. Falling back to a
  // client-side tally keeps the chips correct even if the server omits a status.
  const byBand = { attention: 0, active: 0, resting: 0, quiet: 0 };
  for (const campaign of campaigns) {
    const band = STATUS_BAND[campaign.status] ?? 'quiet';
    byBand[band] += 1;
  }

  els.counts.replaceChildren();
  const total = campaigns.length;
  els.counts.append(
    element('span', { className: 'companion-count', text: `${total} total` }),
  );

  for (const chip of BAND_CHIPS) {
    const n = byBand[chip.band];
    if (!n) continue;
    const wrap = element('span', { className: 'companion-count' });
    const dot = element('span', { className: 'companion-count-dot' });
    dot.style.background = chip.color;
    wrap.append(dot, document.createTextNode(`${n} ${chip.label}`));
    els.counts.append(wrap);
  }
}

function renderList(campaigns) {
  const sorted = [...campaigns].sort(compareCampaigns);

  if (sorted.length === 0) {
    els.list.replaceChildren(
      element('p', { className: 'companion-empty', text: 'No campaigns registered yet.' }),
    );
    return;
  }

  const rows = sorted.map(renderRow);
  els.list.replaceChildren(...rows);
}

// Sort by band priority, then most-recently-active first, then title. Stable,
// deterministic ordering so the list doesn't jitter between polls.
function compareCampaigns(a, b) {
  const bandA = BAND_ORDER[STATUS_BAND[a.status] ?? 'quiet'];
  const bandB = BAND_ORDER[STATUS_BAND[b.status] ?? 'quiet'];
  if (bandA !== bandB) return bandA - bandB;

  const timeA = Date.parse(a.lastActivityAt ?? '') || 0;
  const timeB = Date.parse(b.lastActivityAt ?? '') || 0;
  if (timeA !== timeB) return timeB - timeA;

  return (a.title ?? '').localeCompare(b.title ?? '');
}

function renderRow(campaign) {
  const row = element('div', { className: 'companion-row' });

  const dot = element('div', { className: 'companion-row-dot' });
  dot.style.color = statusColor(campaign.status);
  dot.style.background = 'currentColor';
  if (campaign.status === 'running') dot.classList.add('is-running');

  const title = element('div', {
    className: campaign.missing ? 'companion-row-title is-missing' : 'companion-row-title',
    text: campaign.title || 'Untitled campaign',
    title: campaign.missing ? 'Markdown file is missing from disk' : campaign.title || '',
  });

  const status = element('div', {
    className: 'companion-row-status',
    text: campaign.label || campaign.status || '',
  });
  status.style.color = statusColor(campaign.status);

  const meta = element('div', { className: 'companion-row-meta' });
  for (const part of metaParts(campaign)) {
    if (meta.childNodes.length) {
      meta.append(element('span', { className: 'sep', text: '·' }));
    }
    meta.append(part);
  }

  row.append(dot, title, status);
  if (meta.childNodes.length) row.append(meta);
  return row;
}

// Build the secondary line: backend · step · progress · last activity. Each
// piece only appears when it carries real information.
function metaParts(campaign) {
  const parts = [];

  if (campaign.backend) {
    parts.push(element('span', { className: 'backend', text: campaign.backend }));
  }

  const step = campaign.current_step;
  if (step && (step.id || step.name)) {
    const label = [step.id, step.name].filter(Boolean).join(' · ');
    parts.push(element('span', { className: 'step', text: label }));
  }

  const progress = campaign.progress;
  if (progress && progress.total > 0) {
    parts.push(element('span', { text: `${progress.done}/${progress.total}` }));
  }

  if (campaign.lastActivityAt) {
    parts.push(element('span', { text: relativeTime(campaign.lastActivityAt) }));
  }

  return parts;
}

function statusColor(status) {
  return `var(--${status || 'idle'}, var(--idle))`;
}

function setFooter(mode, text) {
  els.footDot.classList.toggle('is-live', mode === 'live');
  els.footDot.classList.toggle('is-error', mode === 'error');
  els.footText.textContent = text;
}

/* ------------------------------ Pet sprite ---------------------------------- */

// Fetch the selected pet once. When a package exists we set up the sprite cell
// from the contract grid and start a gentle frame loop; when none does we leave
// the pet block hidden and the page stays fully usable.
async function loadPet() {
  let data;
  try {
    const response = await fetch(PET_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
  } catch {
    return; // no pet, no problem — header just runs text-only
  }

  const pet = data?.pet;
  if (!pet || !pet.spritesheetUrl || !pet.sprite) return;

  setupSprite(pet);
  els.pet.hidden = false;
  if (!document.hidden) startPetLoop();
}

// Scale one sprite cell down to the header slot and prime the loop. The sheet is
// a fixed grid (8×9, 192×208 cells per the codex-pet contract); we render a
// single cell by sizing the element to the cell and the background to the whole
// scaled sheet, then stepping background-position per frame.
function setupSprite(pet) {
  const grid = pet.sprite;
  const displayWidth = 56;
  const scale = displayWidth / grid.cellWidth;
  const cellH = grid.cellHeight * scale;

  const node = els.petSprite;
  node.style.width = `${displayWidth}px`;
  node.style.height = `${cellH}px`;
  node.style.backgroundImage = `url("${pet.spritesheetUrl}")`;
  node.style.backgroundSize = `${grid.width * scale}px ${grid.height * scale}px`;

  // Animation mapping is intentionally minimal: the pet contract has no semantic
  // row names yet, so we loop a simple deterministic frame run along the first
  // row and leave named idle/running/attention animations to a later campaign.
  // Tempo (not frames) reflects activity — that's enough signal for now.
  runtime.petFrameCount = Math.min(grid.columns, 4);
  runtime.petCellStep = grid.cellWidth * scale;
  runtime.petFrameIndex = 0;
  positionSprite();
}

function positionSprite() {
  const x = -(runtime.petFrameIndex * (runtime.petCellStep || 0));
  els.petSprite.style.backgroundPosition = `${x}px 0px`;
}

function startPetLoop() {
  if (runtime.petFrameCount <= 0) return;
  stopPetLoop();
  // Faster, lighter step when work is live; a slow idle bob otherwise.
  const interval = runtime.petActive ? 200 : 460;
  runtime.petFrameTimer = setInterval(() => {
    runtime.petFrameIndex = (runtime.petFrameIndex + 1) % runtime.petFrameCount;
    positionSprite();
  }, interval);
}

function stopPetLoop() {
  if (runtime.petFrameTimer) {
    clearInterval(runtime.petFrameTimer);
    runtime.petFrameTimer = null;
  }
}

/* ------------------------------ Helpers ------------------------------------- */

// Minimal DOM builder, same shape as app.js's element() (the subset this page
// needs). Keeps row construction readable without a framework.
function element(tagName, options = {}) {
  const node = document.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  return node;
}

// Human elapsed string, matching app.js relativeTime() so both surfaces speak
// the same way ("just now", "4m ago", "2h ago", "3d ago", then a date).
function relativeTime(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  if (ms < 7 * 86_400_000) return `${Math.round(ms / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));
}

function clockNow() {
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date());
}
