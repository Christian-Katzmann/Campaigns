import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RUNNER_CONFIG_PATH = fileURLToPath(
  new URL('../campaigns.config.json', import.meta.url),
);

const PROMPT_DELIVERIES = new Set(['stdin', 'arg']);
const COMPLETION_SOURCE_KINDS = new Set(['text', 'jsonl']);

export async function loadRunnerRegistry(configPath = DEFAULT_RUNNER_CONFIG_PATH) {
  const raw = await readFile(configPath, 'utf8');
  return createRunnerRegistry(JSON.parse(raw));
}

export function createRunnerRegistry(config) {
  if (!isObject(config)) throw new TypeError('runner config must be an object');
  if (!Number.isInteger(config.schemaVersion) || config.schemaVersion < 1) {
    throw new TypeError('runner config schemaVersion must be a positive integer');
  }
  const defaultRunner = requireString(config.defaultRunner, 'defaultRunner');
  const watchdog = normalizeWatchdog(config.watchdog);
  if (!isObject(config.runners) || Object.keys(config.runners).length === 0) {
    throw new TypeError('runners must be a non-empty object');
  }

  const runners = new Map(
    Object.entries(config.runners).map(([name, runner]) => [name, normalizeRunner(name, runner)]),
  );
  if (!runners.has(defaultRunner)) {
    throw new TypeError(`defaultRunner names an unknown runner: ${defaultRunner}`);
  }

  return Object.freeze({
    schemaVersion: config.schemaVersion,
    defaultRunner,
    watchdog: Object.freeze(watchdog),
    names: Object.freeze([...runners.keys()]),
    get(name = defaultRunner) {
      const runner = runners.get(name);
      if (!runner) throw new TypeError(`Unknown runner: ${name}`);
      return runner;
    },
  });
}

export function buildRunnerInvocation(registry, runnerName, options = {}) {
  const runner = registry.get(runnerName);
  const prompt = requireString(options.prompt, 'prompt');
  const model = requireString(options.model ?? runner.defaults.model, 'model');
  const requestedEffort = requireString(options.effort ?? runner.defaults.effort, 'effort');
  const effort = runner.effortMap[requestedEffort] ?? requestedEffort;
  const values = {
    effort,
    model,
    output: options.outputPath,
    prompt,
    repo: options.repoRoot,
  };
  const args = runner.args.map((argument) => renderTemplate(argument, values, runner.name));
  const env = { ...(options.env ?? process.env) };
  for (const key of runner.environment.remove) delete env[key];

  return {
    runner: runner.name,
    command: runner.binary,
    args,
    stdin: runner.prompt.delivery === 'stdin' ? prompt : null,
    env,
    model,
    effort,
  };
}

export function createRunnerCompletionMarker(registry, runnerName, expected) {
  const runner = registry.get(runnerName);
  return JSON.stringify(expectedMarker(runner, expected));
}

export function createRunnerCompletionInstruction(registry, runnerName, expected) {
  const marker = createRunnerCompletionMarker(registry, runnerName, expected);
  return `After the work and verification succeed, print this exact JSON object as the final non-empty line of your final response:\n${marker}`;
}

export function classifyRunnerResult(registry, runnerName, result) {
  const runner = registry.get(runnerName);
  if (!isObject(result)) throw new TypeError('runner result must be an object');
  const expected = normalizeExpected(result.expected);
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  const exitCode = result.exitCode;

  if (!Number.isInteger(exitCode)) throw new TypeError('exitCode must be an integer');
  if (exitCode !== 0) {
    return failedResult(
      expected.step_id,
      'worker_exit',
      `Runner exited with code ${exitCode}.`,
      stdout,
      stderr,
    );
  }

  const wanted = expectedMarker(runner, expected);
  const marker = findCompletionMarker(runner.completion.sources, stdout, wanted);
  if (!marker) {
    return failedResult(
      expected.step_id,
      'completion_signal_missing',
      'Runner exited without a matching structured completion marker.',
      stdout,
      stderr,
    );
  }

  if (!path.isAbsolute(result.receiptPath ?? '')) {
    throw new TypeError('receiptPath must be absolute for a completed runner result');
  }
  return {
    completed: true,
    marker,
    transition: {
      event: 'step_completed',
      step_id: expected.step_id,
      receipt_path: result.receiptPath,
    },
  };
}

function normalizeRunner(name, runner) {
  if (!isObject(runner)) throw new TypeError(`runners.${name} must be an object`);
  const binary = requireString(runner.binary, `runners.${name}.binary`);
  if (!Array.isArray(runner.args) || runner.args.some((value) => typeof value !== 'string')) {
    throw new TypeError(`runners.${name}.args must be an array of strings`);
  }
  if (!isObject(runner.prompt) || !PROMPT_DELIVERIES.has(runner.prompt.delivery)) {
    throw new TypeError(`runners.${name}.prompt.delivery must be stdin or arg`);
  }
  const hasPromptPlaceholder = runner.args.some((argument) => argument.includes('{prompt}'));
  if (runner.prompt.delivery === 'arg' && !hasPromptPlaceholder) {
    throw new TypeError(`runners.${name} uses arg prompt delivery but has no {prompt} argument`);
  }
  if (runner.prompt.delivery === 'stdin' && hasPromptPlaceholder) {
    throw new TypeError(`runners.${name} uses stdin prompt delivery but has a {prompt} argument`);
  }
  if (!isObject(runner.defaults)) throw new TypeError(`runners.${name}.defaults must be an object`);
  const defaults = {
    model: requireString(runner.defaults.model, `runners.${name}.defaults.model`),
    effort: requireString(runner.defaults.effort, `runners.${name}.defaults.effort`),
  };
  const effortMap = normalizeStringMap(runner.effortMap, `runners.${name}.effortMap`);
  const environment = normalizeEnvironment(name, runner.environment);
  const completion = normalizeCompletion(name, runner.completion);

  return Object.freeze({
    name,
    binary,
    args: Object.freeze([...runner.args]),
    prompt: Object.freeze({ delivery: runner.prompt.delivery }),
    defaults: Object.freeze(defaults),
    effortMap: Object.freeze(effortMap),
    environment: Object.freeze(environment),
    completion: Object.freeze(completion),
  });
}

function normalizeWatchdog(watchdog) {
  if (!isObject(watchdog)) throw new TypeError('watchdog must be an object');
  const minimumRuntime = watchdog.minimum_runtime_ms;
  const stallWindow = watchdog.stall_window_ms;
  if (!Number.isInteger(minimumRuntime) || minimumRuntime < 0) {
    throw new TypeError('watchdog.minimum_runtime_ms must be a non-negative integer');
  }
  if (!Number.isInteger(stallWindow) || stallWindow < 1) {
    throw new TypeError('watchdog.stall_window_ms must be a positive integer');
  }
  return { minimum_runtime_ms: minimumRuntime, stall_window_ms: stallWindow };
}

function normalizeEnvironment(name, environment) {
  if (!isObject(environment) || !Array.isArray(environment.remove)) {
    throw new TypeError(`runners.${name}.environment.remove must be an array`);
  }
  for (const key of environment.remove) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new TypeError(`runners.${name}.environment.remove must contain environment names`);
    }
  }
  return { remove: Object.freeze([...new Set(environment.remove)]) };
}

function normalizeCompletion(name, completion) {
  if (!isObject(completion) || !isObject(completion.marker)) {
    throw new TypeError(`runners.${name}.completion.marker must be an object`);
  }
  const markerEntries = Object.entries(completion.marker);
  if (markerEntries.length === 0 || markerEntries.some(([, value]) => !isScalar(value))) {
    throw new TypeError(`runners.${name}.completion.marker must contain scalar fields`);
  }
  if (!Array.isArray(completion.sources) || completion.sources.length === 0) {
    throw new TypeError(`runners.${name}.completion.sources must be a non-empty array`);
  }
  const sources = completion.sources.map((source, index) => {
    const label = `runners.${name}.completion.sources[${index}]`;
    if (!isObject(source) || !COMPLETION_SOURCE_KINDS.has(source.kind)) {
      throw new TypeError(`${label}.kind must be text or jsonl`);
    }
    if (source.kind === 'text') return Object.freeze({ kind: 'text' });
    if (!isObject(source.match)) throw new TypeError(`${label}.match must be an object`);
    const match = normalizeScalarMap(source.match, `${label}.match`);
    return Object.freeze({
      kind: 'jsonl',
      match: Object.freeze(match),
      field: requireString(source.field, `${label}.field`),
    });
  });
  return {
    marker: Object.freeze({ ...completion.marker }),
    sources: Object.freeze(sources),
  };
}

function normalizeStringMap(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} must be an object`);
  const result = {};
  for (const [key, mapped] of Object.entries(value)) {
    result[requireString(key, `${label} key`)] = requireString(mapped, `${label}.${key}`);
  }
  return result;
}

function normalizeScalarMap(value, label) {
  const result = {};
  for (const [key, expected] of Object.entries(value)) {
    if (!isScalar(expected)) throw new TypeError(`${label}.${key} must be scalar`);
    result[requireString(key, `${label} key`)] = expected;
  }
  return result;
}

function renderTemplate(template, values, runnerName) {
  return template.replace(/\{([a-z_]+)\}/g, (_match, key) => {
    if (!Object.hasOwn(values, key)) {
      throw new TypeError(`Runner ${runnerName} uses unknown template field {${key}}`);
    }
    const value = values[key];
    if (value == null || value === '') {
      throw new TypeError(`Runner ${runnerName} requires template field {${key}}`);
    }
    return String(value);
  });
}

function expectedMarker(runner, expected) {
  const identity = normalizeExpected(expected);
  return {
    ...runner.completion.marker,
    run_id: identity.run_id,
    step_id: identity.step_id,
    invocation_id: identity.invocation_id,
  };
}

function normalizeExpected(expected) {
  if (!isObject(expected)) throw new TypeError('expected completion identity must be an object');
  return {
    run_id: requireString(expected.run_id, 'expected.run_id'),
    step_id: requireString(expected.step_id, 'expected.step_id'),
    invocation_id: requireString(expected.invocation_id, 'expected.invocation_id'),
  };
}

function findCompletionMarker(sources, stdout, wanted) {
  for (const text of extractCompletionTexts(sources, stdout)) {
    const line = text.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).at(-1);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (isObject(parsed) && matchesFields(parsed, wanted)) return parsed;
    } catch {
      // A normal final sentence is simply not a completion marker.
    }
  }
  return null;
}

function extractCompletionTexts(sources, stdout) {
  const texts = [];
  for (const source of sources) {
    if (source.kind === 'text') {
      texts.push(stdout);
      continue;
    }
    for (const line of stdout.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        const event = JSON.parse(line);
        if (!isObject(event) || !matchesFields(event, source.match)) continue;
        const value = valueAtPath(event, source.field);
        if (typeof value === 'string') texts.push(value);
      } catch {
        // Non-JSON output is ignored for a jsonl completion source.
      }
    }
  }
  return texts;
}

function matchesFields(value, expected) {
  return Object.entries(expected).every(([key, wanted]) => valueAtPath(value, key) === wanted);
}

function valueAtPath(value, fieldPath) {
  return fieldPath.split('.').reduce((current, key) => current?.[key], value);
}

function failedResult(stepId, code, message, stdout, stderr) {
  return {
    completed: false,
    marker: null,
    transition: {
      event: 'step_failed',
      step_id: stepId,
      failure: {
        code,
        message,
        retryable: true,
        output_tail: outputTail(stdout, stderr),
      },
    },
  };
}

function outputTail(stdout, stderr) {
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  return combined.slice(-4_000) || null;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}
