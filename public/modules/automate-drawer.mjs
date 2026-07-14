// The automation drawer + the automation polling loop. Polls bulk and per-campaign
// automation state, keeps the topbar status line / overview indicator / library
// dots in sync, and renders the drawer panel (now/ETA, nudge, finalize-halt with
// its confirm+review modals, current step, timeline, receipts, and the live log).
//
// A leaf: it reads shared automation state and calls into library (dot updaters,
// unit label) and away (ETA hints), but never back into the board renderer.

import {
  automateDisplayStatus,
  automateState,
  elements,
  isAutomateAttention,
  isAutomateRunning,
  isAutomateScheduled,
  state,
} from './state.mjs';
import { element, relativeTime, showToast } from './dom.mjs';
import { automateIndicator, formatAutomateUnitLabel, updateLibraryDots } from './library.mjs';
import { awayBestFitHint, estimateAutomateWait, openAwayMode } from './away.mjs';
import { playAudioFeedback } from './effects.mjs';

const DRAWER_WIDTH_KEY = 'campaigns-drawer-width:v1';

const drawerState = {
  open: false,
  width: 420,
};

export function initAutomateDrawer() {
  const drawer = document.querySelector('#automate-drawer');
  const panel = drawer?.querySelector('.automate-drawer-panel');
  const toggleBtn = document.querySelector('#automate-drawer-toggle');
  const resizeHandle = drawer?.querySelector('.automate-drawer-resize');
  if (!drawer || !panel || !toggleBtn) return;

  const savedWidth = localStorage.getItem(DRAWER_WIDTH_KEY);
  if (savedWidth) {
    const w = Number(savedWidth);
    if (w >= 320 && w <= 720) drawerState.width = w;
  }
  panel.style.setProperty('--drawer-width', `${drawerState.width}px`);

  toggleBtn.addEventListener('click', () => {
    if (drawerState.open) closeAutomateDrawer();
    else openAutomateDrawer();
  });

  drawer.querySelectorAll('[data-action="close-automate-drawer"]').forEach((btn) => {
    btn.addEventListener('click', closeAutomateDrawer);
  });

  drawer.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAutomateDrawer();
    }
  });

  if (resizeHandle) initDrawerResize(resizeHandle, panel);
}

export function openAutomateDrawer() {
  const drawer = document.querySelector('#automate-drawer');
  const toggleBtn = document.querySelector('#automate-drawer-toggle');
  if (!drawer) return;

  drawerState.open = true;
  drawer.removeAttribute('hidden');
  toggleBtn?.setAttribute('aria-expanded', 'true');

  if (automateState.current) {
    renderDrawerBody(automateState.current);
    clearInterval(automateState.elapsedTimer);
    automateState.elapsedTimer = setInterval(() => {
      tickDrawerElapsed();
      const statusEl = document.getElementById('automate-status');
      const data = automateState.current;
      if (statusEl && data && (isAutomateRunning(data) || isAutomateAttention(data))) {
        renderAutomateStatusContent(statusEl, data);
      }
    }, 60_000);
  }
  drawerLogScrolledByUser = false;
}

export function closeAutomateDrawer() {
  const drawer = document.querySelector('#automate-drawer');
  const toggleBtn = document.querySelector('#automate-drawer-toggle');
  if (!drawer) return;

  drawerState.open = false;
  drawer.setAttribute('hidden', '');
  toggleBtn?.setAttribute('aria-expanded', 'false');

  clearInterval(automateState.elapsedTimer);
  automateState.elapsedTimer = null;
}

export function toggleAutomateDrawer() {
  if (drawerState.open) closeAutomateDrawer();
  else openAutomateDrawer();
}

export function syncDrawerToggleVisibility(status) {
  const toggleBtn = document.querySelector('#automate-drawer-toggle');
  if (!toggleBtn) return;

  if (!state.capabilities.automate) {
    toggleBtn.hidden = true;
    return;
  }

  toggleBtn.hidden = false;

  const existingDot = toggleBtn.querySelector('.drawer-indicator');
  if (!status) {
    if (existingDot) existingDot.remove();
    return;
  }

  const next = automateIndicator(status, 'drawer-indicator');
  if (existingDot) {
    existingDot.replaceWith(next);
  } else {
    toggleBtn.append(next);
  }
}

export function initDrawerResize(handle, panel) {
  let startX = 0;
  let startWidth = 0;

  const onPointerMove = (event) => {
    const delta = startX - event.clientX;
    const next = Math.max(320, Math.min(720, startWidth + delta));
    drawerState.width = next;
    panel.style.setProperty('--drawer-width', `${next}px`);
  };

  const onPointerUp = () => {
    handle.classList.remove('is-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerState.width));
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  };

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    startX = event.clientX;
    startWidth = drawerState.width;
    handle.classList.add('is-dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  });
}

/* ------------------------------ Automate state polling ---------------------- */

let automateVisibilityBound = false;

export function syncOverviewActiveIndicator(active) {
  if (!elements.overviewActiveIndicator) return;
  elements.overviewActiveIndicator.hidden = !active;
}

export function startAutomatePolling() {
  clearInterval(automateState.libraryTimer);
  clearInterval(automateState.campaignTimer);
  automateState.libraryTimer = null;
  automateState.campaignTimer = null;

  if (!state.capabilities.automate) return;

  const isLibrary = document.body.classList.contains('view-library');

  if (isLibrary) {
    fetchBulkAutomateState();
    automateState.libraryTimer = setInterval(fetchBulkAutomateState, 15_000);
  } else if (state.id) {
    fetchCampaignAutomateState();
    automateState.campaignTimer = setInterval(fetchCampaignAutomateState, 15_000);
  }

  if (!automateVisibilityBound) {
    automateVisibilityBound = true;
    document.addEventListener('visibilitychange', handleAutomateVisibility);
  }
}

export function handleAutomateVisibility() {
  if (document.hidden) {
    clearInterval(automateState.libraryTimer);
    clearInterval(automateState.campaignTimer);
    clearInterval(automateState.elapsedTimer);
    automateState.libraryTimer = null;
    automateState.campaignTimer = null;
    automateState.elapsedTimer = null;
  } else {
    startAutomatePolling();
  }
}

export async function fetchBulkAutomateState() {
  try {
    const response = await fetch('/api/automate-state');
    if (!response.ok) return;
    automateState.bulk = await response.json();
    updateLibraryDots();
  } catch {
    /* silent — non-critical UI enhancement */
  }
}

export async function fetchCampaignAutomateState() {
  if (!state.id) return;
  try {
    const response = await fetch(`/api/automate-state?id=${encodeURIComponent(state.id)}`);
    if (!response.ok) return;
    const prev = automateState.current;
    const next = await response.json();
    automateState.current = next;

    const prevStatus = automateDisplayStatus(prev);
    const nextStatus = automateDisplayStatus(next);
    const statusChanged = prevStatus !== nextStatus;
    const stepChanged = (prev?.current_step?.id || null) !== (next?.current_step?.id || null);
    const timelineChanged = (prev?.timeline_events?.length || 0) !== (next?.timeline_events?.length || 0);
    const logChanged = (prev?.current_step_log?.length || 0) !== (next?.current_step_log?.length || 0);

    if (statusChanged || stepChanged || timelineChanged || !prev) {
      updateAutomateStatusLine();
    } else if (logChanged && drawerState.open) {
      updateDrawerLog(next);
      // Parsed activity (latest text, action chips, effort row) lives in the
      // Now block and changes with every new tool call. Re-render the body so
      // it stays current. Cheap: replaceChildren on the drawer body only.
      renderDrawerBody(next);
    }
  } catch {
    /* silent */
  }
}

export function updateAutomateStatusLine() {
  const statusEl = document.getElementById('automate-status');
  if (!statusEl) return;

  const data = automateState.current;
  if (!data || !data.status) {
    statusEl.hidden = true;
    clearInterval(automateState.elapsedTimer);
    automateState.elapsedTimer = null;
    syncDrawerToggleVisibility(null);
    syncOverviewActiveIndicator(false);
    renderDrawerBody(null);
    return;
  }

  const displayStatus = automateDisplayStatus(data);
  const isCompleted = displayStatus === 'completed';
  const isAbandoned = displayStatus === 'abandoned';
  const isActive = isAutomateRunning(data);
  const isWarn = isAutomateAttention(data);
  const isScheduled = isAutomateScheduled(data);

  if (!isActive && !isWarn && !isScheduled && !isCompleted && !isAbandoned) {
    statusEl.hidden = true;
    clearInterval(automateState.elapsedTimer);
    automateState.elapsedTimer = null;
    syncDrawerToggleVisibility(null);
    syncOverviewActiveIndicator(false);
    renderDrawerBody(null);
    return;
  }

  if (isActive || isWarn || isScheduled) {
    statusEl.hidden = false;
    renderAutomateStatusContent(statusEl, data);
  } else {
    statusEl.hidden = true;
  }

  clearInterval(automateState.elapsedTimer);
  if ((isActive || isCompleted) && drawerState.open) {
    automateState.elapsedTimer = setInterval(() => {
      if (isActive || isWarn) renderAutomateStatusContent(statusEl, data);
      tickDrawerElapsed();
    }, 60_000);
  }

  syncDrawerToggleVisibility(isActive || isWarn || isScheduled || isCompleted || isAbandoned ? displayStatus : null);
  syncOverviewActiveIndicator(isActive);
  statusEl.onclick = () => openAutomateDrawer();
  renderDrawerBody(data);
}

export function renderAutomateStatusContent(el, data) {
  const unit = data.current_step || { id: data.current_step_id };
  const unitLabel = formatAutomateUnitLabel(unit);
  const elapsed = formatAutomateElapsed(data.current_step?.started_at);
  const displayStatus = automateDisplayStatus(data);
  const prefix = {
    queued: 'Scheduled',
    scheduled: 'Scheduled',
    stalled: 'Stalled',
    halted: 'Halted',
    failed: 'Failed',
  }[displayStatus];

  const text = prefix ? `${prefix} · ${unitLabel}` : elapsed ? `${unitLabel} · ${elapsed}` : unitLabel;

  el.replaceChildren(
    automateIndicator(displayStatus),
    element('span', { className: 'automate-status-text', text }),
  );
  el.title = data.current_step?.name || data.current_step_name || '';
}

export function formatAutomateElapsed(startedAt) {
  if (!startedAt) return '';
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h ${remainMinutes}m`;
}

export function renderDrawerEta(data) {
  const estimate = estimateAutomateWait(data);
  if (!estimate) return null;

  const block = element('section', { className: 'drawer-eta' });
  const header = element('div', { className: 'drawer-eta-header' });
  header.append(
    element('span', { className: 'drawer-eta-label', text: 'Away window' }),
    element('span', { className: 'drawer-eta-window', text: estimate.windowLabel }),
    element('span', { className: `drawer-eta-confidence drawer-eta-confidence--${estimate.confidence}`, text: estimate.confidence }),
  );
  block.append(header);

  // Best-fit hint from the user's task library — real suggestions, not canned copy.
  const hint = awayBestFitHint(estimate.overTypical ? 0 : estimate.safeAway);
  block.append(element('p', { className: 'drawer-eta-suggestion', text: hint }));

  const facts = element('div', { className: 'drawer-eta-facts' });
  facts.append(element('span', { text: `Step left ${estimate.stepRangeLabel}` }));
  if (estimate.phaseWindowLabel) {
    facts.append(element('span', { text: `Phase window ${estimate.phaseWindowLabel}` }));
  }
  facts.append(element('span', { text: `${estimate.baseline.label} history, n=${estimate.baseline.sample}` }));
  block.append(facts);

  const awayBtn = element('button', {
    className: 'button button-quiet drawer-eta-away',
    type: 'button',
    text: 'Plan away time',
  });
  awayBtn.addEventListener('click', () => openAwayMode({ mode: 'campaign', ids: [state.id], title: awayCurrentCampaignTitle() }));
  block.append(awayBtn);

  return block;
}

/* ------------------------------ Drawer content rendering ------------------- */

let drawerLogScrolledByUser = false;
let drawerLastLogLength = 0;
let nudgePendingPulse = false;

export function renderDrawerBody(data) {
  const body = document.getElementById('automate-drawer-body');
  if (!body) return;

  if (!data || !data.status) {
    body.replaceChildren(element('p', { className: 'automate-drawer-empty', text: 'No active automation.' }));
    return;
  }

  const displayStatus = automateDisplayStatus(data);
  const isCompleted = displayStatus === 'completed';
  const isActive = isAutomateRunning(data);

  const children = [];

  children.push(renderDrawerStatusPill(data));

  const nudge = renderDrawerNudge(data);
  if (nudge) children.push(nudge);

  const finalizeHalt = renderDrawerFinalizeHalt(data);
  if (finalizeHalt) children.push(finalizeHalt);

  // "Now" block: subsumes the old current-step block AND replaces the raw log
  // as the primary "what's happening" surface. Only active campaigns get this.
  // Falls back to the legacy current-step block when live_activity is missing
  // (older campaigns with text-only logs).
  const now = renderDrawerNow(data);
  if (now) {
    children.push(now);
  } else if (isActive && data.current_step) {
    children.push(renderDrawerCurrentStep(data));
  }

  children.push(renderDrawerTimeline(data));
  children.push(renderDrawerReceipts(data, isCompleted));

  // Raw log: collapsed by default — debugging fallback, not primary signal.
  if (!isCompleted && isActive && data.current_step_log != null) {
    children.push(renderDrawerLogTail(data));
  }

  body.replaceChildren(...children);
}

export function renderDrawerNow(data) {
  const isActive = isAutomateRunning(data);
  if (!isActive || !data.current_step) return null;

  const step = data.current_step;
  const live = data.live_activity;

  const block = element('section', { className: 'drawer-now' });

  const header = element('div', { className: 'drawer-now-header' });
  header.append(
    element('span', { className: 'drawer-now-step-id', text: formatAutomateUnitLabel(step) }),
    element('span', { className: 'drawer-now-step-name', text: step.name || '' }),
    element('span', {
      className: 'drawer-now-elapsed',
      text: formatAutomateElapsed(step.started_at) || '0m',
    }),
  );
  block.append(header);

  const eta = renderDrawerEta(data);
  if (eta) block.append(eta);

  if (live?.latest_text) {
    const voice = element('p', { className: 'drawer-now-voice' });
    const text = live.latest_text.length > 320
      ? `${live.latest_text.slice(0, 320)}…`
      : live.latest_text;
    voice.textContent = text;
    block.append(voice);
  } else if (!live) {
    // Legacy log format — no JSON events to parse.
    const note = element('p', {
      className: 'drawer-now-voice drawer-now-voice--legacy',
      text: 'Live activity will appear here once the next step launches. (Older steps used plain-text logs.)',
    });
    block.append(note);
  }

  if (live?.recent_actions?.length) {
    const stream = element('div', { className: 'drawer-now-actions' });
    for (const act of live.recent_actions) {
      const toolKey = (act.tool || '').toLowerCase().replace(/[^a-z]/g, '') || 'other';
      const chip = element('span', {
        className: `drawer-now-action drawer-now-action--${toolKey}`,
      });
      chip.title = act.detail || act.label || '';
      chip.textContent = act.label;
      stream.append(chip);
    }
    block.append(stream);
  }

  if (live?.effort) {
    const e = live.effort;
    const pluralize = (n, singular, plural = `${singular}s`) => `${n} ${n === 1 ? singular : plural}`;
    const parts = [];
    if (e.tools_called) parts.push(pluralize(e.tools_called, 'tool'));
    if (e.files_touched) parts.push(pluralize(e.files_touched, 'file'));
    if (e.edits) parts.push(pluralize(e.edits, 'edit'));
    if (e.bash_commands) parts.push(`${e.bash_commands} bash`);
    if (e.tokens_used) parts.push(`${formatTokenCount(e.tokens_used)} tokens`);
    if (parts.length) {
      block.append(element('div', { className: 'drawer-now-effort', text: parts.join(' · ') }));
    }
  }

  const stepData = data.steps?.find((s) => s.id === step.id);
  if (stepData?.prompt) {
    const details = element('details', { className: 'drawer-now-prompt-toggle' });
    details.append(element('summary', { text: 'Show step prompt' }));
    const pre = element('pre', { className: 'drawer-step-prompt-code' });
    pre.textContent = stepData.prompt.length > 2000
      ? `${stepData.prompt.slice(0, 2000)}…`
      : stepData.prompt;
    details.append(pre);
    block.append(details);
  }

  return block;
}

export function formatTokenCount(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function renderDrawerStatusPill(data) {
  const status = automateDisplayStatus(data);
  const pill = element('div', { className: `drawer-status-pill drawer-status-pill--${status}` });
  pill.append(
    automateIndicator(status),
    element('span', { className: 'drawer-status-label', text: status }),
  );
  return pill;
}

export function renderDrawerNudge(data) {
  if (!data.nudge_modes) return null;
  const modes = data.nudge_modes;
  const hasAny = Object.values(modes).some((m) => m.available);
  if (!hasAny) return null;

  const section = element('div', { className: 'drawer-nudge' });

  const stepId = data.current_step?.id || '?';
  const unitLabel = formatAutomateUnitLabel(data.current_step || { id: stepId });
  const stepElapsedMs = data.current_step?.started_at
    ? Date.now() - Date.parse(data.current_step.started_at)
    : 0;
  const elapsedMin = Math.floor(stepElapsedMs / 60_000);
  const cap = data.max_step_minutes || 60;
  const displayStatus = automateDisplayStatus(data);
  const statusLabel = displayStatus === 'failed'
    ? `${unitLabel} failed.`
    : displayStatus === 'stalled'
      ? `${unitLabel} is not currently running.`
      : `${unitLabel} has been running for ${elapsedMin} minutes (cap: ${cap}).`;

  section.append(element('p', { className: 'drawer-nudge-header', text: `${statusLabel} What would you like to do?` }));

  const actions = element('div', { className: 'drawer-nudge-actions' });

  const confirmDescriptions = {
    continue: modes.continue?.description || `This re-launches ${unitLabel} with a prompt telling the agent to check git state and finish what's left. Safe default — work that already landed won't be redone.`,
    restart: modes.restart?.description || `This wipes ${unitLabel}'s progress entirely and runs it again from scratch. Any work the previous attempt landed stays in git, but the agent starts fresh.`,
    skip: `This marks ${unitLabel} as done without verifying and advances to the next step. If the work isn't actually there, the chain will have a silent gap.`,
    restart_failed: modes.restart_failed?.description || `This re-runs the failed ${unitLabel} from scratch. The previous failure's log and state will be replaced.`,
  };

  if (modes.continue.available) {
    const btn = element('button', {
      className: 'button button-primary drawer-nudge-btn',
      text: modes.continue.label,
      type: 'button',
    });
    btn.addEventListener('click', () => showNudgeConfirmModal(data, 'continue', modes.continue.label, confirmDescriptions.continue));
    actions.append(btn);
  }

  if (modes.restart_failed.available) {
    const btn = element('button', {
      className: 'button button-primary drawer-nudge-btn',
      text: modes.restart_failed.label,
      type: 'button',
    });
    btn.addEventListener('click', () => showNudgeConfirmModal(data, 'restart_failed', modes.restart_failed.label, confirmDescriptions.restart_failed));
    actions.append(btn);
  }

  if (modes.restart.available) {
    const btn = element('button', {
      className: 'button drawer-nudge-btn drawer-nudge-btn--secondary',
      text: modes.restart.label,
      type: 'button',
    });
    btn.addEventListener('click', () => showNudgeConfirmModal(data, 'restart', modes.restart.label, confirmDescriptions.restart));
    actions.append(btn);
  }

  if (modes.skip.available) {
    const btn = element('button', {
      className: 'button drawer-nudge-btn drawer-nudge-btn--secondary',
      text: modes.skip.label,
      type: 'button',
    });
    btn.addEventListener('click', () => showNudgeConfirmModal(data, 'skip', modes.skip.label, confirmDescriptions.skip, true));
    actions.append(btn);
  }

  section.append(actions);
  return section;
}

export function showNudgeConfirmModal(data, mode, label, description, requireCheckbox) {
  let existing = document.getElementById('nudge-confirm-modal');
  if (existing) existing.remove();

  const stepId = data.current_step?.id || '?';
  const unitLabel = formatAutomateUnitLabel(data.current_step || { id: stepId });
  const overlay = element('div', { className: 'nudge-confirm-modal', id: 'nudge-confirm-modal' });

  const card = element('div', { className: 'nudge-confirm-card' });
  card.append(element('h3', { className: 'nudge-confirm-title', text: label }));
  card.append(element('p', { className: 'nudge-confirm-desc', text: description }));

  let checkbox = null;
  if (requireCheckbox) {
    const checkRow = element('label', { className: 'nudge-confirm-check-row' });
    checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'nudge-confirm-checkbox';
    checkRow.append(checkbox, element('span', { text: "I've checked git status and the work is there." }));
    card.append(checkRow);
  }

  const footer = element('div', { className: 'nudge-confirm-footer' });
  const cancelBtn = element('button', { className: 'button', text: 'Cancel', type: 'button' });
  const confirmBtn = element('button', {
    className: 'button button-primary',
    text: label,
    type: 'button',
  });

  if (requireCheckbox) confirmBtn.disabled = true;

  cancelBtn.addEventListener('click', () => overlay.remove());

  if (checkbox) {
    checkbox.addEventListener('change', () => {
      confirmBtn.disabled = !checkbox.checked;
    });
  }

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = 'Sending…';
    const result = await executeNudge(state.id, mode);
    overlay.remove();
    if (result.ok) {
      showToast(`${unitLabel} nudged — ${mode === 'continue' ? 'continuing' : mode === 'skip' ? 'skipping' : 'restarting'}.`);
      playAudioFeedback('tick');
      nudgePendingPulse = true;
      fetchCampaignAutomateState();
    } else {
      showToast(result.message || 'Nudge failed.');
    }
  });

  footer.append(cancelBtn, confirmBtn);
  card.append(footer);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.remove();
  });

  overlay.append(card);
  document.body.append(overlay);
  (requireCheckbox ? checkbox : confirmBtn).focus();
}

export async function executeNudge(id, mode) {
  try {
    const response = await fetch('/api/automate-nudge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, mode }),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export function renderDrawerFinalizeHalt(data) {
  const actions = data.finalize_actions;
  if (!actions || !actions.rerun_finalize?.available) return null;

  const fin = data.finalize || {};
  const attempts = fin.attempts || 1;
  const haltedReason = fin.halted_reason || 'the fix-agent could not produce a commit';

  const section = element('div', { className: 'drawer-finalize-halt' });

  section.append(
    element('p', {
      className: 'drawer-finalize-halt-header',
      text: `Auto-finalize said NEEDS WORK on attempt ${attempts}.`,
    }),
    element('p', {
      className: 'drawer-finalize-halt-body',
      text: `The chain halted because ${haltedReason}.`,
    }),
  );

  const reviewPreview = extractReviewFailuresSnippet(fin.review_content);
  if (reviewPreview) {
    const preview = element('div', { className: 'drawer-finalize-halt-preview' });
    preview.innerHTML = renderSimpleMarkdown(reviewPreview);
    section.append(preview);
  }

  const actionsRow = element('div', { className: 'drawer-finalize-halt-actions' });

  const rerunBtn = element('button', {
    className: 'button button-primary drawer-finalize-halt-btn',
    text: actions.rerun_finalize.label,
    type: 'button',
  });
  rerunBtn.addEventListener('click', () => {
    showFinalizeRerunConfirm(data);
  });
  actionsRow.append(rerunBtn);

  if (actions.view_review?.available) {
    const viewBtn = element('button', {
      className: 'button drawer-finalize-halt-btn drawer-finalize-halt-btn--secondary',
      text: actions.view_review.label,
      type: 'button',
    });
    viewBtn.addEventListener('click', () => {
      showFinalizeReviewModal(data);
    });
    actionsRow.append(viewBtn);
  }

  if (actions.mark_abandoned?.available) {
    const abandonBtn = element('button', {
      className: 'button drawer-finalize-halt-btn drawer-finalize-halt-btn--tertiary',
      text: actions.mark_abandoned.label,
      type: 'button',
    });
    abandonBtn.addEventListener('click', () => {
      showFinalizeAbandonConfirm(data);
    });
    actionsRow.append(abandonBtn);
  }

  section.append(actionsRow);
  return section;
}

// The review markdown can be hundreds of lines. The drawer banner only has
// room for a teaser — the "Failures" section is what blocks the user, so
// surface that and let the modal handle the rest.
export function extractReviewFailuresSnippet(content) {
  if (!content) return null;
  const headingRegex = /^#{2,3}\s+failures?/im;
  const match = headingRegex.exec(content);
  if (!match) return null;

  const start = match.index;
  const afterHeading = content.slice(start + match[0].length);
  const nextHeadingMatch = /^#{1,3}\s+/m.exec(afterHeading);
  const end = nextHeadingMatch ? start + match[0].length + nextHeadingMatch.index : content.length;
  return content.slice(start, end).trim();
}

export function showFinalizeRerunConfirm(data) {
  showFinalizeConfirmModal({
    title: 'Re-run finalize review',
    body: 'Spawn another auto-finalize pass. Use this after you’ve manually closed the gaps the last review flagged. The review runs in the background — refresh to see results.',
    confirmLabel: 'Start finalize',
    busyLabel: 'Starting…',
    onConfirm: async () => {
      const result = await executeFinalizeRerun(state.id);
      if (result.ok) {
        showToast(result.message || 'Finalize started.');
        playAudioFeedback('tick');
        fetchCampaignAutomateState();
      } else {
        showToast(result.message || 'Could not start finalize.');
      }
    },
  });
}

export function showFinalizeAbandonConfirm(data) {
  showFinalizeConfirmModal({
    title: 'Mark campaign abandoned',
    body: 'Close this campaign out without running finalize again. The status pill turns neutral; you can still re-open or revisit the markdown.',
    confirmLabel: 'Mark abandoned',
    busyLabel: 'Marking…',
    onConfirm: async () => {
      const result = await executeFinalizeAbandon(state.id);
      if (result.ok) {
        showToast(result.message || 'Marked abandoned.');
        fetchCampaignAutomateState();
      } else {
        showToast(result.message || 'Could not mark abandoned.');
      }
    },
  });
}

export function showFinalizeConfirmModal({ title, body, confirmLabel, busyLabel, onConfirm }) {
  let existing = document.getElementById('nudge-confirm-modal');
  if (existing) existing.remove();

  const overlay = element('div', { className: 'nudge-confirm-modal', id: 'nudge-confirm-modal' });
  const card = element('div', { className: 'nudge-confirm-card' });
  card.append(
    element('h3', { className: 'nudge-confirm-title', text: title }),
    element('p', { className: 'nudge-confirm-desc', text: body }),
  );

  const footer = element('div', { className: 'nudge-confirm-footer' });
  const cancelBtn = element('button', { className: 'button', text: 'Cancel', type: 'button' });
  const confirmBtn = element('button', {
    className: 'button button-primary',
    text: confirmLabel,
    type: 'button',
  });

  cancelBtn.addEventListener('click', () => overlay.remove());
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = busyLabel;
    try {
      await onConfirm();
    } finally {
      overlay.remove();
    }
  });

  footer.append(cancelBtn, confirmBtn);
  card.append(footer);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.remove();
  });

  overlay.append(card);
  document.body.append(overlay);
  confirmBtn.focus();
}

export function showFinalizeReviewModal(data) {
  let existing = document.getElementById('finalize-review-modal');
  if (existing) existing.remove();

  const fin = data.finalize || {};
  const content = fin.review_content || 'Review content unavailable.';
  const reviewPath = fin.review_path || '';

  const overlay = element('div', {
    className: 'finalize-review-modal',
    id: 'finalize-review-modal',
  });
  const card = element('div', { className: 'finalize-review-card' });

  const header = element('div', { className: 'finalize-review-header' });
  header.append(
    element('h3', { className: 'finalize-review-title', text: `Finalize review — verdict ${fin.verdict || 'unknown'}` }),
    element('button', {
      className: 'icon-button finalize-review-close',
      ariaLabel: 'Close review',
      text: '×',
      type: 'button',
    }),
  );

  if (reviewPath) {
    header.append(element('p', { className: 'finalize-review-path', text: reviewPath }));
  }

  const body = element('div', { className: 'finalize-review-body' });
  body.innerHTML = renderSimpleMarkdown(content);

  card.append(header, body);
  overlay.append(card);

  const closeModal = () => overlay.remove();
  header.querySelector('.finalize-review-close')?.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  document.body.append(overlay);
  card.tabIndex = -1;
  card.focus();
}

export async function executeFinalizeRerun(id) {
  try {
    const response = await fetch('/api/automate-finalize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export async function executeFinalizeAbandon(id) {
  try {
    const response = await fetch('/api/automate-abandon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

export function tickDrawerElapsed() {
  const data = automateState.current;
  if (!data?.current_step) return;
  const el = document.querySelector('.drawer-now-elapsed');
  if (el) el.textContent = formatAutomateElapsed(data.current_step.started_at) || '0m';
  const eta = document.querySelector('.drawer-eta');
  if (eta) {
    const next = renderDrawerEta(data);
    if (next) eta.replaceWith(next);
    else eta.remove();
  }
}

export function renderDrawerCurrentStep(data) {
  const step = data.current_step;
  const block = element('div', { className: 'drawer-current-step' });

  const header = element('div', { className: 'drawer-current-step-header' });
  header.append(
    element('span', { className: 'drawer-current-step-id', text: formatAutomateUnitLabel(step) }),
    element('span', { className: 'drawer-current-step-name', text: step.name || '' }),
  );

  const elapsed = element('div', {
    className: 'drawer-current-step-elapsed',
    text: formatAutomateElapsed(step.started_at) || '0m',
  });

  block.append(header, elapsed);

  const stepData = data.steps?.find((s) => s.id === step.id);
  if (stepData?.prompt) {
    const details = element('details', { className: 'drawer-step-prompt-toggle' });
    details.append(
      element('summary', { text: 'Show step prompt' }),
    );
    const pre = element('pre', { className: 'drawer-step-prompt-code' });
    pre.textContent = stepData.prompt.length > 2000 ? stepData.prompt.slice(0, 2000) + '…' : stepData.prompt;
    details.append(pre);
    block.append(details);
  }

  return block;
}

export function renderDrawerTimeline(data) {
  const events = data.timeline_events || [];
  if (events.length === 0) {
    return element('div', { className: 'drawer-timeline drawer-timeline-empty', text: 'No timeline events yet.' });
  }

  const wrapper = element('div', { className: 'drawer-timeline' });
  wrapper.append(element('h3', { className: 'drawer-section-title', text: 'Timeline' }));

  const limit = 20;
  const visible = events.slice(-limit).reverse();
  const hidden = events.length > limit ? events.slice(0, events.length - limit).reverse() : [];

  const shouldPulse = nudgePendingPulse;
  nudgePendingPulse = false;

  const list = element('div', { className: 'drawer-timeline-list' });
  for (let i = 0; i < visible.length; i++) {
    const chip = renderTimelineChip(visible[i]);
    if (shouldPulse && i === 0) chip.classList.add('drawer-timeline-chip--pulse');
    list.append(chip);
  }
  wrapper.append(list);

  if (hidden.length > 0) {
    const showAll = element('button', {
      className: 'drawer-show-all-btn',
      text: `Show all ${events.length} events`,
      type: 'button',
    });
    showAll.addEventListener('click', () => {
      for (const ev of hidden) {
        list.append(renderTimelineChip(ev));
      }
      showAll.remove();
    });
    wrapper.append(showAll);
  }

  return wrapper;
}

export function renderTimelineChip(ev) {
  const chip = element('div', { className: 'drawer-timeline-chip' });
  const ts = ev.ts ? relativeTime(ev.ts) : '';
  const eventText = ev.event || '';
  const detail = ev.step_id ? ` ${ev.step_id}` : '';
  const reason = ev.reason ? ` — ${ev.reason}` : '';

  chip.append(
    element('span', { className: 'drawer-timeline-time', text: ts }),
    element('span', { className: 'drawer-timeline-event', text: `${eventText}${detail}${reason}` }),
  );
  return chip;
}

export function renderDrawerReceipts(data, isCompleted) {
  const steps = (data.steps || []).filter((s) => s.status === 'done');
  if (steps.length === 0) {
    return element('div', { className: 'drawer-receipts drawer-receipts-empty' });
  }

  const wrapper = element('div', { className: 'drawer-receipts' });
  wrapper.append(element('h3', { className: 'drawer-section-title', text: 'Completed steps' }));

  for (const step of steps) {
    const details = document.createElement('details');
    details.className = 'drawer-receipt-item';
    if (isCompleted) details.open = true;

    const summary = element('summary', { className: 'drawer-receipt-summary' });
    summary.append(
      element('span', { className: 'drawer-receipt-id', text: step.id }),
      element('span', { className: 'drawer-receipt-name', text: step.name || '' }),
    );
    details.append(summary);

    if (step.receipt) {
      const content = element('div', { className: 'drawer-receipt-content' });
      content.innerHTML = renderSimpleMarkdown(step.receipt);
      details.append(content);
    } else {
      details.append(element('p', { className: 'drawer-receipt-empty', text: 'No receipt available.' }));
    }

    wrapper.append(details);
  }

  return wrapper;
}

export function renderDrawerLogTail(data) {
  const wrapper = element('details', { className: 'drawer-log-tail' });
  wrapper.append(element('summary', { className: 'drawer-section-title', text: 'Step log' }));

  const logContainer = element('div', { className: 'drawer-log-container' });
  const pre = element('pre', { className: 'drawer-log-pre' });

  const logText = data.current_step_log || '';
  const lines = logText.split('\n');
  const capped = lines.length > 500 ? lines.slice(-500).join('\n') : logText;
  pre.textContent = capped;

  logContainer.append(pre);

  const rejoinChip = element('button', {
    className: 'drawer-log-rejoin',
    text: '↓ new',
    type: 'button',
    hidden: true,
  });
  rejoinChip.addEventListener('click', () => {
    logContainer.scrollTop = logContainer.scrollHeight;
    rejoinChip.hidden = true;
    drawerLogScrolledByUser = false;
  });
  logContainer.append(rejoinChip);

  logContainer.addEventListener('scroll', () => {
    const atBottom = logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 30;
    drawerLogScrolledByUser = !atBottom;
    if (atBottom) rejoinChip.hidden = true;
  });

  wrapper.append(logContainer);

  drawerLastLogLength = logText.length;
  requestAnimationFrame(() => {
    logContainer.scrollTop = logContainer.scrollHeight;
  });

  return wrapper;
}

export function updateDrawerLog(data) {
  const pre = document.querySelector('.drawer-log-pre');
  const container = document.querySelector('.drawer-log-container');
  const rejoin = document.querySelector('.drawer-log-rejoin');
  if (!pre || !container || !data.current_step_log) return;

  const logText = data.current_step_log;
  if (logText.length === drawerLastLogLength) return;

  const lines = logText.split('\n');
  const capped = lines.length > 500 ? lines.slice(-500).join('\n') : logText;
  pre.textContent = capped;
  drawerLastLogLength = logText.length;

  if (!drawerLogScrolledByUser) {
    container.scrollTop = container.scrollHeight;
  } else if (rejoin) {
    rejoin.hidden = false;
  }
}

export function renderSimpleMarkdown(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}
