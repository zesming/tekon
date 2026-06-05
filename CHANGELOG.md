# 变更日志

## 未发布

### 新增

- 阶段一 `@donkey/core` 安全可恢复内核。
- GitHub Actions core validation workflow 和 native dependency build gate。
- actionlint workflow validation。
- README 和当前 MVP 边界手册。

### 变更

- Vitest 配置从旧 workspace 文件迁移到 `vitest.config.ts` 的 `test.projects`。
- 建立 `.prettierrc.json`，让全仓 `prettier --check .` 成为可执行的发布 gate。

### 修复

- CommandGateway 不再在无 stdin 时写入空 chunk；显式 stdin 写失败、子进程异步 `error` 事件、命令日志写入失败和忽略 `SIGTERM` 的 timeout 场景会返回受控结果，降低快速退出命令触发 `EPIPE`、promise 悬挂或丢失执行证据的风险。

### 说明

- Donkey 尚未发布面向终端用户的 CLI、Web dashboard 或自动 PR 创建流程。
- 当前没有普通用户入口，主要可执行对象仍是 `packages/core` 的测试、类型检查和构建。

### 已验证

- 发布就绪加固本地 gate 已通过。
- 代码完成提交的远端 Core workflow 已通过。
- Claude provider 手动 smoke 已在认证本地环境通过。
- 最高思考等级 subagent review 已通过，未检出剩余必须修复项。
