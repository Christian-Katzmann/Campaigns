#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${CAMPAIGNS_ASSET_PORT:-4182}"
URL="http://localhost:$PORT"
DEMO_FILE="$ROOT_DIR/design/demo-data/publication-campaign.md"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/campaigns-assets.XXXXXX")"
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
  profile="$TMP_DIR/profile-$(basename "$output" .png)"

  "$CHROME_BIN" \
    --headless \
    --no-sandbox \
    --disable-gpu \
    --hide-scrollbars \
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
    -fill '#121212' -font Avenir-Medium -pointsize 40 -annotate +190+800 'Plan in markdown. Execute with prompts.' \
    -fill '#121212' -font Avenir-Medium -pointsize 40 -annotate +190+855 'Keep progress in Git.' \
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

cd "$ROOT_DIR"
PORT="$PORT" node server.mjs --file "$DEMO_FILE" > "$TMP_DIR/server.log" 2>&1 &
SERVER_PID="$!"
wait_for_server

capture "$ROOT_DIR/design/screenshots/01-campaign-board.png" "1440,1100" "/"
capture "$ROOT_DIR/design/screenshots/02-mobile-step-flow.png" "390,900" "/"
capture "$ROOT_DIR/design/screenshots/03-library.png" "1440,900" "?library"
render_social_preview
render_trailer

printf 'Rendered public assets in design/.\n'
