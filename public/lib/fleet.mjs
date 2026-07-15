const FLEET_STATUSES = new Set([
  'running',
  'queued',
  'stalled',
  'paused',
  'stale',
  'halted',
  'failed',
  'completed',
  'idle',
]);

const STATUS_PRIORITY = {
  stalled: 0,
  failed: 1,
  halted: 2,
  running: 3,
  queued: 4,
  paused: 5,
  idle: 6,
  stale: 7,
  completed: 8,
};

const NUDGE_PRIORITY = ['continue', 'restart_failed', 'restart', 'skip'];

export function buildFleetViewModel(payload = {}) {
  const campaigns = Array.isArray(payload.campaigns) ? payload.campaigns : [];
  const running = campaigns.filter((campaign) => campaign.status === 'running').length;
  const needsYou = campaigns.filter((campaign) => (
    ['stalled', 'failed', 'halted'].includes(campaign.status)
  )).length;
  const groupsById = new Map();

  for (const campaign of campaigns) {
    const repo = normalizeRepo(campaign.repo);
    const group = groupsById.get(repo.id) ?? { ...repo, campaigns: [] };
    group.campaigns.push(buildFleetRow(campaign));
    groupsById.set(repo.id, group);
  }

  const groups = [...groupsById.values()]
    .map((group) => ({
      ...group,
      campaigns: group.campaigns.sort(compareFleetRows),
    }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));

  return {
    generatedAt: payload.generatedAt ?? null,
    running,
    needsYou,
    total: campaigns.length,
    calm: running === 0 && needsYou === 0,
    empty: campaigns.length === 0,
    babysittingLabel: formatFleetBabysitting(payload.babysitting),
    kroState: normalizeWorstStatus(payload.worstStatus),
    groups,
  };
}

export function buildFleetRow(campaign = {}) {
  const status = FLEET_STATUSES.has(campaign.status) ? campaign.status : 'idle';
  const nudges = Array.isArray(campaign.actions?.nudge) ? campaign.actions.nudge : [];
  const primaryNudge = NUDGE_PRIORITY
    .map((mode) => nudges.find((action) => action?.mode === mode))
    .find(Boolean) ?? null;
  return {
    id: String(campaign.id ?? ''),
    title: campaign.title || 'Untitled campaign',
    status,
    statusLabel: campaign.label || titleCase(status),
    currentStepLabel: formatCurrentStep(campaign.current_step),
    etaLabel: formatFleetEta(campaign.eta),
    attentionLabel: campaign.attention?.label || null,
    attentionTitle: campaign.attention?.title || campaign.attention?.cause || '',
    canStop: campaign.actions?.stop?.available === true,
    primaryNudge,
    progress: campaign.progress ?? null,
    missing: campaign.missing === true,
  };
}

export function formatFleetEta(eta) {
  if (!eta || !Number.isFinite(eta.lowMinutes) || !Number.isFinite(eta.highMinutes)) {
    return 'No estimate';
  }
  if (eta.remainingSteps === 0) return 'Done';
  const low = formatMinutes(eta.lowMinutes);
  const high = formatMinutes(eta.highMinutes);
  return low === high ? low : `${low}–${high}`;
}

export function formatFleetBabysitting(babysitting) {
  if (!babysitting || !Number.isFinite(babysitting.manualStopRate)) return 'Not tracked yet';
  const percent = Math.round(babysitting.manualStopRate * 100);
  const stops = Number.isInteger(babysitting.manualStops) ? babysitting.manualStops : 0;
  return `${percent}% · ${stops} manual stop${stops === 1 ? '' : 's'}`;
}

export function fleetKroAsset(worstStatus) {
  const state = normalizeWorstStatus(worstStatus);
  if (state === 'working') return '/assets/kro/working.svg';
  if (state === 'needs-attention') return '/assets/kro/attention.svg';
  return '/assets/kro/idle.svg';
}

function normalizeWorstStatus(value) {
  return ['idle', 'working', 'needs-attention'].includes(value) ? value : 'idle';
}

function normalizeRepo(repo) {
  const label = typeof repo?.label === 'string' && repo.label.trim() ? repo.label.trim() : 'Local files';
  const id = typeof repo?.id === 'string' && repo.id.trim() ? repo.id.trim() : `repo-${label.toLowerCase()}`;
  return { id, label };
}

function formatCurrentStep(step) {
  if (!step || (!step.id && !step.name)) return 'No active step';
  return [step.id, step.name].filter(Boolean).join(' · ');
}

function formatMinutes(value) {
  const minutes = Math.max(0, Math.round(value));
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return `${hours >= 10 ? Math.round(hours) : hours.toFixed(hours % 1 === 0 ? 0 : 1)}h`;
}

function compareFleetRows(left, right) {
  return (STATUS_PRIORITY[left.status] ?? 99) - (STATUS_PRIORITY[right.status] ?? 99)
    || left.title.localeCompare(right.title);
}

function titleCase(value) {
  return String(value).replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
