# Donkey

Donkey V2 是本地 Agent workflow 系统的重构分支。当前 `rebuild-v2` 已完成 Phase 3 本地验收，并补齐第一批工作可用化闭环：真实 worktree 执行分支、真实 provider artifact manifest 入库、repo profile 驱动 gate、provider 快照恢复、PR 准备包、人工批准后的远端 PR 创建、Web human approval 自动继续、Web 发起受控 run/prepare/create-pr、语义验收证据、安全扫描、readiness 评估和 CLI/Web 审阅面。

## 当前状态

- Phase 2 已验证：`packages/core` 安全可恢复内核、角色系统、workflow 模板、约束校验、动态 workflow dry-run、持久化调度器、Artifact Store、Audit hash chain、GateEngine、HumanGate、Mock Agent 和 Claude Code adapter contract。
- Phase 2 已验证：`packages/cli` 本地命令入口，包括 `init`、`run --template`、`run --dynamic --dry-run`、`run --allow-dirty-base`、`status`、`pause`、`resume --approve-human`、`cancel`、`role`、`workflow`、`constraints`、`log`、`clean`。
- Phase 3 已验证：交付 dry-run、delivery evidence、metrics、dogfooding 报告、本地 Web dashboard、Web human approval、audit hash/filter、CLI/Web release e2e 和最终验收报告。
- 工作可用化增量已验证：`repo-profile.yaml` 仓库画像、`workflow preflight`、模板 `commandRef`、角色 prompt 注入、Claude Code artifact manifest 协议、run provider 快照、真实 git worktree lease 进入 Engine 主执行路径、节点改动推进到 `donkey-delivery/<runId>`、`delivery prepare` PR 准备包、`delivery create-pr --approve-human` 受控创建远端 PR、`eval readiness` 工作就绪度评估、`review` 聚合审阅面、Web approval 后按 provider 快照自动 resume、Web 使用 session token 发起模板 run、执行 PR 准备和触发受控 create-pr。
- 尚未作为已完成能力发布：自动 merge、自动上线、动态 workflow 非 dry-run、生产级真实 LLM workflow 稳定性、生产级 OS 沙箱和远程多租户服务。

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

查看模板将使用哪些仓库命令：

```bash
node packages/cli/dist/index.js workflow preflight standard-feature --repo /path/to/project
```

运行动态 workflow dry-run：

```bash
node packages/cli/dist/index.js run --dynamic --dry-run "给支付模块加退款功能，属于高风险数据变更" --agent mock --repo /path/to/project
```

运行标准模板：

```bash
node packages/cli/dist/index.js run "给示例模块加批量重试" --template standard-feature --agent mock --repo /path/to/project
```

默认情况下，模板运行会拒绝带有实际本地改动的 dirty base；确认要基于当前未提交改动执行时显式追加 `--allow-dirty-base`。

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

生成本地 PR 准备包：

```bash
node packages/cli/dist/index.js delivery prepare --run-id <runId> --repo /path/to/project
```

`delivery prepare` 会在 `.donkey/runs/<runId>/delivery/` 下生成 `pr-package.md` 和 `pr-body.md`，并记录 `delivery.pr-prepared` 审计事件。它仍不 push、不创建远端 PR。

人工批准后创建远端 PR：

```bash
node packages/cli/dist/index.js delivery create-pr --run-id <runId> --approve-human --repo /path/to/project
```

`delivery create-pr` 会要求主工作区除 `.donkey` 外没有未提交改动，然后直接 push 本地交付分支并调用 `gh pr create --body-file`。不带 `--approve-human` 时只落库为 `awaiting-approval`；带 `--approve-human` 后才执行 push/PR 副作用。若 `gh pr create` 因 PR 已存在失败，会尝试用 `gh pr view` 恢复 PR URL 并落库。

检查工作就绪度：

```bash
node packages/cli/dist/index.js eval readiness --run-id <runId> --repo /path/to/project
```

`eval readiness` 会检查 workflow、audit、验证 gate、delivery package、PR 准备包、pending human gate、验收标准证据、安全扫描和 PR 创建状态，作为“这次是否可拿去人工审阅/提交”的最小评估面。PR 已创建是推荐项；自动 merge 和上线不在 readiness 范围内。

聚合审阅面：

```bash
node packages/cli/dist/index.js review --run-id <runId> --repo /path/to/project
```

`review` 会把 readiness 失败项、PR body、PR package、`donkey-delivery/<runId>` diff 摘要、artifact 正文预览、gate 日志预览和建议下一步命令汇总到一个输出中。Web dashboard 也使用同一 review surface，展示 Readiness、Diff、Artifact 正文、Gate Logs、PR 包和下一步命令。

真实 provider 需要遵守 Donkey artifact 协议：在 `DONKEY_OUTPUT_DIR` 写入节点产物，并写 `DONKEY_ARTIFACT_MANIFEST`。Adapter 会校验 manifest 中的 artifact schema 并写入 Artifact Store；缺少必需 artifact 时节点失败，不会继续把 stdout/stderr 当作有效交付证据。

启动本地 Web dashboard：

```bash
DONKEY_PROJECT_ROOT=/path/to/project npm exec --yes -- pnpm@10.12.1 --filter @donkey/web dev
```

`donkey init` 会生成 `.donkey/web-session.json`，Web 写操作需要其中的 session token。该文件已被 `.gitignore` 排除，不应提交。Web dashboard 会展示 human gate 的 request/gate/command/risk 上下文，可用 session token 发起模板 run、执行 `delivery prepare`、触发受人工批准的 `delivery create-pr`，并在审阅区展示 readiness、diff、artifact 正文、gate logs、PR 包和下一步命令，在审计区展示 hash chain 状态和 node/gate/role 过滤。Web create-pr 与 CLI 一样仍会在未批准时只落库等待审批，批准后才产生 push/PR 副作用。

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
- 历史 MVP 边界：`docs/manual/donkey-mvp-user-manual.html`

## 发布状态

当前状态是本地 V2 重构和工作可用化增量验收通过，不是公开生产发布。任何对外说明都应明确：Donkey 现在已可在本地通过 CLI 跑 mock workflow、Claude Code adapter 协议接线、dynamic dry-run、delivery dry-run、delivery prepare、受人工批准的 delivery create-pr、eval readiness、Web dashboard human approval 和 Web 受控发起 run/prepare/create-pr；自动 merge、自动上线和生产级真实 LLM workflow 稳定性仍需后续发布范围确认。
