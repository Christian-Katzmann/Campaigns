import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveCampaignConfig } from './config.mjs';
import { normalizeCampaignName } from './campaign-scaffold.mjs';
import { redactAndCapText, redactText } from './redaction.mjs';
import { runRunnerInvocation } from './runner-process.mjs';
import {
  buildRunnerInvocation,
  extractRunnerOutput,
  loadConfiguredRunnerRegistry,
  runnerCapabilities,
} from './runners.mjs';
import { analyzePlanHealth } from '../public/lib/plan-health.mjs';
import {
  extractFinalReview,
  extractPhases,
  extractStepSections,
  findStepForCheck,
  parseMarkdown,
  progressChecklistBlocks,
} from '../public/lib/parser.mjs';

const execFileAsync = promisify(execFile);

export const PROJECT_TREE_MAX_CHARACTERS = 20_000;
export const PLANNER_OUTPUT_MAX_CHARACTERS = 12_000;
export const PLANNER_TIMEOUT_MS = 15 * 60 * 1_000;

const REQUIRED_PROMPT_SECTIONS = [
  'SCOPE',
  'REQUIRED READING',
  'OUTPUT',
  'ACCEPTANCE',
  'OPEN QUESTIONS',
  'FORWARD SWEEP',
];

export class PlannerDraftError extends Error {
  constructor(statusCode, message, { findings = [], rawOutput = '' } = {}) {
    super(message);
    this.name = 'PlannerDraftError';
    this.statusCode = statusCode;
    this.findings = findings;
    this.rawOutput = rawOutput;
  }
}

export async function draftCampaign({
  effort,
  env = process.env,
  intent,
  model,
  projectPath,
  runnerId,
  signal,
} = {}) {
  const normalizedIntent = requireIntent(intent);
  const requestedProjectPath = requireString(projectPath, 'Project folder is required.');
  let resolved;
  try {
    resolved = await resolveCampaignConfig({ cwd: path.resolve(requestedProjectPath), env });
  } catch (error) {
    throw new PlannerDraftError(400, error.message);
  }
  const projectRoot = resolved.projectRoot;
  let registry;
  try {
    registry = await loadConfiguredRunnerRegistry(resolved.config);
  } catch (error) {
    throw new PlannerDraftError(400, `Runner configuration is invalid: ${error.message}`);
  }
  const capabilities = await runnerCapabilities(registry, { cwd: projectRoot, env });
  const selection = resolvePlannerSelection(registry, capabilities, { effort, model, runnerId });
  const [template, projectTree] = await Promise.all([
    readFile(new URL('../docs/paste-anywhere-planner.md', import.meta.url), 'utf8'),
    buildProjectTree(projectRoot),
  ]);
  const modelValue = plannerModelValue(registry, capabilities, selection);
  const prompt = buildPlannerPrompt({
    intent: normalizedIntent,
    modelValue,
    projectRoot,
    projectTree,
    template,
  });
  const tempDir = await mkdtemp(path.join(tmpdir(), 'campaigns-planner-'));
  const outputPath = path.join(tempDir, 'runner-output.txt');
  const logPath = path.join(tempDir, 'runner.log');
  const invocation = buildRunnerInvocation(registry, selection.runnerId, {
    effort: selection.effort,
    env,
    model: selection.model,
    outputPath,
    prompt,
    repoRoot: projectRoot,
  });
  const configuredTimeout = Number(resolved.config.run?.max_run_minutes) * 60_000;
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(PLANNER_TIMEOUT_MS, configuredTimeout)
    : PLANNER_TIMEOUT_MS;

  try {
    const result = await runRunnerInvocation(invocation, {
      containmentRoot: projectRoot,
      cwd: projectRoot,
      deadlineMs: Date.now() + timeoutMs,
      logPath,
      onSpawn: async () => {},
      signal,
      watchdog: registry.watchdog,
    });
    const savedOutput = await readOptional(outputPath);
    const extractedOutput = extractRunnerOutput(registry, selection.runnerId, result.stdout);
    const rawOutput = savedOutput || extractedOutput || [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (signal?.aborted) {
      throw new PlannerDraftError(499, 'Campaign drafting was cancelled.');
    }
    if (result.exitCode !== 0 || result.cap || result.watchdog) {
      const reason = result.cap
        ? `Planner timed out after ${Math.round(timeoutMs / 60_000)} minutes.`
        : result.watchdog?.message || `Planner exited with code ${result.exitCode}.`;
      throw new PlannerDraftError(502, reason, { rawOutput: salvageOutput(rawOutput) });
    }
    const markdown = normalizePlannerMarkdown(redactText(rawOutput));
    const validated = validateDraftedCampaign(markdown, { modelValue });
    return {
      ...validated,
      markdown,
      modelValue,
      projectRoot,
      selection,
    };
  } catch (error) {
    if (error instanceof PlannerDraftError) throw error;
    throw new PlannerDraftError(502, `Planner failed: ${error.message}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function buildProjectTree(projectRoot, maxCharacters = PROJECT_TREE_MAX_CHARACTERS) {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 100) {
    throw new TypeError('Project tree cap must be an integer of at least 100 characters.');
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['-C', projectRoot, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { maxBuffer: 20 * 1_024 * 1_024 },
    ));
  } catch (error) {
    throw new PlannerDraftError(400, `Could not read the target repository tree: ${error.message}`);
  }
  const entries = new Set();
  for (const filePath of stdout.split('\n')) {
    const parts = filePath.trim().split('/').filter(Boolean);
    if (parts.length === 0 || parts.includes('node_modules')) continue;
    const visible = parts.slice(0, 2).join('/');
    entries.add(`${visible}${parts.length > 2 ? '/' : ''}`);
  }
  const lines = [...entries].sort().map((entry) => `- ${entry}`);
  const marker = `… (tree capped at ${maxCharacters} characters)`;
  let output = '';
  for (const line of lines) {
    const next = `${output}${output ? '\n' : ''}${line}`;
    if (next.length <= maxCharacters) {
      output = next;
      continue;
    }
    const room = maxCharacters - marker.length - (output ? 1 : 0);
    output = `${output.slice(0, Math.max(0, room))}${output ? '\n' : ''}${marker}`;
    break;
  }
  return output || '(No tracked or unignored files yet.)';
}

export function buildPlannerPrompt({ intent, modelValue, projectRoot, projectTree, template }) {
  const projectDescription = [
    `TARGET GIT ROOT: ${projectRoot}`,
    '',
    'DEFAULT MODEL CHIP:',
    `Write this exact line below every step heading: Model: ${modelValue}`,
    'This exact line overrides Rule 5. Do not tune individual steps.',
    '',
    `REPOSITORY TREE (depth 2, capped at ${PROJECT_TREE_MAX_CHARACTERS} characters):`,
    projectTree,
    '',
    'USER INTENT:',
    intent,
  ].join('\n');
  const placeholder = '{{PASTE THE PROJECT DESCRIPTION HERE}}';
  if (!template.includes(placeholder)) {
    throw new PlannerDraftError(500, 'The bundled planner prompt is missing its project-description placeholder.');
  }
  return template.replace(placeholder, projectDescription);
}

export function validateDraftedCampaign(markdown, { modelValue } = {}) {
  const blocks = parseMarkdown(markdown);
  const steps = extractStepSections(blocks, markdown);
  const phases = extractPhases(blocks);
  const finalReview = extractFinalReview(blocks);
  const findings = [...analyzePlanHealth(markdown)];
  const addError = (ruleId, message, stepId = null) => {
    findings.push({ ruleId, severity: 'error', message, stepId, anchorId: null, line: 1 });
  };
  const h1 = blocks.find((block) => block.type === 'heading' && block.level === 1);
  if (!h1) addError('missing-title', 'The drafted campaign has no H1 title.');
  if (h1) {
    try {
      normalizeCampaignName(h1.text);
    } catch (error) {
      addError('invalid-title', error.message);
    }
  }
  if (phases.length < 2 || phases.length > 6) {
    addError('phase-count', 'The drafted campaign must contain 2–6 checklist phases.');
  }
  if (steps.length === 0) addError('missing-steps', 'The drafted campaign has no implementation steps.');
  const checklist = progressChecklistBlocks(blocks).filter((block) => block.type === 'check');
  const linkedCheckCounts = new Map(steps.map((step) => [step.number, 0]));
  for (const check of checklist) {
    const linked = findStepForCheck(check.text, steps);
    if (linked) linkedCheckCounts.set(linked.number, linkedCheckCounts.get(linked.number) + 1);
  }
  if ([...linkedCheckCounts.values()].some((count) => count !== 1)) {
    addError('checklist-mismatch', 'Every step section must have exactly one matching checklist item.');
  }
  const finalChecks = checklist.filter((check) => /^final\s+review\s*$/i.test(check.text));
  if (finalChecks.length !== 1) {
    addError('final-review-check-count', 'The checklist must contain exactly one Final review item.');
  }
  if (!finalReview?.code) addError('missing-final-review', 'The final review must contain a fenced prompt.');

  for (const step of steps) {
    if (!/^\d+\.\d+$/.test(step.number)) {
      addError('invalid-step-id', `Step ${step.number} must use a numeric N.M id.`, step.number);
    }
    if (modelValue) {
      const [primary = '', alternate = ''] = modelValue.split(/\s*\/\s*/);
      if (step.model?.primary !== primary || step.model?.alternate !== alternate) {
        addError('wrong-default-model', `Step ${step.number} does not use the selected default Model chip.`, step.number);
      }
    }
    if (!step.lane?.globs?.length) {
      addError('missing-lane', `Step ${step.number} needs a valid Lane declaration.`, step.number);
    }
    const prompt = firstStepPrompt(blocks, step.anchorId);
    for (const section of REQUIRED_PROMPT_SECTIONS) {
      if (!new RegExp(`^\\s*${section.replace(' ', '\\s+')}\\s*:`, 'im').test(prompt)) {
        addError('missing-prompt-section', `Step ${step.number} is missing ${section}.`, step.number);
      }
    }
  }

  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length > 0) {
    throw new PlannerDraftError(422, `Planner returned an invalid campaign: ${errors[0].message}`, {
      findings,
      rawOutput: salvageOutput(markdown),
    });
  }
  return { findings, title: h1.text.trim() };
}

export function normalizePlannerMarkdown(output) {
  let markdown = String(output ?? '').trim();
  const outerFence = markdown.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (outerFence) markdown = outerFence[1].trim();
  const h1Index = markdown.search(/^#\s+\S/m);
  if (h1Index > 0) markdown = markdown.slice(h1Index);
  return markdown;
}

function resolvePlannerSelection(registry, capabilities, requested) {
  const runnerId = requireString(requested.runnerId, 'Planner is required.');
  let runner;
  try {
    runner = registry.get(runnerId);
  } catch {
    throw new PlannerDraftError(400, `Unknown planner: ${runnerId}.`);
  }
  const capability = capabilities.find((candidate) => candidate.id === runnerId);
  if (!capability?.available) {
    throw new PlannerDraftError(400, capability?.availabilityHint || `Planner ${runner.label} is unavailable.`);
  }
  const model = requireString(requested.model, 'Planner model is required.');
  const effort = requireString(requested.effort, 'Planner effort is required.');
  if (!runner.models.some((candidate) => candidate.id === model)) {
    throw new PlannerDraftError(400, `Model ${model} is not configured for ${runner.label}.`);
  }
  if (!runner.efforts.some((candidate) => candidate.id === effort)) {
    throw new PlannerDraftError(400, `Effort ${effort} is not configured for ${runner.label}.`);
  }
  return { runnerId, model, effort };
}

function plannerModelValue(registry, capabilities, selection) {
  const primary = registry.get(selection.runnerId);
  const model = primary.models.find((candidate) => candidate.id === selection.model);
  const effort = primary.efforts.find((candidate) => candidate.id === selection.effort);
  const segments = [`${model.label} · ${effort.label}`];
  const alternateId = registry.names.find((name) => (
    name !== selection.runnerId && capabilities.find((candidate) => candidate.id === name)?.available
  ));
  if (alternateId) {
    const alternate = registry.get(alternateId);
    const alternateModel = alternate.models.find((candidate) => candidate.id === alternate.defaults.model);
    const alternateEffort = alternate.efforts.find((candidate) => candidate.id === alternate.defaults.effort);
    segments.push(`${alternateModel.label} · ${alternateEffort.label}`);
  }
  return segments.join(' / ');
}

function firstStepPrompt(blocks, anchorId) {
  const start = blocks.findIndex((block) => block.id === anchorId);
  for (let index = start + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === 'heading' && block.level <= 2) break;
    if (block.type === 'code') return block.content;
  }
  return '';
}

function requireIntent(value) {
  const intent = requireString(value, 'Campaign intent is required.');
  if (intent.length > 20_000) throw new PlannerDraftError(400, 'Campaign intent is too long.');
  return intent;
}

function requireString(value, message) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new PlannerDraftError(400, message);
  }
  return value.trim();
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function salvageOutput(value) {
  return redactAndCapText(value, PLANNER_OUTPUT_MAX_CHARACTERS);
}
