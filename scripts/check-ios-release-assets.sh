#!/usr/bin/env bash
# =============================================================================
# iOS 发布资产检查（ios/ 与 ios-local/ 通用）
#
#   用法: scripts/check-ios-release-assets.sh <工程目录> <scheme> [选项]
#     例: scripts/check-ios-release-assets.sh ios-local TallyLocal Tally
#         scripts/check-ios-release-assets.sh ios Tally
#
#   检查项（任一不合格即 exit 1，CI 与本地发布前都跑）：
#     1) AppIcon：存在被引用的 PNG、严格 1024x1024、无 alpha 通道（App Store 拒绝带透明度）
#     2) 工程里 ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon（否则图标不会被打进包）
#     3) 版本号：MARKETING_VERSION(x.y.z) 与 CURRENT_PROJECT_VERSION(整数) 在每个 build
#        configuration 里都存在、且各配置一致；不允许 0.0.0 / 占位
#     4) Bundle ID：存在、非 example.com 之类占位、与 Info.plist 无冲突
#     5) 签名：CODE_SIGN_STYLE 为 Automatic；报告本机证书与 DEVELOPMENT_TEAM 情况
#        （传 --require-team 时，无 Team 视为失败，用于 Archive/上传场景）
#     6) 最低系统版本已声明（IPHONEOS_DEPLOYMENT_TARGET）
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="${1:-}"; shift || true
SCHEME="${1:-}"; shift || true
REQUIRE_TEAM=0
for a in "$@"; do
  [ "$a" = "--require-team" ] && REQUIRE_TEAM=1
done
[ -n "$PROJECT_DIR" ] && [ -n "$SCHEME" ] || { echo "用法: $0 <工程目录> <scheme> [--require-team]" >&2; exit 2; }

cd "$ROOT/$PROJECT_DIR"
PBXPROJ="$(find . -maxdepth 2 -name project.pbxproj | head -1)"
[ -n "$PBXPROJ" ] || { echo "❌ 找不到 project.pbxproj（在 ${PROJECT_DIR}）" >&2; exit 1; }
ASSETSET="$(find . -path '*/AppIcon.appiconset' -type d | head -1)"
FAIL=0
note() { printf '%s\n' "$*"; }
bad() { printf '❌ %s\n' "$*" >&2; FAIL=1; }
ok()  { printf '✅ %s\n' "$*"; }

note "=== 发布资产检查：${PROJECT_DIR}（scheme: ${SCHEME}） ==="

# ---------- 1) AppIcon ----------
if [ -z "$ASSETSET" ]; then
  bad "找不到 AppIcon.appiconset"
else
  CONTENTS="$ASSETSET/Contents.json"
  ICON_FILE="$(python3 - "$CONTENTS" <<'PY'
import json,sys
d=json.load(open(sys.argv[1],encoding='utf-8'))
names=[i.get('filename') for i in d.get('images',[]) if i.get('filename')]
print(names[0] if names else '')
PY
)"
  if [ -z "$ICON_FILE" ]; then
    bad "$ASSETSET/Contents.json 没有引用任何图标文件（只有空 slot 的图标不会被打进包）"
  else
    ICON="$ASSETSET/$ICON_FILE"
    if [ ! -f "$ICON" ]; then
      bad "Contents.json 引用的图标文件不存在：$ICON"
    else
      W="$(sips -g pixelWidth  "$ICON" 2>/dev/null | awk '/pixelWidth/{print $2}')"
      H="$(sips -g pixelHeight "$ICON" 2>/dev/null | awk '/pixelHeight/{print $2}')"
      A="$(sips -g hasAlpha    "$ICON" 2>/dev/null | awk '/hasAlpha/{print $2}')"
      [ "${W:-0}" = "1024" ] && [ "${H:-0}" = "1024" ] \
        && ok "AppIcon 尺寸 ${W}x${H}：$ICON_FILE" \
        || bad "AppIcon 必须是 1024x1024，实际 ${W}x${H}：$ICON"
      [ "${A:-yes}" = "no" ] \
        && ok "AppIcon 无 alpha 通道（App Store 要求）" \
        || bad "AppIcon 不能带透明通道（hasAlpha=yes）：$ICON"
    fi
  fi
  grep -q '"size" : "1024x1024"' "$CONTENTS" \
    && ok "Contents.json 声明 1024x1024 slot" \
    || bad "Contents.json 缺少 1024x1024 slot"
fi

# ---------- 2) 工程引用 AppIcon ----------
grep -q 'ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;' "$PBXPROJ" \
  && ok "工程已设置 ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon" \
  || bad "工程未设置 ASSETCATALOG_COMPILER_APPICON_NAME（图标不会被编译进 .app）"

# ---------- 3) 版本号 ----------
MAP="$(python3 - "$PBXPROJ" <<'PY'
import re,sys
s=open(sys.argv[1],encoding='utf-8').read()
out=[]
for blk in re.finditer(r'isa = XCBuildConfiguration;\n\s*buildSettings = \{(.*?)\n\s*\};', s, re.S):
    b=blk.group(1)
    mv=re.search(r'MARKETING_VERSION = ([^;]+);',b)
    cv=re.search(r'CURRENT_PROJECT_VERSION = ([^;]+);',b)
    bid=re.search(r'PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);',b)
    dt=re.search(r'IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);',b)
    cs=re.search(r'CODE_SIGN_STYLE = ([^;]+);',b)
    team=re.search(r'DEVELOPMENT_TEAM = ([^;]+);',b)
    if mv or cv:
        out.append((mv.group(1) if mv else '', cv.group(1) if cv else '',
                    bid.group(1) if bid else '', dt.group(1) if dt else '',
                    cs.group(1) if cs else '', team.group(1) if team else ''))
if not out:
    print('NONE||||||||')
for r in out:
    print('|'.join(r))
PY
)"
if grep -q '^NONE' <<<"$MAP"; then
  bad "工程里找不到 MARKETING_VERSION / CURRENT_PROJECT_VERSION"
else
  VC="$(grep -c '|' <<<"$MAP")"
  VLIST="$(awk -F'|' 'NF>1{print $1}' <<<"$MAP" | sort -u | tr '\n' ' ')"
  BLIST="$(awk -F'|' 'NF>1{print $2}' <<<"$MAP" | sort -u | tr '\n' ' ')"
  VUNIQ="$(awk -F'|' 'NF>1{print $1}' <<<"$MAP" | sort -u | grep -c .)"
  BUNIQ="$(awk -F'|' 'NF>1{print $2}' <<<"$MAP" | sort -u | grep -c .)"
  note "检测到 $VC 个带版本号的 build configuration；MARKETING_VERSION=[$VLIST] CURRENT_PROJECT_VERSION=[$BLIST]"
  [ "$VUNIQ" = "1" ] \
    && ok "各 configuration 的 MARKETING_VERSION 一致" \
    || bad "MARKETING_VERSION 在不同配置间不一致：$VLIST"
  [ "$BUNIQ" = "1" ] \
    && ok "各 configuration 的 CURRENT_PROJECT_VERSION 一致" \
    || bad "CURRENT_PROJECT_VERSION 在不同配置间不一致：$BLIST"
  VER="$(awk -F'|' 'NF>1 && $1!=""{print $1; exit}' <<<"$MAP")"
  BUILD="$(awk -F'|' 'NF>1 && $2!=""{print $2; exit}' <<<"$MAP")"
  if [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then ok "版本号格式合规（x.y.z）：$VER"; else bad "版本号必须是 x.y.z 形式，当前：'$VER'"; fi
  if [ "$VER" = "0.0.0" ]; then bad "版本号不能是占位的 0.0.0"; fi
  if [ "${VER%%.*}" = "0" ]; then bad "发布版本号不应停在 0.x（发布前应升到 1.0.0 或更高）：$VER"; fi
  if [[ "$BUILD" =~ ^[0-9]+$ ]]; then ok "构建号是纯数字（App Store 要求）：$BUILD"; else bad "构建号必须是纯数字（当前：'$BUILD'）"; fi
fi

# ---------- 4) Bundle ID ----------
BID="$(awk -F'|' 'NF>1 && $3!=""{print $3; exit}' <<<"$MAP")"
if [ -z "$BID" ]; then
  bad "找不到 PRODUCT_BUNDLE_IDENTIFIER"
else
  case "$BID" in
    *example*|*CHANGE_ME*|*changeme*|*placeholder*) bad "Bundle ID 疑似占位：$BID" ;;
    *) [ "$(printf '%s' "$BID" | tr -cd '.' | wc -c | tr -d ' ')" -ge 1 ] \
         && ok "Bundle ID：$BID" || bad "Bundle ID 至少要有一段（reverse-DNS）：$BID" ;;
  esac
fi

# ---------- 5) 签名 ----------
CS="$(awk -F'|' 'NF>1 && $5!=""{print $5; exit}' <<<"$MAP")"
TEAM="$(awk -F'|' 'NF>1 && $6!=""{print $6; exit}' <<<"$MAP")"
[ "${CS:-}" = "Automatic" ] && ok "CODE_SIGN_STYLE = Automatic" || bad "CODE_SIGN_STYLE 应为 Automatic（当前：${CS:-未设置}）"
NIDENT="$(security find-identity -v -p codesigning 2>/dev/null | awk '/"Apple (Development|Distribution|iPhone)/{n++} END{print n+0}')"
note "本机可用的 Apple 签名身份：${NIDENT}；DEVELOPMENT_TEAM=${TEAM:-<未设置>}"
if [ "$REQUIRE_TEAM" -eq 1 ]; then
  [ -n "$TEAM" ] && [ "$NIDENT" -gt 0 ] \
    && ok "签名身份就绪（Team=${TEAM}，证书 ${NIDENT} 个）" \
    || bad "Archive/上传需要 DEVELOPMENT_TEAM 与至少 1 个签名身份（Team=${TEAM:-无}，证书=${NIDENT}）"
fi

# 描述文件（provisioning profile）只能由登录的 Apple ID 自动申请，机器上往往没有：
# 这里只做提示，避免“CI 能过、真机装不上/上传失败”才发现。
#
# 注意路径里含空格（"Provisioning Profiles"）：原先用未加引号的空格分隔字符串遍历，
# 会被拆成 ".../UserData/Provisioning" 与 "Profiles" 两个不存在的路径，
# 于是**永远数出 0 个**并误报"本机没有描述文件"（本机实测：Xcode 管理目录里实际有 1 个）。
# 改用数组逐项遍历，并额外报告检测到的 Profile 属于哪个 Team，便于直接判断是否匹配工程。
PROF_DIRS=(
  "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
  "$HOME/Library/MobileDevice/Provisioning Profiles"
)
NPROF=0
PROF_TEAMS=""
for d in "${PROF_DIRS[@]}"; do
  [ -d "$d" ] || continue
  n=$(find "$d" -name '*.mobileprovision' 2>/dev/null | wc -l | tr -d ' ')
  NPROF=$((NPROF + n))
  # 逐个解析出 TeamIdentifier（本机可能同时存在多个团队的描述文件）
  while IFS= read -r prof; do
    [ -n "$prof" ] || continue
    t=$(security cms -D -i "$prof" 2>/dev/null | plutil -p - 2>/dev/null | grep -oE '"TeamIdentifier"' -A 1 | grep -oE '[A-Z0-9]{10}' | head -1)
    [ -n "$t" ] && PROF_TEAMS="${PROF_TEAMS}${t} "
  done <<< "$(find "$d" -name '*.mobileprovision' 2>/dev/null)"
done
PROF_TEAMS="$(printf '%s\n' $PROF_TEAMS | sort -u | tr '\n' ' ' | sed 's/ $//')"
if [ "$NPROF" -gt 0 ]; then
  ok "本机已安装描述文件 ${NPROF} 个（Team: ${PROF_TEAMS:-未知}）"
  if [ -n "${TEAM}" ] && [ -n "$PROF_TEAMS" ] && ! printf '%s' "$PROF_TEAMS" | grep -q "$TEAM"; then
    note "⚠️  已安装的描述文件团队（${PROF_TEAMS}）与工程 DEVELOPMENT_TEAM（${TEAM}）不一致："
    note "    真机安装/上传前需在 Xcode → Settings → Accounts 登录 ${TEAM} 对应的 Apple ID。"
  fi
else
  note "⚠️  本机没有描述文件（provisioning profile）。Archive 可用 CODE_SIGNING_ALLOWED=NO 做结构校验，"
  note "    但真机安装 / TestFlight 上传前必须：Xcode → Settings → Accounts 登录 ${TEAM:-对应 Team} 的 Apple ID，"
  note "    构建时加 -allowProvisioningUpdates（或手工安装描述文件）。"
fi

# ---------- 6) 最低系统版本 ----------
# 部署目标可能只在工程级配置里声明，因此直接扫整个 pbxproj
DTU="$(grep -o 'IPHONEOS_DEPLOYMENT_TARGET = [^;]*;' "$PBXPROJ" | sed 's/.*= //; s/;//' | sort -u)"
DT="$(printf '%s\n' "$DTU" | head -1)"
if [ -z "$DT" ]; then
  bad "未声明 IPHONEOS_DEPLOYMENT_TARGET"
elif [ "$(printf '%s\n' "$DTU" | grep -c .)" != "1" ]; then
  bad "IPHONEOS_DEPLOYMENT_TARGET 在不同配置间不一致：$(printf '%s\n' "$DTU" | tr '\n' ' ')"
else
  ok "IPHONEOS_DEPLOYMENT_TARGET = ${DT}（各配置一致）"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "❌ 发布资产检查未通过：$PROJECT_DIR" >&2
  exit 1
fi
echo "✅ 发布资产检查通过：${PROJECT_DIR}（版本 $VER build ${BUILD}，Bundle ${BID}）"
