#!/usr/bin/env node

import { PumpLockError, runCampaign } from '../lib/pump.mjs';
import { RecoveryError, recoverCampaign } from '../lib/recovery.mjs';

const HELP = `Usage:
  campaigns run <campaign.md> [options]
  campaigns recover <campaign.md> [options]

Options:
  --runner <name>       Runner from campaigns.config.json
  --model <id>          Override the runner's default model
  --effort <level>      Override the runner's default effort
  --repo <path>         Execution repository (defaults to campaign's Git root)
  --branch <name>       Branch to check out or create before the first step
  --config <path>       Runner config path
  --state-dir <path>    Run-ledger directory
  --registry-id <id>    Campaign registry identity
  --force-merge-unreviewed
                         Merge after review failure (explicit escape hatch)
  -h, --help            Show this help
`;

async function main(argv) {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const [command, campaignFile, ...rest] = argv;
  if (!['run', 'recover'].includes(command) || !campaignFile) {
    process.stderr.write(HELP);
    return 2;
  }

  let options;
  try {
    options = parseOptions(rest, command);
  } catch (error) {
    process.stderr.write(`campaigns: ${error.message}\n`);
    return 2;
  }
  if (command === 'recover') {
    try {
      const result = await recoverCampaign(campaignFile, { runsDir: options.runsDir });
      process.stdout.write(`${result.message}\nState: ${result.statePath}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`campaigns: ${error.message}\n`);
      return error instanceof RecoveryError ? 2 : 1;
    }
  }

  const controller = new AbortController();
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runCampaign(campaignFile, { ...options, signal: controller.signal });
    return interrupted ? 130 : 0;
  } catch (error) {
    process.stderr.write(`campaigns: ${error.message}\n`);
    if (interrupted) return 130;
    return error instanceof PumpLockError ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

function parseOptions(args, command) {
  const runNames = [
    ['--runner', 'runner'],
    ['--model', 'model'],
    ['--effort', 'effort'],
    ['--repo', 'repoRoot'],
    ['--branch', 'branch'],
    ['--config', 'configPath'],
    ['--state-dir', 'runsDir'],
    ['--registry-id', 'registryId'],
  ];
  const names = new Map(command === 'recover'
    ? [['--state-dir', 'runsDir']]
    : runNames);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (command === 'run' && args[index] === '--force-merge-unreviewed') {
      options.forceMergeUnreviewed = true;
      continue;
    }
    const key = names.get(args[index]);
    if (!key || !args[index + 1]) throw new Error(`Unknown or incomplete option: ${args[index]}`);
    options[key] = args[index + 1];
    index += 1;
  }
  return options;
}

process.exitCode = await main(process.argv.slice(2));
