# 天工（Tekon）

天工（Tekon，取 Tech + Kong 的融合谐音）V2 是本地 Agent workflow 系统的重构分支。当前 `rebuild-v2` 已完成 Phase 3 本地验收，并补齐第一批工作可用化闭环：需求塑形与人工批准入口、受控 workflow selection、真实 worktree 执行分支、真实 provider artifact manifest 入库、repo profile 驱动 gate 和缺失命令修复引导、provider 快照恢复、PR 准备包、人工批准后的远端 PR 创建、PR 创建后的远端 CI 状态证据和 watch 轮询、Web human approval 自动继续、CLI/Web 审批摘要、Web 发起受控 run/prepare/create-pr、语义验收证据、安全扫描、命令日志脱敏、artifact 入库敏感信息拦截、readiness 评估、CLI/Web 审阅面、审阅证据导航、工作可用样本评估、样本记录和评估报告导出。

## 当前状态

- Phase 2 已验证：`packages/core` 安全可恢复内核、角色系统、workflow 模板、约束校验、动态 workflow dry-run、持久化调度器、Artifact Store、Audit hash chain、GateEngine、HumanGate、Mock Agent 和 Claude Code adapter contract。
- Phase 2 已验证：`packages/cli` 本地命令入口，包括 `init`、`run --template`、`run --dynamic --dry-run`、`run --allow-dirty-base`、`status`、`pause`、`resume --approve-human`、`cancel`、`role`、`workflow`、`constraints`、`log`、`clean`。
- Phase 3 已验证：交付 dry-run、delivery evidence、metrics、dogfooding 报告、本地 Web dashboard、Web human approval、audit hash/filter、CLI/Web release e2e 和最终验收报告。
- 工作可用化增量已验证：`demand shape/approve` 需求塑形、默认写入需求卡、`run` 默认读取最近需求卡并要求先批准、CLI 自动发现当前 repo/latest run/latest pending decision、`workflow select` 受控模板推荐、`eval demand-shape` 和 `eval workflow-selection` 需求/模板质量评估、`repo-profile.yaml` 仓库画像、`workflow preflight` 缺失命令修复引导、模板 `commandRef`、角色 prompt 注入、Claude Code artifact manifest 协议、run provider 快照、真实 git worktree lease 进入 Engine 主执行路径、节点改动推进到 `tekon-delivery/<runId>`、`delivery prepare` PR 准备包、`delivery create-pr --approve-human` 受控创建远端 PR、`delivery ci-status` 只读查询 PR checks 并落库、`delivery ci-watch` 只读轮询 PR checks 直到终态或达到次数上限、`approval summary` 可复制审批摘要、`approval reject` CLI 拒绝入口、`eval approval-summary` 审批摘要质量评估、`eval readiness` 工作就绪度评估、`eval work-usability --samples` 样本集评估、`eval work-usability record` 样本记录、样本评估 Markdown/HTML 报告导出、命令日志脱敏、artifact 入库敏感信息拦截、`review` 聚合审阅面、Evidence Navigation 和 Gate Failure Triage、Web approval 后按 provider 快照自动 resume、Web 使用 session token 发起模板 run、执行 PR 准备和触发受控 create-pr。
- 尚未作为已完成能力发布：自动 merge、自动上线、动态 workflow 非 dry-run、生产级真实 LLM workflow 稳定性、生产级 OS 沙箱和远程多租户服务。

## 快速开始

仓库使用 `pnpm@10.12.1`。在 Tekon 仓库根目录构建 CLI：

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 build
```

以下示例假设 `tekon` 已在 PATH 中，并且命令都在目标仓库根目录执行。若在 Tekon 源码仓库中调试，可用 `node /path/to/tekon/packages/cli/dist/index.js` 替换 `tekon`；只有跨仓库操作时才需要额外传 `--repo /path/to/project`。

初始化目标仓库：

```bash
cd /path/to/project
tekon init
```

查看模板将使用哪些仓库命令：

```bash
tekon workflow preflight
```

如果某个 `commandRef` 缺失，preflight 会输出 `status=missing`、`profilePath` 和 `hint`；当 `package.json` 中存在 `compile`、`test:e2e` 等候选脚本时，还会输出 `suggestedScript` 和 `suggestedCommand`。用户需要把确认后的命令写入 `.tekon/repo-profile.yaml`；Tekon 不会因命令缺失自动跳过 gate。确实不适用的普通命令 gate 可在 repo profile 中显式配置 `notApplicable: true` 和 `reason`，运行时会记录为 `skipped/not-applicable`，并在 readiness 和 PR 包中可见；`security-scan` 即使没有外部命令仍会执行 Tekon 内置扫描。

为需求选择受控模板：

```bash
tekon workflow select "补齐 CLI 的单元测试覆盖，要求 test 通过"
tekon eval workflow-selection "补齐 CLI 的单元测试覆盖，要求 test 通过" --template test-improvement
```

当前内置模板包括 `standard-feature`、`bugfix`、`test-improvement`、`docs-update` 和 `plan-only`。`workflow select` 只做确定性推荐和解释，不会自动生成动态 workflow；如果人工选择了不同模板，`eval workflow-selection` 会把推荐模板与所选模板不一致作为失败项暴露出来。

运行动态 workflow dry-run：

```bash
tekon run --dynamic --dry-run "给支付模块加退款功能，属于高风险数据变更" --agent mock
```

运行标准模板：

```bash
tekon run "给示例模块加批量重试" --template standard-feature --agent mock
```

默认情况下，模板运行会拒绝带有实际本地改动的 dirty base；确认要基于当前未提交改动执行时显式追加 `--allow-dirty-base`。

在真实工作前先塑形需求：

```bash
tekon demand shape "给 Web dashboard 增加需求塑形入口，要求 e2e 通过"
tekon demand approve
tekon eval demand-shape
tekon run --agent mock
```

`demand shape` 会默认生成 `.tekon/demands/<shapeId>.json` 和同名 Markdown 审阅稿，包含分类、推荐模板、风险标签、非目标、开放问题和验收标准。`demand approve` 默认批准最近需求卡；如果最近需求卡已经批准，Tekon 会要求你显式传 `--shape <path>` 才能处理历史未批准需求卡。`run` 在没有需求文本时默认读取最近需求卡，且该需求卡必须已批准。若最近需求卡尚未批准，Tekon 会要求先批准，不会静默跳过它去运行更旧的需求卡。需要复现历史需求卡或跨仓库操作时，再显式传 `--shape`、`--demand-file` 或 `--repo`。

查看状态和日志：

```bash
tekon status
tekon log
```

若存在 pending human gate：

```bash
tekon approval summary
tekon eval approval-summary
tekon resume --approve-human
tekon approval reject
```

`approval summary` 会生成可复制审批摘要，包含 decision/run/node、需求标题、风险、human gate、exact command、影响文件状态、readiness 失败项、证据入口，以及批准/拒绝/Web 处理入口。`eval approval-summary` 会检查摘要是否具备风险、命令、影响、证据、批准和拒绝入口。`approval reject` 会把 pending human decision 标记为 rejected，并把 workflow 阻断；它不会继续执行后续节点。如果同一 run 同时存在多个 pending decision，Tekon 会要求显式传 `--decision-id`，避免短命令误处理。需要记录具体操作者时，可额外传入真实账号或姓名。

按当前实现边界准备交付 dry-run：

```bash
tekon delivery dry-run
```

`delivery dry-run` 只用于生成可审阅的交付命令计划和 evidence 摘要，不代表真实远端分支或 PR 已创建。

生成本地 PR 准备包：

```bash
tekon delivery prepare
```

`delivery prepare` 会在 `.tekon/runs/<runId>/delivery/` 下生成 `pr-package.md` 和 `pr-body.md`，并记录 `delivery.pr-prepared` 审计事件。它仍不 push、不创建远端 PR。

人工批准后创建远端 PR：

```bash
tekon delivery create-pr --approve-human
```

`delivery create-pr` 会要求主工作区除 `.tekon` 外没有未提交改动，然后直接 push 本地交付分支并调用 `gh pr create --body-file`。不带 `--approve-human` 时只落库为 `awaiting-approval`；带 `--approve-human` 后才执行 push/PR 副作用。若 `gh pr create` 因 PR 已存在失败，会尝试用 `gh pr view` 恢复 PR URL 并落库。

查询 PR 创建后的远端 CI 状态：

```bash
tekon delivery ci-status
```

`delivery ci-status` 会调用 `gh pr checks <prUrl|branch> --json ...` 只读查询 GitHub PR checks，将 `passed/failed/pending/skipped/unknown` 状态写入 `ci-status` artifact 和 `delivery.ci.checked` 审计事件。它不 rerun CI、不等待 CI、不 merge、不上线；没有已落库 PR URL 时可用 `--selector <prUrl|branch>` 显式指定。

等待 PR checks 进入终态：

```bash
tekon delivery ci-watch --max-attempts 20 --interval-ms 15000
```

`delivery ci-watch` 会重复执行同一只读 checks 查询，把每次尝试都写入 `ci-status` artifact，并在结束时记录 `delivery.ci.watch-completed` 审计事件。`passed/failed/skipped` 视为终态；`pending/unknown` 会继续等待到次数上限。它只等待和记录结果，不 rerun CI、不 push、不 merge、不上线；可用 `--selector <prUrl|branch>`、`--backoff <multiplier>` 控制查询对象和退避。

检查工作就绪度：

```bash
tekon eval readiness
```

`eval readiness` 会检查 workflow、audit、验证 gate、delivery package、PR 准备包、pending human gate、验收标准证据、安全扫描、PR 创建状态和远端 CI 状态，作为“这次是否可拿去人工审阅/提交”的最小评估面。PR 已创建和远端 CI 通过是推荐项；自动 merge 和上线不在 readiness 范围内。

评估一组真实工作样本是否达到试用门槛：

```bash
tekon eval work-usability --samples /path/to/work-usability-samples.yaml
```

样本清单会逐个绑定 run id，并按阈值检查 readiness、真实 provider 运行数、真实 PR 数、security scan、worktree 隔离和远端副作用审批。可用 `eval work-usability record --samples <path>` 把最近一次 run 追加或更新到样本清单；评估时可追加 `--report-md docs/reviews/work-usability.md --report-html docs/reviews/work-usability.html` 生成可提交审阅报告。默认阈值面向正式 dogfooding：10 个样本、5 个 ready run、5 个真实 provider run、2 个真实 PR，并要求所有样本有隔离证据；fixture 或阶段性验收可在清单中显式降低阈值。

聚合审阅面：

```bash
tekon review
```

`review` 会把 readiness 失败项、Evidence Navigation、Gate Failure Triage、PR body、PR package、`tekon-delivery/<runId>` diff 摘要、artifact 正文预览、gate 日志预览和建议下一步命令汇总到一个输出中。Evidence Navigation 会把失败项关联到 artifact、gate log、audit event、PR body、PR package 和 diff；Gate Failure Triage 会给失败 gate 标注分类、日志锚点、重试建议和建议命令。若已执行 `delivery ci-status` 或 `delivery ci-watch`，远端 CI 结果会作为 `ci-status` artifact 和 PR 包中的 Remote CI 证据出现。Web dashboard 也使用同一 review surface，展示 Readiness、Evidence Links、Gate Failure Triage、Diff、Artifact 正文、Gate Logs、PR 包和下一步命令。

真实 provider 需要遵守 Tekon artifact 协议：在 `TEKON_OUTPUT_DIR` 写入节点产物，并写 `TEKON_ARTIFACT_MANIFEST`。Adapter 会校验 manifest 中的 artifact schema 并写入 Artifact Store；缺少必需 artifact 时节点失败，不会继续把 stdout/stderr 当作有效交付证据。

Artifact Store 会在写入前扫描明显密钥模式并拒绝入库；CommandGateway 会在 stdout/stderr 写入日志文件前脱敏。当前规则覆盖 private key、OpenAI-style key、AWS access key 和常见 token/secret assignment。这是最小敏感信息治理，不等于完整 DLP 或生产级密钥平台。

启动本地 Web dashboard：

```bash
TEKON_PROJECT_ROOT=/path/to/project npm exec --yes -- pnpm@10.12.1 --filter @tekon/web dev
```

`tekon init` 会生成 `.tekon/web-session.json`，Web 写操作需要其中的 session token。该文件已被 `.gitignore` 排除，不应提交。Web dashboard 会展示 human gate 的 request/gate/command/risk 上下文，可用 session token 塑形并批准需求、发起模板 run、执行 `delivery prepare`、触发受人工批准的 `delivery create-pr`，并可在项目 runs 中选择任意 run 审阅 readiness、Evidence Links、diff、artifact 正文、gate logs、PR 包和下一步命令，在审计区展示 hash chain 状态和 node/gate/role 过滤。Web prepare/create-pr 会作用在当前选中的 run 上；与 CLI 一样，create-pr 未批准时只落库等待审批，批准后才产生 push/PR 副作用。

## 本地验证

根测试入口保持为 `vitest`，Vitest 项目发现使用根 `vitest.config.ts` 的 `test.projects`。

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 ignored-builds
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @tekon/cli test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @tekon/web test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core build
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm run lint:actions
```

Coverage 使用 Vitest 直接参数形式执行；`pnpm test -- --run --coverage` 在当前工具组合下不会输出 coverage 表。

```bash
npm exec --yes -- pnpm@10.12.1 exec vitest --exclude "**/__manual__/**" --run --coverage
```

## 文档入口

- 主用户使用手册：`docs/manual/tekon-user-manual.md`
- 技术方案：`docs/technical/tekon-v2-technical-plan.html`
- 三阶段实施计划：`docs/superpowers/plans/2026-06-05-tekon-v2-three-phase-implementation.md`
- 三阶段实施计划 HTML：`docs/superpowers/plans/2026-06-05-tekon-v2-three-phase-implementation.html`
- Phase 2 CLI 证据报告：`docs/reviews/2026-06-05-tekon-v2-phase2-cli-evidence.md`
- Phase 2 评审记录：`docs/reviews/2026-06-05-tekon-v2-phase2-review.md`
- V2 用户手册：`docs/manual/tekon-v2-user-manual.html`
- Dogfooding 报告：`docs/reviews/2026-06-05-tekon-v2-dogfooding-report.html`
- Final acceptance：`docs/reviews/2026-06-05-tekon-v2-final-acceptance.html`
- 工作可用样本评估增量：`docs/reviews/2026-06-08-tekon-work-usability-eval-increment.html`
- 工作可用样本沉淀增量：`docs/reviews/2026-06-08-tekon-work-usability-sample-record-increment.html`
- 审阅证据导航增量：`docs/reviews/2026-06-08-tekon-review-evidence-navigation-increment.html`
- 敏感信息治理增量：`docs/reviews/2026-06-08-tekon-secret-governance-increment.html`
- Web 多运行审阅流增量：`docs/reviews/2026-06-08-tekon-web-multirun-review-increment.html`
- 远端 CI 状态证据增量：`docs/reviews/2026-06-08-tekon-remote-ci-status-increment.html`
- 远端 CI watch 增量：`docs/reviews/2026-06-08-tekon-remote-ci-watch-increment.html`
- Gate 失败诊断增量：`docs/reviews/2026-06-08-tekon-gate-failure-triage-increment.html`
- 需求塑形入口增量：`docs/reviews/2026-06-08-tekon-demand-shaping-increment.html`
- 受控 workflow selection 增量：`docs/reviews/2026-06-08-tekon-workflow-selection-increment.html`
- 审批摘要增量：`docs/reviews/2026-06-08-tekon-approval-summary-increment.html`
- 历史 MVP 边界：`docs/manual/tekon-mvp-user-manual.html`

## 发布状态

当前状态是本地 V2 重构和工作可用化增量验收通过，不是公开生产发布。任何对外说明都应明确：Tekon 现在已可在本地通过 CLI 跑 mock workflow、需求塑形和人工批准、受控 workflow selection、Claude Code adapter 协议接线、dynamic dry-run、delivery dry-run、delivery prepare、受人工批准的 delivery create-pr、delivery ci-status 只读查询 GitHub PR checks、delivery ci-watch 只读等待 PR checks 终态、approval summary、approval reject、eval approval-summary、eval demand-shape、eval workflow-selection、eval readiness、eval work-usability、eval work-usability record、样本评估报告导出、命令日志脱敏、artifact 敏感内容拦截、Web dashboard human approval/审批摘要和 Web 受控发起 run/prepare/create-pr；自动 merge、自动上线、完整 DLP 和生产级真实 LLM workflow 稳定性仍需后续发布范围确认。
