# Standard Delivery Governance Bootstrap 归档

日期：2026-06-11
分支：`tekon-standard-delivery-full-bootstrap`
结论：本轮把 `standard-delivery` 从种子模板推进到可运行的标准交付治理模板，并使用 mock provider 完成 Tekon 自身需求的本地治理链路自举验证。真实 PR 创建不在自举 run 内自动执行，将由本分支最终 PR 完成。

## 1. 范围

本轮落地能力：

- 新 artifact：`demand-review`、`implementation-plan`、`requirement-interface-review`、`technical-review`、`code-review`、`test-plan`、`test-plan-review`、`ac-evidence`、`qa-release-signoff`、`qa-release-signoff-review`、`process-checkpoint`。
- 新 gate：`independent-review`、`role-scope`、`ac-evidence`、`qa-signoff`、`process-completeness`。
- `standard-delivery` workflow：PM 内审、PM 外部需求意图评审、RD/QA 需求接口评审、RD 技术评审、QA 测试方案评审、PM 测试意图评审、独立变更评审、QA 验收、QA release signoff、QA signoff review、PMO checkpoint。
- 交付证据：AC evidence、QA release signoff、CI status、PR package、readiness 汇总。
- 过程治理：非 `code-changes` 节点源码变更 guard、QA validation tested ref 审计、逐节点 `pmo.node-checkpoint` 审计、审批 note 脱敏、PR 创建前置只读 probe 统一走 CommandGateway。
- PR 前置边界：`delivery prepare` 和 `delivery create-pr` 共享 pre-PR readiness，要求 workflow passed、无 pending human gate、验证 gate/安全扫描满足、AC evidence 完整、QA release signoff 通过且绑定 QA validation tested ref；SCM 写命令使用 exact allow，delivery branch/base branch 做安全 ref 校验。
- 长程任务：真实 provider 和受控 `delivery create-pr` 的 `git/gh` 命令默认 1 小时总超时、15 分钟无 stdout/stderr 进展超时，CommandGateway 输出 `*.progress.json`；CLI `run` 与 Web dashboard 可显式覆盖总超时、无进展超时和 heartbeat，支持 2 小时以上长程任务预算。
- Gate 身份：gate result 持久化 `gateKey`，同一节点下多个 `schema` 等同类型 gate 会按 artifact/commandRef 区分；PMO checkpoint 的 gate evidence 也记录 `gateKey`，避免重复 gate 被跳过或误判为已通过；human gate 审批更新原始 gate result 并保留 gateKey，不再创建无 key 的 resume gate。
- 常规模板：`standard-feature`、`bugfix`、`test-improvement`、`docs-update` 补齐 `qa-release-signoff` 输出和 gate。

## 2. 自举运行

最新通过 run：

```text
runId=run_c1cc3995-a8fc-45ac-a4fe-408eba1b9b50 repo=/Users/zhaoensheng/Projects/tekon status=passed currentNode=none gates=41 artifacts=19 pendingHumanDecisions=0
```

Readiness：

```text
runId=run_c1cc3995-a8fc-45ac-a4fe-408eba1b9b50 ready=false score=0.73 prCreated=false prUrl= failed=pr-prepared,pr-created,remote-ci-passed
```

判断：

- 该 run 使用 mock provider，验证对象是标准治理模板、artifact/gate 协议和本地 gate 闭环，不宣称真实 Codex/provider 端到端已完成。
- workflow、artifact schema、独立评审、角色范围、AC evidence、QA signoff、PMO process completeness、逐节点 PMO checkpoint 和非 code 节点源码 guard 均已在本地自举 run 或目标测试内通过。
- readiness 仍为 false 是预期结果，因为该 run 明确不在内部创建远端 PR，也未记录远端 CI。
- 本分支创建真实 PR 后，可再补远端 PR URL、CI 结果和 `delivery ci-status` 证据。

## 3. 失败样本

已知失败 run：

| Run ID                                     | 状态        | 原因                                                            |
| ------------------------------------------ | ----------- | --------------------------------------------------------------- |
| `run_04b37267-2686-42c6-a0a4-9b37410f65f7` | interrupted | 早期 RD Codex 节点 300 秒超时，任务粒度过大，无 manifest 入库。 |
| `run_86811b0c-6b23-40f3-8dab-b07faf4df826` | blocked     | 旧测试仍断言 9 个 artifact，未适配标准流程新增 artifact。       |
| `run_7c85825c-fbf3-4abb-8416-9c0f1af2e61c` | blocked     | 慢测试阈值不足，非标准交付 gate 语义失败。                      |
| `run_13e73649-9a67-4520-9444-e748260c6a26` | blocked     | 慢测试阈值不足，非标准交付 gate 语义失败。                      |
| `run_c174ef64-0ec4-4083-9e2f-8c1426a79751` | blocked     | 慢测试阈值不足，非标准交付 gate 语义失败。                      |

## 4. 长程任务证据

最新通过 run 中的命令 progress 文件显示：

| 命令                                                 | 状态      | elapsedMs | timeoutMs | stdoutBytes | stderrBytes |
| ---------------------------------------------------- | --------- | --------: | --------: | ----------: | ----------: |
| `pnpm --dir /Users/zhaoensheng/Projects/tekon build` | completed |      1724 |     60000 |         848 |           0 |
| `pnpm --dir /Users/zhaoensheng/Projects/tekon lint`  | completed |      1839 |     60000 |         324 |           0 |
| `pnpm --dir /Users/zhaoensheng/Projects/tekon test`  | completed |     28704 |     60000 |        8751 |       38050 |

补充判断：

- 该 run 的三条 gate 命令均短于默认 60 秒 heartbeat 间隔，因此 heartbeatCount 为 0 是合理现象。
- `packages/core/__tests__/runtime/command-gateway.test.ts` 使用 10ms heartbeat 间隔验证了长命令会写入 heartbeat evidence。
- 1 小时默认总超时合理，2 小时以上应只作为 `run` 的显式配置，并保留 no-progress timeout；manifest mtime、artifact count、diff 变化和可恢复 job runner 仍是后续增强。

## 5. 本地验证

已通过命令：

```bash
pnpm test
pnpm vitest run packages/cli/__tests__/run-cli.test.ts
pnpm build
pnpm lint
pnpm --filter @tekon/web test:e2e
node packages/cli/dist/index.js workflow show standard-delivery --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js workflow preflight standard-delivery --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js status --run-id run_c1cc3995-a8fc-45ac-a4fe-408eba1b9b50 --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js eval readiness --run-id run_c1cc3995-a8fc-45ac-a4fe-408eba1b9b50 --repo /Users/zhaoensheng/Projects/tekon
git diff --check
git diff --check origin/main
```

关键输出：

- `pnpm test`：58 个 test files passed，332 个 tests passed。
- `pnpm vitest run packages/cli/__tests__/run-cli.test.ts`：1 个 test file passed，12 个 tests passed。
- `pnpm build`：core、cli、web build passed。
- `pnpm lint`：core、cli、web typecheck passed。
- `pnpm --filter @tekon/web test:e2e`：2 个 Playwright tests passed。
- `workflow show standard-delivery`：`id=standard-delivery`，`phases=13`。
- `workflow preflight standard-delivery`：build/lint/test/security commandRef resolved；schema 和 semantic gate 显示 `status=not-command-gate`，不再误报 command missing，也不再和 repo profile 的 `not-applicable` 混淆。
- `status` / `eval readiness`：自举 run 保持 `status=passed`，readiness 失败项仍为 `pr-prepared,pr-created,remote-ci-passed`，符合“不在 run 内创建真实 PR”的边界。
- `git diff --check` / `git diff --check origin/main`：无空白错误。
- `pnpm format:check`：仍失败在两个未触碰的历史文档 `docs/research/2026-06-10-external-research-report.md`、`docs/reviews/2026-06-10-tekon-comprehensive-evaluation.md`；本轮改动文件的空白和未完成标记扫描无新增问题。

## 6. 风险和下一步

- 真实 PR 和远端 CI 证据仍需在本分支 PR 创建后补齐。
- `qa-release-signoff` 当前已绑定 `targetRef`/`validatedRef` 和最新 QA validation ref，后续应绑定 delivery branch SHA 或 PR head SHA，并处理 PR 更新后的重新验证策略。
- PMO 当前已有逐节点 `pmo.node-checkpoint` 审计和末端 checkpoint gate，后续应补 CLI/Web 展示、风险聚合和人工升级入口。
- 长程任务已具备总超时、stdout/stderr no-progress timeout 和 progress 文件；仍需 manifest/artifact/diff 级进展续期、可恢复执行和外部 job runner。
- 当前强 gate 不能替代人类业务决策，merge、release、deploy 仍必须受控。
