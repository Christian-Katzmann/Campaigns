#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${CAMPAIGNS_ASSET_PORT:-4182}"
URL="http://localhost:$PORT"
DEMO_FILE="$ROOT_DIR/design/demo-data/publication-campaign.md"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/campaigns-assets.XXXXXX")"
LESSONS_HELPER="$TMP_DIR/public-lessons.py"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

find_chrome() {
  if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    printf '%s\n' "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    return 0
  fi

  chromium="$(find "$HOME/Library/Caches/ms-playwright" -path "*/Chromium.app/Contents/MacOS/Chromium" 2>/dev/null | sort | tail -1)"
  if [ -n "$chromium" ] && [ -x "$chromium" ]; then
    printf '%s\n' "$chromium"
    return 0
  fi

  return 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

wait_for_server() {
  i=0
  while [ "$i" -lt 80 ]; do
    if curl -fsS "$URL/api/registry" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
    i=$((i + 1))
  done
  printf 'Campaigns server did not start on %s\n' "$URL" >&2
  exit 1
}

capture() {
  output="$1"
  size="$2"
  path="$3"
  wait_ms="${4:-1500}"
  min_bytes="${5:-1}"
  profile="$TMP_DIR/profile-$(basename "$output" .png)"

  "$CHROME_BIN" \
    --headless \
    --no-sandbox \
    --disable-gpu \
    --hide-scrollbars \
    "--virtual-time-budget=$wait_ms" \
    "--user-data-dir=$profile" \
    "--window-size=$size" \
    "--screenshot=$output" \
    "$URL$path" >/dev/null 2>&1 &

  chrome_pid="$!"
  i=0
  while kill -0 "$chrome_pid" 2>/dev/null; do
    if [ "$i" -ge 80 ]; then
      kill "$chrome_pid" 2>/dev/null || true
      wait "$chrome_pid" 2>/dev/null || true
      break
    fi
    sleep 0.1
    i=$((i + 1))
  done

  if [ ! -s "$output" ]; then
    printf 'Failed to capture screenshot: %s\n' "$output" >&2
    exit 1
  fi

  actual_bytes="$(wc -c < "$output" | tr -d ' ')"
  if [ "$actual_bytes" -lt "$min_bytes" ]; then
    printf 'Screenshot too small: %s (%s bytes, expected at least %s)\n' "$output" "$actual_bytes" "$min_bytes" >&2
    exit 1
  fi
}

write_lessons_fixture() {
  cat > "$LESSONS_HELPER" <<'PY'
#!/usr/bin/env python3
import json

print(json.dumps({
    "scanned": {"claude": 24, "codex": 18, "total": 42},
    "backends": {
        "claude": {
            "n_total": 24,
            "n_with_verdict": 19,
            "approval_rate": 0.84,
            "first_try_rate": 0.63,
            "rework_rate": 0.21,
            "needs_work_attempt_n": 4,
            "data_quality_warning_n": 1,
            "median_step_count": 5,
        },
        "codex": {
            "n_total": 18,
            "n_with_verdict": 14,
            "approval_rate": 0.79,
            "first_try_rate": 0.43,
            "rework_rate": 0.36,
            "needs_work_attempt_n": 5,
            "data_quality_warning_n": 2,
            "median_step_count": 6,
        },
    },
    "sizing": {
        "median_steps": 6,
        "p90_steps": 10,
        "max_first_try": 7,
        "avoid_above": 10,
        "sample": 42,
    },
    "halt_signals": {
        "high_step_count_correlates_with_halt": True,
        "halt_rate_overall": 0.10,
        "halt_rate_high_step_count": 0.28,
        "examples": ["atlas-import", "workflow-refresh"],
    },
    "raw": [
        {"recover_count": 1, "data_quality_warnings": [], "reasons": ["verification-gap"]},
        {"recover_count": 0, "data_quality_warnings": ["missing-receipt"], "reasons": ["visual-regression"]},
        {"recover_count": 0, "data_quality_warnings": ["legacy-timeline"], "reasons": ["scheduler-failure"]},
        {"recover_count": 1, "data_quality_warnings": [], "legacy_reasons": ["manual-review"]},
    ],
}))
PY
  chmod +x "$LESSONS_HELPER"
}

write_run_fixture() {
  node --input-type=module - "$ROOT_DIR" "$DEMO_FILE" "$TMP_DIR/runs" "$SERVER_PID" <<'NODE'
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [rootDir, campaignPath, runsDir, serverPid] = process.argv.slice(2);
const { runPathsForCampaign } = await import(pathToFileURL(path.join(rootDir, 'lib/pump.mjs')));
const { createRunState, transitionRunState } = await import(pathToFileURL(path.join(rootDir, 'lib/run-state.mjs')));
const paths = runPathsForCampaign(campaignPath, runsDir);
const receiptPath = path.join(paths.receiptsDir, '1.1-1.md');
const logPath = path.join(paths.logsDir, 'step-1.2-1.jsonl');
const now = Date.now();
const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

await mkdir(paths.receiptsDir, { recursive: true });
await mkdir(paths.logsDir, { recursive: true });
await writeFile(receiptPath, '# Step 1.1 receipt\n\nInstall path drafted and checked.\n', 'utf8');

const activity = [
  {
    type: 'assistant',
    timestamp: at(1),
    message: {
      content: [
        { type: 'tool_use', name: 'Read', input: { file_path: 'design/demo-data/publication-campaign.md' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm run check' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'README.md' } },
      ],
    },
  },
  {
    type: 'assistant',
    timestamp: at(0),
    message: {
      content: [
        { type: 'text', text: 'Refreshing the public proof from the deterministic campaign fixture, then checking the rendered board.' },
      ],
    },
  },
];
await writeFile(logPath, `${activity.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');

let state = createRunState({
  id: 'public-assets-live-run',
  identity: {
    registry_id: null,
    source: { campaign_path: campaignPath, repo_root: rootDir },
    execution: { campaign_path: campaignPath, repo_root: rootDir, branch: 'main' },
  },
  steps: [
    { id: '1.1', name: 'Draft the installation path', phase: '1' },
    { id: '1.2', name: 'Capture the product proof', phase: '1' },
    { id: '1.3', name: 'Tighten the release notes', phase: '1' },
  ],
  config: {
    runner: 'claude',
    model: 'public-fixture',
    effort: 'high',
    watchdog: { minimum_runtime_ms: 60_000, stall_window_ms: 60_000 },
  },
  artifacts: {
    run_dir: paths.runDir,
    receipts_dir: paths.receiptsDir,
    final_review_path: paths.finalReviewPath,
  },
  created_at: at(5),
});
state = transitionRunState(state, { event: 'run_started', at: at(4) });
state = transitionRunState(state, {
  event: 'step_started',
  step_id: '1.1',
  at: at(3),
  worker: { runner: 'claude', invocation_id: 'public-step-1', pid: Number(serverPid) },
});
state = transitionRunState(state, {
  event: 'step_completed',
  step_id: '1.1',
  receipt_path: receiptPath,
  at: at(2),
  message: 'Install path drafted and checked.',
});
state = transitionRunState(state, {
  event: 'step_started',
  step_id: '1.2',
  at: at(1),
  worker: {
    runner: 'claude',
    invocation_id: 'public-step-2',
    pid: Number(serverPid),
    log_path: logPath,
  },
});
await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
NODE
}

render_social_preview() {
  hero="$ROOT_DIR/design/screenshots/01-campaign-board.png"
  social="$ROOT_DIR/design/social/social-preview.png"
  hero_crop="$TMP_DIR/social-hero.png"
  base="$TMP_DIR/social-base.png"

  magick "$hero" -resize 1260x880^ -gravity center -extent 1260x880 "$hero_crop"

  magick -size 2560x1280 xc:'#f6f5f2' \
    -fill '#0b66d8' -draw 'rectangle 0,0 28,1280' \
    -fill '#ffffff' -stroke '#dedbd5' -strokewidth 3 -draw 'roundrectangle 1160,190 2395,1090 30,30' \
    -stroke none \
    -fill '#121212' -font Avenir-Next-Bold -pointsize 176 -annotate +180+430 'Campaigns' \
    -fill '#5f5b56' -font Avenir-Book -pointsize 58 -annotate +190+545 'A local execution board' \
    -fill '#5f5b56' -font Avenir-Book -pointsize 58 -annotate +190+620 'for markdown plans.' \
    -fill '#121212' -font Avenir-Medium -pointsize 40 -annotate +190+800 'Plan in markdown. Run with an agent.' \
    -fill '#121212' -font Avenir-Medium -pointsize 40 -annotate +190+855 'Watch progress locally.' \
    -fill '#dedbd5' -draw 'rectangle 190,920 780,924' \
    "$base"

  magick "$base" "$hero_crop" -geometry +1218+235 -composite "$social"
}

render_trailer() {
  trailer="$ROOT_DIR/design/trailer/trailer.mp4"
  ffmpeg -y \
    -loop 1 -t 10 -i "$ROOT_DIR/design/screenshots/01-campaign-board.png" \
    -loop 1 -t 10 -i "$ROOT_DIR/design/screenshots/02-mobile-step-flow.png" \
    -loop 1 -t 10 -i "$ROOT_DIR/design/screenshots/03-library.png" \
    -filter_complex "\
[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xf6f5f2,setsar=1[v0];\
[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xf6f5f2,setsar=1[v1];\
[2:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xf6f5f2,setsar=1[v2];\
[v0][v1][v2]concat=n=3:v=1:a=0,format=yuv420p[out]" \
    -map '[out]' -r 30 -movflags +faststart "$trailer" >/dev/null 2>&1
}

require_command curl
require_command magick
require_command ffmpeg
CHROME_BIN="$(find_chrome || true)"
if [ -z "$CHROME_BIN" ]; then
  printf 'Missing Chrome or Playwright Chromium for screenshots.\n' >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/design/screenshots" "$ROOT_DIR/design/social" "$ROOT_DIR/design/trailer"
write_lessons_fixture
mkdir -p "$TMP_DIR/runs"

cd "$ROOT_DIR"
CAMPAIGNS_REGISTRY_DIR="$TMP_DIR/registry" CAMPAIGNS_RUNS_DIR="$TMP_DIR/runs" CAMPAIGNS_AUTOMATE_BASE="$TMP_DIR/claude-automate" CODEX_HOME="$TMP_DIR/codex-home" CAMPAIGNS_LESSONS_HELPER="$LESSONS_HELPER" CAMPAIGNS_PORT_FILE="$TMP_DIR/server.port" PORT="$PORT" node server.mjs --file "$DEMO_FILE" > "$TMP_DIR/server.log" 2>&1 &
SERVER_PID="$!"
wait_for_server
write_run_fixture

capture "$ROOT_DIR/design/screenshots/01-campaign-board.png" "1440,1100" "?drawer=activity" 3000
mv "$TMP_DIR/runs" "$TMP_DIR/captured-live-run"
capture "$ROOT_DIR/design/screenshots/02-mobile-step-flow.png" "390,900" "/" 2500
capture "$ROOT_DIR/design/screenshots/03-library.png" "1440,900" "?library" 6000 20000
render_social_preview
render_trailer

printf 'Rendered public assets in design/.\n'
