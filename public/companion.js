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
const MODE_STORAGE_KEY = 'campaignCompanionMode';
const COLLAPSED_STORAGE_KEY = 'campaignCompanionCollapsed';

// Poll cadence. The state feed changes on the order of seconds while work runs,
// so 4s feels live without hammering. The pet package effectively never changes
// at runtime, so we fetch it once on load and only re-check lazily.
const STATE_POLL_MS = 4_000;
const RECENT_STALLED_NOTIFICATION_MS = 24 * 60 * 60 * 1000;
const PET_ANIMATIONS = {
  idle: { row: 0, frames: 6, durations: [280, 110, 110, 140, 140, 320] },
  running: { row: 7, frames: 6, durations: [120, 120, 120, 120, 120, 220] },
  waving: { row: 3, frames: 4, durations: [140, 140, 140, 280] },
};

// Companion statuses sort into five bands. Default view hides sleeping/quiet
// campaigns so the panel stays about what matters now, not the full archive.
const STATUS_BAND = {
  stalled: 'attention',
  failed: 'attention',
  halted: 'attention',
  running: 'active',
  queued: 'active',
  paused: 'paused',
  stale: 'sleeping',
  idle: 'quiet',
  completed: 'quiet',
};
const BAND_ORDER = { attention: 0, active: 1, paused: 2, sleeping: 3, quiet: 4 };
const ATTENTION_STATUSES = new Set(['stalled', 'failed', 'halted']);
const DEFAULT_VISIBLE_STATUSES = new Set(['running', 'queued', 'paused']);

// Compact summary chips, in display order, each rolling up one band.
const BAND_CHIPS = [
  { band: 'attention', label: 'attention', color: 'var(--stalled)' },
  { band: 'active', label: 'active', color: 'var(--running)' },
  { band: 'paused', label: 'paused', color: 'var(--paused)' },
  { band: 'sleeping', label: 'sleeping', color: 'var(--stale)' },
  { band: 'quiet', label: 'idle', color: 'var(--idle)' },
];

const els = {
  head: document.getElementById('companion-head'),
  petFallback: document.getElementById('companion-pet-fallback'),
  pet: document.getElementById('companion-pet'),
  petSprite: document.getElementById('companion-pet-sprite'),
  signal: document.getElementById('companion-signal'),
  collapseButton: document.getElementById('collapse-button'),
  collapsedExpandButton: document.getElementById('collapsed-expand-button'),
  openAppButton: document.getElementById('open-app-button'),
  activeModeButton: document.getElementById('active-mode-button'),
  allModeButton: document.getElementById('all-mode-button'),
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
  petFrameIndex: 0,
  petAnimation: 'idle',
  petCellStep: 0,
  petRowStep: 0,
  petHovered: false,
  petActive: false, // whether any campaign is live, drives sprite tempo
  campaigns: [],
  mode: localStorage.getItem(MODE_STORAGE_KEY) === 'all' ? 'all' : 'active',
  collapsed: localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1',
};

init();

function init() {
  els.collapseButton?.addEventListener('click', () => setCollapsed(true));
  els.collapsedExpandButton?.addEventListener('click', () => setCollapsed(false));
  els.openAppButton?.addEventListener('click', openApp);
  els.activeModeButton?.addEventListener('click', () => setMode('active'));
  els.allModeButton?.addEventListener('click', () => setMode('all'));
  els.list?.addEventListener('click', handleListClick);
  els.pet?.addEventListener('mouseenter', () => setPetHovered(true));
  els.pet?.addEventListener('mouseleave', () => setPetHovered(false));
  window.campaignCompanionSetCollapsedFromNative = (collapsed) => setCollapsed(collapsed);

  applyModeButtons();
  setCollapsed(runtime.collapsed, { persist: false });
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
  runtime.campaigns = campaigns;
  const visible = visibleCampaigns(campaigns);
  renderAttentionSignal(campaigns);
  renderCounts(campaigns, visible);
  renderList(visible);

  runtime.petActive = campaigns.some((c) => c.status === 'running');
  window.campaignCompanion?.setPetActive?.(runtime.petActive);
  updatePetAnimation();

  const liveCount = campaigns.filter((c) => STATUS_BAND[c.status] === 'active').length;
  const attentionCount = campaigns.filter(isNotification).length;
  setFooter(
    'live',
    attentionCount > 0
      ? `${attentionCount} attention · updated ${clockNow()}`
      : liveCount > 0
        ? `${liveCount} active · updated ${clockNow()}`
        : `No active work · updated ${clockNow()}`,
  );
}

function visibleCampaigns(campaigns) {
  if (runtime.mode === 'all') return campaigns;
  return campaigns.filter(isDefaultVisible);
}

function isDefaultVisible(campaign) {
  if (isNotification(campaign)) return true;
  if (campaign.parked) return false;
  return DEFAULT_VISIBLE_STATUSES.has(campaign.status);
}

function campaignBand(campaign) {
  if (campaign.status === 'stalled' && !isNotification(campaign)) return 'sleeping';
  if (campaign.parked && !ATTENTION_STATUSES.has(campaign.status)) return 'sleeping';
  return STATUS_BAND[campaign.status] ?? 'quiet';
}

function renderCounts(campaigns, visible) {
  // Roll the per-status server counts up into display bands. Falling back to a
  // client-side tally keeps the chips correct even if the server omits a status.
  const byBand = { attention: 0, active: 0, paused: 0, sleeping: 0, quiet: 0 };
  const tallySource = runtime.mode === 'all' ? campaigns : visible;
  for (const campaign of tallySource) {
    const band = campaignBand(campaign);
    byBand[band] += 1;
  }

  els.counts.replaceChildren();
  const total = runtime.mode === 'all' ? campaigns.length : visible.length;
  els.counts.append(
    element('span', {
      className: 'companion-count',
      text: runtime.mode === 'all' ? `${total} total` : `${total} relevant`,
    }),
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
      element('p', {
        className: 'companion-empty',
        text:
          runtime.mode === 'all'
            ? 'No campaigns registered yet.'
            : 'No active campaigns right now.',
      }),
    );
    return;
  }

  const rows = sorted.map(renderRow);
  els.list.replaceChildren(...rows);
}

// Sort by band priority, then most-recently-active first, then title. Stable,
// deterministic ordering so the list doesn't jitter between polls.
function compareCampaigns(a, b) {
  const bandA = BAND_ORDER[campaignBand(a)];
  const bandB = BAND_ORDER[campaignBand(b)];
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
  const copyButton = element('button', {
    className: 'companion-copy-button',
    title: copyTitle(campaign),
  });
  copyButton.type = 'button';
  copyButton.setAttribute('aria-label', copyTitle(campaign));
  copyButton.dataset.copyReference = copyReference(campaign);
  copyButton.dataset.copyKind = campaign.current_step?.path ? 'step' : 'campaign';
  copyButton.append(copyIcon());

  const actions = element('div', { className: 'companion-row-actions' });
  actions.append(status, copyButton);

  const meta = element('div', { className: 'companion-row-meta' });
  for (const part of metaParts(campaign)) {
    if (meta.childNodes.length) {
      meta.append(element('span', { className: 'sep', text: '·' }));
    }
    meta.append(part);
  }

  row.append(dot, title, actions);
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

function renderAttentionSignal(campaigns) {
  const count = campaigns.filter(isNotification).length;
  els.signal.classList.toggle('is-attention', count > 0);
  els.signal.textContent = count > 0 ? String(Math.min(count, 99)) : '';
  els.signal.title = count > 0
    ? `${count} important campaign${count === 1 ? '' : 's'} need attention`
    : 'No important notifications';
  window.campaignCompanion?.setBadgeCount?.(count);
}

function isNotification(campaign) {
  if (!campaign || campaign.parked) return false;
  return ATTENTION_STATUSES.has(campaign.status) && isRecentlyActive(campaign.lastActivityAt);
}

function isRecentlyActive(iso) {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && Date.now() - ms <= RECENT_STALLED_NOTIFICATION_MS;
}

function copyReference(campaign) {
  return campaign.current_step?.path || campaign.referencePath || campaign.filePath || '';
}

function copyTitle(campaign) {
  return campaign.current_step?.path ? 'Copy step path' : 'Copy campaign path';
}

async function handleListClick(event) {
  const button = event.target.closest('[data-copy-reference]');
  if (!button) return;
  const text = button.dataset.copyReference;
  if (!text) return;
  try {
    await copyText(text);
    const kind = button.dataset.copyKind === 'step' ? 'step' : 'campaign';
    button.classList.add('is-copied');
    setFooter('live', `Copied ${kind} path`);
    window.setTimeout(() => {
      button.classList.remove('is-copied');
    }, 1200);
  } catch {
    setFooter('error', 'Copy failed');
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('copy failed');
}

function setMode(mode) {
  runtime.mode = mode === 'all' ? 'all' : 'active';
  localStorage.setItem(MODE_STORAGE_KEY, runtime.mode);
  applyModeButtons();
  renderState({ campaigns: runtime.campaigns });
}

function applyModeButtons() {
  const all = runtime.mode === 'all';
  els.activeModeButton?.setAttribute('aria-pressed', String(!all));
  els.allModeButton?.setAttribute('aria-pressed', String(all));
}

function setCollapsed(collapsed, { persist = true } = {}) {
  runtime.collapsed = Boolean(collapsed);
  document.body.classList.toggle('is-collapsed', runtime.collapsed);
  document.documentElement.classList.toggle('is-collapsed', runtime.collapsed);
  if (els.collapsedExpandButton) els.collapsedExpandButton.hidden = !runtime.collapsed;
  els.collapseButton?.setAttribute('aria-pressed', String(runtime.collapsed));
  if (persist) localStorage.setItem(COLLAPSED_STORAGE_KEY, runtime.collapsed ? '1' : '0');
  setNativeCollapsed(runtime.collapsed);
}

function setNativeCollapsed(collapsed) {
  if (typeof window.campaignCompanion?.setCollapsed === 'function') {
    window.campaignCompanion.setCollapsed(collapsed);
    return;
  }
  try {
    window.resizeTo(collapsed ? 112 : 360, collapsed ? 128 : 520);
  } catch {}
}

function openApp() {
  if (typeof window.campaignCompanion?.openApp === 'function') {
    window.campaignCompanion.openApp();
    return;
  }

  const opened = window.open('/', 'campaigns-app');
  if (!opened) {
    window.location.href = '/';
  }
}

function copyIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const attrs of [
    { x: '8', y: '8', width: '11', height: '11', rx: '2' },
    { x: '5', y: '5', width: '11', height: '11', rx: '2' },
  ]) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    for (const [key, value] of Object.entries(attrs)) rect.setAttribute(key, value);
    svg.append(rect);
  }
  return svg;
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
  els.petFallback.hidden = true;
  els.pet.hidden = false;
  if (!document.hidden) startPetLoop();
}

// Scale one sprite cell down to the header slot and prime the loop. The sheet is
// a fixed grid (8x9, 192x208 cells per the codex-pet contract); we render a
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

  runtime.petCellStep = grid.cellWidth * scale;
  runtime.petRowStep = grid.cellHeight * scale;
  runtime.petFrameIndex = 0;
  runtime.petAnimation = desiredPetAnimation();
  positionSprite();
}

function positionSprite() {
  const animation = currentPetAnimation();
  const x = -(runtime.petFrameIndex * (runtime.petCellStep || 0));
  const y = -(animation.row * (runtime.petRowStep || 0));
  els.petSprite.style.backgroundPosition = `${x}px ${y}px`;
}

function startPetLoop() {
  if (!runtime.petCellStep) return;
  stopPetLoop();
  schedulePetFrame();
}

function schedulePetFrame() {
  const animation = currentPetAnimation();
  const duration = animation.durations[runtime.petFrameIndex]
    ?? animation.durations[animation.durations.length - 1]
    ?? 180;
  runtime.petFrameTimer = setTimeout(() => {
    const nextAnimation = currentPetAnimation();
    runtime.petFrameIndex = (runtime.petFrameIndex + 1) % nextAnimation.frames;
    positionSprite();
    schedulePetFrame();
  }, duration);
}

function stopPetLoop() {
  if (runtime.petFrameTimer) {
    clearTimeout(runtime.petFrameTimer);
    runtime.petFrameTimer = null;
  }
}

function setPetHovered(hovered) {
  runtime.petHovered = hovered;
  updatePetAnimation();
}

function updatePetAnimation() {
  const next = desiredPetAnimation();
  const changed = runtime.petAnimation !== next;
  if (changed) {
    runtime.petAnimation = next;
    runtime.petFrameIndex = 0;
    positionSprite();
  }
  if (!document.hidden && (changed || !runtime.petFrameTimer)) {
    startPetLoop();
  }
}

function desiredPetAnimation() {
  if (runtime.petHovered) return 'waving';
  return runtime.petActive ? 'running' : 'idle';
}

function currentPetAnimation() {
  return PET_ANIMATIONS[runtime.petAnimation] || PET_ANIMATIONS.idle;
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
