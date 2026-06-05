# Donkey

Donkey V2 是本地 Agent workflow 系统的重构分支。当前 `rebuild-v2` 已完成阶段二的本地 mock CLI 产品环：core 内核、角色系统、workflow 模板、约束校验、动态 dry-run、持久化调度器和 `donkey` CLI 已可在本地验证。

## 当前状态

- 已可用：`packages/core` TypeScript API，包括 CommandGateway、WorktreeManager、SQLite recovery、Artifact Store、Audit hash chain、GateEngine、HumanGate、Mock Agent、Claude Code adapter contract、角色加载、workflow parser/state machine、constraint validator、dynamic workflow preview 和 durable workflow engine。
- 已可用：`packages/cli` 的本地命令入口，包括 `init`、`run --template`、`run --dynamic --dry-run`、`status`、`pause`、`resume --approve-human`、`cancel`、`role`、`workflow`、`constraints`、`log`、`clean`。
- 暂不可用：Web dashboard、真实 PR 创建、自动 merge、生产级真实 LLM workflow 执行和远端发布流程。

## 本地验证

仓库使用 `pnpm@10.12.1`。根测试入口保持为 `vitest`，Vitest 项目发现已迁移到根 `vitest.config.ts` 的 `test.projects`。

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 ignored-builds
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core build
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm run lint:actions
```

## 文档入口

- 技术方案：`docs/technical/donkey-v2-technical-plan.html`
- 三阶段实施计划：`docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.md`
- 三阶段实施计划 HTML：`docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.html`
- 阶段一评估报告：`docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.md`
- 阶段一评估报告 HTML：`docs/reviews/2026-06-05-donkey-v2-phase1-kernel-evaluation.html`
- 阶段二 CLI 证据报告：`docs/reviews/2026-06-05-donkey-v2-phase2-cli-evidence.md`
- 阶段二评审记录：`docs/reviews/2026-06-05-donkey-v2-phase2-review.md`
- 当前 MVP 边界：`docs/manual/donkey-mvp-user-manual.html`

## 发布状态

当前状态是阶段二本地 mock CLI 验证，不是公开产品发布。任何对外说明都应明确：Donkey 现在可以在本地通过 CLI 跑 mock workflow 和 dynamic dry-run，但还没有 Web dashboard、真实 PR 创建、自动 merge 或生产级真实 LLM workflow 执行。
