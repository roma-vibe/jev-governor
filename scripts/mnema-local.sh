#!/bin/sh
# The local Mnema memory server the mod's memory option uses (memory.*).
#   mnema-local.sh start|run|stop|status|key <name>|reembed
# Environment: MNEMA_REPO (the Mnema checkout, default ~/Documents/startUpProject),
# MNEMA_DATA_DIR (default ~/.mnema-local), MNEMA_PORT (default 8787),
# MNEMA_LLM (openrouter when OPENROUTER_API_KEY or the key file MNEMA_KEY_FILE, default
# <repo>/.openrouter_key, exists; else mock: offline, no model calls).
#
# Two ways to run it:
# - `run`: in the foreground, for a supervisor that owns the process, restarts it and shows its
#   log (a process manager's project with this as its command and port 8787). It leaves a
#   marker, and from then on `start` leaves the server to the supervisor.
# - `start`: in the background, in its own session (setsid), so it outlives the process that
#   started it. This is what the mod runs when the memory does not answer (memory.autoStart).
#   `start --force` starts it this way even when a supervisor is in charge.
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
# Left by `run`: a supervisor is in charge of the server.
MANAGED="$DATA/managed"

bin() {
  for b in "$REPO/target/release/mnema" "$REPO/target/debug/mnema"; do
    [ -x "$b" ] && { echo "$b"; return 0; }
  done
  echo "mnema binary not found under $REPO/target (cargo build --release -p mnema-server)" >&2
  return 1
}

healthy() { curl -fsS -m 2 "$URL/healthz" >/dev/null 2>&1; }

# The clients (the mnema-mcp server, the mod, its UI) read the service's address from the mnema-mcp
# config file. When the port is not the one written there (a supervisor moved it), the file's
# `base_url` follows. An address that is not this machine's is someone's own choice: left alone.
CONF="${MNEMA_MCP_CONFIG:-$HOME/.config/mnema-mcp/config.toml}"
sync_url() {
  [ -f "$CONF" ] || return 0
  cur="$(sed -n 's/^[[:space:]]*base_url[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' "$CONF" | head -1)"
  case "$cur" in
    "$URL") return 0 ;;
    "" | http://127.0.0.1:* | http://localhost:*) ;;
    *) return 0 ;;
  esac
  tmp="$CONF.tmp.$$"
  if [ -n "$cur" ]; then
    sed "s|^[[:space:]]*base_url[[:space:]]*=.*\$|base_url = \"$URL\"|" "$CONF" >"$tmp"
  else
    { cat "$CONF"; echo "base_url = \"$URL\""; } >"$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$CONF"
  echo "address in $CONF: ${cur:-none} -> $URL"
}

case "${1:-status}" in
  run)
    B="$(bin)"
    mkdir -p "$DATA"
    chmod 700 "$DATA"
    # A server started earlier in the background gives way to the supervised one.
    if [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; then
      i=0
      while [ $i -lt 40 ] && healthy; do
        sleep 0.25
        i=$((i + 1))
      done
    fi
    rm -f "$PIDFILE"
    : >"$MANAGED"
    sync_url
    echo "mnema $URL (llm $LLM, data $DATA)"
    exec env MNEMA_DATA_DIR="$DATA" MNEMA_BIND="127.0.0.1:$PORT" MNEMA_PUBLIC_URL="$URL" MNEMA_LLM="$LLM" MNEMA_DEMO=off "$B" serve
    ;;
  start)
    if healthy; then echo "running $URL"; exit 0; fi
    if [ -f "$MANAGED" ] && [ "${2:-}" != "--force" ]; then
      echo "the memory server is run by a supervisor (the process manager whose project runs \"$0 run\"): start it there, or run: $0 start --force" >&2
      exit 4
    fi
    B="$(bin)"
    mkdir -p "$DATA"
    chmod 700 "$DATA"
    sync_url
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
