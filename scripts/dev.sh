#!/usr/bin/env bash
# twenty4 local dev — boots infra (Postgres :5433, Redis :6379, MinIO :9000) then
# the API (:4000) + the BullMQ worker. Ctrl+C stops API+worker (infra keeps running).
#
#   bash scripts/dev.sh
#   ADMIN_EMAILS=you@example.com bash scripts/dev.sh   # to test the admin console
#
set -o pipefail
# shellcheck disable=SC1090
source ~/.twenty4-dev-env.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ADMIN_EMAILS="${ADMIN_EMAILS:-}"

echo "▶ infra"
# Postgres (user-space embedded cluster)
if "$PG_BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then echo "  • Postgres up (:$PGPORT)"
else echo "  • starting Postgres (:$PGPORT)"; twenty4_pg_start >/dev/null 2>&1; fi
# Redis (system service)
if redis-cli ping >/dev/null 2>&1; then echo "  • Redis up (:6379)"
else echo "  ✗ Redis not running — start it: sudo service redis-server start (then re-run)"; fi
# MinIO (static binary)
if curl -sf http://127.0.0.1:9000/minio/health/live -o /dev/null 2>&1; then echo "  • MinIO up (:9000)"
else echo "  • starting MinIO (:9000)"; twenty4_minio_start; sleep 5; fi
~/bin/mc alias set local http://127.0.0.1:9000 minioadmin minioadmin >/dev/null 2>&1 || true
for b in raw montages thumbnails; do ~/bin/mc mb --ignore-existing "local/$b" >/dev/null 2>&1 || true; done

echo "▶ migrations (apply any pending)"
( cd "$ROOT/packages/contracts" && pnpm exec drizzle-kit migrate >/dev/null 2>&1 ) \
  && echo "  • schema up to date" || echo "  ! migrate skipped (check DATABASE_URL)"

echo "▶ API (:4000, HOST 0.0.0.0) + worker   —   Ctrl+C to stop"
[ -n "$ADMIN_EMAILS" ] && echo "  • admin emails: $ADMIN_EMAILS"
pids=()
( cd "$ROOT/services/api" && PORT=4000 HOST=0.0.0.0 exec node --import tsx src/server.ts ) & pids+=($!)
( cd "$ROOT/services/worker" && exec node --import tsx src/index.ts ) & pids+=($!)
trap 'echo; echo "stopping API + worker…"; kill "${pids[@]}" 2>/dev/null; exit 0' INT TERM
( for _ in $(seq 1 25); do curl -sf http://127.0.0.1:4000/healthz >/dev/null 2>&1 \
    && { echo "  ✓ API ready → http://127.0.0.1:4000/health"; break; }; sleep 1; done ) &
wait
