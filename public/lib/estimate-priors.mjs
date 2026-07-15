function fleetPrior({ label, sample, p50, p75, p90, gapPerStep }) {
  return Object.freeze({
    label,
    sample,
    p50,
    median: p50,
    p75,
    p90,
    gapPerStep,
  });
}

// One fleet baseline shared by the browser's current-step ETA and the server's
// campaign estimator. Values are minutes; gapPerStep is inter-step pump time.
export const ETA_STEP_BASELINES = Object.freeze({
  claude: fleetPrior({
    label: 'Claude',
    sample: 662,
    p50: 12.9,
    p75: 18.1,
    p90: 23.6,
    gapPerStep: 0,
  }),
  codex: fleetPrior({
    label: 'Codex',
    sample: 100,
    p50: 6.1,
    p75: 8.8,
    p90: 11,
    gapPerStep: 12,
  }),
  default: fleetPrior({
    label: 'Campaign history',
    sample: 0,
    p50: 10,
    p75: 16,
    p90: 24,
    gapPerStep: 0,
  }),
});

export function fleetPriorForBackend(backend) {
  return ETA_STEP_BASELINES[String(backend || '').toLowerCase()] ?? ETA_STEP_BASELINES.default;
}
