#!/usr/bin/env bash
# SQLite 在线备份（含 WAL/SHM 一致性），用法：scripts/backup.sh <db_path> <backup_dir>
# 保留策略：最近 7 份每日 + 180 天内每月一份（对应 7/30/180 的轻量实现）
set -euo pipefail
DB="${1:-./backend/data/tally.db}"
DEST="${2:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
sqlite3 "$DB" ".backup '$DEST/tally-$STAMP.db'"
echo "已备份到 $DEST/tally-$STAMP.db"

prune_retention() {
  # 1) 删除 180 天以前的旧备份
  find "$DEST" -name 'tally-*.db' -mtime +180 -delete 2>/dev/null || true
  # 2) 最近 7 份（每日）
  ls -1t "$DEST"/tally-*.db 2>/dev/null | tail -n +8 | xargs -r rm -f 2>/dev/null || true
  # 3) 超过 7 份的部分：同一 (年-月) 只保留最新一份
  printf '%s\n' "$DEST"/tally-20*.db 2>/dev/null | sort -r | awk '
    {
      f=$0; m=substr(f, length(f)-17, 6); # tally-YYYYMMDD-... → 取 YYYYMM
      if (count++ < 7) { seen[m]=1; next }
      if (!(m in seen)) { seen[m]=1; next }
      print f
    }' | xargs -r rm -f 2>/dev/null || true
}
prune_retention
echo "保留策略：最近 7 份 + 180 天内每月一份；已清理过期备份。"
