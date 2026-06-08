# Donkey Web 多运行审阅流增量报告

日期：2026-06-08

范围：补齐 Web dashboard 只能审阅 latest run 的缺口，让真实工作复盘、历史 run 对比和补交付不再依赖终端手工查库。

## 1. 本轮新增能力

| 能力              | 实现位置                                     | 说明                                                                                                                                                                                 |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 项目 run 聚合     | `packages/web/src/server/api/root.ts`        | `project.detail` 会按当前 `DONKEY_PROJECT_ROOT` 聚合所有 scoped project rows 的 runs；这匹配 Engine 每次 `startRun` 新建 project row 的真实数据形态，同时继续排除 repo root 外项目。 |
| Web run 选择      | `packages/web/src/client/App.tsx`            | 概览区新增 run selector，默认选中 latest run；切换后重新加载当前 run 的 artifact、gate、audit 和 review surface。                                                                    |
| 选中 run 交付动作 | `packages/web/src/client/App.tsx`            | `delivery.prepare` 和 `delivery.createPr` 使用当前选中的 run id，不再固定 latest run。                                                                                               |
| 多 run fixture    | `packages/web/__tests__/fixtures/project.ts` | fixture 模拟 `project_0/run_0` 与 `project_1/run_1` 两个同 repo root project rows，覆盖真实 Engine 数据形态。                                                                        |

## 2. 验证记录

本轮已通过：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web typecheck
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test:e2e
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- prettier --check packages/web/src/client/App.tsx packages/web/src/client/styles.css packages/web/__tests__/fixtures/project.ts packages/web/__tests__/api/read-api.test.ts packages/web/__tests__/api/project-context.test.ts packages/web/__tests__/e2e/dashboard.test.ts packages/web/__tests__/e2e/release-dashboard.test.ts README.md CHANGELOG.md docs/manual/donkey-v2-user-manual.md docs/manual/donkey-v2-user-manual.html docs/reviews/2026-06-08-donkey-work-usability-gap-analysis.md docs/reviews/2026-06-08-donkey-work-usability-gap-analysis.html docs/reviews/2026-06-08-donkey-work-usable-increment.md docs/reviews/2026-06-08-donkey-work-usable-increment.html
git diff --check
占位符扫描命令已执行，目标范围为 README.md、CHANGELOG.md、docs、packages 和 workflows。
```

新增覆盖：

- API：`project.detail({ projectId: 'project_1' })` 返回同 repo root 下 `run_1` 和 `run_0`；`project_escaped` 仍返回 `NOT_FOUND`。
- API：指定 `run_0` 调用 `review.get` 能读取 older artifact 正文和 gate log。
- E2E：dashboard 选择 `run_0` 后展示 older artifact/gate log，切回 `run_1` 后直接 `准备 PR`，断言结果为 `donkey-delivery/run_1 -> main`，再继续 human approval 和新 run 发起。

## 3. 边界

- 本轮只补 Web 多 run 审阅和选中 run 交付动作，不新增自动 merge、自动上线或真实远端 PR 稳定性声明。
- 多 run fixture 证明的是 Web 选择和 API scope 语义，不替代真实仓库样本集、真实 provider 稳定性或真实 PR 证据。
- artifact/gate/audit 互跳仍是基础锚点级体验，深度上下文导航仍是后续工作。

## 4. Reviewer 结论

最高思考 reviewer 第一轮结论为 `CHANGES_REQUESTED`，必须修复项是：`project.detail` 只返回单个 project row 的 runs，未匹配 Engine 每次 run 新建 project row 的真实数据形态；fixture 未覆盖该形态。

修复后第二轮复查结论为 `APPROVED`。必须修复项为无。Reviewer 确认：`project.detail` 已按 repo root 聚合 scoped runs，out-of-scope 仍被排除；fixture 已模拟真实数据形态；e2e 已覆盖历史 run 选择、切回 latest run、对选中 run 准备 PR；文档未过度声明真实 provider、真实 PR 或生产级能力。
