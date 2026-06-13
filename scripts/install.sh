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

log_info "检查前置依赖..."
check_command git
check_command node
check_command npm

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  log_error "Node.js >= 18 版本，当前: $(node -v)"
  exit 1
fi
log_ok "git $(git --version | cut -d' ' -f3), node $(node -v), npm $(npm -v)"

# ── 克隆仓库 ───────────────────────────────────────

if [ -d "$TEKON_HOME" ]; then
  log_warn "$TEKON_HOME 已存在，执行 git pull..."
  cd "$TEKON_HOME"
  git fetch origin "$TEKON_VERSION"
  git checkout "$TEKON_VERSION"
  git pull origin "$TEKON_VERSION" 2>/dev/null || true
else
  log_info "克隆 Tekon 仓库到 $TEKON_HOME ..."
  git clone --branch "$TEKON_VERSION" --depth 1 "$TEKON_REPO" "$TEKON_HOME"
  cd "$TEKON_HOME"
fi

# ── 安装依赖 ───────────────────────────────────────

log_info "安装依赖 (pnpm@10.12.1)..."
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile

log_info "构建项目..."
npm exec --yes -- pnpm@10.12.1 build

# ── 验证构建 ───────────────────────────────────────

CLI_PATH="$TEKON_HOME/packages/cli/dist/index.js"
if [ -f "$CLI_PATH" ]; then
  log_ok "构建成功"
else
  log_error "构建失败: 找不到 $CLI_PATH"
  exit 1
fi

# ── 配置 PATH ──────────────────────────────────────

TEKON_BIN="$TEKON_HOME/bin"
mkdir -p "$TEKON_BIN"

cat > "$TEKON_BIN/tekon" << 'SCRIPT'
#!/usr/bin/env bash
exec node "$HOME/.tekon/packages/cli/dist/index.js" "$@"
SCRIPT
chmod +x "$TEKON_BIN/tekon"

SHELL_NAME=$(basename "$SHELL")
SHELL_RC=""

case "$SHELL_NAME" in
  zsh)  SHELL_RC="$HOME/.zshrc" ;;
  bash) SHELL_RC="$HOME/.bashrc" ;;
  fish) SHELL_RC="$HOME/.config/fish/config.fish" ;;
  *)    SHELL_RC="" ;;
esac

if [ -n "$SHELL_RC" ] && ! grep -q "TEKON_HOME" "$SHELL_RC" 2>/dev/null; then
  echo "" >> "$SHELL_RC"
  echo "# 天工 Tekon" >> "$SHELL_RC"
  echo "export TEKON_HOME=\"$TEKON_HOME\"" >> "$SHELL_RC"
  echo "export PATH=\"\$TEKON_HOME/bin:\$PATH\"" >> "$SHELL_RC"
  log_info "已将 tekon 添加到 $SHELL_RC"
else
  log_info "PATH 配置已存在，跳过"
fi

# ── 完成 ────────────────────────────────────────────

echo ""
printf "${BOLD}${GREEN}══════════════════════════════════════════${NC}\n"
printf "${BOLD}${GREEN}  天工 Tekon 安装完成！${NC}\n"
printf "${BOLD}${GREEN}══════════════════════════════════════════${NC}\n"
echo ""
log_info "运行以下命令使 PATH 生效:"
echo ""
printf "  ${BOLD}source %s${NC}\n" "$SHELL_RC"
echo ""
log_info "或直接使用:"
echo ""
printf "  ${BOLD}node %s/packages/cli/dist/index.js <命令>${NC}\n" "$TEKON_HOME"
echo ""
log_info "快速开始:"
echo ""
printf "  ${BOLD}cd /path/to/your-project && tekon init${NC}\n"
printf "  ${BOLD}tekon demand shape \"你的需求\"${NC}\n"
printf "  ${BOLD}tekon run${NC}\n"
echo ""
log_info "详细文档: ${TEKON_HOME}/docs/manual/tekon-user-manual.md"
echo ""
