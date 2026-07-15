import { spawn } from 'node:child_process';

export const STEP_DIFF_LIMIT_BYTES = 200 * 1024;

export async function buildStepDiff({
  repoRoot,
  baseOid,
  headOid,
  limitBytes = STEP_DIFF_LIMIT_BYTES,
  findings = [],
  reasonTags = [],
  anchorPrefix = 'step',
}) {
  requireOid(baseOid, 'baseOid');
  requireOid(headOid, 'headOid');
  const diff = await runGitBounded(repoRoot, ['diff', baseOid, headOid], limitBytes);
  const binary = /^(?:GIT binary patch|Binary files .+ differ)$/m.test(diff.stdout);
  if (diff.oversized || binary) {
    const stat = await runGitBounded(repoRoot, ['diff', '--stat', baseOid, headOid], limitBytes);
    if (stat.exitCode !== 0) throw new Error(stat.stderr || 'git diff --stat failed');
    const reason = binary ? 'binary' : 'large';
    return {
      kind: 'summary',
      reason,
      raw: null,
      files: [],
      byte_limit: limitBytes,
      html: renderReasonChips(reasonTags, findings, [], anchorPrefix)
        + renderSummary(stat.stdout, reason, limitBytes),
    };
  }
  if (diff.exitCode !== 0) throw new Error(diff.stderr || 'git diff failed');
  const files = parseDiffFiles(diff.stdout);
  return {
    kind: 'diff',
    reason: null,
    raw: diff.stdout,
    files,
    byte_limit: limitBytes,
    html: renderReasonChips(reasonTags, findings, files, anchorPrefix)
      + renderUnifiedDiff(diff.stdout, files, anchorPrefix),
  };
}

export function parseDiffFiles(diff) {
  const files = [];
  let current = null;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (line.startsWith('+++ b/')) current = line.slice(6);
    else if (!current && line.startsWith('--- a/')) current = line.slice(6);
    if (current && !files.includes(current)) files.push(current);
  }
  return files;
}

function renderUnifiedDiff(raw, files, anchorPrefix) {
  if (!raw) return '<p class="step-diff-empty">No file changes in this step.</p>';
  const sections = splitDiffSections(raw);
  if (sections.length === 0) return diffCode(raw);
  return sections.map((section, index) => {
    const filePath = section.filePath ?? files[index] ?? `Change ${index + 1}`;
    return [
      `<section id="${fileAnchor(anchorPrefix, index)}" class="step-diff-file" data-diff-path="${escapeHtml(filePath)}">`,
      `<h4>${escapeHtml(filePath)}</h4>`,
      diffCode(section.text),
      '</section>',
    ].join('');
  }).join('');
}

function renderReasonChips(reasonTags, findings, files, anchorPrefix) {
  if (!Array.isArray(reasonTags) || reasonTags.length === 0) return '';
  const links = new Map();
  for (const finding of Array.isArray(findings) ? findings : []) {
    const matches = finding.paths?.filter((filePath) => files.includes(filePath)) ?? [];
    if (matches.length > 0) links.set(finding.reason, matches);
  }
  const chips = reasonTags.map((reason) => {
    const paths = links.get(reason);
    if (!paths) return `<span class="step-diff-reason">${escapeHtml(reason)}</span>`;
    return paths.map((filePath) => {
      const index = files.indexOf(filePath);
      return `<a class="step-diff-reason step-diff-reason--linked" href="#${fileAnchor(anchorPrefix, index)}">${escapeHtml(reason)}</a>`;
    }).join('');
  }).join('');
  return `<div class="step-diff-reasons" aria-label="Review reasons">${chips}</div>`;
}

function fileAnchor(prefix, index) {
  return `step-diff-${String(prefix).replace(/[^a-z0-9_-]+/gi, '-')}-file-${index}`;
}

function splitDiffSections(raw) {
  const starts = [];
  const pattern = /^diff --git /gm;
  for (const match of raw.matchAll(pattern)) starts.push(match.index);
  return starts.map((start, index) => {
    const text = raw.slice(start, starts[index + 1] ?? raw.length);
    return { text, filePath: parseDiffFiles(text)[0] ?? null };
  });
}

function diffCode(raw) {
  const lines = String(raw).split('\n').map((line) => {
    let className = 'step-diff-line';
    if (line.startsWith('@@')) className += ' step-diff-line--hunk';
    else if (line.startsWith('+') && !line.startsWith('+++')) className += ' step-diff-line--add';
    else if (line.startsWith('-') && !line.startsWith('---')) className += ' step-diff-line--del';
    else if (/^(?:diff --git|index |--- |\+\+\+ )/.test(line)) className += ' step-diff-line--meta';
    return `<span class="${className}">${escapeHtml(line) || ' '}</span>`;
  });
  return `<pre class="step-diff-code"><code>${lines.join('\n')}</code></pre>`;
}

function renderSummary(stat, reason, limitBytes) {
  const explanation = reason === 'binary'
    ? 'Binary diff omitted.'
    : `Diff exceeds ${Math.round(limitBytes / 1024)} KB.`;
  return [
    `<p class="step-diff-hint">${explanation} Open this range in the terminal for the full diff.</p>`,
    `<pre class="step-diff-stat"><code>${escapeHtml(stat || '(no stat output)')}</code></pre>`,
  ].join('');
}

function runGitBounded(repoRoot, args, limitBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoRoot, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    const errors = [];
    let bytes = 0;
    let oversized = false;
    child.stdout.on('data', (chunk) => {
      if (oversized) return;
      bytes += chunk.length;
      if (bytes > limitBytes) {
        oversized = true;
        child.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (errors.reduce((total, value) => total + value.length, 0) < 16 * 1024) errors.push(chunk);
    });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({
      exitCode: oversized ? 0 : exitCode,
      oversized,
      stdout: Buffer.concat(chunks).toString('utf8'),
      stderr: Buffer.concat(errors).toString('utf8').trim(),
    }));
  });
}

function requireOid(value, label) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(String(value))) {
    throw new TypeError(`${label} must be a Git object id`);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
