#!/usr/bin/env bash
# SQLite 在线备份（含 WAL/SHM 一致性），用法：scripts/backup.sh <db_path> <backup_dir>
set -euo pipefail
DB="${1:-./backend/data/tally.db}"
DEST="${2:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
sqlite3 "$DB" ".backup '$DEST/tally-$STAMP.db'"
echo "已备份到 $DEST/tally-$STAMP.db"
# 保留最近 14 份
ls -1t "$DEST"/tally-*.db 2>/dev/null | tail -n +15 | xargs -r rm -f
