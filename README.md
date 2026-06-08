# Donkey

Donkey V2 是本地 Agent workflow 系统的重构分支。当前 `rebuild-v2` 已完成 Phase 3 本地验收，并补齐第一批工作可用化闭环：真实 worktree 执行分支、真实 provider artifact manifest 入库、repo profile 驱动 gate 和缺失命令修复引导、provider 快照恢复、PR 准备包、人工批准后的远端 PR 创建、PR 创建后的远端 CI 状态证据和 watch 轮询、Web human approval 自动继续、Web 发起受控 run/prepare/create-pr、语义验收证据、安全扫描、命令日志脱敏、artifact 入库敏感信息拦截、readiness 评估、CLI/Web 审阅面、审阅证据导航、工作可用样本评估、样本记录和评估报告导出。

## 当前状态

- Phase 2 已验证：`packages/core` 安全可恢复内核、角色系统、workflow 模板、约束校验、动态 workflow dry-run、持久化调度器、Artifact Store、Audit hash chain、GateEngine、HumanGate、Mock Agent 和 Claude Code adapter contract。
- Phase 2 已验证：`packages/cli` 本地命令入口，包括 `init`、`run --template`、`run --dynamic --dry-run`、`run --allow-dirty-base`、`status`、`pause`、`resume --approve-human`、`cancel`、`role`、`workflow`、`constraints`、`log`、`clean`。
- Phase 3 已验证：交付 dry-run、delivery evidence、metrics、dogfooding 报告、本地 Web dashboard、Web human approval、audit hash/filter、CLI/Web release e2e 和最终验收报告。
- 工作可用化增量已验证：`repo-profile.yaml` 仓库画像、`workflow preflight` 缺失命令修复引导、模板 `commandRef`、角色 prompt 注入、Claude Code artifact manifest 协议、run provider 快照、真实 git worktree lease 进入 Engine 主执行路径、节点改动推进到 `donkey-delivery/<runId>`、`delivery prepare` PR 准备包、`delivery create-pr --approve-human` 受控创建远端 PR、`delivery ci-status` 只读查询 PR checks 并落库、`delivery ci-watch` 只读轮询 PR checks 直到终态或达到次数上限、`eval readiness` 工作就绪度评估、`eval work-usability --samples` 样本集评估、`eval work-usability record` 样本记录、样本评估 Markdown/HTML 报告导出、命令日志脱敏、artifact 入库敏感信息拦截、`review` 聚合审阅面和 Evidence Navigation、Web approval 后按 provider 快照自动 resume、Web 使用 session token 发起模板 run、执行 PR 准备和触发受控 create-pr。
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

如果某个 `commandRef` 缺失，preflight 会输出 `status=missing`、`profilePath` 和 `hint`；当 `package.json` 中存在 `compile`、`test:e2e` 等候选脚本时，还会输出 `suggestedScript` 和 `suggestedCommand`。用户需要把确认后的命令写入 `.donkey/repo-profile.yaml`；Donkey 不会因命令缺失自动跳过 gate。确实不适用的普通命令 gate 可在 repo profile 中显式配置 `notApplicable: true` 和 `reason`，运行时会记录为 `skipped/not-applicable`，并在 readiness 和 PR 包中可见；`security-scan` 即使没有外部命令仍会执行 Donkey 内置扫描。

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

查询 PR 创建后的远端 CI 状态：

```bash
node packages/cli/dist/index.js delivery ci-status --run-id <runId> --repo /path/to/project
```

`delivery ci-status` 会调用 `gh pr checks <prUrl|branch> --json ...` 只读查询 GitHub PR checks，将 `passed/failed/pending/skipped/unknown` 状态写入 `ci-status` artifact 和 `delivery.ci.checked` 审计事件。它不 rerun CI、不等待 CI、不 merge、不上线；没有已落库 PR URL 时可用 `--selector <prUrl|branch>` 显式指定。

等待 PR checks 进入终态：

```bash
node packages/cli/dist/index.js delivery ci-watch --run-id <runId> --max-attempts 20 --interval-ms 15000 --repo /path/to/project
```

`delivery ci-watch` 会重复执行同一只读 checks 查询，把每次尝试都写入 `ci-status` artifact，并在结束时记录 `delivery.ci.watch-completed` 审计事件。`passed/failed/skipped` 视为终态；`pending/unknown` 会继续等待到次数上限。它只等待和记录结果，不 rerun CI、不 push、不 merge、不上线；可用 `--selector <prUrl|branch>`、`--backoff <multiplier>` 控制查询对象和退避。

检查工作就绪度：

```bash
node packages/cli/dist/index.js eval readiness --run-id <runId> --repo /path/to/project
```

`eval readiness` 会检查 workflow、audit、验证 gate、delivery package、PR 准备包、pending human gate、验收标准证据、安全扫描、PR 创建状态和远端 CI 状态，作为“这次是否可拿去人工审阅/提交”的最小评估面。PR 已创建和远端 CI 通过是推荐项；自动 merge 和上线不在 readiness 范围内。

评估一组真实工作样本是否达到试用门槛：

```bash
node packages/cli/dist/index.js eval work-usability --samples /path/to/work-usability-samples.yaml --repo /path/to/project
```

样本清单会逐个绑定 run id，并按阈值检查 readiness、真实 provider 运行数、真实 PR 数、security scan、worktree 隔离和远端副作用审批。可用 `eval work-usability record --run-id <runId> --samples <path>` 把已完成 run 追加或更新到样本清单；评估时可追加 `--report-md docs/reviews/work-usability.md --report-html docs/reviews/work-usability.html` 生成可提交审阅报告。默认阈值面向正式 dogfooding：10 个样本、5 个 ready run、5 个真实 provider run、2 个真实 PR，并要求所有样本有隔离证据；fixture 或阶段性验收可在清单中显式降低阈值。

聚合审阅面：

```bash
node packages/cli/dist/index.js review --run-id <runId> --repo /path/to/project
```

`review` 会把 readiness 失败项、Evidence Navigation、PR body、PR package、`donkey-delivery/<runId>` diff 摘要、artifact 正文预览、gate 日志预览和建议下一步命令汇总到一个输出中。Evidence Navigation 会把失败项关联到 artifact、gate log、audit event、PR body、PR package 和 diff。若已执行 `delivery ci-status` 或 `delivery ci-watch`，远端 CI 结果会作为 `ci-status` artifact 和 PR 包中的 Remote CI 证据出现。Web dashboard 也使用同一 review surface，展示 Readiness、Evidence Links、Diff、Artifact 正文、Gate Logs、PR 包和下一步命令。

真实 provider 需要遵守 Donkey artifact 协议：在 `DONKEY_OUTPUT_DIR` 写入节点产物，并写 `DONKEY_ARTIFACT_MANIFEST`。Adapter 会校验 manifest 中的 artifact schema 并写入 Artifact Store；缺少必需 artifact 时节点失败，不会继续把 stdout/stderr 当作有效交付证据。

Artifact Store 会在写入前扫描明显密钥模式并拒绝入库；CommandGateway 会在 stdout/stderr 写入日志文件前脱敏。当前规则覆盖 private key、OpenAI-style key、AWS access key 和常见 token/secret assignment。这是最小敏感信息治理，不等于完整 DLP 或生产级密钥平台。

启动本地 Web dashboard：

```bash
DONKEY_PROJECT_ROOT=/path/to/project npm exec --yes -- pnpm@10.12.1 --filter @donkey/web dev
```

`donkey init` 会生成 `.donkey/web-session.json`，Web 写操作需要其中的 session token。该文件已被 `.gitignore` 排除，不应提交。Web dashboard 会展示 human gate 的 request/gate/command/risk 上下文，可用 session token 发起模板 run、执行 `delivery prepare`、触发受人工批准的 `delivery create-pr`，并可在项目 runs 中选择任意 run 审阅 readiness、Evidence Links、diff、artifact 正文、gate logs、PR 包和下一步命令，在审计区展示 hash chain 状态和 node/gate/role 过滤。Web prepare/create-pr 会作用在当前选中的 run 上；与 CLI 一样，create-pr 未批准时只落库等待审批，批准后才产生 push/PR 副作用。

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
- 工作可用样本评估增量：`docs/reviews/2026-06-08-donkey-work-usability-eval-increment.html`
- 工作可用样本沉淀增量：`docs/reviews/2026-06-08-donkey-work-usability-sample-record-increment.html`
- 审阅证据导航增量：`docs/reviews/2026-06-08-donkey-review-evidence-navigation-increment.html`
- 敏感信息治理增量：`docs/reviews/2026-06-08-donkey-secret-governance-increment.html`
- Web 多运行审阅流增量：`docs/reviews/2026-06-08-donkey-web-multirun-review-increment.html`
- 远端 CI 状态证据增量：`docs/reviews/2026-06-08-donkey-remote-ci-status-increment.html`
- 远端 CI watch 增量：`docs/reviews/2026-06-08-donkey-remote-ci-watch-increment.html`
- 历史 MVP 边界：`docs/manual/donkey-mvp-user-manual.html`

## 发布状态

当前状态是本地 V2 重构和工作可用化增量验收通过，不是公开生产发布。任何对外说明都应明确：Donkey 现在已可在本地通过 CLI 跑 mock workflow、Claude Code adapter 协议接线、dynamic dry-run、delivery dry-run、delivery prepare、受人工批准的 delivery create-pr、delivery ci-status 只读查询 GitHub PR checks、delivery ci-watch 只读等待 PR checks 终态、eval readiness、eval work-usability、eval work-usability record、样本评估报告导出、命令日志脱敏、artifact 敏感内容拦截、Web dashboard human approval 和 Web 受控发起 run/prepare/create-pr；自动 merge、自动上线、完整 DLP 和生产级真实 LLM workflow 稳定性仍需后续发布范围确认。
