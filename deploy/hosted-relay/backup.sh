#!/usr/bin/env bash
# Consistent online backup of the relay SQLite database (WAL-safe). Keeps 14 days.
set -euo pipefail
DB="${DATABASE_PATH:-/var/lib/cloudcli-relay/relay.db}"
DEST="${BACKUP_DIR:-/var/backups/cloudcli-relay}"
install -d -m 0700 "$DEST"
OUT="$DEST/relay-$(date -u +%Y%m%dT%H%M%SZ).db"
sqlite3 "$DB" ".backup '$OUT'"
test "$(sqlite3 "$OUT" 'PRAGMA integrity_check;')" = "ok"
chmod 0600 "$OUT"
find "$DEST" -name 'relay-*.db' -mtime +14 -delete
echo "backup ok: $OUT"
