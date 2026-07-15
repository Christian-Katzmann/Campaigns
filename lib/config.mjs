import { execFile } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { redactText, redactValue } from './redaction.mjs';

const execFileAsync = promisify(execFile);

export const BUNDLED_CONFIG_PATH = fileURLToPath(
  new URL('../campaigns.config.json', import.meta.url),
);

const CONFIG_FILE_NAME = 'config.json';
const PROJECT_CONFIG_FILE_NAME = '.campaigns.json';

const ENV_OVERRIDES = [
  ['CAMPAIGNS_RUNNER', ['defaultRunner'], String],
  ['CAMPAIGNS_REPO', ['run', 'repoRoot'], String],
  ['CAMPAIGNS_BRANCH', ['run', 'branch'], String],
  ['CAMPAIGNS_MAX_STEPS_PER_RUN', ['run', 'max_steps_per_run'], Number],
  ['CAMPAIGNS_MAX_RUN_MINUTES', ['run', 'max_run_minutes'], Number],
  ['CAMPAIGNS_MAX_COST_USD', ['run', 'max_cost_usd'], Number],
  ['CAMPAIGNS_STOP_GRACE_MS', ['run', 'stop_grace_ms'], Number],
  ['CAMPAIGNS_MAX_PARALLEL_STEPS', ['run', 'max_parallel_steps'], Number],
  ['CAMPAIGNS_FORCE_MERGE_UNREVIEWED', ['review', 'forceMergeUnreviewed'], parseBoolean],
];

const CLI_OVERRIDES = [
  ['runner', ['defaultRunner'], '--runner'],
  ['repoRoot', ['run', 'repoRoot'], '--repo'],
  ['branch', ['run', 'branch'], '--branch'],
  ['maxStepsPerRun', ['run', 'max_steps_per_run'], '--max-steps-per-run', Number],
  ['maxRunMinutes', ['run', 'max_run_minutes'], '--max-run-minutes', Number],
  ['maxCostUsd', ['run', 'max_cost_usd'], '--max-cost-usd', Number],
  ['stopGraceMs', ['run', 'stop_grace_ms'], '--stop-grace-ms', Number],
  ['maxParallelSteps', ['run', 'max_parallel_steps'], '--max-parallel-steps', Number],
  ['forceMergeUnreviewed', ['review', 'forceMergeUnreviewed'], '--force-merge-unreviewed'],
];

export function defaultCampaignsConfigDir(
  env = process.env,
  platform = process.platform,
  home = homedir(),
) {
  if (env.CAMPAIGNS_CONFIG_DIR) return path.resolve(env.CAMPAIGNS_CONFIG_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Campaigns');
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Campaigns');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'campaigns');
}

export function userCampaignsConfigPath(env = process.env) {
  return path.join(defaultCampaignsConfigDir(env), CONFIG_FILE_NAME);
}

export async function resolveCampaignConfig({
  campaignPath = null,
  cwd = process.cwd(),
  env = process.env,
  cli = {},
  explicitConfigPath = cli.configPath ?? null,
} = {}) {
  const canonicalCampaignPath = campaignPath
    ? await realpath(path.resolve(cwd, campaignPath))
    : null;
  const projectRoot = await findCanonicalGitRoot(
    canonicalCampaignPath ? path.dirname(canonicalCampaignPath) : cwd,
  );
  const projectConfigPath = path.join(projectRoot, PROJECT_CONFIG_FILE_NAME);
  const userConfigPath = userCampaignsConfigPath(env);
  const resolvedExplicitPath = explicitConfigPath
    ? path.resolve(cwd, explicitConfigPath)
    : null;
  const layerSpecs = [
    { kind: 'bundled', filePath: BUNDLED_CONFIG_PATH, required: true },
    { kind: 'project', filePath: projectConfigPath, required: false },
    { kind: 'user', filePath: userConfigPath, required: false },
    ...(resolvedExplicitPath
      ? [{ kind: 'explicit', filePath: resolvedExplicitPath, required: true }]
      : []),
  ];

  const config = {};
  const sources = {};
  const sourceFiles = {};
  const files = [];
  const warnings = [];
  for (const spec of layerSpecs) {
    const loaded = await readConfigLayer(spec);
    files.push({ ...spec, loaded: Boolean(loaded) });
    if (!loaded) continue;
    const source = `${spec.kind}:${spec.filePath}`;
    sourceFiles[source] = spec.filePath;
    mergeLayer(config, loaded, [], source, sources);
    warnings.push(...findUnknownKeys(loaded).map((key) => (
      `Unknown key "${key}" in ${spec.kind} config ${spec.filePath}.`
    )));
  }

  for (const [name, keyPath, convert] of ENV_OVERRIDES) {
    if (env[name] === undefined || env[name] === '') continue;
    setScalar(config, keyPath, convert(env[name]), `env:${name}`, sources);
  }
  for (const [name, keyPath, flag, convert = (value) => value] of CLI_OVERRIDES) {
    if (cli[name] === undefined) continue;
    setScalar(config, keyPath, convert(cli[name]), `cli:${flag}`, sources);
  }

  normalizeConfiguredPaths(config, sources, sourceFiles, cwd);
  warnings.push(...await findDeadPaths(config, projectRoot));

  const effective = resolveEffectiveValues(config, sources, env, cli);
  return {
    campaignPath: canonicalCampaignPath,
    projectRoot,
    config,
    sources,
    files,
    warnings,
    effective: effective.values,
    effectiveSources: effective.sources,
  };
}

export function formatConfigDoctor(result) {
  const lines = [
    `Project root: ${result.projectRoot}`,
    'Config files:',
    ...result.files.map((file) => (
      `  ${file.kind}: ${file.filePath} (${file.loaded ? 'loaded' : 'not found'})`
    )),
    'Effective run values:',
    ...Object.entries(redactValue(result.effective)).map(([key, value]) => (
      `  ${key}: ${formatValue(value)} [${result.effectiveSources[key] ?? 'derived'}]`
    )),
    'Resolved configuration:',
    ...flattenValues(redactValue(result.config)).map(([key, value]) => (
      `  ${key}: ${formatValue(value)} [${result.sources[key] ?? 'derived'}]`
    )),
    result.warnings.length > 0 ? 'Warnings:' : 'Warnings: none',
    ...result.warnings.map((warning) => `  - ${warning}`),
  ];
  return `${redactText(lines.join('\n'))}\n`;
}

async function findCanonicalGitRoot(startPath) {
  let result;
  try {
    result = await execFileAsync('git', ['-C', path.resolve(startPath), 'rev-parse', '--show-toplevel']);
  } catch {
    throw new Error(`No Git project root found from ${path.resolve(startPath)}.`);
  }
  return realpath(path.resolve(result.stdout.trim()));
}

async function readConfigLayer({ kind, filePath, required }) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (!required && error.code === 'ENOENT') return null;
    throw new Error(`Could not read ${kind} config ${filePath}: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${kind} config ${filePath}: ${error.message}`);
  }
  if (!isObject(value)) throw new Error(`${kind} config must contain a JSON object: ${filePath}`);
  return value;
}

function mergeLayer(target, incoming, prefix, source, sources) {
  for (const [key, value] of Object.entries(incoming)) {
    const keyPath = [...prefix, key];
    const dotted = keyPath.join('.');
    const replacesRunner = prefix.length === 1 && prefix[0] === 'runners';
    if (replacesRunner) {
      target[key] = structuredClone(value);
      clearSourcePrefix(sources, dotted);
      recordSources(value, keyPath, source, sources);
      continue;
    }
    if (isObject(value) && isObject(target[key])) {
      mergeLayer(target[key], value, keyPath, source, sources);
      continue;
    }
    target[key] = structuredClone(value);
    clearSourcePrefix(sources, dotted);
    recordSources(value, keyPath, source, sources);
  }
}

function recordSources(value, keyPath, source, sources) {
  if (isObject(value) && Object.keys(value).length > 0) {
    for (const [key, child] of Object.entries(value)) {
      recordSources(child, [...keyPath, key], source, sources);
    }
    return;
  }
  sources[keyPath.join('.')] = source;
}

function clearSourcePrefix(sources, prefix) {
  for (const key of Object.keys(sources)) {
    if (key === prefix || key.startsWith(`${prefix}.`)) delete sources[key];
  }
}

function setScalar(config, keyPath, value, source, sources) {
  let parent = config;
  for (const key of keyPath.slice(0, -1)) {
    if (!isObject(parent[key])) parent[key] = {};
    parent = parent[key];
  }
  const dotted = keyPath.join('.');
  parent[keyPath.at(-1)] = value;
  clearSourcePrefix(sources, dotted);
  sources[dotted] = source;
}

function normalizeConfiguredPaths(config, sources, sourceFiles, cwd) {
  const value = config.run?.repoRoot;
  if (typeof value === 'string' && value.trim()) {
    const source = sources['run.repoRoot'];
    const sourceFile = sourceFiles[source];
    config.run.repoRoot = path.resolve(sourceFile ? path.dirname(sourceFile) : cwd, value);
  }

  if (Array.isArray(config.runnerPaths)) {
    const source = sources.runnerPaths;
    const sourceFile = sourceFiles[source];
    const baseDir = sourceFile ? path.dirname(sourceFile) : cwd;
    config.runnerPaths = config.runnerPaths.map((runnerPath) => (
      typeof runnerPath === 'string' && runnerPath.trim()
        ? path.resolve(baseDir, runnerPath)
        : runnerPath
    ));
  }
}

function resolveEffectiveValues(config, sources, env, cli) {
  const runner = config.defaultRunner ?? null;
  let model = config.runners?.[runner]?.defaults?.model ?? null;
  let effort = config.runners?.[runner]?.defaults?.effort ?? null;
  let modelSource = sources[`runners.${runner}.defaults.model`] ?? 'unresolved';
  let effortSource = sources[`runners.${runner}.defaults.effort`] ?? 'unresolved';
  if (env.CAMPAIGNS_MODEL) {
    model = env.CAMPAIGNS_MODEL;
    modelSource = 'env:CAMPAIGNS_MODEL';
  }
  if (env.CAMPAIGNS_EFFORT) {
    effort = env.CAMPAIGNS_EFFORT;
    effortSource = 'env:CAMPAIGNS_EFFORT';
  }
  if (cli.model !== undefined) {
    model = cli.model;
    modelSource = 'cli:--model';
  }
  if (cli.effort !== undefined) {
    effort = cli.effort;
    effortSource = 'cli:--effort';
  }
  return {
    values: {
      runner,
      model,
      effort,
      repoRoot: config.run?.repoRoot ?? null,
      branch: config.run?.branch ?? null,
      maxStepsPerRun: config.run?.max_steps_per_run ?? null,
      maxRunMinutes: config.run?.max_run_minutes ?? null,
      maxCostUsd: config.run?.max_cost_usd ?? null,
      stopGraceMs: config.run?.stop_grace_ms ?? null,
      maxParallelSteps: config.run?.max_parallel_steps ?? null,
      reviewer: config.review?.reviewer ?? 'auto',
      forceMergeUnreviewed: config.review?.forceMergeUnreviewed ?? false,
    },
    sources: {
      runner: sources.defaultRunner,
      model: modelSource,
      effort: effortSource,
      repoRoot: sources['run.repoRoot'],
      branch: sources['run.branch'],
      maxStepsPerRun: sources['run.max_steps_per_run'],
      maxRunMinutes: sources['run.max_run_minutes'],
      maxCostUsd: sources['run.max_cost_usd'],
      stopGraceMs: sources['run.stop_grace_ms'],
      maxParallelSteps: sources['run.max_parallel_steps'],
      reviewer: sources['review.reviewer'] ?? 'bundled default',
      forceMergeUnreviewed: sources['review.forceMergeUnreviewed'],
    },
  };
}

async function findDeadPaths(config, projectRoot) {
  const candidates = [];
  if (typeof config.run?.repoRoot === 'string' && config.run.repoRoot) {
    candidates.push(['run.repoRoot', config.run.repoRoot]);
  }
  for (const [index, runnerPath] of (Array.isArray(config.runnerPaths) ? config.runnerPaths : []).entries()) {
    if (typeof runnerPath !== 'string' || !runnerPath) continue;
    candidates.push([`runnerPaths[${index}]`, runnerPath]);
  }
  for (const [name, runner] of Object.entries(config.runners ?? {})) {
    if (typeof runner?.binary !== 'string' || !looksLikePath(runner.binary)) continue;
    candidates.push([
      `runners.${name}.binary`,
      path.resolve(config.run?.repoRoot || projectRoot, runner.binary),
    ]);
  }
  const warnings = [];
  for (const [key, candidate] of candidates) {
    try {
      await access(candidate);
    } catch {
      warnings.push(`Path "${key}" does not exist: ${candidate}.`);
    }
  }
  return warnings;
}

function findUnknownKeys(value, prefix = []) {
  if (!isObject(value)) return [];
  const allowed = allowedChildren(prefix);
  if (allowed === null) return [];
  const unknown = [];
  for (const [key, child] of Object.entries(value)) {
    if (allowed !== 'any' && !allowed.has(key)) {
      unknown.push([...prefix, key].join('.'));
      continue;
    }
    unknown.push(...findUnknownKeys(child, [...prefix, key]));
  }
  return unknown;
}

function allowedChildren(prefix) {
  const dotted = prefix.join('.');
  if (dotted === '') {
    return new Set([
      'schemaVersion',
      '_comment',
      'defaultRunner',
      'runnerPaths',
      'watchdog',
      'run',
      'review',
      'runners',
    ]);
  }
  if (dotted === 'watchdog') return new Set(['minimum_runtime_ms', 'stall_window_ms']);
  if (dotted === 'run') {
    return new Set([
      'repoRoot',
      'branch',
      'max_steps_per_run',
      'max_run_minutes',
      'max_cost_usd',
      'stop_grace_ms',
      'max_parallel_steps',
    ]);
  }
  if (dotted === 'review') return new Set(['reviewer', 'maxFixAttempts', 'forceMergeUnreviewed']);
  if (dotted === 'runners') return 'any';
  if (/^runners\.[^.]+$/.test(dotted)) {
    return new Set([
      'label',
      'family',
      'binary',
      'args',
      'prompt',
      'defaults',
      'models',
      'efforts',
      'effortMap',
      'environment',
      'completion',
      'usage',
    ]);
  }
  if (/^runners\.[^.]+\.prompt$/.test(dotted)) return new Set(['delivery']);
  if (/^runners\.[^.]+\.defaults$/.test(dotted)) return new Set(['model', 'effort']);
  if (/^runners\.[^.]+\.environment$/.test(dotted)) return new Set(['remove']);
  if (/^runners\.[^.]+\.completion$/.test(dotted)) return new Set(['marker', 'sources']);
  if (/^runners\.[^.]+\.usage$/.test(dotted)) return new Set(['sources']);
  return null;
}

function flattenValues(value, prefix = []) {
  if (isObject(value) && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([key, child]) => (
      flattenValues(child, [...prefix, key])
    ));
  }
  return [[prefix.join('.'), value]];
}

function formatValue(value) {
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function looksLikePath(value) {
  return value.startsWith('.') || value.includes('/') || value.includes('\\');
}

function parseBoolean(value) {
  if (/^(?:1|true|yes|on)$/i.test(value)) return true;
  if (/^(?:0|false|no|off)$/i.test(value)) return false;
  return value;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
