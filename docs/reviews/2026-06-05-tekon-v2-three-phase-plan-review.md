# Tekon V2 三阶段实施计划审阅记录

## 审阅对象

- `docs/technical/tekon-v2-technical-plan.md`
- `docs/superpowers/plans/2026-06-05-tekon-v2-phase1-implementation.md`（旧计划对照）
- `docs/superpowers/plans/2026-06-05-tekon-v2-three-phase-implementation.md`
- `docs/superpowers/plans/2026-06-05-tekon-v2-three-phase-implementation.html`

## Reviewer 结论

最高思考等级 reviewer 结论：**有条件通过**。

Reviewer 判断新三阶段计划明显比旧计划更可落地，旧计划中的关键阻断点已经被前置拆分到阶段一，包括：

- Tool Gateway / 权限边界
- Git Worktree 隔离
- SQLite 可恢复状态
- GateResult 与 HumanGate
- Artifact Store 与 Audit hash chain
- Dynamic Workflow 与 PR Delivery

## 必须修复项

1. **pnpm filter 命令语法不正确**
   - 问题：原计划写成 `pnpm test --filter @tekon/core` 和 `pnpm build --filter @tekon/core`，容易把 `--filter` 传给脚本而不是 pnpm 包过滤器。
   - 修复：统一改为 `pnpm --filter @tekon/core test -- --run`、`pnpm --filter @tekon/core build`、`pnpm --filter @tekon/cli test -- --run`。

2. **WorktreeManager 与 CommandGateway 顺序/边界需写死**
   - 问题：原计划中 WorktreeManager 在 CommandGateway 前实现，容易让 worker 先实现裸 `spawn`/`execFile`。
   - 修复：将 CommandGateway 调整为 Task 5，WorktreeManager 调整为 Task 6；明确 WorktreeManager 的 `git worktree add/remove/prune` 必须通过 CommandGateway argv 命令执行，禁止直接调用 `spawn`、`execFile`、`exec`、`execSync`。

## 建议修复项处理

- 已在 Task 7 增加 provider capability check：真实 AgentAdapter 若不能证明 sandbox、approval、filesystem scope、network scope、tool allow/deny 的映射，必须拒绝真实执行，只能 mock 或 dry-run。
- 已在 Scope Decisions 中说明实现替代和降级：
  - Schema Gate 第一版使用 Zod schema，AJV/JSON Schema 兼容导出后续补。
  - 真实 PR 创建依赖 GitHub CLI 认证和远程仓库权限；无认证或高风险仓库降级为 `--delivery dry-run`。
  - `<date>` 是未来审阅文件命名模板变量，不是未完成实现或敏感信息。
- 已在 HTML 审阅版增加“执行细节索引”，指向全局验收门槛、文件结构、逐任务文件路径和执行交接。

## 复查结论

必须修复项已处理。当前计划可以作为 Tekon V2 重构执行基线。

建议进入重构前的执行顺序：

1. 以新三阶段计划替代旧 Phase 1 plan 作为主执行计划。
2. 从阶段一 Task 1 开始执行；阶段一不允许跳过 CommandGateway、WorktreeManager、SQLite recovery、Gate/HumanGate。
3. 每个 task 完成后按仓库指令启动最高思考等级 reviewer 复查。
