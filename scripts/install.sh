#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════
# 天工 Tekon — 安装脚本
# 用法: curl -fsSL https://raw.githubusercontent.com/zesming/tekon/main/scripts/install.sh | bash
# ═══════════════════════════════════════════════════

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

TEKON_REPO="https://github.com/zesming/tekon.git"
TEKON_HOME="${TEKON_HOME:-$HOME/.tekon}"
TEKON_VERSION="${TEKON_VERSION:-main}"

log_info()  { printf "${CYAN}[Tekon]${NC} %s\n" "$1"; }
log_ok()    { printf "${GREEN}[Tekon]${NC} %s\n" "$1"; }
log_warn()  { printf "${YELLOW}[Tekon]${NC} %s\n" "$1"; }
log_error() { printf "${RED}[Tekon]${NC} %s\n" "$1"; }
log_step()  { printf "\n${BOLD}${CYAN}══ %s ══${NC}\n" "$1"; }

# ── 前置检查 ───────────────────────────────────────

check_command() {
  if ! command -v "$1" &>/dev/null; then
    log_error "缺少命令: $1。请先安装后再运行本脚本。"
    case "$1" in
      git)   log_info "安装 Git: https://git-scm.com/downloads" ;;
      node)  log_info "安装 Node.js (>=18): https://nodejs.org" ;;
      npm)   log_info "npm 通常随 Node.js 一起安装" ;;
    esac
    exit 1
  fi
}

log_info "天工 Tekon 安装脚本"
echo ""

check_command git
check_command node
check_command npm

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  log_error "Node.js >= 18 版本，当前: $(node -v)"
  exit 1
fi

# ── 克隆仓库 ───────────────────────────────────────

if [ -d "$TEKON_HOME" ]; then
  log_step "更新已有仓库"
  cd "$TEKON_HOME"
  git fetch origin "$TEKON_VERSION" --quiet 2>/dev/null
  git checkout "$TEKON_VERSION" --quiet 2>/dev/null
  git pull origin "$TEKON_VERSION" --quiet 2>/dev/null || true
else
  log_step "克隆仓库"
  git clone --branch "$TEKON_VERSION" --depth 1 --quiet "$TEKON_REPO" "$TEKON_HOME" 2>/dev/null
  cd "$TEKON_HOME"
fi

# ── 安装依赖 ───────────────────────────────────────

log_step "安装依赖与构建"
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile >/dev/null 2>&1
npm exec --yes -- pnpm@10.12.1 build >/dev/null 2>&1

# ── 验证构建 ───────────────────────────────────────

CLI_PATH="$TEKON_HOME/packages/cli/dist/index.js"
if [ ! -f "$CLI_PATH" ]; then
  log_error "构建失败: 找不到 $CLI_PATH"
  exit 1
fi

# ── 安装 tekon 命令 ────────────────────────────────

TEKON_BIN="$TEKON_HOME/bin"
mkdir -p "$TEKON_BIN"

cat > "$TEKON_BIN/tekon" << 'SCRIPT'
#!/usr/bin/env bash
exec node "$HOME/.tekon/packages/cli/dist/index.js" "$@"
SCRIPT
chmod +x "$TEKON_BIN/tekon"

VERSION=$(git rev-parse --short HEAD)

# ── 完成 ────────────────────────────────────────────

echo ""
printf "${BOLD}${GREEN}══════════════════════════════════════════${NC}\n"
printf "${BOLD}${GREEN}  天工 Tekon 安装完成  ${NC}${CYAN}${VERSION}${NC}\n"
printf "${BOLD}${GREEN}══════════════════════════════════════════${NC}\n"
echo ""

SHELL_NAME=$(basename "$SHELL")
SHELL_RC=""
case "$SHELL_NAME" in
  zsh)  SHELL_RC="$HOME/.zshrc" ;;
  bash) SHELL_RC="$HOME/.bashrc" ;;
  fish) SHELL_RC="$HOME/.config/fish/config.fish" ;;
  *)    SHELL_RC="" ;;
esac

log_info "将以下行加入你的 Shell 配置文件以使 tekon 在 PATH 中可用："
echo ""
printf "  ${BOLD}export TEKON_HOME=\"%s\"${NC}\n" "$TEKON_HOME"
printf "  ${BOLD}export PATH=\"\$TEKON_HOME/bin:\$PATH\"${NC}\n"
echo ""
if [ -n "$SHELL_RC" ]; then
  log_info "或直接执行："
  echo ""
  printf "  ${BOLD}echo 'export TEKON_HOME=\"%s\"' >> %s${NC}\n" "$TEKON_HOME" "$SHELL_RC"
  printf "  ${BOLD}echo 'export PATH=\"\$TEKON_HOME/bin:\$PATH\"' >> %s${NC}\n" "$SHELL_RC"
  printf "  ${BOLD}source %s${NC}\n" "$SHELL_RC"
  echo ""
fi
log_info "配置完成后即可使用: ${BOLD}tekon${NC}"
echo ""
