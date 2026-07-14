// Compact board view for the pure plan-health analyzer. Step findings reuse the
// board's existing jump-to-step action; campaign-level findings stay plain text.

import { element } from './dom.mjs';

const SEVERITY_ORDER = ['error', 'warning', 'info'];

export function renderPlanHealthStrip(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return null;

  const highestSeverity = SEVERITY_ORDER.find((severity) =>
    findings.some((finding) => finding.severity === severity)) ?? 'info';
  const strip = element('details', {
    className: `plan-health-strip plan-health-strip--${highestSeverity}`,
  });
  const summary = element('summary', { className: 'plan-health-summary' });
  summary.append(
    element('span', { className: 'plan-health-title', text: 'Plan health' }),
    element('span', {
      className: 'plan-health-count',
      text: `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`,
    }),
    element('span', {
      ariaHidden: 'true',
      className: 'plan-health-chevron',
      text: '›',
    }),
  );

  const list = element('div', { className: 'plan-health-list' });
  for (const finding of findings) {
    list.append(renderFinding(finding));
  }
  strip.append(summary, list);
  return strip;
}

function renderFinding(finding) {
  const canJump = Boolean(finding.stepId && finding.anchorId);
  const row = element(canJump ? 'a' : 'div', {
    className: `plan-health-finding plan-health-finding--${finding.severity}`,
    dataset: canJump
      ? { action: 'jump-to-step', stepId: finding.anchorId }
      : undefined,
    href: canJump ? `#${finding.anchorId}` : undefined,
  });
  const copy = element('span', { className: 'plan-health-finding-copy' });
  copy.append(
    element('span', { className: 'plan-health-message', text: finding.message }),
    element('span', { className: 'plan-health-fix', text: finding.fixHint }),
  );
  row.append(
    element('span', {
      className: 'plan-health-severity',
      text: finding.severity,
    }),
    copy,
  );
  return row;
}
