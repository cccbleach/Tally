#!/usr/bin/env bash
set -euo pipefail

PROJECT="${1:-ios/Tally.xcodeproj}"
SCHEME="${2:-Tally}"

if [[ ! -d "$PROJECT" ]]; then
  echo "❌ 找不到 Xcode 工程：$PROJECT" >&2
  exit 1
fi

settings_for() {
  local configuration="$1"
  xcodebuild -project "$PROJECT" -scheme "$SCHEME" \
    -configuration "$configuration" -showBuildSettings \
    CODE_SIGNING_ALLOWED=NO 2>/dev/null
}

setting_value() {
  local settings="$1"
  local key="$2"
  printf '%s\n' "$settings" \
    | awk -F ' = ' -v wanted="$key" '$1 ~ "^[[:space:]]*" wanted "$" { print $2; exit }'
}

assert_exact() {
  local label="$1"
  local settings="$2"
  local key="$3"
  local expected="$4"
  local actual
  actual="$(setting_value "$settings" "$key")"
  if [[ "$actual" != "$expected" ]]; then
    echo "❌ $label: $key 应为 '$expected'，实际为 '${actual:-<未设置>}'" >&2
    exit 1
  fi
  echo "✅ $label: $key = $actual"
}

assert_word() {
  local label="$1"
  local settings="$2"
  local key="$3"
  local expected_word="$4"
  local actual
  actual="$(setting_value "$settings" "$key")"
  if [[ " $actual " != *" $expected_word "* ]]; then
    echo "❌ $label: $key 必须包含 '$expected_word'，实际为 '${actual:-<未设置>}'" >&2
    exit 1
  fi
  echo "✅ $label: $key 包含 $expected_word"
}

DEBUG_SETTINGS="$(settings_for Debug)"
RELEASE_SETTINGS="$(settings_for Release)"

assert_word "Debug" "$DEBUG_SETTINGS" SWIFT_ACTIVE_COMPILATION_CONDITIONS DEBUG
assert_exact "Debug" "$DEBUG_SETTINGS" SWIFT_OPTIMIZATION_LEVEL -Onone
assert_exact "Debug" "$DEBUG_SETTINGS" ENABLE_TESTABILITY YES
assert_exact "Debug" "$DEBUG_SETTINGS" DEBUG_INFORMATION_FORMAT dwarf

assert_exact "Release" "$RELEASE_SETTINGS" SWIFT_OPTIMIZATION_LEVEL -O
assert_exact "Release" "$RELEASE_SETTINGS" SWIFT_COMPILATION_MODE wholemodule
assert_exact "Release" "$RELEASE_SETTINGS" ENABLE_TESTABILITY NO
assert_exact "Release" "$RELEASE_SETTINGS" DEBUG_INFORMATION_FORMAT dwarf-with-dsym

echo "✅ iOS Debug/Release 核心构建设置完整"
