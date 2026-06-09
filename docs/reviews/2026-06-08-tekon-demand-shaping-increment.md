# Tekon 需求塑形入口增量报告

日期：2026-06-08

范围：补齐 P1 “需求塑形入口”。本增量不把需求澄清做成全面自动化；它先用确定性规则生成可审阅需求卡，并要求人工批准后才进入 workflow。

## 1. 背景判断

真实工作中，一句“帮我做这个”通常不足以让 Agent 稳定交付。Tekon 需要在运行前固定最小输入证据：需求分类、推荐 workflow、风险、非目标、开放问题和验收标准。否则后续 PR 包、readiness 和 review surface 即使完整，也可能建立在模糊需求上。

## 2. 已完成能力

| 能力         | 实现位置                                                         | 说明                                                                                                   |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 需求塑形核心 | `packages/core/src/demand/shape.ts`                              | `shapeDemand` 生成需求卡、分类、推荐模板、风险、非目标、开放问题和验收标准。                           |
| 人工批准     | `packages/core/src/demand/shape.ts`                              | `approveDemandShape` 写入 approved、approvedBy 和 approvedAt；`run --demand-file` 默认要求批准。       |
| 需求塑形评估 | `packages/core/src/demand/shape.ts`、CLI `eval demand-shape`     | 检查标题、验收标准、非目标、风险边界，以及开放问题是否已解决或已被批准。                               |
| CLI 入口     | `packages/cli/src/index.ts`                                      | 新增 `demand shape/approve/show`、`run --demand-file` 和 `eval demand-shape`。                         |
| Web 入口     | `packages/web/src/server/api/root.ts`、`packages/web/src/client` | Web 可用 session token 塑形需求、批准需求，并在发起 run 时使用 shape path。                            |
| 文件沉淀     | `.tekon/demands/<shapeId>.json`、`.tekon/demands/<shapeId>.md`   | JSON 是后续运行输入，Markdown 是本地审阅稿；当前不建议提交 `.tekon` 运行态目录。                       |
| 回归测试     | core/cli/web 单测与 Web e2e                                      | 覆盖塑形、批准、未批准阻断、评估、Web API 路径、Web symlink 写入/读取逃逸拒绝和 dashboard 塑形后运行。 |

## 3. 当前边界

- 当前不是 PM LLM 多轮澄清，只是确定性启发式需求卡生成。
- 开放问题不会被自动视为已解决；如果用户批准有开放问题的需求，表示人类接受当前输入边界。
- `demand approve` 只批准需求输入，不批准 push、PR 创建、merge、上线或生产写操作。
- `run --demand-file` 会把需求卡渲染为 workflow demand body，但后续 gate、readiness 和 review surface 仍照常执行。
- Web demand shape 路径限制在当前项目 `.tekon/demands/*.json` 内，并拒绝 symlink 文件或 symlink `demands` 目录，避免通过 Web 写入、读取或批准仓库外文件。

## 4. 验证记录

阶段性验证已通过：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core build
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:unit -- --run packages/core/__tests__/demand/shape.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @tekon/cli test:unit -- --run packages/cli/__tests__/run-cli.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @tekon/web test -- --run packages/web/__tests__/api/write-auth.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @tekon/web typecheck
```

新增覆盖点：

- Core：高风险识别、推荐模板、验收标准生成、开放问题、批准后评估通过、JSON/Markdown 文件沉淀。
- CLI：`demand shape --write`、未批准 `run --demand-file` 阻断、`demand approve`、`eval demand-shape`、批准后 `run --demand-file`。
- Web API：token 校验、shape path 范围校验、symlink 文件/目录写入与读取逃逸拒绝、未批准 shape path 阻断、批准后 run。
- Web e2e：dashboard 中塑形需求、批准需求、发起 run、准备 PR。

## 5. 后续仍需

1. 接入真实 PM/LLM 多轮澄清前，先用真实需求样本校准启发式分类、风险标签和开放问题是否可用。
2. 把需求塑形结果纳入真实 work-usability 样本报告，记录哪些 run 是从批准后的 demand shape 发起。
3. 需求卡暂存于 `.tekon/demands`，后续若要作为长期知识沉淀，需要导出到可提交的 `docs/reviews/` 或产品需求目录。

## 6. Reviewer 结论

最高思考 reviewer 第一轮结论为 CHANGES_REQUIRED，必须修复项为：Web `demand.shape` 写入前未拒绝已存在的 `.tekon/demands` symlink，可能把需求卡 JSON/Markdown 写到仓库外；测试也缺少该写入逃逸回归。

已修复摘要：Web `demand.shape` 写入前新增 demand shape storage realpath/lstat 校验，拒绝 `.tekon` symlink、`.tekon/demands` symlink，并确认真实 `.tekon/demands` 仍在真实项目根下；`demand.approve` 和 `project.run({ demandShapePath })` 复用同一 storage 校验后，再拒绝 shape 文件 symlink 和 realpath 逃逸。新增 Web API 回归测试覆盖 shape 文件 symlink、demands 目录 symlink 的 approve/run 逃逸，以及调用 `demand.shape()` 前 demands 目录就是 symlink 的写入逃逸。

第二轮复查结论：APPROVED，必须修复项为无。剩余风险为非阻塞：当前需求塑形仍是确定性启发式和人工批准入口，不代表真实 PM/LLM 多轮需求澄清已经完成；真实 provider 稳定性和真实工作样本仍需后续 dogfooding 证明。
