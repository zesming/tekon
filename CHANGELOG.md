# 变更日志

## 未发布

### 新增

- 阶段一 `@donkey/core` 安全可恢复内核。
- GitHub Actions core validation workflow 和 native dependency build gate。
- actionlint workflow validation。
- README 和当前 MVP 边界手册。
- 阶段二角色文件系统、内置 `pm/rd/qa/reviewer/pmo` 角色、workflow 模板、constraint validator、dynamic workflow dry-run 和 durable workflow engine。
- `@donkey/cli` 本地 CLI 包，支持 `init/run/status/pause/resume/cancel/role/workflow/constraints/log/clean` 的 mock 验证路径。
- Phase 2 CLI evidence 和 review HTML 审阅文档。

### 变更

- Vitest 配置从旧 workspace 文件迁移到 `vitest.config.ts` 的 `test.projects`。
- 建立 `.prettierrc.json`，让全仓 `prettier --check .` 成为可执行的发布 gate。
- `@donkey/core test:e2e` 覆盖 workflow engine、recovery、gate repair 和 dynamic constraint e2e。

### 修复

- CommandGateway 不再在无 stdin 时写入空 chunk；显式 stdin 写失败、子进程异步 `error` 事件、命令日志写入失败和忽略 `SIGTERM` 的 timeout 场景会返回受控结果，降低快速退出命令触发 `EPIPE`、promise 悬挂或丢失执行证据的风险。

### 说明

- Donkey 已有本地 mock CLI 入口，但仍未发布 Web dashboard、真实 PR 创建、自动 merge 或生产级真实 LLM workflow。
- 当前 CLI 主要用于本地验收和研发 dogfooding，真实远端交付能力仍在 Phase 3 范围内。

### 已验证

- 发布就绪加固本地 gate 已通过。
- 代码完成提交的远端 Core workflow 已通过。
- Claude provider 手动 smoke 已在认证本地环境通过。
- 最高思考等级 subagent review 已通过，未检出剩余必须修复项。
- Phase 2 本地 gate 已通过：`pnpm build`、`pnpm typecheck`、`pnpm test -- --run`、`@donkey/core test:e2e`、`@donkey/cli test:e2e`、`prettier --check .`。
