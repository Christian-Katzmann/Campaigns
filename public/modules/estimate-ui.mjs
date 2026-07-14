import { showToast } from './dom.mjs';
import { automateState, elements, isAutomateRunning, state } from './state.mjs';

let initialized = false;
let saveDocument = null;

export function initCampaignEstimate({ save } = {}) {
  if (typeof save === 'function') saveDocument = save;
  if (initialized || !elements.estimateCard || !elements.launchButton) return;
  initialized = true;
  elements.launchButton.addEventListener('click', launchCampaign);
  window.addEventListener('campaign:saved', () => { void fetchCampaignEstimate(); });
  renderCampaignEstimate();
}

export async function fetchCampaignEstimate() {
  if (!state.id || !elements.estimateCard) return null;
  try {
    const response = await fetch(`/api/estimate?id=${encodeURIComponent(state.id)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not estimate this campaign.');
    state.campaignEstimate = payload;
    renderCampaignEstimate();
    return payload;
  } catch (error) {
    state.launchError = error.message;
    renderCampaignEstimate();
    return null;
  }
}

export function renderCampaignEstimate() {
  const card = elements.estimateCard;
  if (!card || !state.id) return;
  card.hidden = false;

  const estimate = state.campaignEstimate;
  const running = isAutomateRunning(automateState.current);
  const label = card.querySelector('.estimate-card-label');
  const duration = card.querySelector('#estimate-duration');
  const facts = card.querySelector('#estimate-facts');
  const source = card.querySelector('#estimate-source');
  const error = card.querySelector('#estimate-error');
  const launch = elements.launchButton;

  label.textContent = running ? 'Estimated remaining' : 'Estimated work';
  if (!estimate) {
    duration.textContent = 'Loading…';
    facts.replaceChildren();
    source.textContent = '';
  } else {
    duration.textContent = formatDurationRange(estimate.duration);
    facts.replaceChildren(
      fact(formatSessions(estimate.sessions)),
      fact(formatReworkRisk(estimate.reworkRisk)),
    );
    const sample = estimate.source === 'personal'
      ? estimate.personalSampleSize
      : estimate.sampleSize;
    const pace = estimate.live?.applied ? ` · ${formatPace(estimate.live.paceRatio)}` : '';
    source.textContent = `${capitalize(estimate.confidence)} confidence · ${formatSource(estimate.source)} · n=${sample}${pace}`;
    source.dataset.confidence = estimate.confidence;
  }

  const complete = estimate?.remainingSteps === 0;
  launch.disabled = state.launchPending || running || complete;
  launch.textContent = state.launchPending ? 'Launching…' : running ? 'Running' : complete ? 'Complete' : 'Launch';

  error.textContent = state.launchError;
  error.hidden = !state.launchError;
}

export function formatDurationRange(duration) {
  const low = Number(duration?.lowMinutes);
  const high = Number(duration?.highMinutes);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return 'Estimate unavailable';
  if (high <= 0) return 'Done';
  return `${formatMinutes(low)}–${formatMinutes(Math.max(low, high))}`;
}

function formatMinutes(minutes) {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatSessions(sessions) {
  const low = Number(sessions?.low);
  const high = Number(sessions?.high);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return 'Sessions unknown';
  return low === high ? `${low} sessions` : `${low}–${high} sessions`;
}

function formatReworkRisk(risk) {
  if (risk?.rate == null) return 'Rework unknown';
  return `${capitalize(risk.label)} rework · ${Math.round(risk.rate * 100)}%`;
}

function formatSource(source) {
  if (source === 'personal') return 'your history';
  if (source === 'personal+fleet') return 'history + fleet';
  return 'fleet baseline';
}

function formatPace(ratio) {
  return `${Number(ratio).toFixed(1)}× live pace`;
}

function fact(text) {
  const node = document.createElement('span');
  node.textContent = text;
  return node;
}

function capitalize(value) {
  const text = String(value || 'low');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

async function launchCampaign() {
  if (!state.id || state.launchPending) return;
  state.launchPending = true;
  state.launchError = '';
  renderCampaignEstimate();

  await saveDocument?.();
  if (state.dirty || state.saveStatus === 'error') {
    state.launchPending = false;
    state.launchError = state.lastSaveError || 'Save the campaign before launching.';
    renderCampaignEstimate();
    return;
  }

  try {
    const response = await fetch('/api/run/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: state.id }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not launch this campaign.');
    showToast(payload.committed ? 'Campaign saved and launched.' : 'Campaign launched.');
    window.dispatchEvent(new CustomEvent('campaign:run-started'));
  } catch (error) {
    state.launchError = error.message;
    showToast(error.message);
  } finally {
    state.launchPending = false;
    renderCampaignEstimate();
  }
}
