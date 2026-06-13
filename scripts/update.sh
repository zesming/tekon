#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════
# 天工 Tekon — 更新脚本
# 用法: bash scripts/update.sh  或  tekon update
# ═══════════════════════════════════════════════════

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

TEKON_HOME="${TEKON_HOME:-$HOME/.tekon}"

log_info()  { printf "${CYAN}[Tekon]${NC} %s\n" "$1"; }
log_ok()    { printf "${GREEN}[Tekon]${NC} %s\n" "$1"; }
log_error() { printf "${RED}[Tekon]${NC} %s\n" "$1"; }
log_step()  { printf "\n${BOLD}${CYAN}══ %s ══${NC}\n" "$1"; }

if [ ! -d "$TEKON_HOME" ]; then
  log_error "Tekon 未安装。请先运行安装脚本:"
  echo "  curl -fsSL https://raw.githubusercontent.com/zesming/tekon/main/scripts/install.sh | bash"
  exit 1
fi

cd "$TEKON_HOME"

OLD_VERSION=$(git rev-parse --short HEAD)

log_step "拉取最新代码"
git fetch origin main --quiet 2>/dev/null
git checkout main --quiet 2>/dev/null
git pull origin main --quiet 2>/dev/null

NEW_VERSION=$(git rev-parse --short HEAD)

if [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
  log_ok "已是最新版本 (${OLD_VERSION})"
  exit 0
fi

log_step "安装依赖与构建"
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile >/dev/null 2>&1
npm exec --yes -- pnpm@10.12.1 build >/dev/null 2>&1

CLI_PATH="$TEKON_HOME/packages/cli/dist/index.js"
if [ ! -f "$CLI_PATH" ]; then
  log_error "构建失败: 找不到 $CLI_PATH"
  exit 1
fi

# ── 完成 ────────────────────────────────────────────

echo ""
printf "${BOLD}${GREEN}══════════════════════════════════════════${NC}\n"
printf "${BOLD}${GREEN}  天工 Tekon 更新完成${NC}\n"
printf "${BOLD}${CYAN}  %s${NC} ${BOLD}→${NC} ${BOLD}${GREEN}%s${NC}\n" "$OLD_VERSION" "$NEW_VERSION"
printf "${BOLD}${GREEN}══════════════════════════════════════════${NC}\n"
echo ""
