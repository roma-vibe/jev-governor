#!/bin/sh
# The local Mnema memory server the mod's memory option uses (memory.*).
#   mnema-local.sh start|stop|status|key <name>
# Environment: MNEMA_REPO (the Mnema checkout, default ~/Documents/startUpProject),
# MNEMA_DATA_DIR (default ~/.mnema-local), MNEMA_PORT (default 8787),
# MNEMA_LLM (openrouter when OPENROUTER_API_KEY or the key file MNEMA_KEY_FILE, default
# <repo>/.openrouter_key, exists; else mock: offline, no model calls).
# The server runs in its own session (setsid), so it outlives the process that started it.
set -eu

REPO="${MNEMA_REPO:-$HOME/Documents/startUpProject}"
DATA="${MNEMA_DATA_DIR:-$HOME/.mnema-local}"
PORT="${MNEMA_PORT:-8787}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
KEYFILE="${MNEMA_KEY_FILE:-$HERE/.openrouter_key}"
# Real models (meaning-based recall) when an OpenRouter key is at hand, else the offline mock.
if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -f "$KEYFILE" ]; then OPENROUTER_API_KEY="$(tr -d '[:space:]' <"$KEYFILE")"; fi
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
if [ -n "${MNEMA_LLM:-}" ]; then LLM="$MNEMA_LLM"; elif [ -n "$OPENROUTER_API_KEY" ]; then LLM=openrouter; else LLM=mock; fi
URL="http://127.0.0.1:$PORT"
PIDFILE="$DATA/server.pid"
LOG="$DATA/server.log"

bin() {
  for b in "$REPO/target/release/mnema" "$REPO/target/debug/mnema"; do
    [ -x "$b" ] && { echo "$b"; return 0; }
  done
  echo "mnema binary not found under $REPO/target (cargo build --release -p mnema-server)" >&2
  return 1
}

healthy() { curl -fsS -m 2 "$URL/healthz" >/dev/null 2>&1; }

case "${1:-status}" in
  start)
    if healthy; then echo "running $URL"; exit 0; fi
    B="$(bin)"
    mkdir -p "$DATA"
    chmod 700 "$DATA"
    MNEMA_DATA_DIR="$DATA" MNEMA_BIND="127.0.0.1:$PORT" MNEMA_PUBLIC_URL="$URL" MNEMA_LLM="$LLM" MNEMA_DEMO=off \
      nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec: $!"' -- "$B" serve >>"$LOG" 2>&1 </dev/null &
    echo $! >"$PIDFILE"
    i=0
    while [ $i -lt 40 ]; do
      healthy && { echo "started $URL (pid $(cat "$PIDFILE"), llm $LLM)"; exit 0; }
      sleep 0.25
      i=$((i + 1))
    done
    echo "did not come up in 10 s; see $LOG" >&2
    exit 1
    ;;
  stop)
    if [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; then rm -f "$PIDFILE"; echo stopped; else echo "not running"; fi
    ;;
  status)
    if healthy; then echo "running $URL"; else echo "down $URL"; exit 3; fi
    ;;
  key)
    # Prints a new API key for a local project (account on the pro plan).
    B="$(bin)"
    MNEMA_DATA_DIR="$DATA" "$B" local-key "${2:-claude-code}" --plan pro
    ;;
  reembed)
    # Embeds stored facts that have no vectors yet (after switching from mock to openrouter).
    B="$(bin)"
    MNEMA_DATA_DIR="$DATA" MNEMA_LLM="$LLM" "$B" reembed
    ;;
  *)
    echo "usage: $0 start|stop|status|key [name]|reembed" >&2
    exit 2
    ;;
esac
