import { buildFleetViewModel, fleetKroAsset } from '../lib/fleet.mjs';
import { element, showToast } from './dom.mjs';
import { elements } from './state.mjs';

const FLEET_REFRESH_MS = 15_000;
let refreshTimer = null;
let eventsBound = false;

export async function renderFleet(initialPayload = null) {
  document.body.classList.add('view-fleet');
  if (!elements.fleet) return;
  elements.fleet.hidden = false;
  bindFleetEvents();
  if (initialPayload) renderFleetPayload(initialPayload);
  else await refreshFleet();
  startFleetPolling();
}

export async function refreshFleet() {
  try {
    const response = await fetch('/api/companion-state', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not load the fleet.');
    renderFleetPayload(payload);
  } catch (error) {
    if (elements.fleetSummary) elements.fleetSummary.textContent = 'Fleet is temporarily unavailable.';
    if (elements.fleetGroups) {
      elements.fleetGroups.replaceChildren(
        element('p', { className: 'fleet-load-error', text: error.message }),
      );
    }
  }
}

export function renderFleetPayload(payload) {
  const view = buildFleetViewModel(payload);
  if (elements.fleetSummary) {
    elements.fleetSummary.textContent = view.calm
      ? 'Everything is quiet. No campaign needs you.'
      : `${view.running} running · ${view.needsYou} need you`;
  }
  setMetric('fleet-running-count', String(view.running));
  setMetric('fleet-attention-count', String(view.needsYou));
  setMetric('fleet-babysitting-index', view.babysittingLabel);

  const kro = document.querySelector('#fleet-kro');
  if (kro) {
    kro.src = fleetKroAsset(view.kroState);
    kro.dataset.state = view.kroState;
    kro.alt = view.kroState === 'needs-attention'
      ? 'Kro says the fleet needs attention'
      : view.kroState === 'working' ? 'Kro is working' : 'Kro is resting';
  }

  if (elements.fleetEmpty) {
    elements.fleetEmpty.hidden = !view.empty;
  }
  if (elements.fleetGroups) {
    elements.fleetGroups.hidden = view.empty;
    elements.fleetGroups.replaceChildren(...view.groups.map(renderFleetGroup));
  }
  const updated = document.querySelector('#fleet-updated');
  if (updated) updated.textContent = view.generatedAt ? `Updated ${formatClock(view.generatedAt)}` : '';
}

function renderFleetGroup(group) {
  const section = element('section', { className: 'fleet-group' });
  section.dataset.repoId = group.id;
  const header = element('header', { className: 'fleet-group-header' });
  header.append(
    element('h2', { className: 'fleet-group-title', text: group.label }),
    element('span', {
      className: 'fleet-group-count',
      text: `${group.campaigns.length} campaign${group.campaigns.length === 1 ? '' : 's'}`,
    }),
  );
  const rows = element('div', { className: 'fleet-rows' });
  rows.replaceChildren(...group.campaigns.map(renderFleetRow));
  section.append(header, rows);
  return section;
}

function renderFleetRow(row) {
  const card = element('article', { className: `fleet-row fleet-row--${row.status}` });
  card.dataset.campaignId = row.id;
  const main = element('div', { className: 'fleet-row-main' });
  const title = element('h3', {
    className: `fleet-row-title${row.missing ? ' is-missing' : ''}`,
    text: row.title,
  });
  const status = element('span', { className: 'fleet-status-chip', text: row.statusLabel });
  status.dataset.status = row.status;
  main.append(title, status);

  const details = element('div', { className: 'fleet-row-details' });
  details.append(
    detail('Current step', row.currentStepLabel),
    detail('Remaining ETA', row.etaLabel),
  );
  if (row.attentionLabel) {
    const badge = element('span', {
      className: 'fleet-attention-badge',
      text: row.attentionLabel,
      title: row.attentionTitle,
    });
    details.append(badge);
  }

  const actions = element('div', { className: 'fleet-row-actions' });
  actions.append(actionButton('Open', 'open', row.id));
  if (row.canStop) actions.append(actionButton('Stop', 'stop', row.id, 'button-danger'));
  if (row.primaryNudge) {
    const nudge = actionButton('Nudge', 'nudge', row.id);
    nudge.dataset.mode = row.primaryNudge.mode;
    nudge.title = row.primaryNudge.label;
    actions.append(nudge);
  }
  card.append(main, details, actions);
  return card;
}

function detail(label, value) {
  const item = element('div', { className: 'fleet-detail' });
  item.append(
    element('span', { className: 'fleet-detail-label', text: label }),
    element('strong', { className: 'fleet-detail-value', text: value }),
  );
  return item;
}

function actionButton(label, action, id, modifier = '') {
  return element('button', {
    className: `button button-quiet fleet-action${modifier ? ` ${modifier}` : ''}`,
    text: label,
    type: 'button',
    dataset: { fleetAction: action, campaignId: id },
  });
}

function bindFleetEvents() {
  if (eventsBound || !elements.fleet) return;
  eventsBound = true;
  elements.fleet.addEventListener('click', handleFleetAction);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopFleetPolling();
    else {
      refreshFleet();
      startFleetPolling();
    }
  });
}

async function handleFleetAction(event) {
  const button = event.target.closest('[data-fleet-action]');
  if (!(button instanceof HTMLButtonElement)) return;
  const id = button.dataset.campaignId || '';
  if (!id) return;
  if (button.dataset.fleetAction === 'open') {
    window.location.assign(`?id=${encodeURIComponent(id)}`);
    return;
  }

  button.disabled = true;
  try {
    const isStop = button.dataset.fleetAction === 'stop';
    const endpoint = isStop ? '/api/run/stop' : '/api/automate-nudge';
    const body = isStop ? { id } : { id, mode: button.dataset.mode };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(result.error || result.message || 'Action failed.');
    showToast(isStop ? 'Stop requested.' : result.message || 'Campaign nudged.');
    await refreshFleet();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function startFleetPolling() {
  stopFleetPolling();
  if (!document.hidden) refreshTimer = window.setInterval(refreshFleet, FLEET_REFRESH_MS);
}

function stopFleetPolling() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = null;
}

function setMetric(id, value) {
  const target = document.getElementById(id);
  if (target) target.textContent = value;
}

function formatClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'now';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}
