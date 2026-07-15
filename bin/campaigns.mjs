#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CampaignStopError,
  defaultCampaignsRunsDir,
  PumpLockError,
  requestCampaignStop,
  runCampaign,
} from '../lib/pump.mjs';
import { formatConfigDoctor, resolveCampaignConfig } from '../lib/config.mjs';
import { loadUnifiedLessons } from '../lib/lessons.mjs';
import { RecoveryError, recoverCampaign } from '../lib/recovery.mjs';
import { RollbackError, rollbackCampaign } from '../lib/rollback.mjs';
import {
  analyzePlanHealth,
  resolveAvoidAboveSteps,
} from '../public/lib/plan-health.mjs';

const HELP = `Usage:
  campaigns [--no-open] [--port <number>]
  campaigns run <campaign.md> [options]
  campaigns recover <campaign.md> [options]
  campaigns rollback <campaign.md> --to <step> [options]
  campaigns stop <campaign.md> [options]
  campaigns lint <campaign.md> [--state-dir <path>]
  campaigns config doctor [campaign.md] [options]

Board options:
  --no-open             Launch the bundled sample without opening a browser
  --port <number>       Board port (defaults to 4178; use 0 for any free port)

Options:
  --runner <name>       Runner from campaigns.config.json
  --model <id>          Override the runner's default model
  --effort <level>      Override the runner's default effort
  --repo <path>         Execution repository (defaults to campaign's Git root)
  --branch <name>       Branch to check out or create before the first step
  --config <path>       Extra config file, after project and user config
  --state-dir <path>    Run-ledger directory
  --no-worktree         Run directly on the campaign branch
  --registry-id <id>    Campaign registry identity
  --max-steps-per-run <count>
                         Stop before starting more than this many steps
  --max-run-minutes <minutes>
                         Stop when the total run-time cap is reached
  --stop-grace-ms <ms>  Grace period before terminating the worker group
  --to <step>            Keep work through this step and rewind everything after it
  --max-parallel-steps <count>
                         Concurrent same-phase step workers (default 2)
  --force-merge-unreviewed
                         Merge after review failure (explicit escape hatch)
  -h, --help            Show this help
`;

async function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (isBoardLaunch(argv)) {
    let options;
    try {
      options = parseBoardOptions(argv);
      await launchSampleBoard(options);
      return 0;
    } catch (error) {
      process.stderr.write(`campaigns: ${error.message}\n`);
      return 1;
    }
  }
  if (argv[0] === 'config') return runConfigCommand(argv.slice(1));
  if (argv[0] === 'lint') return runLintCommand(argv.slice(1));
  const [command, campaignFile, ...rest] = argv;
  if (!['run', 'recover', 'rollback', 'stop'].includes(command) || !campaignFile) {
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
  if (command === 'stop') {
    try {
      const result = await requestCampaignStop(campaignFile, options);
      process.stdout.write(`Campaign stopped.\nState: ${result.statePath}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`campaigns: ${error.message}\n`);
      return error instanceof CampaignStopError ? 2 : 1;
    }
  }
  if (command === 'rollback') {
    try {
      const result = await rollbackCampaign(campaignFile, options);
      process.stdout.write(`${result.message}\nReceipt: ${result.receiptPath}\nState: ${result.statePath}\n`);
      return 0;
    } catch (error) {
      process.stderr.write(`campaigns: ${error.message}\n`);
      return error instanceof RollbackError ? 2 : 1;
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

async function runLintCommand(argv) {
  let parsed;
  try {
    parsed = parseLintOptions(argv);
  } catch (error) {
    process.stderr.write(`campaigns: ${error.message}\n`);
    return 2;
  }

  try {
    const campaignPath = path.resolve(parsed.campaignFile);
    const [markdown, lessons] = await Promise.all([
      readFile(campaignPath, 'utf8'),
      loadUnifiedLessons(parsed.runsDir),
    ]);
    const findings = analyzePlanHealth(markdown, resolveAvoidAboveSteps(lessons));

    if (findings.length === 0) {
      process.stdout.write(`${campaignPath}: clean\n`);
      return 0;
    }

    for (const finding of findings) {
      process.stdout.write(
        `${campaignPath}:${finding.line}: ${finding.severity} [${finding.ruleId}] ${finding.message}\n`
        + `  Fix: ${finding.fixHint}\n`,
      );
    }
    return findings.some((finding) => finding.severity === 'error') ? 1 : 0;
  } catch (error) {
    process.stderr.write(`campaigns: ${error.message}\n`);
    return 2;
  }
}

async function runConfigCommand(argv) {
  if (argv[0] !== 'doctor') {
    process.stderr.write(HELP);
    return 2;
  }
  let parsed;
  try {
    parsed = parseDoctorOptions(argv.slice(1));
  } catch (error) {
    process.stderr.write(`campaigns: ${error.message}\n`);
    return 2;
  }
  try {
    const result = await resolveCampaignConfig({
      campaignPath: parsed.campaignFile,
      env: process.env,
      cli: parsed.options,
      explicitConfigPath: parsed.options.configPath,
    });
    process.stdout.write(formatConfigDoctor(result));
    return 0;
  } catch (error) {
    process.stderr.write(`campaigns: ${error.message}\n`);
    return 1;
  }
}

function isBoardLaunch(argv) {
  return argv.length === 0 || argv[0] === '--no-open' || argv[0] === '--port';
}

function parseBoardOptions(args) {
  const options = { open: true, port: 4178 };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--no-open') {
      options.open = false;
      continue;
    }
    if (args[index] === '--port') {
      const port = Number(args[index + 1]);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error(`Invalid port: ${args[index + 1] ?? ''}`);
      }
      options.port = port;
      index += 1;
      continue;
    }
    throw new Error(`Unknown board option: ${args[index]}`);
  }
  return options;
}

async function launchSampleBoard({ open, port }) {
  const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const samplePath = path.join(packageRoot, 'examples', 'sample-campaign.md');
  const { startServer } = await import('../server.mjs');
  const boardServer = await startServer({
    campaignFile: samplePath,
    host: '127.0.0.1',
    port,
  });
  if (!open) return;

  const address = boardServer.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  openBrowser(`http://127.0.0.1:${actualPort}`);
}

function openBrowser(url) {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  execFile(command, args, (error) => {
    if (error) process.stderr.write(`campaigns: Could not open a browser: ${error.message}\n`);
  });
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
    ['--max-steps-per-run', 'maxStepsPerRun'],
    ['--max-run-minutes', 'maxRunMinutes'],
    ['--stop-grace-ms', 'stopGraceMs'],
    ['--max-parallel-steps', 'maxParallelSteps'],
  ];
  const names = new Map(command === 'recover'
    ? [['--state-dir', 'runsDir']]
    : command === 'rollback'
      ? [['--state-dir', 'runsDir'], ['--to', 'to']]
    : command === 'stop'
      ? [['--state-dir', 'runsDir'], ['--stop-grace-ms', 'stopGraceMs']]
      : runNames);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (command === 'run' && args[index] === '--force-merge-unreviewed') {
      options.forceMergeUnreviewed = true;
      continue;
    }
    if (command === 'run' && args[index] === '--no-worktree') {
      options.noWorktree = true;
      continue;
    }
    const key = names.get(args[index]);
    if (!key || !args[index + 1]) throw new Error(`Unknown or incomplete option: ${args[index]}`);
    options[key] = args[index + 1];
    index += 1;
  }
  return options;
}

function parseDoctorOptions(args) {
  let campaignFile = null;
  const optionArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('-')) {
      if (campaignFile) throw new Error(`Unexpected argument: ${argument}`);
      campaignFile = argument;
      continue;
    }
    optionArgs.push(argument);
    if (argument === '--force-merge-unreviewed' || argument === '--no-worktree') continue;
    if (!args[index + 1]) throw new Error(`Unknown or incomplete option: ${argument}`);
    optionArgs.push(args[index + 1]);
    index += 1;
  }
  return { campaignFile, options: parseOptions(optionArgs, 'run') };
}

function parseLintOptions(args) {
  const [campaignFile, ...rest] = args;
  if (!campaignFile || campaignFile.startsWith('-')) {
    throw new Error('Usage: campaigns lint <campaign.md> [--state-dir <path>]');
  }

  let runsDir = defaultCampaignsRunsDir(process.env);
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== '--state-dir' || !rest[index + 1]) {
      throw new Error(`Unknown or incomplete lint option: ${rest[index]}`);
    }
    runsDir = path.resolve(rest[index + 1]);
    index += 1;
  }
  return { campaignFile, runsDir };
}

process.exitCode = await main(process.argv.slice(2));
