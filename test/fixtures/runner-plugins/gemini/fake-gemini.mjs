#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const prompt = process.argv[2] ?? '';

if (!prompt.includes('campaigns.step_completed')) {
  process.stdout.write('Verdict: APPROVED\nReasons:\n\nGemini plugin fixture passed.');
  process.exit(0);
}

const stepId = prompt.match(/^Step: ([^ ]+)/m)?.[1] ?? 'unknown';
const resultPath = `gemini-plugin-${stepId}.txt`;
writeFileSync(resultPath, `${stepId}\n`);
execFileSync('git', ['add', resultPath]);
execFileSync('git', [
  '-c',
  'commit.gpgSign=false',
  'commit',
  '-m',
  `Complete ${stepId} with Gemini plugin`,
]);
process.stdout.write(`${JSON.stringify({
  type: 'usage',
  metrics: { prompt: 120, completion: 30, cost: 0.0042 },
})}\n${prompt}`);
