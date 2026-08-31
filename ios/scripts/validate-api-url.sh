#!/usr/bin/env bash
# =============================================================================
# Tally API 地址校验：Release 构建禁止 localhost / 占位域名 / 非 HTTPS
#
# 两种用法：
#   1) 构建期（Xcode Run Script 或 CI 调用）
#        validate-api-url.sh --url "$TALLY_API_BASE_URL" --require-https
#   2) 产物校验（从已构建的 .app 里读 Info.plist 再校验）
#        validate-api-url.sh --plist "path/to/Tally.app" [--plist-key TallyAPIBaseURL]
#
# 拒绝的内容（Release 一律视为无效）：
#   - 空值 / 未被 Xcode 展开的 $(TALLY_API_BASE_URL)
#   - 非 https:// 协议（含裸域名）
#   - localhost / *.localhost / 127.0.0.1 / 0.0.0.0 / ::1 / [::1]
#   - 单标签主机名（如 tally-backend、192.168.1.10 这类内网/容器名）与私网 IP
#   - example.com / example.org / example.net / test / invalid / local 等保留域
#   - 常见占位写法：your-*、yourdomain、change-me、changeme、placeholder、todo、
#     tbd、xxx、yyy、FIXME、REPLACE、dummy、sample、template、placeholder 等
# =============================================================================
set -euo pipefail

URL=""
APP_PLIST=""
KEY="TallyAPIBaseURL"
REQUIRE_HTTPS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --plist) APP_PLIST="${2:-}"; shift 2 ;;
    --plist-key) KEY="${2:-}"; shift 2 ;;
    --require-https) REQUIRE_HTTPS=1; shift ;;
    -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

fail() {
  echo "❌ API 地址不合规：$1" >&2
  echo "   当前值：${URL:-<空>}" >&2
  echo "   Release 构建必须显式注入真实 HTTPS 域名，例如：" >&2
  echo "     xcodebuild ... -configuration Release TALLY_API_BASE_URL=https://your-domain.cn" >&2
  exit 1
}

# ---- 从构建产物 Info.plist 读取地址（产物校验模式）----
if [ -n "$APP_PLIST" ]; then
  if [ -d "$APP_PLIST" ]; then
    PLIST="$APP_PLIST/Contents/Info.plist"
    [ -f "$PLIST" ] || PLIST="$APP_PLIST/Info.plist"
  else
    PLIST="$APP_PLIST"
  fi
  [ -f "$PLIST" ] || { echo "❌ 找不到 Info.plist：$PLIST" >&2; exit 1; }
  if command -v plutil >/dev/null 2>&1; then
    URL="$(plutil -extract "$KEY" raw -o - "$PLIST" 2>/dev/null || true)"
  else
    URL="$(/usr/libexec/PlistBuddy -c "Print :$KEY" "$PLIST" 2>/dev/null || true)"
  fi
  echo "ℹ️  产物 ${KEY} = ${URL:-<空>}  (${PLIST})"
  REQUIRE_HTTPS=1

  # 顺带扫描产物里出现的**所有** URL，任何 http:// 或占位地址都不允许出现在 Release 包里
  # （例如有人把备用地址、图片地址写进 Info.plist）
  ALL_URLS="$(plutil -p "$PLIST" 2>/dev/null | grep -oE "https?://[^\"'<>() ]+" | sort -u || true)"
  if [ -n "$ALL_URLS" ]; then
    echo "ℹ️  产物 Info.plist 中出现的 URL："
    printf '     %s\n' $ALL_URLS
    while IFS= read -r u; do
      [ -n "$u" ] || continue
      case "$u" in
        http://localhost*|http://127.*|http://*localhost*|*example.com*|*example.org*|*your-*|*placeholder*)
          echo "❌ Release 产物 Info.plist 含明文/占位地址：$u" >&2
          exit 1 ;;
      esac
    done <<< "$ALL_URLS"
  fi
fi

# ---- 校验 ----
[ -n "$URL" ] || fail "地址为空。Release 产物不允许使用空/未展开的构建变量"
if [[ "$URL" == *'$('* || "$URL" == *'${'* ]]; then
  fail "构建变量未被替换（构建变量原样留在产物里），说明 TALLY_API_BASE_URL 没有传入"
fi

# 协议
case "$URL" in
  https://*) : ;;
  http://*)
    if [ "$REQUIRE_HTTPS" -eq 1 ]; then fail "禁止 http:// 明文地址（Release 必须 HTTPS）"; fi
    ;;
  *) fail "缺少协议前缀，必须是 https:// 开头的完整 URL" ;;
esac

# 去掉协议与路径，取 host[:port]
HOSTPORT="${URL#*://}"
HOST="${HOSTPORT%%/*}"
HOST="${HOST%%:*}"
[ -n "$HOST" ] || fail "URL 中没有主机名"

# 本机 / 环回
case "$HOST" in
  localhost|*.localhost|127.*|0.0.0.0|\[::1\]|::1) fail "禁止本机/环回地址（localhost、127.x、::1）" ;;
esac

# 私网与容器内网名 / 裸 IP
case "$HOST" in
  10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*|169.254.*|*.docker|*.internal|*.local|*.home.arpa)
    fail "禁止内网/私网地址（容器服务名、私网 IP、*.local 等）" ;;
esac
# 纯 IP（不含字母）一律拒绝：TLS 证书需要域名，且 IP 往往是内网地址
case "$HOST" in
  *[a-zA-Z]*) : ;;
  *) fail "禁止直接使用 IP 地址作为 API 域名（需要域名才能签发 TLS 证书）" ;;
esac

# 保留/示例域
DOTS_HOST=".$HOST."
case "$DOTS_HOST" in
  *.example.com.|*.example.org.|*.example.net.|*.example.|*.test.|*.invalid.|*.localhost.|*.local.|*.arpa.)
    fail "禁止 example.com / example.org / .test / .invalid 等保留或示例域" ;;
esac

# 单标签主机名（没有点）——例如 tally-backend、backend、localhost
case "$HOST" in
  *.*) : ;;
  *) fail "主机名必须是可公网解析的完全限定域名（当前是单标签主机名：${HOST} ）" ;;
esac

# 占位词（大小写不敏感）
LOWER="$(printf '%s' "$HOST" | tr '[:upper:]' '[:lower:]')"
for bad in yourdomain your-domain yourdomain yourcompany yourcompany yoursite your-server \
           your-production-domain production-domain placeholder changeme change-me change_me \
           please-change replace-me replace_me put-your set-your fill-in todo tbd fixme \
           xxx yyy zzz dummy sample template foo bar baz n/a none null undefined \
           staging-placeholder test-domain testdomain my-domain mydomain; do
  case "$LOWER" in
    *"$bad"*) fail "命中占位域名黑名单「${bad}」（ Release 必须注入真实域名）" ;;
  esac
done

# 主机至少两段且末段是字母（真实 TLD）
TLD="${HOST##*.}"
case "$TLD" in
  ''|*[!a-zA-Z]*) fail "顶级域名不合法： ${HOST}" ;;
esac
[ "${#TLD}" -ge 2 ] || fail "顶级域名过短： ${HOST}"

echo "✅ API 地址合规：$URL"
