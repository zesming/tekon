# Donkey

Donkey V2 是本地 Agent workflow 系统的重构分支。当前 `rebuild-v2` 已完成阶段一 core 内核；还没有面向终端用户的 CLI 或 Web 产品入口。

## 当前状态

- 已可用：`packages/core` TypeScript API，包括 CommandGateway、WorktreeManager、SQLite recovery、Artifact Store、Audit hash chain、GateEngine、HumanGate、Mock Agent、Claude Code adapter contract。
- 暂不可用：`donkey` CLI 命令、Web dashboard、自动 PR 创建、动态 workflow 产品流、面向用户的项目初始化入口。

## 本地验证

仓库使用 `pnpm@10.12.1`。根测试入口保持为 `vitest`，Vitest 项目发现已迁移到根 `vitest.config.ts` 的 `test.projects`。

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 ignored-builds
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
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
- 当前 MVP 边界：`docs/manual/donkey-mvp-user-manual.html`

## 发布状态

当前状态是阶段一内核验证后的发布就绪加固，不是公开产品发布。任何对外说明都应明确：Donkey 现在只有核心库 API，没有 CLI/Web/自动 PR/普通用户入口。
