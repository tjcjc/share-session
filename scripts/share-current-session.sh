#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_PATH="${CLAUDE_SESSION_SHARE_BIN:-$PLUGIN_ROOT/bin/claude-session-share}"

MODE="quick"
ALLOW_INPUT=1
HOST=""
PORT=""
PUBLIC_BASE_URL=""
CLAUDE_BIN="${CLAUDE_BIN_PATH:-$(command -v claude || true)}"
CLAUDE_ROOT="${CLAUDE_ROOT:-${HOME}/.claude}"
RUN_AS_USER=""
OWNER_HOME=""

usage() {
  cat <<'EOF'
Usage: share-current-session.sh [--local] [--read-only] [--host HOST] [--port PORT]
                                [--public-base-url URL] [--claude-bin PATH]
                                [--claude-root PATH] [--run-as-user USER]
                                [--owner-home PATH]
EOF
}

quote() {
  printf '%q' "$1"
}

append_arg() {
  local value="$1"
  CMD+=" $(quote "$value")"
}

tmux_has_session() {
  tmux has-session -t "$1" >/dev/null 2>&1
}

read_existing_local_url() {
  local log_file="$1"
  if [[ -f "$log_file" ]]; then
    awk -F': ' '/^Share URL: / {print $2; exit}' "$log_file"
  fi
}

pick_port() {
  local candidate
  for candidate in $(seq 3939 3999); do
    if command -v ss >/dev/null 2>&1; then
      if ! ss -ltn | awk '{print $4}' | grep -Eq "[:.]${candidate}\$"; then
        printf '%s\n' "$candidate"
        return 0
      fi
    else
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "Unable to find a free port in 3939-3999." >&2
  exit 1
}

wait_for_pattern() {
  local file="$1"
  local pattern="$2"
  local attempts="${3:-80}"
  local delay="${4:-0.25}"
  local output=""
  for _ in $(seq 1 "$attempts"); do
    if [[ -f "$file" ]]; then
      output="$(grep -Eo "$pattern" "$file" | head -n 1 || true)"
      if [[ -n "$output" ]]; then
        printf '%s\n' "$output"
        return 0
      fi
    fi
    sleep "$delay"
  done
  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local)
      MODE="local"
      shift
      ;;
    --read-only)
      ALLOW_INPUT=0
      shift
      ;;
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --public-base-url)
      PUBLIC_BASE_URL="${2:-}"
      shift 2
      ;;
    --claude-bin)
      CLAUDE_BIN="${2:-}"
      shift 2
      ;;
    --claude-root)
      CLAUDE_ROOT="${2:-}"
      shift 2
      ;;
    --run-as-user)
      RUN_AS_USER="${2:-}"
      shift 2
      ;;
    --owner-home)
      OWNER_HOME="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

SESSION_ID="${CLAUDE_SESSION_SHARE_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}"
if [[ -z "$SESSION_ID" ]]; then
  # Fallback: scan ~/.claude/sessions/ for a session matching current PPID or CWD
  SESSIONS_DIR="${CLAUDE_ROOT}/sessions"
  if [[ -d "$SESSIONS_DIR" ]]; then
    # Try to match by PPID first (most reliable)
    PPID_FILE="${SESSIONS_DIR}/${PPID}.json"
    if [[ -f "$PPID_FILE" ]]; then
      SESSION_ID="$(python3 -c "import json,sys; d=json.load(open('$PPID_FILE')); print(d.get('sessionId',''))" 2>/dev/null || true)"
    fi
    # Fallback: match by CWD
    if [[ -z "$SESSION_ID" ]]; then
      CURRENT_CWD="$(pwd)"
      for f in "$SESSIONS_DIR"/*.json; do
        [[ -f "$f" ]] || continue
        SID="$(python3 -c "import json,sys; d=json.load(open('$f')); print(d['sessionId']) if d.get('cwd')=='$CURRENT_CWD' else sys.exit(1)" 2>/dev/null || true)"
        if [[ -n "$SID" ]]; then
          SESSION_ID="$SID"
          break
        fi
      done
    fi
  fi
fi
if [[ -z "$SESSION_ID" ]]; then
  echo "No active Claude session id found. Run this command inside Claude Code." >&2
  exit 1
fi

if [[ ! -x "$BIN_PATH" ]]; then
  echo "claude-session-share binary not found, downloading..." >&2
  bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-binary.sh"
fi

if [[ ! -x "$BIN_PATH" ]]; then
  echo "claude-session-share binary not found at $BIN_PATH" >&2
  exit 1
fi

if [[ -z "$CLAUDE_BIN" ]]; then
  echo "Unable to locate the Claude CLI binary. Pass --claude-bin PATH." >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required to keep the share server running after this command exits." >&2
  exit 1
fi

if [[ "$MODE" == "quick" ]] && [[ -z "$PUBLIC_BASE_URL" ]] && ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is required for public share links. Install it or pass --local." >&2
  exit 1
fi

if [[ -z "$PORT" ]]; then
  PORT="$(pick_port)"
fi

if [[ -z "$HOST" ]]; then
  if [[ "$MODE" == "local" ]]; then
    HOST="0.0.0.0"
  else
    HOST="127.0.0.1"
  fi
fi

STATE_BASE="${CLAUDE_SESSION_SHARE_STATE_DIR:-${HOME}/.claude-session-share}"
SAFE_SESSION_ID="$(printf '%s' "$SESSION_ID" | tr -cs 'a-zA-Z0-9' '-')"
STATE_DIR="${STATE_BASE}/${SAFE_SESSION_ID}"
mkdir -p "$STATE_DIR"

SERVER_SESSION="csshare-${SAFE_SESSION_ID:0:24}"
TUNNEL_SESSION="csshare-tunnel-${SAFE_SESSION_ID:0:17}"
SERVER_LOG="${STATE_DIR}/server.log"
TUNNEL_LOG="${STATE_DIR}/tunnel.log"
PUBLIC_URL_FILE="${STATE_DIR}/public-url.txt"
LOCAL_URL_FILE="${STATE_DIR}/local-url.txt"

EXISTING_LOCAL_URL="$(read_existing_local_url "$SERVER_LOG" || true)"
if [[ -n "$EXISTING_LOCAL_URL" ]] && tmux_has_session "$SERVER_SESSION"; then
  if [[ "$MODE" == "quick" ]]; then
    if [[ -n "$PUBLIC_BASE_URL" ]]; then
      EXISTING_PATH="/${EXISTING_LOCAL_URL#*//*/}"
      printf 'Share URL: %s%s\n' "${PUBLIC_BASE_URL%/}" "$EXISTING_PATH"
      exit 0
    fi
    if [[ -f "$PUBLIC_URL_FILE" ]] && tmux_has_session "$TUNNEL_SESSION"; then
      printf 'Share URL: %s\n' "$(cat "$PUBLIC_URL_FILE")"
      exit 0
    fi
  else
    printf 'Share URL: %s\n' "$EXISTING_LOCAL_URL"
    exit 0
  fi
fi

tmux kill-session -t "$SERVER_SESSION" >/dev/null 2>&1 || true
tmux kill-session -t "$TUNNEL_SESSION" >/dev/null 2>&1 || true
rm -f "$SERVER_LOG" "$TUNNEL_LOG" "$PUBLIC_URL_FILE" "$LOCAL_URL_FILE"

# Wait for port to be released (up to 3 seconds)
for _ in $(seq 1 12); do
  if ! lsof -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
# Force kill anything still holding the port
lsof -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null || true

CMD="exec $(quote "$BIN_PATH") serve --session $(quote "$SESSION_ID") --claude-root $(quote "$CLAUDE_ROOT") --claude-bin $(quote "$CLAUDE_BIN") --host $(quote "$HOST") --port $(quote "$PORT")"

if [[ "$ALLOW_INPUT" -eq 0 ]]; then
  CMD+=" --read-only"
else
  CMD+=" --dangerously-skip-permissions"
fi

if [[ -n "$RUN_AS_USER" ]]; then
  CMD+=" --run-as-user $(quote "$RUN_AS_USER")"
fi

if [[ -n "$OWNER_HOME" ]]; then
  CMD+=" --owner-home $(quote "$OWNER_HOME")"
fi

tmux new-session -d -s "$SERVER_SESSION" "bash -lc $(quote "$CMD >> $(quote "$SERVER_LOG") 2>&1")"

LOCAL_URL="$(wait_for_pattern "$SERVER_LOG" 'http://[^[:space:]]+/s/[a-f0-9]+' 80 0.25 || true)"
if [[ -z "$LOCAL_URL" ]]; then
  echo "Failed to start claude-session-share. Recent server log:" >&2
  tail -n 40 "$SERVER_LOG" >&2 || true
  exit 1
fi
printf '%s\n' "$LOCAL_URL" > "$LOCAL_URL_FILE"

if [[ "$MODE" == "local" ]]; then
  printf 'Share URL: %s\n' "$LOCAL_URL"
  exit 0
fi

LOCAL_PATH="/${LOCAL_URL#*//*/}"
if [[ -n "$PUBLIC_BASE_URL" ]]; then
  FINAL_URL="${PUBLIC_BASE_URL%/}${LOCAL_PATH}"
  printf '%s\n' "$FINAL_URL" > "$PUBLIC_URL_FILE"
  printf 'Share URL: %s\n' "$FINAL_URL"
  exit 0
fi

LOCAL_BASE="${LOCAL_URL%%/s/*}"
tmux new-session -d -s "$TUNNEL_SESSION" "bash -lc $(quote "exec cloudflared tunnel --url $(quote "$LOCAL_BASE") >> $(quote "$TUNNEL_LOG") 2>&1")"

TUNNEL_BASE="$(wait_for_pattern "$TUNNEL_LOG" 'https://[-a-z0-9]+\.trycloudflare\.com' 120 0.5 || true)"
if [[ -z "$TUNNEL_BASE" ]]; then
  echo "Failed to establish a cloudflared quick tunnel. Recent tunnel log:" >&2
  tail -n 60 "$TUNNEL_LOG" >&2 || true
  exit 1
fi

FINAL_URL="${TUNNEL_BASE}${LOCAL_PATH}"
printf '%s\n' "$FINAL_URL" > "$PUBLIC_URL_FILE"
printf 'Share URL: %s\n' "$FINAL_URL"
