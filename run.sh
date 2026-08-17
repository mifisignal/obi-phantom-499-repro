#!/usr/bin/env sh
# Single entrypoint. Brings the stack up for one scenario, lets the loadgen run
# to completion, tears it down, and asserts over the spans.
#
#   ./run.sh S1      one scenario
#   ./run.sh all     every scenario, in order, each in a clean stack
#
# Everything runs in containers; the host needs only Docker and git.
set -eu

cd "$(dirname "$0")"

SCENARIOS_ALL="C0 S1 S2 S3"

DURATION_S="${DURATION_S:-40}"
START_DELAY_S="${START_DELAY_S:-12}"
CONCURRENCY="${CONCURRENCY:-2}"
THINK_MS="${THINK_MS:-5}"
# Settle margin: OBI's exporter batches and the collector's file exporter
# flushes on an interval.
DRAIN_S="${DRAIN_S:-20}"

compose() { docker compose "$@"; }

# Per-scenario knobs. RESEG_AT is the relay's response re-segmentation (0 = off,
# 1 = the first response byte on its own segment). KEEPALIVE / REAP_MS control
# the app's outbound connection pool, i.e. when tcp_close happens.
scenario_env() {
  case "$1" in
    C0) echo "RESEG_AT=0 KEEPALIVE=false REAP_MS=0" ;;
    S1) echo "RESEG_AT=1 KEEPALIVE=false REAP_MS=0" ;;
    S2) echo "RESEG_AT=1 KEEPALIVE=true  REAP_MS=250" ;;
    S3) echo "RESEG_AT=1 KEEPALIVE=true  REAP_MS=0" ;;
    *)  echo "" ;;
  esac
}

run_one() {
  scenario="$1"
  senv=$(scenario_env "$scenario")
  if [ -z "$senv" ]; then
    echo "unknown scenario: $scenario (want one of: $SCENARIOS_ALL)" >&2
    exit 2
  fi
  outdir="out/$scenario"
  rm -rf "$outdir"; mkdir -p "$outdir"

  echo "=============================================================="
  echo "scenario $scenario  ($senv concurrency=$CONCURRENCY duration=${DURATION_S}s)"
  echo "=============================================================="

  rm -f out/traces.jsonl

  for kv in $senv; do
    export "${kv?}"
  done
  export DURATION_S START_DELAY_S CONCURRENCY THINK_MS
  export OBI_BPF_DEBUG="${OBI_BPF_DEBUG:-false}" OBI_LOG_LEVEL="${OBI_LOG_LEVEL:-info}"
  compose up --build -d

  runtime=$(( START_DELAY_S + DURATION_S + DRAIN_S ))
  echo "waiting ${runtime}s for the loadgen to finish..."
  i=0
  while [ "$i" -lt "$runtime" ]; do sleep 5; i=$(( i + 5 )); printf '.'; done
  echo

  # Evidence: the exact image under test, both applications' access logs, and
  # OBI's own logs.
  docker image inspect "$(docker inspect -f '{{.Config.Image}}' obi-499-obi-app)" \
    --format '{{index .RepoDigests 0}}' > "$outdir/obi-image-digest.txt" 2>/dev/null || true
  docker logs obi-499-app     > "$outdir/app.log"     2>&1 || true
  docker logs obi-499-peer    > "$outdir/peer.log"    2>&1 || true
  docker logs obi-499-relay   > "$outdir/relay.log"   2>&1 || true
  docker logs obi-499-loadgen > "$outdir/loadgen.log" 2>&1 || true
  docker logs obi-499-obi-app > "$outdir/obi-app.log" 2>&1 || true
  # SIGTERM makes app and peer print their summary lines before they exit.
  compose stop -t 5 >/dev/null 2>&1 || true
  docker logs obi-499-app  > "$outdir/app.log"  2>&1 || true
  docker logs obi-499-peer > "$outdir/peer.log" 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true

  cp -f out/traces.jsonl "$outdir/traces.jsonl" 2>/dev/null || true
  set +e
  python3 check.py "$scenario" "$outdir" > "$outdir/result.txt" 2>&1
  rc=$?
  set -e
  cat "$outdir/result.txt"
  echo "$scenario exit=$rc" >> out/summary.txt
  return 0
}

target="${1:-all}"
mkdir -p out
: > out/summary.txt

if [ "$target" = "all" ]; then
  for s in $SCENARIOS_ALL; do run_one "$s"; done
  echo
  echo "================= SUMMARY ================="
  cat out/summary.txt
  echo
  echo "exit=1 means the phantom 499 was present in that scenario."
else
  run_one "$(echo "$target" | tr '[:lower:]' '[:upper:]')"
fi
