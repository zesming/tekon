# Claude Provider Smoke 手动验证手册

## 目的

本手册验证 Tekon 能通过 CommandGateway 启动真实 Claude Code provider。该 smoke 不进入默认 CI，必须由维护者在已认证环境显式执行。

## 前置条件

- 本机已安装 Claude Code CLI。
- `claude auth status` 返回成功。
- 不把 API key、token、认证输出或环境变量值写入命令行、报告或 git。

## 命令

先在当前 shell 显式设置 smoke 启用开关，并按需设置 Claude CLI 命令覆盖；不要把认证输出或密钥写入文档。

```bash
npm run smoke:claude-provider
```

## 成功标准

- 命令退出 0。
- stdout 包含 `TEKON_CLAUDE_PROVIDER_SMOKE_OK`。
- 报告只记录 Claude CLI version、exit code、duration、stdout/stderr 文件路径和脱敏说明。

## 当前边界

该 smoke 不证明 OS 级网络隔离。它只验证 Tekon 命令构造、权限模式不 bypass、cwd scope、env 控制、timeout 和日志捕获。
