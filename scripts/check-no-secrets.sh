#!/usr/bin/env bash
# 凭证特征扫描门禁：防止密钥/令牌被误提交，也防止它们留在历史里（改公开仓库前尤其重要）。
#
# 用法：
#   ./scripts/check-no-secrets.sh            # 扫描受跟踪文件 + 全部历史
#   ./scripts/check-no-secrets.sh --worktree # 只扫当前工作区的受跟踪文件（快）
#
# 设计取舍：**只匹配高置信度特征**（云厂商 AK 前缀、GitHub/Slack/OpenAI 令牌、私钥头），
# 因为这些模式在正常代码里几乎不会误报 —— 门禁一旦误报就会被绕过，等于没有门禁。
# 测试用的假密钥（如 `test-secret`、`concurrency-reg-secret-…`）刻意不在匹配范围内。
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2

# 高置信度凭证特征（扩展正则）
PATTERNS=(
  'LTAI[0-9A-Za-z]{12,}'                 # 阿里云 AccessKey ID
  'AKIA[0-9A-Z]{16}'                     # AWS AccessKey ID
  'ASIA[0-9A-Z]{16}'                     # AWS 临时凭证
  'AKID[0-9A-Za-z]{13,}'                 # 腾讯云 SecretId
  'ghp_[A-Za-z0-9]{30,}'                 # GitHub PAT (classic)
  'github_pat_[A-Za-z0-9_]{30,}'         # GitHub PAT (fine-grained)
  'gh[osru]_[A-Za-z0-9]{30,}'            # GitHub OAuth/App/refresh token
  'sk-[A-Za-z0-9]{32,}'                  # OpenAI 风格密钥
  'xox[abpsr]-[A-Za-z0-9-]{10,}'         # Slack token
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'   # 私钥文件内容
  'eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.'  # JWT（两段 base64 + 点）
)
JOINED="$(printf '%s|' "${PATTERNS[@]}")"
JOINED="${JOINED%|}"

status=0

echo "== 受跟踪文件扫描 =="
if git grep -nIE "$JOINED" -- . > /tmp/secrets-worktree.txt 2>/dev/null && [ -s /tmp/secrets-worktree.txt ]; then
  echo "  ❌ 受跟踪文件里发现疑似凭证："
  sed 's/^/     /' /tmp/secrets-worktree.txt
  status=1
else
  echo "  ✅ 受跟踪文件未发现高置信度凭证特征"
fi

if [ "${1:-}" = "--worktree" ]; then
  [ "$status" -eq 0 ] && echo "（仅工作区模式：未扫描历史）"
  exit "$status"
fi

echo
echo "== 完整历史扫描（含已删除文件；改公开仓库前必须过这一关）=="
# git log -p 会输出 diff 内容；用 -S 无法匹配正则，因此直接扫 patch 文本
if git log --all -p --no-color --pretty=format: 2>/dev/null | grep -nIE "$JOINED" > /tmp/secrets-history.txt; then
  echo "  ❌ 历史里发现疑似凭证（共 $(wc -l < /tmp/secrets-history.txt | tr -d ' ') 行）："
  head -20 /tmp/secrets-history.txt | sed 's/^/     /'
  echo "     …完整结果见 /tmp/secrets-history.txt"
  echo "     处理建议：轮换该凭证 → 用 git filter-repo 清理历史 → 强推（参考 docs/secret-hygiene.md）"
  status=1
else
  echo "  ✅ 全部历史未发现高置信度凭证特征"
fi

echo
if [ "$status" -eq 0 ]; then
  echo "凭证扫描通过。"
else
  echo "凭证扫描失败：请先处理上面列出的命中项再提交/改公开。"
fi
exit "$status"
