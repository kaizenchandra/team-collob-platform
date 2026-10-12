#!/usr/bin/env bash
set -euo pipefail
# Isolated local restore only; never drops the application database.
mkdir -p .data/backups
chmod 700 .data/backups
restore_db="concord_restore_$(date +%s)"
dump=".data/backups/${restore_db}.dump"
started=$(date +%s)
docker compose exec -T postgres pg_dump -U concord -d concord -Fc > "$dump"
chmod 600 "$dump"
docker compose exec -T postgres createdb -U concord "$restore_db"
cleanup() { docker compose exec -T postgres dropdb -U concord "$restore_db"; }
trap cleanup EXIT
docker compose exec -T postgres pg_restore -U concord -d "$restore_db" --no-owner --exit-on-error < "$dump"
original=$(docker compose exec -T postgres psql -U concord -d concord -Atc 'SELECT count(*) FROM messages')
restored=$(docker compose exec -T postgres psql -U concord -d "$restore_db" -Atc 'SELECT count(*) FROM messages')
[[ "$original" == "$restored" ]]
docker compose exec -T postgres psql -U concord -d "$restore_db" -v ON_ERROR_STOP=1 -Atc "SELECT 'messages='||count(*) FROM messages; SELECT 'memberships='||count(*) FROM memberships; SELECT 'orphan_messages='||count(*) FROM messages m LEFT JOIN channels c ON c.id=m.channel_id WHERE c.id IS NULL;"
printf 'Local restore passed in %s seconds; dump: %s\n' "$(( $(date +%s) - started ))" "$dump"
printf 'This local dump is not encrypted. It does not establish production backup, RPO, or HA compliance.\n'
