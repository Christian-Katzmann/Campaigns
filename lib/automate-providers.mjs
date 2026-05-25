import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const AUTOMATE_BASE = path.join(homedir(), '.claude-automate', 'campaigns');

const providers = [claudeProvider()];

export async function getAutomateState(filePath, { summary = false } = {}) {
  for (const provider of providers) {
    const state = await provider.getState(filePath, { summary });
    if (state) return state;
  }
  return null;
}

export function nudgeAutomateState(filePath, mode) {
  const slug = path.basename(filePath, '.md');
  const modeFlags = {
    continue: ['--continue'],
    skip: ['--skip'],
    restart_failed: ['--restart-failed'],
    restart: [],
  };

  const flags = modeFlags[mode];
  if (!flags) {
    return Promise.resolve({ ok: false, message: `Unknown nudge mode: ${mode}` });
  }

  return new Promise((resolve) => {
    execFile(
      'claude-automate',
      ['recover', '--slug', slug, ...flags],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, message: stderr?.trim() || error.message });
        } else {
          resolve({ ok: true, message: stdout.trim() || 'Nudge sent.' });
        }
      },
    );
  });
}

function claudeProvider() {
  return {
    async getState(filePath, { summary = false } = {}) {
      const slug = path.basename(filePath, '.md');
      const baseDir = path.join(AUTOMATE_BASE, slug);

      let stateData;
      try {
        const raw = await readFile(path.join(baseDir, 'state.json'), 'utf8');
        stateData = JSON.parse(raw);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`automate-providers: bad state.json for ${slug}:`, err.message);
        }
        return null;
      }

      const currentStepData = stateData.current_step_id
        ? stateData.steps?.find((s) => s.id === stateData.current_step_id) ?? null
        : null;

      const maxMinutes = stateData.config?.max_step_minutes ?? 60;
      const status = deriveStatus(stateData, currentStepData, maxMinutes);

      const currentStep = currentStepData
        ? {
            id: currentStepData.id,
            name: currentStepData.name,
            phase: currentStepData.phase,
            phase_name: currentStepData.phase_name,
            started_at: currentStepData.started_at,
          }
        : null;

      if (summary) {
        return {
          backend: 'claude',
          status,
          current_step_id: currentStep?.id ?? null,
          current_step_name: currentStep?.name ?? null,
        };
      }

      const [timelineEvents, currentStepLog, steps] = await Promise.all([
        readTimelineEvents(stateData, baseDir),
        readCurrentStepLog(currentStepData, baseDir),
        enrichStepsWithReceipts(stateData.steps ?? [], baseDir),
      ]);

      return {
        backend: 'claude',
        is_active: status === 'active' || status === 'stalled',
        status,
        started_at: stateData.created_at,
        current_step: currentStep,
        steps,
        timeline_events: timelineEvents,
        current_step_log: currentStepLog,
        nudge_modes: buildNudgeModes(status),
      };
    },
  };
}

function deriveStatus(stateData, currentStepData, maxMinutes) {
  if (stateData.status === 'completed') return 'completed';
  if (stateData.status !== 'active') return stateData.status;

  if (!currentStepData) return 'idle';
  if (currentStepData.status === 'failed') return 'failed';

  if (currentStepData.status === 'running' && currentStepData.started_at) {
    const elapsed = Date.now() - Date.parse(currentStepData.started_at);
    if (elapsed > maxMinutes * 60_000) return 'stalled';
  }

  return 'active';
}

function buildNudgeModes(status) {
  const isStalled = status === 'stalled' || status === 'halted';
  const isFailed = status === 'failed';
  const canNudge = isStalled || isFailed;

  return {
    continue: {
      available: isStalled,
      label: 'Continue this step',
      description:
        'Re-launch the step, telling the agent to check what already landed and finish what’s left.',
    },
    restart: {
      available: canNudge,
      label: 'Restart from scratch',
      description: 'Wipe this step’s progress and run it again from the beginning.',
    },
    skip: {
      available: canNudge,
      label: 'Mark done and continue',
      description: 'Skip this step and advance to the next one.',
    },
    restart_failed: {
      available: isFailed,
      label: 'Restart failed step',
      description: 'Re-run the failed step from scratch.',
    },
  };
}

async function readTimelineEvents(stateData, baseDir) {
  if (stateData.history?.length) {
    return stateData.history;
  }

  try {
    const raw = await readFile(path.join(baseDir, 'timeline.md'), 'utf8');
    return raw
      .split('\n')
      .map((line) => {
        const match = line.match(/^- `(.+?)` — (.+)$/);
        return match ? { ts: match[1], event: match[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function readCurrentStepLog(currentStepData, baseDir) {
  if (!currentStepData?.id) return null;
  try {
    return await readFile(path.join(baseDir, 'logs', `step-${currentStepData.id}.log`), 'utf8');
  } catch {
    return null;
  }
}

async function enrichStepsWithReceipts(steps, baseDir) {
  return Promise.all(
    steps.map(async (step) => {
      const { receipt_path, log_path, ...rest } = step;
      let receipt = null;
      if (step.status === 'done') {
        try {
          receipt = await readFile(
            path.join(baseDir, 'receipts', `step-${step.id}.md`),
            'utf8',
          );
        } catch {
          /* receipt not written yet */
        }
      }
      return { ...rest, receipt };
    }),
  );
}
