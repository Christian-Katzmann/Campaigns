import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, appendFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { isPhoneReachableHttpsUrl } from './notifications.mjs';
import { redactAndCapText, redactText } from './redaction.mjs';
import { runRunnerInvocation } from './runner-process.mjs';
import { buildRunnerInvocation, extractRunnerOutput } from './runners.mjs';

const execFileAsync = promisify(execFile);

export const DEVICE_ONBOARDING_TIMEOUT_MS = 20 * 60 * 1_000;
export const DEVICE_ONBOARDING_TRANSCRIPT_MAX_CHARACTERS = 16_000;

const TERMINAL_STATUSES = new Set(['completed', 'manual_checkpoint', 'cancelled', 'failed']);
const RESULT_PREFIX = 'DEVICE_ONBOARDING_RESULT';

export class DeviceOnboardingError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'DeviceOnboardingError';
    this.statusCode = statusCode;
  }
}

export function isStablePrivatePhoneUrl(value) {
  if (!isPhoneReachableHttpsUrl(value)) return false;
  const host = new URL(value).hostname.toLowerCase();
  if (host.endsWith('.ts.net')) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

export async function resolveDeviceItSkill({ env = process.env, home = env.HOME || homedir() } = {}) {
  const candidates = [
    env.CAMPAIGNS_DEVICE_IT_SKILL,
    env.CODEX_HOME ? path.join(env.CODEX_HOME, 'skills', 'device-it') : null,
    path.join(home, '.codex', 'skills', 'device-it'),
    path.join(home, '.agents', 'skills', 'device-it'),
    path.join(home, 'Dev', 'skills', 'device-it'),
    path.join(home, 'Developer', 'skills', 'device-it'),
  ].filter(Boolean);

  for (const candidate of [...new Set(candidates.map(normalizeSkillRoot))]) {
    const skillPath = path.join(candidate, 'SKILL.md');
    const runScript = path.join(candidate, 'scripts', 'run.sh');
    try {
      await Promise.all([
        access(skillPath, fsConstants.R_OK),
        access(runScript, fsConstants.R_OK),
      ]);
      return {
        available: true,
        path: candidate,
        skillPath,
        runScript,
        outputDir: path.join(home, '.device-it', 'out'),
      };
    } catch {
      // Try the next conventional skill root.
    }
  }

  return {
    available: false,
    path: '',
    skillPath: '',
    runScript: '',
    outputDir: path.join(home, '.device-it', 'out'),
  };
}

export async function resolveStablePrivateUrl({
  exec = execFileAsync,
  targetPort,
  verifiedPhoneUrl = '',
} = {}) {
  if (isStablePrivatePhoneUrl(verifiedPhoneUrl)) {
    return {
      available: true,
      bridgeState: 'verified',
      installed: true,
      kind: 'verified-url',
      tool: 'verified URL',
      url: new URL(verifiedPhoneUrl).toString(),
    };
  }

  let status;
  try {
    const result = await exec('tailscale', ['status', '--json'], { timeout: 4_000, maxBuffer: 2_000_000 });
    status = JSON.parse(result.stdout);
  } catch (error) {
    return {
      available: false,
      bridgeState: 'unavailable',
      installed: error?.code !== 'ENOENT',
      kind: 'tailscale-serve',
      tool: 'Tailscale Serve',
      url: '',
      hint: error?.code === 'ENOENT'
        ? 'Install Tailscale, then open Campaigns again.'
        : 'Turn on Tailscale, then open Campaigns again.',
    };
  }

  const dnsName = String(status?.Self?.DNSName ?? '').replace(/\.$/, '');
  const online = status?.BackendState === 'Running' && status?.Self?.Online !== false;
  if (!online || !dnsName) {
    return {
      available: false,
      bridgeState: 'unavailable',
      installed: true,
      kind: 'tailscale-serve',
      tool: 'Tailscale Serve',
      url: '',
      hint: 'Turn on Tailscale, then open Campaigns again.',
    };
  }

  let serveStatus = {};
  try {
    const result = await exec('tailscale', ['serve', 'status', '--json'], {
      timeout: 4_000,
      maxBuffer: 2_000_000,
    });
    serveStatus = result.stdout.trim() ? JSON.parse(result.stdout) : {};
  } catch {
    return {
      available: false,
      bridgeState: 'unavailable',
      installed: true,
      kind: 'tailscale-serve',
      tool: 'Tailscale Serve',
      url: '',
      hint: 'Tailscale Serve is unavailable. Run `tailscale serve status` once, then retry.',
    };
  }

  const serialized = JSON.stringify(serveStatus);
  const hasServeConfig = Object.keys(serveStatus).length > 0;
  const targetsCampaigns = Number.isInteger(Number(targetPort))
    && new RegExp(`(?:127\\.0\\.0\\.1|localhost):${Number(targetPort)}(?:[\\/"}]|$)`).test(serialized);
  if (hasServeConfig && !targetsCampaigns) {
    return {
      available: false,
      bridgeState: 'conflict',
      installed: true,
      kind: 'tailscale-serve',
      tool: 'Tailscale Serve',
      url: '',
      hint: 'Tailscale Serve already routes this Mac. Clear that route or provide a verified Campaigns URL.',
    };
  }

  return {
    available: true,
    bridgeState: targetsCampaigns ? 'matching' : 'empty',
    installed: true,
    kind: 'tailscale-serve',
    tool: 'Tailscale Serve',
    url: `https://${dnsName}/`,
  };
}

export async function resolveDeviceOnboardingContext({
  env = process.env,
  exec,
  home,
  runnerCatalog = [],
  runnerRegistry,
  targetPort,
  verifiedPhoneUrl = '',
} = {}) {
  const availableRunners = runnerCatalog.filter((runner) => runner.available === true);
  const runner = availableRunners.find((candidate) => candidate.id === runnerRegistry?.defaultRunner)
    ?? availableRunners[0]
    ?? null;
  const [skill, stable] = await Promise.all([
    resolveDeviceItSkill({ env, home }),
    resolveStablePrivateUrl({ exec, targetPort, verifiedPhoneUrl }),
  ]);

  let hint = '';
  if (!runner) hint = 'Configure an available agent runner to use phone onboarding.';
  else if (!skill.available) hint = 'Install the device-it skill to use guided phone onboarding.';
  else if (!stable.available) hint = stable.hint || 'Connect a stable private HTTPS URL, then retry.';

  return {
    capability: {
      available: Boolean(runner && skill.available && stable.available),
      hint,
      runner: {
        ready: Boolean(runner),
        id: runner?.id ?? '',
        label: runner?.label ?? '',
      },
      skill: {
        ready: skill.available,
        path: skill.path,
      },
      stablePrivateUrl: {
        ready: stable.available,
        kind: stable.kind,
        tool: stable.tool,
        url: stable.url,
      },
    },
    runner,
    runnerRegistry,
    skill,
    stable,
    targetPort: Number(targetPort),
  };
}

export function buildDeviceOnboardingPrompt({ projectRoot, skill, stableUrl }) {
  if (!skill?.runScript || !skill?.skillPath) {
    throw new TypeError('A resolved device-it skill is required.');
  }
  if (!isStablePrivatePhoneUrl(stableUrl)) {
    throw new TypeError('A phone-reachable HTTPS URL is required.');
  }

  const command = [
    'bash',
    shellQuote(skill.runScript),
    '--url',
    shellQuote(new URL(stableUrl).toString()),
    '--name',
    shellQuote('Campaigns'),
    '--slug',
    'campaigns',
  ].join(' ');

  return `Put this running Campaigns app on the user's phone. This is one bounded onboarding job.

Read ${skill.skillPath} completely and follow its current lane contract.
Project root: ${projectRoot}
Stable private URL: ${new URL(stableUrl).toString()}

Required sequence:
1. Run the device-it inspect script against the project root. Confirm FRAMEWORK=node-other and BUILD_CMD is empty.
2. Use device-it WRAP MODE with this exact command:
   ${command}
3. Do not run device-it's build/deploy pipeline. Do not use an anonymous or public deploy. Do not modify Campaigns source.
4. Do not change Tailscale Serve; Campaigns owns that private bridge lifecycle.
5. Verify the stable URL can GET /api/registry. Campaigns will independently verify the guarded baseHash action after you finish.
6. If the lane is scan, stop at the honest phone checkpoint: scan/open the link, then Share → Add to Home Screen. Do not hang waiting for a tap.

Finish with exactly one single-line record:
${RESULT_PREFIX} {"status":"ready|manual_checkpoint","url":"${new URL(stableUrl).toString()}","qr":"absolute PNG path or empty","checkpoint":"clear phone-side instruction or empty"}`;
}

export function parseDeviceOnboardingResult(value, expectedUrl) {
  const text = String(value ?? '');
  const matches = [...text.matchAll(new RegExp(`${RESULT_PREFIX}\\s+(\\{[^\\r\\n]+\\})`, 'g'))];
  if (matches.length === 0) {
    throw new DeviceOnboardingError(502, 'The onboarding agent exited without a completion record.');
  }

  let parsed;
  try {
    parsed = JSON.parse(matches.at(-1)[1]);
  } catch {
    throw new DeviceOnboardingError(502, 'The onboarding agent returned an invalid completion record.');
  }
  if (!['ready', 'manual_checkpoint'].includes(parsed.status)) {
    throw new DeviceOnboardingError(502, 'The onboarding completion status was invalid.');
  }
  if (!isStablePrivatePhoneUrl(parsed.url)) {
    throw new DeviceOnboardingError(502, 'The onboarding agent did not return a phone-reachable HTTPS URL.');
  }
  if (new URL(parsed.url).toString() !== new URL(expectedUrl).toString()) {
    throw new DeviceOnboardingError(502, 'The onboarding agent returned an unexpected URL.');
  }
  const checkpoint = typeof parsed.checkpoint === 'string' ? parsed.checkpoint.trim() : '';
  if (parsed.status === 'manual_checkpoint' && !checkpoint) {
    throw new DeviceOnboardingError(502, 'The onboarding agent omitted the phone-side checkpoint.');
  }
  return {
    status: parsed.status,
    url: new URL(parsed.url).toString(),
    qrPath: typeof parsed.qr === 'string' ? parsed.qr.trim() : '',
    checkpoint,
  };
}

export function createDeviceOnboardingManager({
  exec = execFileAsync,
  getContext,
  onVerifiedUrl = async () => {},
  projectRoot,
  runInvocation = runRunnerInvocation,
  stateDir,
  timeoutMs = DEVICE_ONBOARDING_TIMEOUT_MS,
  verifyPhoneUrlImpl = verifyPhoneUrl,
} = {}) {
  if (typeof getContext !== 'function') throw new TypeError('getContext is required.');
  if (!path.isAbsolute(projectRoot ?? '')) throw new TypeError('projectRoot must be absolute.');
  if (!path.isAbsolute(stateDir ?? '')) throw new TypeError('stateDir must be absolute.');

  const jobs = new Map();
  let latestId = '';

  async function start({ runnerId = '' } = {}) {
    if ([...jobs.values()].some((job) => !TERMINAL_STATUSES.has(job.status))) {
      throw new DeviceOnboardingError(409, 'Phone onboarding is already running.');
    }
    const context = await getContext();
    if (!context?.capability?.available) {
      throw new DeviceOnboardingError(409, context?.capability?.hint || 'Phone onboarding is unavailable.');
    }
    if (runnerId && runnerId !== context.runner.id) {
      throw new DeviceOnboardingError(400, 'The selected onboarding runner is unavailable.');
    }

    const id = randomUUID();
    const receiptDir = path.join(stateDir, 'device-onboarding');
    await mkdir(receiptDir, { recursive: true });
    const job = {
      checkpoint: '',
      controller: new AbortController(),
      error: '',
      finishedAt: '',
      id,
      outputPath: path.join(receiptDir, `${id}.output.txt`),
      qrPath: '',
      receiptPath: path.join(receiptDir, `${id}.log`),
      resultUrl: '',
      runnerId: context.runner.id,
      startedAt: new Date().toISOString(),
      status: 'starting',
      verification: null,
    };
    jobs.set(id, job);
    latestId = id;
    job.promise = execute(job, context);
    return publicJob(job);
  }

  async function execute(job, context) {
    let bridgeCreated = false;
    try {
      const bridge = await ensurePrivateBridge(context, exec);
      bridgeCreated = bridge.created;
      if (job.controller.signal.aborted) throw abortError();

      const prompt = buildDeviceOnboardingPrompt({
        projectRoot,
        skill: context.skill,
        stableUrl: context.stable.url,
      });
      const invocation = buildRunnerInvocation(context.runnerRegistry, context.runner.id, {
        effort: context.runner.defaults.effort,
        env: process.env,
        model: context.runner.defaults.model,
        outputPath: job.outputPath,
        prompt,
        repoRoot: projectRoot,
      });
      job.status = 'running';
      const result = await runInvocation(invocation, {
        containmentRoot: projectRoot,
        cwd: projectRoot,
        deadlineMs: Date.now() + timeoutMs,
        logPath: job.receiptPath,
        onSpawn: async () => {},
        signal: job.controller.signal,
        watchdog: context.runnerRegistry.watchdog,
      });
      if (job.controller.signal.aborted) throw abortError();
      if (result.exitCode !== 0 || result.cap || result.watchdog) {
        throw new DeviceOnboardingError(502, result.cap
          ? 'Phone onboarding timed out.'
          : result.watchdog?.message || `The onboarding runner exited with code ${result.exitCode}.`);
      }

      const extracted = extractRunnerOutput(context.runnerRegistry, context.runner.id, result.stdout);
      const completion = parseDeviceOnboardingResult(
        [extracted, result.stdout].filter(Boolean).join('\n'),
        context.stable.url,
      );
      job.status = 'verifying';
      job.verification = await verifyPhoneUrlImpl(completion.url, { stateDir });
      if (job.controller.signal.aborted) throw abortError();
      await onVerifiedUrl(completion.url);

      job.resultUrl = completion.url;
      job.checkpoint = completion.checkpoint;
      job.qrPath = await acceptedQrPath(completion.qrPath, context.skill.outputDir);
      job.status = completion.status === 'manual_checkpoint' ? 'manual_checkpoint' : 'completed';
      await appendReceipt(job.receiptPath, [
        '',
        `Campaigns verification: GET /api/registry and guarded baseHash save passed.`,
        `Verified phone URL: ${job.resultUrl}`,
        job.checkpoint ? `Manual checkpoint: ${job.checkpoint}` : 'Phone onboarding completed.',
      ].join('\n'));
    } catch (error) {
      const cancelled = job.controller.signal.aborted || error?.name === 'AbortError';
      job.status = cancelled ? 'cancelled' : 'failed';
      job.error = cancelled ? '' : safeErrorMessage(error);
      await cleanupDeviceItRuntime(context, exec).catch(() => {});
      if (bridgeCreated) await cleanupPrivateBridge(exec).catch(() => {});
      await appendReceipt(
        job.receiptPath,
        `\nPhone onboarding ${cancelled ? 'cancelled' : `failed: ${job.error}`}\n`,
      ).catch(() => {});
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }

  async function get(id = '') {
    const job = jobs.get(id || latestId);
    if (!job) throw new DeviceOnboardingError(404, 'Phone onboarding job not found.');
    return publicJob(job);
  }

  async function cancel(id = '') {
    const job = jobs.get(id || latestId);
    if (!job) throw new DeviceOnboardingError(404, 'Phone onboarding job not found.');
    if (!TERMINAL_STATUSES.has(job.status)) job.controller.abort();
    await job.promise;
    return publicJob(job);
  }

  async function stopAll() {
    const active = [...jobs.values()].filter((job) => !TERMINAL_STATUSES.has(job.status));
    for (const job of active) job.controller.abort();
    await Promise.allSettled(active.map((job) => job.promise));
  }

  async function getQrPath(id = '') {
    const job = jobs.get(id || latestId);
    if (!job?.qrPath) throw new DeviceOnboardingError(404, 'Phone onboarding QR not found.');
    const details = await stat(job.qrPath).catch(() => null);
    if (!details?.isFile()) throw new DeviceOnboardingError(404, 'Phone onboarding QR not found.');
    return { path: job.qrPath, size: details.size };
  }

  async function publicJob(job) {
    let transcript = '';
    try {
      transcript = redactAndCapText(
        await readFile(job.receiptPath, 'utf8'),
        DEVICE_ONBOARDING_TRANSCRIPT_MAX_CHARACTERS,
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return {
      checkpoint: job.checkpoint,
      error: job.error,
      finishedAt: job.finishedAt,
      id: job.id,
      qrAvailable: Boolean(job.qrPath),
      receiptPath: job.receiptPath,
      runnerId: job.runnerId,
      startedAt: job.startedAt,
      status: job.status,
      transcript,
      url: job.resultUrl,
      verification: job.verification,
    };
  }

  return { cancel, get, getQrPath, start, stopAll };
}

export async function verifyPhoneUrl(baseUrl, {
  fetchImpl = globalThis.fetch,
  stateDir,
} = {}) {
  if (!isStablePrivatePhoneUrl(baseUrl)) {
    throw new DeviceOnboardingError(400, 'Phone verification requires a reachable HTTPS URL.');
  }
  if (!path.isAbsolute(stateDir ?? '')) throw new TypeError('stateDir must be absolute.');

  const fixtureDir = path.join(stateDir, 'device-onboarding', 'verification');
  const fixturePath = path.join(fixtureDir, `${randomUUID()}.md`);
  const markdown = '# Phone onboarding verification\n\nTemporary baseHash fixture.\n';
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(fixturePath, markdown, 'utf8');
  let registeredId = '';

  try {
    const registry = await requestJson(apiUrl(baseUrl, '/api/registry'), {}, fetchImpl);
    if (!Array.isArray(registry.campaigns)) {
      throw new DeviceOnboardingError(502, 'The phone URL did not return the Campaigns registry.');
    }
    const registered = await requestJson(apiUrl(baseUrl, '/api/registry'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: fixturePath }),
    }, fetchImpl);
    registeredId = registered.id;
    if (typeof registeredId !== 'string' || !registeredId) {
      throw new DeviceOnboardingError(502, 'The phone URL could not register the verification fixture.');
    }

    const documentUrl = apiUrl(baseUrl, '/api/document', { id: registeredId });
    const document = await requestJson(documentUrl, {}, fetchImpl);
    if (document.markdown !== markdown || typeof document.hash !== 'string') {
      throw new DeviceOnboardingError(502, 'The phone URL returned the wrong verification fixture.');
    }
    const saved = await requestJson(documentUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown, baseHash: document.hash }),
    }, fetchImpl);
    if (saved.ok !== true || saved.hash !== document.hash) {
      throw new DeviceOnboardingError(502, 'The guarded phone action did not preserve the fixture hash.');
    }
    return {
      guardedAction: 'baseHash_document_save',
      registry: true,
    };
  } finally {
    await unlink(fixturePath).catch(() => {});
    if (registeredId) {
      await requestJson(apiUrl(baseUrl, '/api/registry'), {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: registeredId }),
      }, fetchImpl).catch(() => {});
    }
  }
}

async function ensurePrivateBridge(context, exec) {
  if (context.stable.kind !== 'tailscale-serve' || context.stable.bridgeState === 'matching') {
    return { created: false };
  }
  if (context.stable.bridgeState !== 'empty') {
    throw new DeviceOnboardingError(409, 'A stable private Campaigns bridge is unavailable.');
  }
  await exec(
    'tailscale',
    ['serve', '--bg', '--yes', `http://127.0.0.1:${context.targetPort}`],
    { timeout: 10_000, maxBuffer: 2_000_000 },
  );
  return { created: true };
}

async function cleanupPrivateBridge(exec) {
  await exec('tailscale', ['serve', 'reset'], { timeout: 10_000, maxBuffer: 2_000_000 });
}

async function cleanupDeviceItRuntime(context, exec) {
  const script = path.join(context.skill.path, 'scripts', 'mdm', 'mdm-down.sh');
  try {
    await access(script, fsConstants.R_OK);
  } catch {
    return;
  }
  await exec('bash', [script], { timeout: 15_000, maxBuffer: 2_000_000 });
}

async function acceptedQrPath(candidate, outputDir) {
  if (!candidate || !path.isAbsolute(candidate) || path.extname(candidate).toLowerCase() !== '.png') return '';
  const absolute = path.resolve(candidate);
  const root = path.resolve(outputDir);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
  const details = await stat(absolute).catch(() => null);
  return details?.isFile() ? absolute : '';
}

async function appendReceipt(receiptPath, value) {
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await appendFile(receiptPath, redactText(value), 'utf8');
}

function normalizeSkillRoot(candidate) {
  const absolute = path.resolve(String(candidate));
  if (path.basename(absolute) === 'SKILL.md') return path.dirname(absolute);
  if (path.basename(absolute) === 'run.sh' && path.basename(path.dirname(absolute)) === 'scripts') {
    return path.dirname(path.dirname(absolute));
  }
  return absolute;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function apiUrl(baseUrl, pathname, params = {}) {
  const url = new URL(baseUrl);
  url.pathname = pathname;
  url.search = '';
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

async function requestJson(url, init, fetchImpl) {
  const response = await fetchImpl(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(8_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new DeviceOnboardingError(response.status, payload.error || `Request failed with ${response.status}.`);
  }
  return payload;
}

function abortError() {
  const error = new Error('Phone onboarding was cancelled.');
  error.name = 'AbortError';
  return error;
}

function safeErrorMessage(error) {
  return redactAndCapText(error?.message || 'Phone onboarding failed.', 1_000);
}
