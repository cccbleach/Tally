#!/usr/bin/env bash
# SQLite 在线备份（含 WAL/SHM 一致性），用法：scripts/backup.sh <db_path> <backup_dir>
# 保留策略（与 scripts/prune-retention.mjs 及自动化测试保持一致）：
#   最近 7 天   : 每天一份  (0 <= ageDays < 7)
#   8-30 天     : 每周一份  (7 <= ageDays < 30)
#   31-180 天   : 每月一份  (30 <= ageDays < 180)
#   超过 180 天 : 删除
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${1:-$ROOT/backend/data/tally.db}"
DEST="${2:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
sqlite3 "$DB" ".backup '$DEST/tally-$STAMP.db'"
echo "已备份到 $DEST/tally-$STAMP.db"

# 用统一的保留策略脚本清理（与自动化测试共用同一实现）
if command -v node >/dev/null 2>&1; then
  node "$ROOT/scripts/prune-retention.mjs" "$DEST"
else
  echo "警告：未找到 node，跳过保留策略清理（仅保留本次备份）。" >&2
fi
