# Donkey 工作可用样本评估增量报告

日期：2026-06-08

范围：继续推进“真实工作可用”计划中 P0-2、P0-6、P0-7 的可验证评估面。本轮不声称已经完成真实仓库样本集、真实 provider 长期稳定性、真实远端 PR 数量或生产级隔离；本轮把这些要求固化为可执行的样本评估命令和回归测试。

## 1. 本轮新增能力

| 能力                     | 实现位置                                                                                                                                           | 说明                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| work usability evaluator | `packages/core/src/eval/work-usability.ts`                                                                                                         | 读取样本清单，检查每个 run 的 readiness、provider snapshot、PR delivery、security scan、worktree lease 和远端副作用审批。 |
| CLI 样本评估入口         | `packages/cli/src/index.ts`                                                                                                                        | 新增 `eval work-usability --samples`，默认样本路径为 `.donkey/eval/work-usability-samples.yaml`。                         |
| 初始化 eval 目录         | `packages/cli/src/index.ts`                                                                                                                        | `donkey init` 会创建 `.donkey/eval`，用于保存本地样本清单。                                                               |
| 样本评估测试             | `packages/core/__tests__/eval/work-usability.test.ts`、`packages/cli/__tests__/run-cli.test.ts`、`packages/cli/__tests__/e2e/release-flow.test.ts` | 覆盖阈值通过、真实 provider/PR/隔离证据缺失失败、缺失 run、CLI 输出和 release e2e 中的样本清单评估。                      |

## 2. 默认评估阈值

默认阈值面向正式 dogfooding，而不是为了让当前 fixture 直接通过：

- `minSamples: 10`
- `minReadyRuns: 5`
- `minRealProviderRuns: 5`
- `minCreatedPrs: 2`
- `requireIsolationEvidence: true`

阶段性 fixture 可以在样本文件中显式降低阈值，但只能证明命令路径和评估语义，不证明真实工作可用。

## 3. 样本检查项

单个样本当前检查：

- run 是否存在。
- provider 是否符合 `expectedProvider`。
- 当 `requireRealProvider=true` 时，provider 不能是 `mock`。
- 当 `requirePr=true` 时，PR delivery 必须为 `created` 且有 PR URL。
- 当声明 `expectedPrUrl` 时，落库 PR URL 必须一致。
- worktree lease 是否存在、路径是否位于 `.donkey/worktrees`、lease 是否释放。
- 如果发生 push 或 PR 创建，delivery 记录必须带 `approvedBy` 和 `approvedAt`。

样本聚合检查：

- 样本数、ready run 数、真实 provider run 数、created PR 数是否达到阈值。
- 所有样本是否具备隔离证据。
- 样本级必需检查是否全部通过。

## 4. 已更新文档

- `README.md`：补充 `eval work-usability --samples` 用法和发布边界。
- `CHANGELOG.md`：记录 work usability evaluator 和 CLI 入口。
- `docs/manual/donkey-v2-user-manual.md/html`：新增工作可用样本评估章节。
- `docs/reviews/2026-06-08-donkey-work-usability-gap-analysis.md/html`：更新 P0-2/P0-6/P0-7 当前状态。
- `docs/reviews/2026-06-08-donkey-work-usable-increment.md/html`：补充本轮能力和验证记录。

## 5. 验证记录

本轮已执行并通过的定向验证：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit -- --run packages/core/__tests__/eval/work-usability.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli test:unit -- --run packages/cli/__tests__/run-cli.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli test:e2e -- --run packages/cli/__tests__/e2e/release-flow.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core typecheck
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli typecheck
```

## 6. Reviewer 结论

最高思考 reviewer 复查结论：APPROVED。

必须修复项：无。

## 7. 仍未完成

- 真实仓库样本集本身：仍需 2-3 个受控真实仓库、10 个左右 B/D 类需求。
- 真实 provider 长期稳定性：仍需 Claude Code 或后续 Codex/custom provider 的连续样本数据。
- 真实 PR 证据：仍需至少 2 次真实受控远端 PR URL 和失败恢复记录。
- 生产级隔离：当前是样本级 worktree/审批证据，不是 OS/container 级沙箱或完整密钥治理。
