#!/usr/bin/env bash
# 开发/构建环境自检。
#
# 为什么需要：本机踩过的坑都不是代码问题，而是"环境看起来能用、实际上某个前置条件没满足"：
#   1) PATH 里的 node 是 Electron 内置（ABI 与 better-sqlite3 不匹配）→ 测试整批挂掉；
#   2) Xcode 升级后**许可证未接受** → xcodebuild/xcrun//usr/bin/python3 全部退出码 69，
#      iOS 本地构建与测试直接不可用（CI 不受影响，只有本机受影响）；
#   3) 缺少 pnpm/Docker 时才发现，白白花时间排查。
# 用法：./scripts/check-dev-env.sh
# 退出码：0 = 全部必需项通过；1 = 有必需项失败（详见输出）。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
WARN=0

pass() { printf '  ✅ %s\n' "$1"; }
fail() { printf '  ❌ %s\n' "$1"; FAIL=$((FAIL + 1)); }
warn() { printf '  ⚠️  %s\n' "$1"; WARN=$((WARN + 1)); }

echo "== Node / 包管理 =="
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v 2>/dev/null | tr -d 'v')"
  ELECTRON_VER="$(node -p 'process.versions.electron ?? ""' 2>/dev/null)"
  MODULES_ABI="$(node -p 'process.versions.modules' 2>/dev/null)"
  if [ -n "${ELECTRON_VER}" ]; then
    fail "PATH 里的 node 是 Electron 内置（$(node -v)，Electron ${ELECTRON_VER}，ABI ${MODULES_ABI}）"
    echo "        native 模块（better-sqlite3）会因 ABI 不匹配加载失败、测试整批挂掉。"
    echo "        请用真实 Node，例如：export PATH=\"\${HOME}/.nvm/versions/node/v24.19.0/bin:\${PATH}\""
  else
    NODE_MAJOR="${NODE_VER%%.*}"
    if [ "${NODE_MAJOR:-0}" -ge 24 ] 2>/dev/null; then
      pass "node $(node -v)（ABI ${MODULES_ABI}）"
    else
      fail "node $(node -v) 版本过低：backend/package.json 要求 >=24.0.0 <25"
    fi
  fi
else
  fail "未找到 node（需要 Node.js 24）"
fi

if command -v pnpm >/dev/null 2>&1; then
  pass "pnpm $(pnpm -v 2>/dev/null)"
else
  fail "未找到 pnpm（corepack enable 或 npm i -g pnpm）"
fi

echo
echo "== 后端原生依赖 =="
if [ -d "${ROOT}/backend/node_modules" ]; then
  if (cd "${ROOT}/backend" && node -e 'require("better-sqlite3");' >/dev/null 2>&1); then
    pass "better-sqlite3 可加载（ABI 与当前 node 匹配）"
  else
    fail "better-sqlite3 无法加载：多为 node ABI 不匹配或未执行 pnpm install"
  fi
else
  warn "backend/node_modules 不存在（首次需 cd backend && pnpm install）"
fi

echo
echo "== Xcode / Swift（仅 iOS 开发需要）=="
XCODEBUILD_SHIM="$(command -v xcodebuild 2>/dev/null || true)"
XCODEBUILD_DIRECT="/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild"
if [ -n "${XCODEBUILD_SHIM}" ]; then
  pass "xcodebuild 已安装：$("${XCODEBUILD_SHIM}" -version 2>/dev/null | head -1)"
  if "${XCODEBUILD_SHIM}" -checkFirstLaunchStatus >/dev/null 2>&1; then
    pass "Xcode 首次启动检查通过（许可证 + 组件齐备）"
  else
    # `-checkFirstLaunchStatus` 是静默失败，两种情况的退出码都是 69，必须区分：
    #   a) 许可证未接受 → xcrun / /usr/bin/python3 也会一起挂；
    #   b) 许可证已接受但"首次启动未完成"（组件/私有框架与 Xcode 版本不同步）
    #      → xcrun 正常、模拟器构建通常也能过，但**真机部署/Archive 可能失败**。
    # 本机实测（Xcode 26→27 升级后）属于 (b)：构建成功但日志出现 DVTPlugInLoading 加载失败，
    # 且 /Library/Developer/PrivateFrameworks/CoreDevice.framework 仍是旧版本。
    if xcrun --find swiftc >/dev/null 2>&1; then
      fail "Xcode 首次启动未完成（组件与 Xcode 版本不同步）：-checkFirstLaunchStatus 退出码 69"
      echo "        许可证已通过（xcrun 正常），但真机部署/Archive 可能因私有框架版本不匹配而失败。"
      echo "        修复：sudo xcodebuild -runFirstLaunch"
    else
      fail "Xcode 许可证未接受：xcodebuild / xcrun / /usr/bin/python3 都会退出码 69，iOS 本地构建不可用"
      echo "        修复：sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch"
      if [ -x "${XCODEBUILD_DIRECT}" ] && "${XCODEBUILD_DIRECT}" -version >/dev/null 2>&1; then
        echo "        （部分绕过：直接调用 ${XCODEBUILD_DIRECT} 可查版本，但完整构建/测试仍会走 xcrun 授权检查）"
      fi
    fi
  fi
else
  warn "未找到 xcodebuild：不做 iOS 开发时可忽略"
fi

SWIFTC_DIRECT="/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc"
if command -v swiftc >/dev/null 2>&1 && swiftc --version >/dev/null 2>&1; then
  pass "swiftc 可用：$(swiftc --version 2>/dev/null | head -1)"
elif [ -x "${SWIFTC_DIRECT}" ] && "${SWIFTC_DIRECT}" --version >/dev/null 2>&1; then
  warn "系统 swiftc 不可用（许可证），但 toolchain 内可直接调用：${SWIFTC_DIRECT}"
  echo "        可做语法校验：\"${SWIFTC_DIRECT}\" -parse <file.swift>"
else
  warn "未找到可用的 swiftc"
fi

echo
echo "== 可选：Docker（仅编排/镜像相关改动需要）=="
if command -v docker >/dev/null 2>&1; then
  pass "docker $(docker --version 2>/dev/null | sed 's/^Docker version //;s/,.*//')"
else
  warn "未安装 docker：Dockerfile/compose 改动只能靠 CI 验证（backend job 的容器级回归）"
fi

echo
if [ "${FAIL}" -eq 0 ]; then
  echo "环境自检通过（警告 ${WARN} 项）。"
  exit 0
fi
echo "环境自检失败：${FAIL} 项必需条件未满足，${WARN} 项警告。"
exit 1
