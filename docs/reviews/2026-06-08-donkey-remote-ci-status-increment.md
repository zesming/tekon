# Donkey 远端 CI 状态证据增量报告

日期：2026-06-08

范围：补齐“PR 创建后能否把远端 CI 状态写回 Donkey 证据包”的第一版能力。本文只覆盖只读查询和本地落库，不覆盖自动 merge、自动上线、CI rerun、长轮询等待或非 GitHub provider。

## 1. 背景判断

飞书方案收敛出的近期工作目标是“受控推进到可审 PR，并让人能基于证据快速判断能不能接受”。此前 Donkey 已经能准备 PR 包、在人工批准后创建 PR，并在 readiness 中展示 PR 创建状态；但 PR 创建后的远端 CI/checks 状态没有回写到 artifact、delivery evidence 或 PR 包中。

这会导致真实审阅时仍需要人手动打开 GitHub 或执行 `gh pr checks`，再把结果和 Donkey 的本地 gate、验收标准证据、安全扫描证据拼在一起判断。作为真实工作工具，即使不做全面自动化，也至少需要把远端 CI 状态纳入同一个证据面。

## 2. 资料依据

| 来源                             | 内容                                                                                                                                                                                      | 对 Donkey 的判断依据                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GitHub CLI manual `gh pr checks` | `--json` 输出包含 `bucket` 字段，可把 state 归类为 `pass`、`fail`、`pending`、`skipping` 或 `cancel`；pending checks 有额外退出码 8。资料链接：https://cli.github.com/manual/gh_pr_checks | Donkey 应解析 JSON stdout，而不是只按 exit code 判断；pending/failed 也应能落库为证据状态。 |
| 本地缺口分析                     | P1 “CI/远端状态”此前要求 PR 创建后能查询远端 CI 状态并写回 delivery evidence。                                                                                                            | 本增量把该项推进到第一版代码能力，但真实 PR 上的稳定证据仍属于后续 dogfooding。             |

## 3. 已完成能力

| 能力                        | 实现位置                                                                     | 说明                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci-status` artifact schema | `packages/core/src/artifact/schemas.ts`、`packages/core/src/types/domain.ts` | 新增 artifact 类型，payload 包含 `ciStatus`、`checkedAt`、`prUrl` 和 checks 列表；agent manifest 不允许 provider 产出该类型，避免伪造远端 CI。                  |
| 远端 CI 查询                | `packages/core/src/delivery/ci-status.ts`                                    | 调用 `gh pr checks <selector> --json bucket,completedAt,description,event,link,name,startedAt,state,workflow`，汇总为 `passed/failed/pending/skipped/unknown`。 |
| 非 0 JSON 解析              | `packages/core/src/delivery/ci-status.ts`                                    | 当 `gh` 因 pending 或 failed 返回非 0，但 stdout 仍是 JSON 数组时，Donkey 继续解析并落库状态；无 JSON 时才视为命令失败。                                        |
| 路径边界保护                | `packages/core/src/delivery/ci-status.ts`                                    | 执行 `gh` 前校验 run 存在和 `runId` path segment；显式 `outputDir` 必须位于仓库 `.donkey` 下，避免命令日志逃逸仓库边界。                                        |
| Evidence 回写               | `packages/core/src/delivery/evidence.ts`                                     | `createDeliveryEvidencePackage` 只信任 `delivery.ci.checked` 审计事件关联的 `ci-status` artifact，并只输出最新一次查询结果，避免伪造或历史状态误导 readiness。  |
| PR 包展示                   | `packages/core/src/delivery/pr-package.ts`                                   | PR body 和 PR package 增加 Remote CI 区块；未查询时显示 `remoteCi: not checked`。                                                                               |
| Readiness 推荐项            | `packages/core/src/eval/work-readiness.ts`                                   | 新增 recommended check `remote-ci-passed`；不阻断 `ready=true`，但会影响 score 和审阅判断。                                                                     |
| CLI 命令                    | `packages/cli/src/index.ts`                                                  | 新增 `delivery ci-status --run-id <runId> [--selector <prUrl or branch>] --repo <repo>`。                                                                       |

## 4. 当前边界

- 这是只读查询能力：不会 push、不会创建 PR、不会 rerun CI、不会等待 CI、不会 merge、不会上线。
- 默认 selector 优先使用已落库 PR URL，其次使用 delivery branch；也可以通过 `--selector` 指定 PR URL 或分支。
- 当前 provider 只覆盖 GitHub CLI 的 `gh pr checks`；GitLab、内部 Git 平台、Buildkite、Jenkins 等需要后续 provider adapter。
- 当前测试使用 fake `gh` fixture；真实 GitHub PR 上还需要记录 `gh auth status`、PR URL、checks 输出和失败恢复证据。

## 5. 验证记录

已通过的阶段性验证：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit -- --run packages/core/__tests__/delivery/ci-status.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit -- --run packages/core/__tests__/delivery/ci-status.test.ts packages/core/__tests__/artifact/schemas.test.ts packages/core/__tests__/delivery/pr-package.test.ts packages/core/__tests__/eval/work-readiness.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core build
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli typecheck
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli test:unit -- --run packages/cli/__tests__/run-cli.test.ts
```

本轮最终收口验证：

```bash
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test:e2e
git diff --check
npm exec --yes -- prettier --check CHANGELOG.md README.md docs/manual/donkey-v2-user-manual.md docs/manual/donkey-v2-user-manual.html docs/reviews/2026-06-08-donkey-work-usability-gap-analysis.md docs/reviews/2026-06-08-donkey-work-usability-gap-analysis.html docs/reviews/2026-06-08-donkey-work-usable-increment.md docs/reviews/2026-06-08-donkey-work-usable-increment.html docs/reviews/2026-06-08-donkey-remote-ci-status-increment.md docs/reviews/2026-06-08-donkey-remote-ci-status-increment.html packages/cli/__tests__/run-cli.test.ts packages/cli/src/index.ts packages/core/__tests__/artifact/schemas.test.ts packages/core/__tests__/delivery/ci-status.test.ts packages/core/src/artifact/schemas.ts packages/core/src/delivery/ci-status.ts packages/core/src/delivery/evidence.ts packages/core/src/delivery/pr-package.ts packages/core/src/eval/work-readiness.ts packages/core/src/index.ts packages/core/src/types/domain.ts
```

覆盖点：

- `delivery/ci-status.test.ts` 覆盖通过 checks、失败 checks、pending exit code 8 但 stdout 为 JSON、历史 passed 后最新 failed 不通过、未审计的伪造 `ci-status` artifact 不被信任、unsafe run id 和 escaped outputDir 不执行 `gh` 的场景。
- `artifact/schemas.test.ts` 覆盖 `ci-status` payload schema，并覆盖 agent manifest 拒绝 `ci-status`。
- `delivery/ci-status.test.ts` 覆盖 Remote CI evidence 进入 delivery evidence 以及 `remote-ci-passed` readiness 推荐项；`delivery/pr-package.test.ts` 保持 PR 包生成基线回归。
- `cli` run-cli 单测用 fake `gh` 覆盖 `delivery ci-status` 命令。

## 6. 后续仍需

1. 在受控 GitHub 测试仓库创建真实 PR 后执行 `delivery ci-status`，记录 PR URL、CI 状态、artifact id 和 `delivery.ci.checked` audit event。
2. 明确无 checks、required checks、pending 长时间不结束、`gh` 未认证、仓库无权限时的用户提示和失败分类。
3. 决定是否增加 `--watch` 或重试退避；默认仍应只读、受控，不能引入自动 merge 或上线。
4. 若内部主力代码平台不是 GitHub，需要设计 CI status provider adapter，而不是把 `gh` 语义写死到产品文档里。

## 7. Reviewer 结论

第一轮最高思考 reviewer 结论为 `CHANGES_REQUIRED`，必须修复项包括：readiness 不能被历史 passed CI artifact 误导；CLI `delivery ci-status` 错误路径必须关闭 SQLite 连接。

已修复摘要：`createDeliveryEvidencePackage` 现在只输出最新 `ci-status` evidence；`remote-ci-passed` 因此只按最新远端 CI 状态判断。CLI `delivery ci-status` 打开 DB 后使用 `try/finally` 关闭连接。新增回归测试覆盖“先 passed 后 failed 时 readiness 不通过”和“无 PR selector 失败后 CLI 仍可继续执行”。

第二轮最高思考 reviewer 结论为 `CHANGES_REQUIRED`，必须修复项为：执行 `gh` 前未校验 runId/path segment，恶意 run id 搭配 selector 可能让 CommandGateway 日志 outputDir 逃逸 `.donkey/runs`。

已修复摘要：`queryPullRequestCiStatus` 现在在执行 `gh` 前校验 `runId` 为安全 path segment、确认 run 存在，并把默认 outputDir 构造在 `.donkey/runs/<runId>/delivery/ci` 下；显式 `outputDir` 也必须解析到目标仓库 `.donkey` 内。补充回归测试覆盖 unsafe run id 和 escaped outputDir 不会触发 gateway。

第三轮最高思考 reviewer 结论为 `CHANGES_REQUIRED`，必须修复项为：`ci-status` 被允许出现在 agent manifest 中，真实 provider 可伪造远端 CI 通过；delivery evidence 也不应信任任意 `ci-status` artifact。

已修复摘要：agent manifest schema 不再允许 `ci-status`；delivery evidence 只信任 `delivery.ci.checked` 审计事件关联的 `ci-status` artifact。补充回归测试覆盖 provider manifest 拒绝 `ci-status`，以及未审计的伪造 `ci-status: passed` 不会让 `remote-ci-passed` 通过。

最终最高思考 reviewer 复查结论：`APPROVED`。必须修复项为无。建议项为后续可进一步补 PR package Remote CI 展示的直接断言；当前不阻塞本次交付。
