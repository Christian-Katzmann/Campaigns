// Away mode: the ETA model for automation runs and the "step out for N minutes"
// planner built on top of it — task library, adaptive estimates, the matcher, the
// countdown timer, and the overlay UI. A leaf module: it reads shared state and
// automation snapshots and builds its own DOM, but never calls the board, library,
// or drawer, so those can import its entry points without a cycle.

import {
  automateDisplayStatus,
  automateState,
  isAutomateAttention,
  isAutomateRunning,
  state,
} from './state.mjs';
import { element, showToast } from './dom.mjs';
import { ETA_STEP_BASELINES, fleetPriorForBackend } from '../lib/estimate-priors.mjs';

export { ETA_STEP_BASELINES } from '../lib/estimate-priors.mjs';

// One-line readout of the closest-fitting task(s) for the drawer panel. Keeps
// the inline panel honest without rebuilding the whole matcher UI there.
export function awayBestFitHint(windowMin) {
  if (!windowMin || windowMin <= 0) return 'Too tight for an away task — stay nearby.';
  const tasks = loadAwayTasks();
  const logs = loadAwayLogs();
  const matches = awayMatchTasks(windowMin, tasks, logs);
  if (!matches.length) return 'Nothing in your task library fits yet — add a shorter task.';
  const best = matches[0];
  const names = best.tasks.map((t) => t.name).join(' + ');
  const fit = best.overage ? `${best.overage}m over` : `${best.leftover}m spare`;
  return `Best fit: ${names} (${best.total}m, ${fit}).`;
}

export function estimateAutomateWait(data) {
  const window = awayStepWindow(data);
  if (!window) return null;

  const { baseline, elapsed, overTypical, minutes: safeAway, confidence } = window;
  const stepLow = Math.max(0, Math.round(baseline.median - elapsed));
  const stepHigh = Math.max(stepLow, Math.round(baseline.p90 - elapsed));
  const phase = estimateCurrentPhase(data, baseline, stepLow);

  return {
    baseline,
    confidence,
    safeAway,
    overTypical,
    windowLabel: overTypical ? 'Stay nearby' : formatAwayWindow(safeAway),
    stepRangeLabel: overTypical ? 'past usual range' : formatMinuteRange(stepLow, stepHigh),
    phaseWindowLabel: phase ? `~${formatWholeMinutes(phase.center)}` : '',
  };
}

// Confidence-driven safety buffer (minutes) subtracted from the p75 window.
// Tighter when we trust the sample, looser when we don't. Matches the ETA
// research: Claude pool is high-confidence (n=662), Codex medium (n=100).
const AWAY_SAFETY_BUFFER = Object.freeze({ high: 2, medium: 3, low: 5 });

// The one safe-window calculation, shared by the drawer readout and Away Mode.
// Accepts either a full automate state ({current_step:{started_at}}) or a bulk
// summary entry ({current_step_started_at}). safe_window = p75 - elapsed - buffer.
export function awayStepWindow(stateLike) {
  if (!stateLike || !isAutomateRunning(stateLike)) return null;
  const startedAt = stateLike.current_step?.started_at ?? stateLike.current_step_started_at ?? null;
  const elapsed = startedAt == null ? null : minutesSince(startedAt);
  if (elapsed == null) return null;

  const backend = String(stateLike.backend || 'default').toLowerCase();
  const baseline = etaBaselineForBackend(backend);
  const confidence = etaConfidence(baseline);
  const buffer = AWAY_SAFETY_BUFFER[confidence] ?? 3;
  return {
    minutes: Math.max(0, Math.floor(baseline.p75 - elapsed - buffer)),
    confidence,
    baseline,
    backend,
    eta_cell_used: `backend:${backend}`,
    eta_predicted_low: baseline.median,
    eta_predicted_median: baseline.p75,
    eta_predicted_high: baseline.p90,
    elapsed,
    overTypical: elapsed >= baseline.p90,
  };
}

export function etaBaselineForBackend(backend) {
  return fleetPriorForBackend(backend);
}

export function etaConfidence(baseline) {
  if (baseline.sample >= 300) return 'high';
  if (baseline.sample >= 75) return 'medium';
  return 'low';
}

export function minutesSince(startedAt) {
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 60_000);
}

export function formatAwayWindow(minutes) {
  if (minutes < 5) return 'Check soon';
  if (minutes < 10) return '5m reset';
  if (minutes < 20) return '10-15m task';
  if (minutes < 30) return '20m task';
  if (minutes < 45) return '30m task';
  if (minutes < 75) return '45m task';
  return 'Deep block';
}

export function formatMinuteRange(low, high) {
  const a = Math.max(0, Math.round(low));
  const b = Math.max(a, Math.round(high));
  if (b === 0) return '<1m';
  if (a === 0) return `under ${b}m`;
  if (a === b) return `${a}m`;
  return `${a}-${b}m`;
}

export function formatWholeMinutes(minutes) {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const remain = rounded % 60;
  return remain ? `${hours}h ${remain}m` : `${hours}h`;
}

export function estimateCurrentPhase(data, baseline, currentStepLow) {
  const step = data.current_step;
  const phase = step.phase ?? phaseFromStepId(step.id);
  if (!phase || !Array.isArray(data.steps)) return null;

  const phaseSteps = data.steps.filter((item) => {
    const itemPhase = item.phase ?? phaseFromStepId(item.id);
    return String(itemPhase) === String(phase) && item.status !== 'done';
  });
  if (phaseSteps.length <= 1) return null;

  const remainingAfterCurrent = Math.max(0, phaseSteps.length - 1);
  return {
    center: currentStepLow + remainingAfterCurrent * (baseline.median + baseline.gapPerStep),
  };
}

export function phaseFromStepId(id) {
  const value = String(id || '');
  const match = value.match(/^(\d+)\./);
  return match ? match[1] : null;
}

/* ------------------------------ Away Mode --------------------------------- */
// "Can I leave the screen now, for how long, and what real-life task fits?"
// Local-first task library + deterministic matcher + a pause-aware timer.
// Reachable from the drawer, a campaign card, a stack, or all running
// campaigns. Windows are backend-only (ETA_STEP_BASELINES) — no AI, no tags.

const AWAY_TASKS_KEY = 'campaigns:awayTasks:v1';
const AWAY_LOGS_KEY = 'campaigns:awayLogs:v1';
// Transition buffer between tasks in a combo. Kept 0: the safe window already
// subtracts a confidence-based safety buffer from p75, so adding switch-time
// slack on top would double-count it. (Spec allows 0m or 2m.)
const AWAY_TRANSITION_BUFFER = 0;
const AWAY_OVERAGE_TOLERANCE_MIN = 5;
const AWAY_MAX_SUGGESTIONS = 6;
const AWAY_COMBO_TASK_CAP = 12;   // bound combinatorics for the matcher
const AWAY_DEFAULT_TASKS = [
  { name: 'Laundry', estimated_min: 15 },
  { name: 'Dishes', estimated_min: 12 },
  { name: 'Tidy desk', estimated_min: 8 },
];

/* --- storage --- */

export function awayStorageGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function awayStorageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode / quota) — Away Mode still works in-session */
  }
}

export function loadAwayTasks() {
  const stored = awayStorageGet(AWAY_TASKS_KEY);
  if (Array.isArray(stored)) return stored.filter((t) => t && t.id && t.name);
  // First run only: seed a few starters so matching isn't empty. Once the key
  // exists (even as []), we respect the user's list and never reseed.
  const seeded = AWAY_DEFAULT_TASKS.map((t) => ({ id: awayId(), name: t.name, estimated_min: t.estimated_min }));
  saveAwayTasks(seeded);
  return seeded;
}

export function saveAwayTasks(tasks) {
  awayStorageSet(AWAY_TASKS_KEY, tasks);
}

export function loadAwayLogs() {
  const stored = awayStorageGet(AWAY_LOGS_KEY);
  return Array.isArray(stored) ? stored : [];
}

export function appendAwayLog(log) {
  const logs = loadAwayLogs();
  logs.push(log);
  awayStorageSet(AWAY_LOGS_KEY, logs);
}

export function awayId() {
  return `t_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

export function awayAddTask(name, minutes) {
  const trimmed = String(name || '').trim();
  const est = Math.round(Number(minutes));
  if (!trimmed || !Number.isFinite(est) || est <= 0) return null;
  const tasks = loadAwayTasks();
  const task = { id: awayId(), name: trimmed.slice(0, 60), estimated_min: est };
  tasks.push(task);
  saveAwayTasks(tasks);
  return task;
}

export function awayDeleteTask(id) {
  saveAwayTasks(loadAwayTasks().filter((t) => t.id !== id));
}

/* --- estimates + matching (deterministic, no AI) --- */

export function awayMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function awayTaskLogCount(task, logs) {
  return logs.filter(
    (l) => l.status === 'completed' && Array.isArray(l.task_ids) && l.task_ids.length === 1 && l.task_ids[0] === task.id,
  ).length;
}

// >= 3 completed single-task logs → median actual; otherwise the user estimate.
export function awayEffectiveEstimate(task, logs) {
  const actuals = logs
    .filter((l) => l.status === 'completed' && Array.isArray(l.task_ids) && l.task_ids.length === 1 && l.task_ids[0] === task.id)
    .map((l) => Number(l.actual_min))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (actuals.length >= 3) return Math.max(1, Math.round(awayMedian(actuals)));
  return task.estimated_min;
}

export function awayTaskIsAdaptive(task, logs) {
  return awayTaskLogCount(task, logs) >= 3;
}

// Singles + 2/3-task combos that fit the window, plus near-fits within a small
// tolerance. Sorted by closest fit; exact/under-window choices win ties.
export function awayMatchTasks(windowMin, tasks, logs) {
  if (!Number.isFinite(windowMin) || windowMin <= 0) return [];
  const items = tasks
    .map((t) => ({ task: t, est: awayEffectiveEstimate(t, logs) }))
    .filter((it) => Number.isFinite(it.est) && it.est > 0)
    .slice(0, AWAY_COMBO_TASK_CAP);

  const out = [];
  const consider = (combo) => {
    const total = combo.reduce((s, it) => s + it.est, 0) + AWAY_TRANSITION_BUFFER * (combo.length - 1);
    if (total > windowMin + AWAY_OVERAGE_TOLERANCE_MIN) return;
    const overage = Math.max(0, total - windowMin);
    out.push({
      tasks: combo.map((it) => it.task),
      ids: combo.map((it) => it.task.id),
      total,
      leftover: windowMin - total,
      overage,
    });
  };

  for (let i = 0; i < items.length; i += 1) {
    consider([items[i]]);
    for (let j = i + 1; j < items.length; j += 1) {
      consider([items[i], items[j]]);
      for (let k = j + 1; k < items.length; k += 1) {
        consider([items[i], items[j], items[k]]);
      }
    }
  }

  out.sort(
    (a, b) =>
      Math.abs(a.leftover) - Math.abs(b.leftover) ||
      a.overage - b.overage ||
      a.tasks.length - b.tasks.length,
  );
  return out.slice(0, AWAY_MAX_SUGGESTIONS);
}

/* --- window resolution (single + multi campaign) --- */

export function awayCurrentCampaignTitle() {
  return document.getElementById('document-title')?.textContent?.trim() || 'This campaign';
}

export function awayStateForId(id) {
  if (id && id === state.id && automateState.current) return automateState.current;
  return automateState.bulk?.[id] ?? null;
}

export function awayTitleMap() {
  const map = {};
  document.querySelectorAll('.library-card[data-campaign-id]').forEach((card) => {
    const id = card.dataset.campaignId;
    const title = card.querySelector('.library-card-title')?.textContent?.trim();
    if (id && title) map[id] = title;
  });
  return map;
}

export function awayHumanizeId(id) {
  return String(id || 'Campaign').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function awayIsMulti(source) {
  return Boolean(source) && (source.mode === 'stack' || source.mode === 'all');
}

// Available window for a set of campaign ids. Open campaign uses its full
// state; the rest use the polled bulk summary — so stack/all-running need no
// extra requests. Window = the limiting (active) campaign; attention campaigns
// are reported separately and never counted (min over active windows).
export function awayResolveWindow(source) {
  const titles = awayTitleMap();
  const active = [];
  const attention = [];

  for (const id of source?.ids || []) {
    const stateLike = awayStateForId(id);
    if (!stateLike) continue;
    const title = (id === state.id ? awayCurrentCampaignTitle() : null) || titles[id] || awayHumanizeId(id);
    if (isAutomateAttention(stateLike)) {
      attention.push({ id, title, status: automateDisplayStatus(stateLike) });
      continue;
    }
    const window = awayStepWindow(stateLike);
    if (window) active.push({ id, title, ...window });
  }

  if (!active.length) {
    return { available: null, confidence: null, limiting: null, active, attention };
  }
  const limiting = active.reduce((a, b) => (b.minutes < a.minutes ? b : a));
  return {
    available: limiting.minutes,
    confidence: limiting.confidence,
    overTypical: active.every((a) => a.overTypical),
    limiting,
    active,
    attention,
  };
}

/* --- timer (pause-aware; paused time never counts) --- */

const awayTimer = {
  running: false,
  taskIds: [],
  taskNames: [],
  estimatedMin: 0,
  startedAt: null,    // ISO of first start
  accumulatedMs: 0,   // active ms banked before the current running segment
  segmentStart: null, // epoch ms of current running segment, or null when paused
  source: null,       // {mode, campaign_ids, scope, eta_window_min, confidence}
  intervalId: null,
};

export function awayTimerActiveMs() {
  const live = awayTimer.running && awayTimer.segmentStart ? Date.now() - awayTimer.segmentStart : 0;
  return awayTimer.accumulatedMs + live;
}

export function awayTimerArmed() {
  return awayTimer.running || awayTimer.accumulatedMs > 0;
}

export function awayStartTimer(combo, windowInfo, source) {
  awayStopTicker();
  awayTimer.running = true;
  awayTimer.taskIds = combo.ids;
  awayTimer.taskNames = combo.tasks.map((t) => t.name);
  awayTimer.estimatedMin = combo.total;
  awayTimer.startedAt = new Date().toISOString();
  awayTimer.accumulatedMs = 0;
  awayTimer.segmentStart = Date.now();
  awayTimer.source = {
    mode: source.mode,
    campaign_ids: windowInfo.active.map((a) => a.id),
    scope: 'step',
    eta_window_min: windowInfo.available,
    confidence: windowInfo.confidence,
    eta_cell_used: windowInfo.limiting?.eta_cell_used ?? null,
    eta_predicted_low: windowInfo.limiting?.eta_predicted_low ?? null,
    eta_predicted_median: windowInfo.limiting?.eta_predicted_median ?? null,
    eta_predicted_high: windowInfo.limiting?.eta_predicted_high ?? null,
  };
  awayStartTicker();
  renderAwayOverlay();
}

export function awayPauseTimer() {
  if (!awayTimer.running) return;
  awayTimer.accumulatedMs = awayTimerActiveMs();
  awayTimer.running = false;
  awayTimer.segmentStart = null;
  awayStopTicker();
  renderAwayOverlay();
}

export function awayResumeTimer() {
  if (awayTimer.running || !awayTimerArmed()) return;
  awayTimer.running = true;
  awayTimer.segmentStart = Date.now();
  awayStartTicker();
  renderAwayOverlay();
}

export function awayStopTimer() {
  if (!awayTimerArmed()) return;
  const log = {
    id: awayId(),
    status: 'completed',
    task_ids: awayTimer.taskIds,
    task_names: awayTimer.taskNames,
    estimated_min: awayTimer.estimatedMin,
    started_at: awayTimer.startedAt,
    stopped_at: new Date().toISOString(),
    actual_min: Math.max(0, Math.round(awayTimerActiveMs() / 60_000)),
    source: awayTimer.source,
  };
  appendAwayLog(log);
  awayResetTimer();
  showToast(`Logged ${log.task_names.join(' + ')} — ${log.actual_min}m active`);
  renderAwayOverlay();
}

export function awayDiscardTimer() {
  awayResetTimer();
  showToast('Away session discarded — not logged.');
  renderAwayOverlay();
}

export function awayResetTimer() {
  awayStopTicker();
  awayTimer.running = false;
  awayTimer.taskIds = [];
  awayTimer.taskNames = [];
  awayTimer.estimatedMin = 0;
  awayTimer.startedAt = null;
  awayTimer.accumulatedMs = 0;
  awayTimer.segmentStart = null;
  awayTimer.source = null;
}

export function awayStartTicker() {
  awayStopTicker();
  awayTimer.intervalId = window.setInterval(awayTickTimer, 1000);
}

export function awayStopTicker() {
  if (awayTimer.intervalId) {
    window.clearInterval(awayTimer.intervalId);
    awayTimer.intervalId = null;
  }
}

export function awayTickTimer() {
  const readout = document.querySelector('#away-timer-readout');
  if (readout) readout.textContent = awayFormatClock(awayTimerActiveMs());
  const delta = document.querySelector('#away-timer-delta');
  if (delta) delta.textContent = awayTimerDeltaLabel();
  const fill = document.querySelector('#away-timer-fill');
  if (fill) fill.style.width = `${awayTimerProgress()}%`;
  const elapsed = document.querySelector('#away-timer-elapsed');
  if (elapsed) elapsed.textContent = `${awayFormatClock(awayTimerActiveMs())} elapsed`;
}

export function awayFormatClock(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function awayTimerDeltaLabel() {
  const est = awayTimer.estimatedMin;
  if (!est) return '';
  const activeMin = awayTimerActiveMs() / 60_000;
  const diff = activeMin - est;
  if (Math.abs(diff) < 0.5) return `on estimate (${est}m)`;
  return diff > 0 ? `${Math.round(diff)}m over ${est}m est` : `${Math.round(-diff)}m under ${est}m est`;
}

export function awayTimerProgress() {
  const total = awayTimer.estimatedMin * 60_000;
  if (!total) return 0;
  return Math.min(100, Math.round((awayTimerActiveMs() / total) * 100));
}

/* --- overlay UI --- */

let awayOverlayEl = null;
let awayPreviouslyFocused = null;
let awayAllButtonBound = false;
const awayUi = { open: false, source: null, selectedIds: [] };

export function ensureAwayOverlay() {
  if (awayOverlayEl) return awayOverlayEl;
  const overlay = element('div', { id: 'away-overlay', className: 'away-overlay' });
  overlay.hidden = true;
  const backdrop = element('div', { className: 'away-backdrop' });
  backdrop.addEventListener('click', closeAwayMode);
  const panel = element('div', { className: 'away-panel' });
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Away Mode');
  panel.setAttribute('tabindex', '-1');
  overlay.append(backdrop, panel);
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAwayMode();
      return;
    }
    if (event.key === 'Tab') trapDialogFocus(event, panel);
  });
  document.body.append(overlay);
  awayOverlayEl = overlay;
  return overlay;
}

export function openAwayMode(source) {
  if (!source || !Array.isArray(source.ids) || !source.ids.length) return;
  ensureAwayOverlay();
  awayUi.open = true;
  awayUi.source = source;
  awayUi.selectedIds = [];
  awayPreviouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  awayOverlayEl.hidden = false;
  document.body.classList.add('away-open');
  renderAwayOverlay();
  window.requestAnimationFrame(() => awayOverlayEl.querySelector('.away-panel')?.focus());
}

export function closeAwayMode() {
  if (!awayOverlayEl) return;
  awayUi.open = false;
  awayOverlayEl.hidden = true;
  document.body.classList.remove('away-open');
  if (awayPreviouslyFocused && document.contains(awayPreviouslyFocused)) awayPreviouslyFocused.focus();
}

export function renderAwayOverlay() {
  if (!awayOverlayEl || !awayUi.open) return;
  const panel = awayOverlayEl.querySelector('.away-panel');
  const source = awayUi.source;
  const windowInfo = awayResolveWindow(source);
  panel.replaceChildren();

  // Header: title + close, then a source subline.
  const header = element('div', { className: 'away-header' });
  const topRow = element('div', { className: 'away-header-row' });
  const title = element('h2', { className: 'away-title' });
  title.append(awayClockIcon(), element('span', { text: 'Away Mode' }));
  topRow.append(title);
  const close = element('button', { className: 'away-close', type: 'button', ariaLabel: 'Close Away Mode', text: '×' });
  close.addEventListener('click', closeAwayMode);
  topRow.append(close);
  header.append(topRow, element('p', { className: 'away-source', text: awaySourceLabel(source, windowInfo) }));
  panel.append(header);

  panel.append(awayRenderWindowBlock(windowInfo));

  if (!awayTimerArmed() && windowInfo.available > 0) {
    panel.append(awayRenderSuggestions(windowInfo));
  }

  // Only show the timer (incl. the big "Select a task to start" button) when a
  // session is already running/paused, or there's a real window to start
  // against. With nothing running, the window block is the neutral empty state
  // and only the task library follows.
  if (awayTimerArmed() || windowInfo.available > 0) {
    panel.append(awayRenderTimer(windowInfo));
  }
  panel.append(awayRenderTaskManager());
}

export function awaySourceLabel(source, windowInfo) {
  if (!source) return '';
  if (source.mode === 'stack') return `${source.title || 'Stack'} · ${windowInfo.active.length} running`;
  if (source.mode === 'all') return `All running · ${windowInfo.active.length} active`;
  return source.title || windowInfo.active[0]?.title || windowInfo.attention[0]?.title || 'Campaign';
}

export function awayWindowMetric(label, value, valueClass = '') {
  const item = element('div', { className: 'away-window-metric' });
  item.append(
    element('span', { className: 'away-window-metric-label', text: label }),
    element('span', { className: `away-window-metric-value${valueClass ? ` ${valueClass}` : ''}`, text: value }),
  );
  return item;
}

export function awayEndsAt(minutes) {
  const date = new Date(Date.now() + Math.max(0, minutes) * 60_000);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function awayConfidenceText(confidence) {
  if (confidence === 'high') return 'High';
  if (confidence === 'medium') return 'Medium';
  return 'Low';
}

export function awayFitText(match) {
  if (match.overage) return `${match.overage}m over`;
  return `${match.leftover}m spare`;
}

export function awayClockIcon() {
  return element('span', {
    className: 'away-title-icon',
    ariaHidden: 'true',
    html: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></svg>',
  });
}

export function awayTaskIcon(name) {
  const key = String(name || '').toLowerCase();
  let path;
  if (key.includes('laundry') || key.includes('clothes')) {
    path = '<path d="M8 4l2 3h4l2-3 4 3-3 4-2-1v10H9V10l-2 1-3-4 4-3z"/>';
  } else if (key.includes('dish') || key.includes('cup') || key.includes('coffee')) {
    path = '<path d="M6 5h10v9a4 4 0 0 1-4 4H9a3 3 0 0 1-3-3V5z"/><path d="M16 8h2a3 3 0 0 1 0 6h-2"/><path d="M6 10h10"/>';
  } else if (key.includes('clean') || key.includes('tidy')) {
    path = '<path d="M15 4l5 5"/><path d="M14 5l-8 8 5 5 8-8"/><path d="M6 13l-3 6h6l2-2"/>';
  } else {
    path = '<circle cx="12" cy="12" r="7"/><path d="M12 8v4l3 2"/>';
  }
  return element('span', {
    className: 'away-task-icon',
    ariaHidden: 'true',
    html: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`,
  });
}

export function awayRenderWindowBlock(windowInfo) {
  const block = element('section', { className: 'away-window' });

  if (windowInfo.available == null) {
    if (windowInfo.attention.length) {
      // Attention is a real problem → keep the alert (red) treatment.
      block.classList.add('away-window--blocked');
      block.append(element('p', { className: 'away-window-headline', text: 'Needs attention before Away Mode' }));
      block.append(element('p', { className: 'away-window-sub', text: 'Resolve these before leaving the screen:' }));
      block.append(awayAttentionList(windowInfo.attention));
    } else {
      // Nothing running is benign → neutral empty state, not an alert.
      block.classList.add('away-window--idle');
      block.append(element('p', { className: 'away-window-headline', text: 'Nothing running' }));
      block.append(element('p', { className: 'away-window-sub', text: 'An away window appears while a campaign is automating.' }));
    }
    return block;
  }

  const summary = element('div', { className: 'away-window-summary' });
  summary.append(
    awayWindowMetric('Available', windowInfo.available > 0 ? formatWholeMinutes(windowInfo.available) : 'Nearby'),
    awayWindowMetric('Ends at', windowInfo.available > 0 ? awayEndsAt(windowInfo.available) : 'soon'),
    awayWindowMetric('Confidence', awayConfidenceText(windowInfo.confidence), `away-confidence away-confidence--${windowInfo.confidence || 'low'}`),
  );
  block.append(summary);

  const sub = [];
  if (awayIsMulti(awayUi.source) && windowInfo.limiting) sub.push(`limited by ${windowInfo.limiting.title}`);
  sub.push('current step · safe window');
  block.append(element('p', { className: 'away-window-sub', text: sub.join(' · ') }));

  if (windowInfo.attention.length) {
    block.append(element('p', { className: 'away-window-ignored-label', text: 'Ignored — needs attention:' }));
    block.append(awayAttentionList(windowInfo.attention));
  }
  return block;
}

export function awayAttentionList(list) {
  const wrap = element('ul', { className: 'away-attention' });
  for (const item of list) {
    const li = element('li', {});
    li.append(
      element('span', { className: 'away-attention-name', text: item.title }),
      element('span', { className: 'away-attention-status', text: item.status }),
    );
    wrap.append(li);
  }
  return wrap;
}

export function awayRenderSuggestions(windowInfo) {
  const section = element('section', { className: 'away-suggestions' });
  const tasks = loadAwayTasks();
  const logs = loadAwayLogs();
  const matches = awayMatchTasks(windowInfo.available, tasks, logs);

  if (!matches.length) {
    section.append(element('p', { className: 'away-empty', text: 'Nothing fits — add a shorter task below, or stay nearby.' }));
    return section;
  }

  const singles = matches.filter((match) => match.tasks.length === 1);
  const combos = matches.filter((match) => match.tasks.length > 1);

  if (singles.length) {
    section.append(element('h3', { className: 'away-h3', text: 'Suggested tasks' }));
    const cards = element('div', { className: 'away-task-cards' });
    for (const match of singles.slice(0, 3)) {
      cards.append(awaySuggestionButton(match, 'card'));
    }
    section.append(cards);
  }

  if (combos.length) {
    section.append(element('h3', { className: 'away-h3 away-h3-combos', text: 'Combinations' }));
    const list = element('div', { className: 'away-combo-list' });
    for (const match of combos) {
      list.append(awaySuggestionButton(match, 'combo'));
    }
    section.append(list);
    section.append(element('p', { className: 'away-combo-note', text: `Near fits up to ${AWAY_OVERAGE_TOLERANCE_MIN}m over are included.` }));
  }

  return section;
}

export function awaySuggestionButton(match, variant) {
  const selected = awaySameIds(match.ids, awayUi.selectedIds);
  const button = element('button', {
    className: `away-suggestion away-suggestion--${variant}${selected ? ' is-selected' : ''}${match.overage ? ' is-over' : ''}`,
    type: 'button',
    ariaPressed: String(selected),
  });

  if (variant === 'card') {
    const task = match.tasks[0];
    button.append(
      awayTaskIcon(task.name),
      element('span', { className: 'away-suggestion-name', text: task.name }),
      element('span', { className: 'away-suggestion-time', text: `${match.total}m` }),
      element('span', { className: 'away-suggestion-plus', ariaHidden: 'true', text: '+' }),
    );
  } else {
    const names = element('span', { className: 'away-combo-name' });
    match.tasks.forEach((task, index) => {
      if (index > 0) names.append(element('span', { className: 'away-combo-plus', text: '+' }));
      names.append(awayTaskIcon(task.name), element('span', { text: task.name }));
    });
    button.append(
      names,
      element('span', { className: 'away-suggestion-fit', text: `${match.total}m · ${awayFitText(match)}` }),
      element('span', { className: 'away-suggestion-plus away-suggestion-plus--small', ariaHidden: 'true', text: '+' }),
    );
  }

  button.addEventListener('click', () => {
    awayUi.selectedIds = selected ? [] : match.ids;
    renderAwayOverlay();
  });
  return button;
}

export function awaySameIds(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function awayRenderTimer(windowInfo) {
  const section = element('section', { className: 'away-timer' });

  if (!awayTimerArmed()) {
    const tasks = loadAwayTasks();
    const logs = loadAwayLogs();
    const selectedTasks = awayUi.selectedIds.map((id) => tasks.find((t) => t.id === id)).filter(Boolean);
    const canStart = selectedTasks.length > 0 && windowInfo.available > 0;
    const start = element('button', {
      className: 'button button-primary button-wide',
      type: 'button',
      text: selectedTasks.length ? `Start: ${selectedTasks.map((t) => t.name).join(' + ')}` : 'Select a task to start',
    });
    start.disabled = !canStart;
    start.addEventListener('click', () => {
      const total = selectedTasks.reduce((s, t) => s + awayEffectiveEstimate(t, logs), 0)
        + AWAY_TRANSITION_BUFFER * Math.max(0, selectedTasks.length - 1);
      awayStartTimer({ ids: awayUi.selectedIds.slice(), tasks: selectedTasks, total }, windowInfo, awayUi.source);
    });
    section.append(start);
    return section;
  }

  section.classList.add('is-active');
  const timerHead = element('div', { className: 'away-timer-head' });
  timerHead.append(
    element('span', { className: `away-timer-state${awayTimer.running ? ' is-running' : ''}`, text: awayTimer.running ? 'ACTIVE' : 'PAUSED' }),
    element('span', { className: 'away-timer-task', text: awayTimer.taskNames.join(' + ') || 'Away session' }),
  );
  section.append(timerHead);
  const readout = element('div', { id: 'away-timer-readout', className: 'away-timer-readout', text: awayFormatClock(awayTimerActiveMs()) });
  if (!awayTimer.running) readout.classList.add('is-paused');
  section.append(readout);
  section.append(element('p', { id: 'away-timer-delta', className: 'away-timer-delta', text: awayTimerDeltaLabel() }));

  const progress = element('div', { className: 'away-timer-progress' });
  const fill = element('div', { id: 'away-timer-fill', className: 'away-timer-fill' });
  fill.style.width = `${awayTimerProgress()}%`;
  progress.append(fill);
  section.append(progress);

  const meta = element('div', { className: 'away-timer-meta' });
  meta.append(
    element('span', { id: 'away-timer-elapsed', text: `${awayFormatClock(awayTimerActiveMs())} elapsed` }),
    element('span', { text: `${awayFormatClock(awayTimer.estimatedMin * 60_000)} total` }),
  );
  section.append(meta);

  const controls = element('div', { className: 'away-timer-controls' });
  if (awayTimer.running) {
    const pause = element('button', { className: 'button', type: 'button', text: 'Pause' });
    pause.addEventListener('click', awayPauseTimer);
    controls.append(pause);
  } else {
    const resume = element('button', { className: 'button button-primary', type: 'button', text: 'Start' });
    resume.addEventListener('click', awayResumeTimer);
    controls.append(resume);
  }
  const stop = element('button', { className: 'button', type: 'button', text: 'Stop & log' });
  stop.addEventListener('click', awayStopTimer);
  const discard = element('button', { className: 'button button-danger', type: 'button', text: 'Discard' });
  discard.addEventListener('click', awayDiscardTimer);
  controls.append(stop, discard);
  section.append(controls);
  section.append(element('p', { className: 'away-timer-note', text: awayTimer.running ? 'Pause if you step back to the screen — paused time is not counted.' : 'Stop to log, or discard to throw this run away.' }));
  return section;
}

export function awayRenderTaskManager() {
  const section = element('section', { className: 'away-tasks' });
  section.append(element('h3', { className: 'away-h3', text: 'Task library' }));

  const form = element('form', { className: 'away-add-form' });
  const nameInput = element('input', { className: 'away-input away-input-name', type: 'text' });
  nameInput.placeholder = 'Task name';
  nameInput.maxLength = 60;
  nameInput.setAttribute('aria-label', 'Task name');
  const minInput = element('input', { className: 'away-input away-input-min', type: 'number' });
  minInput.placeholder = 'min';
  minInput.min = '1';
  minInput.setAttribute('aria-label', 'Estimated minutes');
  const save = element('button', { className: 'button', type: 'submit', text: 'Save' });
  form.append(nameInput, minInput, save);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!awayAddTask(nameInput.value, minInput.value)) {
      showToast('Enter a task name and minutes.');
      return;
    }
    nameInput.value = '';
    minInput.value = '';
    renderAwayOverlay();
    window.requestAnimationFrame(() => awayOverlayEl?.querySelector('.away-input-name')?.focus());
  });
  section.append(form);

  const tasks = loadAwayTasks();
  const logs = loadAwayLogs();
  if (!tasks.length) {
    section.append(element('p', { className: 'away-empty', text: 'No tasks yet — add one above.' }));
    return section;
  }

  const list = element('ul', { className: 'away-task-list' });
  for (const task of tasks) {
    const li = element('li', { className: 'away-task-item' });
    li.append(element('span', { className: 'away-task-name', text: task.name }));
    const est = awayEffectiveEstimate(task, logs);
    const estLabel = element('span', { className: 'away-task-est', text: `${est}m` });
    if (awayTaskIsAdaptive(task, logs)) {
      estLabel.classList.add('is-adaptive');
      estLabel.title = `Median of ${awayTaskLogCount(task, logs)} logged times`;
    }
    li.append(estLabel);
    const del = element('button', { className: 'away-task-delete', type: 'button', ariaLabel: `Delete ${task.name}`, text: '×' });
    del.addEventListener('click', () => {
      awayDeleteTask(task.id);
      awayUi.selectedIds = awayUi.selectedIds.filter((id) => id !== task.id);
      renderAwayOverlay();
    });
    li.append(del);
    list.append(li);
  }
  section.append(list);
  return section;
}

/* --- entry points (card / stack / all-running) --- */

export function awayMoonIcon() {
  return element('span', {
    className: 'away-icon',
    ariaHidden: 'true',
    html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  });
}

export function awayEntryButton(label, onActivate, extraClass = '') {
  const btn = element('button', {
    className: `away-entry-button${extraClass ? ` ${extraClass}` : ''}`,
    type: 'button',
    title: 'Away Mode — what fits while this runs?',
    ariaLabel: 'Open Away Mode',
  });
  btn.append(awayMoonIcon());
  if (label) btn.append(element('span', { className: 'away-entry-label', text: label }));
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  });
  return btn;
}

export function awayActiveIdsIn(ids) {
  return ids.filter((id) => isAutomateRunning(automateState.bulk?.[id]));
}

export function updateAwayAllButton() {
  const btn = document.querySelector('#away-all-button');
  if (!btn) return;
  if (!state.capabilities.away) {
    btn.hidden = true;
    return;
  }
  if (!awayAllButtonBound) {
    awayAllButtonBound = true;
    btn.addEventListener('click', () => {
      const ids = awayActiveIdsIn(Object.keys(automateState.bulk || {}));
      if (ids.length) openAwayMode({ mode: 'all', ids, title: 'All running' });
    });
  }
  const activeCount = awayActiveIdsIn(Object.keys(automateState.bulk || {})).length;
  btn.hidden = activeCount < 1;
  if (activeCount >= 1) btn.textContent = `Away · ${activeCount} running`;
}
