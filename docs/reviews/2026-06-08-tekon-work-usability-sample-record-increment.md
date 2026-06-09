# Tekon 工作可用样本沉淀增量报告

日期：2026-06-08

范围：补齐 P0-2/P0-6/P0-7 的样本沉淀入口。上一轮 `eval work-usability --samples` 已能评估样本清单，但样本仍需要手写 YAML，`.tekon/` 里的运行态结论也缺少一键生成可提交报告的路径。本轮聚焦把“某次 run 的证据”沉淀成后续 dogfooding 可复查的数据，不扩大自动 merge、自动上线或全面自动化范围。

## 1. 背景判断

真实工作可用的核心不是多跑几个 fixture，而是持续记录真实样本：run id、provider、PR URL、隔离证据、readiness、失败项和人工判断。缺少记录入口时，样本清单容易滞后，最终只剩 `.tekon/` 运行态数据，无法随仓库提交归档。

本轮增量让用户在完成一次 run 后执行一条命令，把该 run 写入样本清单；评估时可同步生成 Markdown 和 HTML 报告，满足“运行态关键验收结论要写入可提交文档”的仓库要求。

## 2. 已完成能力

| 能力         | 实现位置                                                                                                                                           | 说明                                                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 样本 upsert  | `packages/core/src/eval/work-usability.ts`                                                                                                         | 新增 `upsertWorkUsabilitySample`，按 `id` 新增或更新样本，保留阈值配置并用 schema 校验样本。                                                                |
| 评估报告渲染 | `packages/core/src/eval/work-usability.ts`                                                                                                         | 新增 `renderWorkUsabilityEvaluationReport`，输出 Markdown 和 HTML，展示 counts、threshold checks、样本失败项和边界判断。                                    |
| CLI 样本记录 | `packages/cli/src/index.ts`                                                                                                                        | 新增 `eval work-usability record --run-id <runId> --samples <path>`，读取 run provider snapshot 和已落库 PR URL，推断可记录的 expected provider / PR 要求。 |
| CLI 报告导出 | `packages/cli/src/index.ts`                                                                                                                        | `eval work-usability` 支持 `--report-md` 和 `--report-html`，生成可提交到 `docs/reviews/` 的评估报告。                                                      |
| 回归测试     | `packages/core/__tests__/eval/work-usability.test.ts`、`packages/cli/__tests__/run-cli.test.ts`、`packages/cli/__tests__/e2e/release-flow.test.ts` | 覆盖 upsert、报告渲染、CLI record、报告导出和 release e2e。                                                                                                 |

## 3. 当前边界

- `record` 只记录已有 run，不会自动创建真实仓库样本，也不会替代人工判断样本是否代表目标工作场景。
- `record` 可根据 provider snapshot 和 PR URL 推断字段，但 `demandType`、notes、阈值和样本是否纳入正式 dogfooding 仍需要用户确认。
- 报告只证明样本清单里记录的 run，不证明未采样仓库、未采样需求、生产级 OS 沙箱或长期真实 provider 稳定性。
- HTML 报告是本地静态审阅件，不会上传、发布或自动创建 PR。

## 4. 验证记录

已完成的阶段性验证：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:unit -- --run packages/core/__tests__/eval/work-usability.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @tekon/cli test:unit -- --run packages/cli/__tests__/run-cli.test.ts
```

本轮最终收口验证：

```bash
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @tekon/web test:e2e
git diff --check
npm exec --yes -- prettier --check packages/cli/src/index.ts packages/core/src/eval/work-usability.ts packages/core/__tests__/eval/work-usability.test.ts packages/cli/__tests__/run-cli.test.ts packages/cli/__tests__/e2e/release-flow.test.ts README.md CHANGELOG.md docs/manual/tekon-v2-user-manual.md docs/manual/tekon-v2-user-manual.html docs/reviews/2026-06-08-tekon-work-usability-gap-analysis.md docs/reviews/2026-06-08-tekon-work-usability-gap-analysis.html docs/reviews/2026-06-08-tekon-work-usable-increment.md docs/reviews/2026-06-08-tekon-work-usable-increment.html docs/reviews/2026-06-08-tekon-work-usability-sample-record-increment.md docs/reviews/2026-06-08-tekon-work-usability-sample-record-increment.html
```

最终结果：build 通过；typecheck 通过；全量测试 55 个 test files / 191 个 tests 通过；Web e2e 2 个 tests 通过；`git diff --check` 通过；占位符扫描无命中。

## 5. 后续仍需

1. 用 2-3 个真实仓库积累样本清单，不再只使用 fixture。
2. 将 `record` 生成的样本报告纳入真实 dogfooding PR 或审阅文档。
3. 在样本报告中继续补人工介入次数、返工原因、耗时和失败分类，形成更完整的数据飞轮。

## 6. Reviewer 结论

最高思考 reviewer 结论：APPROVED。必须修复项：无。

复查确认：`record` 只在 run 存在后写样本；schema 校验失败会在写入前中断，run 不存在和写入失败路径不会输出成功结果，DB 关闭路径覆盖主要错误分支。报告文案明确限定为 recorded sample set 证据，并声明不证明生产就绪，未把真实 dogfooding、真实 PR 或生产隔离写成已完成。core/CLI/e2e 覆盖了 upsert、报告渲染、CLI record、报告导出和 release e2e 主路径，足以支撑本轮声明。
