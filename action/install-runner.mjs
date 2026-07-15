#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateInputs } from './preflight.mjs';

export function runnerPackageSpec(runner, version) {
  const inputs = validateInputs({
    campaign: 'campaign.md',
    runner,
    runnerCliVersion: version,
    maxSteps: 1,
    maxMinutes: 1,
    maxCostUsd: 1,
  });
  return `@anthropic-ai/claude-code@${inputs.runnerCliVersion}`;
}

export function installRunner({
  runner = process.env.INPUT_RUNNER,
  version = process.env.INPUT_RUNNER_CLI_VERSION,
  env = process.env,
} = {}) {
  const packageSpec = runnerPackageSpec(runner, version);
  return new Promise((resolve, reject) => {
    const child = spawn('npm', [
      'install', '--global', '--no-audit', '--no-fund', packageSpec,
    ], { env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install exited ${code ?? 1}`));
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installRunner().catch((error) => {
    process.stderr.write(`campaigns-action: ${error.message}\n`);
    process.exitCode = 1;
  });
}
