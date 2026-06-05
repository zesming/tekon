# Donkey

Donkey V2 是本地 Agent workflow 系统的重构分支。当前 `rebuild-v2` 已完成 Phase 3 本地验收，发布范围限定为本地 CLI/Web dashboard、SCM delivery dry-run、metrics、evidence package 和 dogfooding 报告。

## 当前状态

- Phase 2 已验证：`packages/core` 安全可恢复内核、角色系统、workflow 模板、约束校验、动态 workflow dry-run、持久化调度器、Artifact Store、Audit hash chain、GateEngine、HumanGate、Mock Agent 和 Claude Code adapter contract。
- Phase 2 已验证：`packages/cli` 本地命令入口，包括 `init`、`run --template`、`run --dynamic --dry-run`、`status`、`pause`、`resume --approve-human`、`cancel`、`role`、`workflow`、`constraints`、`log`、`clean`。
- Phase 3 已验证：交付 dry-run、delivery evidence、metrics、dogfooding 报告、本地 Web dashboard、Web human approval、CLI/Web release e2e 和最终验收报告。
- 尚未作为已完成能力发布：真实 PR 创建、自动 merge、生产级真实 LLM workflow 执行和远端发布流程。

## 快速开始

仓库使用 `pnpm@10.12.1`。在 Donkey 仓库根目录构建 CLI：

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 build
```

初始化目标仓库：

```bash
node packages/cli/dist/index.js init --repo /path/to/project
```

运行动态 workflow dry-run：

```bash
node packages/cli/dist/index.js run --dynamic --dry-run "给支付模块加退款功能，属于高风险数据变更" --agent mock --repo /path/to/project
```

运行标准模板：

```bash
node packages/cli/dist/index.js run "给示例模块加批量重试" --template standard-feature --agent mock --repo /path/to/project
```

查看状态和日志：

```bash
node packages/cli/dist/index.js status --run-id <runId> --repo /path/to/project
node packages/cli/dist/index.js log --run-id <runId> --repo /path/to/project
```

若存在 pending human gate：

```bash
node packages/cli/dist/index.js resume --run-id <runId> --approve-human --repo /path/to/project
```

按当前实现边界准备交付 dry-run：

```bash
node packages/cli/dist/index.js delivery dry-run --run-id <runId> --repo /path/to/project
```

`delivery dry-run` 只用于生成可审阅的交付命令计划和 evidence 摘要，不代表真实远端分支或 PR 已创建。

启动本地 Web dashboard：

```bash
DONKEY_PROJECT_ROOT=/path/to/project npm exec --yes -- pnpm@10.12.1 --filter @donkey/web dev
```

`donkey init` 会生成 `.donkey/web-session.json`，Web 写操作需要其中的 session token。该文件已被 `.gitignore` 排除，不应提交。

## 本地验证

根测试入口保持为 `vitest`，Vitest 项目发现使用根 `vitest.config.ts` 的 `test.projects`。

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 ignored-builds
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core build
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm run lint:actions
```

Coverage 使用 Vitest 直接参数形式执行；`pnpm test -- --run --coverage` 在当前工具组合下不会输出 coverage 表。

```bash
npm exec --yes -- pnpm@10.12.1 exec vitest --exclude "**/__manual__/**" --run --coverage
```

## 文档入口

- 技术方案：`docs/technical/donkey-v2-technical-plan.html`
- 三阶段实施计划：`docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.md`
- 三阶段实施计划 HTML：`docs/superpowers/plans/2026-06-05-donkey-v2-three-phase-implementation.html`
- Phase 2 CLI 证据报告：`docs/reviews/2026-06-05-donkey-v2-phase2-cli-evidence.md`
- Phase 2 评审记录：`docs/reviews/2026-06-05-donkey-v2-phase2-review.md`
- V2 用户手册：`docs/manual/donkey-v2-user-manual.html`
- Dogfooding 报告：`docs/reviews/2026-06-05-donkey-v2-dogfooding-report.html`
- Final acceptance：`docs/reviews/2026-06-05-donkey-v2-final-acceptance.html`
- 当前 MVP 边界：`docs/manual/donkey-mvp-user-manual.html`

## 发布状态

当前状态是本地 V2 重构验收通过，不是公开生产发布。任何对外说明都应明确：Donkey 现在已可在本地通过 CLI 跑 mock workflow、dynamic dry-run、delivery dry-run 和 Web dashboard human approval；真实 PR 创建、自动 merge 和生产级真实 LLM workflow 仍需后续发布范围确认。
