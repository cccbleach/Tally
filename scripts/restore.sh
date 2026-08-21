#!/usr/bin/env bash
# 从备份恢复 SQLite 数据库，用法：scripts/restore.sh <backup_file> <target_dir>
# 例：scripts/restore.sh backups/tally-20260820-172625.db ./backend/data
set -euo pipefail
BACKUP="${1:-}"
TARGET_DIR="${2:-./backend/data}"
if [ -z "$BACKUP" ] || [ ! -f "$BACKUP" ]; then
  echo "错误：备份文件不存在：$BACKUP" >&2
  exit 1
fi
mkdir -p "$TARGET_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
# 先对当前库做一个“部署前备份”，避免恢复操作覆盖现有数据
if [ -f "$TARGET_DIR/tally.db" ]; then
  cp "$TARGET_DIR/tally.db" "$TARGET_DIR/tally.db.before-restore-$STAMP" 2>/dev/null || true
fi
# 用 SQLite 在线备份恢复（保证一致性），而非直接 cp 主库（避免 WAL 未合并问题）
temp="$TARGET_DIR/tally-restore-$STAMP.db"
sqlite3 "$BACKUP" ".clone '$temp'"
mv "$temp" "$TARGET_DIR/tally.db"
rm -f "$TARGET_DIR/tally.db-wal" "$TARGET_DIR/tally.db-shm"
echo "已恢复到 $TARGET_DIR/tally.db（原库保留为 tally.db.before-restore-$STAMP.db）"
echo "请检查应用配置的 DATABASE_URL 指向该位置，并重启应用加载恢复后的库。"
