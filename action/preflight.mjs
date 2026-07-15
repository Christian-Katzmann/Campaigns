#!/usr/bin/env node

import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPathsForCampaign } from '../lib/pump.mjs';

const SECRET_ENV_NAME = /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export async function runPreflight({ env = process.env, stdout = process.stdout } = {}) {
  maskInheritedSecrets(env, stdout);
  const inputs = validateInputs({
    campaign: env.INPUT_CAMPAIGN,
    runner: env.INPUT_RUNNER,
    model: env.INPUT_MODEL,
    effort: env.INPUT_EFFORT,
    runnerCliVersion: env.INPUT_RUNNER_CLI_VERSION,
    maxSteps: env.INPUT_MAX_STEPS,
    maxMinutes: env.INPUT_MAX_MINUTES,
    maxCostUsd: env.INPUT_MAX_COST_USD,
  });
  await validateTrustContext(env);

  const workspace = await realpath(path.resolve(required(env.GITHUB_WORKSPACE, 'GITHUB_WORKSPACE')));
  const campaignPath = await realpath(path.resolve(workspace, inputs.campaign));
  if (!isSameOrInside(campaignPath, workspace)) {
    throw new Error('campaign must resolve inside GITHUB_WORKSPACE');
  }
  const runsRoot = path.join(
    path.resolve(required(env.RUNNER_TEMP, 'RUNNER_TEMP')),
    `campaigns-${safePart(env.GITHUB_RUN_ID ?? 'local')}-${safePart(env.GITHUB_RUN_ATTEMPT ?? '1')}`,
  );
  const stateDir = runPathsForCampaign(campaignPath, runsRoot).runDir;
  await mkdir(runsRoot, { recursive: true });
  await writeOutputs(env.GITHUB_OUTPUT, {
    'campaign-path': campaignPath,
    'runs-root': runsRoot,
    'state-dir': stateDir,
    'artifact-name': `campaigns-${safePart(env.GITHUB_RUN_ID ?? 'local')}`,
  });
  stdout.write('Campaigns CI preflight passed.\n');
  return { inputs, campaignPath, runsRoot, stateDir };
}

export function validateInputs(raw) {
  const runner = required(raw.runner, 'runner');
  if (runner !== 'claude') {
    throw new Error(`runner must be claude; ${runner} has no supported CI cost-reporting contract`);
  }
  const runnerCliVersion = required(raw.runnerCliVersion, 'runner_cli_version');
  if (!EXACT_VERSION.test(runnerCliVersion)) {
    throw new Error('runner_cli_version must be an exact semver such as 2.1.3');
  }
  return {
    campaign: required(raw.campaign, 'campaign'),
    runner,
    model: String(raw.model ?? '').trim(),
    effort: String(raw.effort ?? '').trim(),
    runnerCliVersion,
    maxSteps: positiveInteger(raw.maxSteps, 'max_steps'),
    maxMinutes: positiveNumber(raw.maxMinutes, 'max_minutes'),
    maxCostUsd: positiveNumber(raw.maxCostUsd, 'max_cost_usd'),
  };
}

export async function validateTrustContext(env) {
  const eventName = required(env.GITHUB_EVENT_NAME, 'GITHUB_EVENT_NAME');
  if (eventName === 'pull_request_target') {
    throw new Error('pull_request_target is refused because it can execute PR code with base-repo secrets');
  }
  if (eventName !== 'pull_request') return;

  const event = JSON.parse(await readFile(required(env.GITHUB_EVENT_PATH, 'GITHUB_EVENT_PATH'), 'utf8'));
  const baseRepo = event.repository?.full_name;
  const headRepo = event.pull_request?.head?.repo?.full_name;
  if (!baseRepo || !headRepo || baseRepo !== headRepo || event.pull_request?.head?.repo?.fork === true) {
    throw new Error('fork pull requests are refused before runner installation or launch');
  }
}

export function maskInheritedSecrets(env, stdout = process.stdout) {
  const values = [...new Set(Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === 'string' && value)
    .map(([, value]) => value))];
  for (const value of values) stdout.write(`::add-mask::${value}\n`);
  stdout.write(`Registered GitHub masking for ${values.length} inherited secret value(s).\n`);
  return values.length;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function positiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return parsed;
}

function required(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safePart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function writeOutputs(outputPath, values) {
  if (!outputPath) return;
  await appendFile(outputPath, Object.entries(values)
    .map(([name, value]) => `${name}=${value}\n`)
    .join(''));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPreflight().catch((error) => {
    process.stderr.write(`campaigns-action: ${error.message}\n`);
    process.exitCode = 1;
  });
}
