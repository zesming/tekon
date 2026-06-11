# Tekon Standard Delivery 下一阶段迭代方案

日期：2026-06-11
状态：已根据 P1-0 自举失败样本和当前代码约束重新调整。
目标：先让 Tekon 以 Codex provider 支持可运行的标准交付种子流程，再逐步补齐独立评审、角色边界强校验、AC evidence、QA final signoff、PMO checkpoint 和长程任务可观测能力。

## 1. 当前事实

- 已完成 P0 Codex 真实闭环：`run_d2350140-b1b7-4fca-b01b-e28daac61e31` 使用 `codex --profile internal` 创建真实 PR #2，CI 通过，未自动 merge。
- P1-0 seed run `run_04b37267-2686-42c6-a0a4-9b37410f65f7` 使用 `standard-feature` 执行 `standard-delivery` 种子需求，PM 节点通过，RD 节点在 300 秒超时后中断。
- 当前 `artifactTypeSchema` 只支持 `demand-card`、`prd`、`tech-design`、`code-changes`、`test-report`、`review-report`、`security-report`、`rollback-plan`、`delivery-package`、`ci-status`。
- 当前 `gateTypeSchema` 只支持 `build`、`test`、`lint`、`e2e-pass`、`schema`、`security-scan`、`human`。
- 因此，`independent-review`、`role-scope`、`qa-signoff`、`ac-evidence`、`process-completeness` 等 gate，以及 `test-plan`、`qa-release-signoff`、`process-checkpoint` 等 artifact 不能直接写入首版模板。

## 2. 调整原则

- P1-A 首版模板必须 parser-compatible：只使用当前已注册 artifact 和 gate。
- 角色边界先写入 `roles/*/system.md`，作为 prompt 约束；强制防越权必须等后续 gate runner 实现后再宣称。
- 自举任务必须缩小粒度，避免一个 RD node 同时做模板、角色、schema、gate、PR package 和文档。
- 长程任务不能只靠拉大超时解决；应组合“总超时 + 进展观测 + 无进展超时 + 可恢复证据”。
- QA final signoff 先以 QA 节点和 `test-report`/`review-report` 表达，后续再引入绑定 delivery branch SHA 或 PR head SHA 的专用 schema。
- PR 创建、merge、release、deploy、force push 保持人工控制。

## 3. 资料依据

| 资料                                                                                                        | 资料内容                                                      | 对 Tekon 的判断依据                                                  |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| IBM requirements guideline: `https://www.ibm.com/docs/en/erqa?topic=assistant-guidelines-good-requirements` | 好需求应清晰、可验证，支撑沟通、设计、计划和工程活动。        | PM demand-card 后需要需求质量评审，不能只依赖 schema。               |
| ISTQB CTFL syllabus: `https://istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf`          | 测试活动应维护 test basis、testware、测试结果和追踪关系。     | QA test plan、QA validation、AC evidence 和 signoff 需要结构化关联。 |
| DORA change approval: `https://dora.dev/capabilities/streamlining-change-approval/`                         | 高效变更审批应前移到开发过程中的 review，并用自动化检测补充。 | Tekon 应做轻量独立评审和自动 gate，不引入重审批委员会。              |
| Scrum Definition of Done: `https://www.scrum.org/resources/definition-done`                                 | Done 表示增量满足质量标准并处于 usable 状态。                 | QA final signoff 必须绑定确切交付对象，避免“所测非所得”。            |
| Google Engineering Practices: `https://google.github.io/eng-practices/review/`                              | Review 关注设计、功能、复杂度、测试和文档。                   | RD technical review 和 reviewer change review 需要明确 rubric。      |

## 4. 阶段总览

| 阶段  | 目标                              | 范围                                                        | 退出标准                                                  |
| ----- | --------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| P1-0R | 归档 seed run 失败证据            | 写入 `docs/reviews/2026-06-11-standard-delivery-seed-run.*` | 失败原因、产物、gate、风险和下一步明确                    |
| P1-A0 | 最小兼容 `standard-delivery` 模板 | 新增模板和 parser 测试，只用现有 artifact/gate              | 模板可加载，`workflow preflight standard-delivery` 可执行 |
| P1-A1 | 角色边界模板化                    | 更新 PM/RD/QA/reviewer/PMO system 描述                      | 每个角色有评审范围、不越权、独立评审、升级条件            |
| P1-A2 | 长程任务最小支持                  | 真实 provider 默认超时提升到 1 小时，snapshot 保留 timeout  | CLI/Web Codex snapshot 测试通过                           |
| P1-B  | 独立评审与角色范围强校验          | 新 artifact 字段、`independent-review`、`role-scope` gate   | 自产自测、越权 review 可被 deterministic gate 拦截        |
| P1-C  | QA signoff 与 AC evidence         | `qa-release-signoff`、AC 到测试证据映射、PR package V2      | readiness 不再泛化为 evidence unknown                     |
| P1-D  | 标准流程 dogfooding               | 用 Tekon 自身 3 个低风险需求跑标准流程                      | 每个样本有 run、PR、CI、QA/PMO 证据和复盘                 |
| P2    | Web/Artifact/Telemetry            | Web Cockpit、Artifact Center、审计回放、成本 telemetry      | 人能在 Web 上完成主要审阅和追踪                           |
| P3    | 平台化扩展                        | DAG 并行、多 Provider、release/rollback、组织治理           | 多角色复杂需求可控运行                                    |

## 5. P1-A0 模板策略

首版 `standard-delivery` 不新增引擎能力，只固化节点结构：

```text
pm-demand-card
-> pm-demand-review
-> rd-requirement-interface-review
-> qa-requirement-interface-review
-> rd-implementation-plan
-> rd-technical-review
-> qa-test-plan
-> qa-test-plan-review
-> pm-test-plan-intent-review
-> rd-code-change
-> reviewer-change-review
-> qa-validation
-> qa-release-signoff-review
-> pmo-checkpoint
```

兼容映射：

| 语义                      | P1-A0 使用的现有 artifact | 后续专用 artifact           |
| ------------------------- | ------------------------- | --------------------------- |
| PM demand review          | `review-report`           | `demand-review`             |
| RD implementation plan    | `tech-design`             | `implementation-plan`       |
| RD technical review       | `review-report`           | `technical-review`          |
| QA test plan              | `test-report`             | `test-plan`                 |
| QA test plan review       | `review-report`           | `test-plan-review`          |
| QA release signoff review | `review-report`           | `qa-release-signoff-review` |
| PMO checkpoint            | `delivery-package`        | `process-checkpoint`        |

P1-A0 不做：

- 不实现新 gate runner。
- 不新增 artifact type。
- 不改变默认 workflow selection。
- 不把 role prompt 约束宣称为 deterministic enforcement。
- 不自动创建、合并或发布 PR。

## 6. 长程任务策略

这次 RD 节点 300 秒超时说明：真实 Codex 任务可能需要长程执行。调整建议分三层：

| 层级            | 能力                                                                                  | 判断                                   |
| --------------- | ------------------------------------------------------------------------------------- | -------------------------------------- |
| L1 本轮最小补强 | 将真实 provider 默认超时从 300 秒提升到 1 小时，并写入 provider snapshot              | 合理，能降低长程 seed 误杀概率，改动小 |
| L2 进展观测     | 记录 stdout/stderr 增量、工作区 diff、manifest mtime、artifact 文件数量、最近命令活动 | 必须做，否则 1 小时只是更久等待        |
| L3 长程可恢复   | 支持 node heartbeat、无进展超时、可中断恢复、后台 process registry 或外部 job runner  | 适合 P1-D/P2，不应塞进 P1-A0           |

推荐运行策略：

- `maxRuntimeMs` 默认 1 小时，后续允许 repo/profile 或 run 级覆盖。
- `noProgressTimeoutMs` 默认 15 分钟，只要日志、diff、manifest 或 artifact 有变化就续期。
- status/review surface 展示 `lastProgressAt`、`lastArtifactAt`、`stdoutBytes`、`stderrBytes`、`changedFiles`。
- 超时后先尝试读取 manifest；manifest 完整且必需 artifact 合法时允许进入 gate。
- 没有 manifest 且无进展时中断，并把 stderr 尾部、worktree diff 和 mtime 写入诊断证据。

## 7. 自举粒度

| 批次   | 流程                                | 任务粒度                                    | 目标                    |
| ------ | ----------------------------------- | ------------------------------------------- | ----------------------- |
| Seed-1 | 当前模板 + Codex                    | 只做 `standard-delivery` 模板和 parser 测试 | 验证模板可加载          |
| Seed-2 | 当前模板 + Codex                    | 只做角色边界文档                            | 验证 role prompt 可审阅 |
| Seed-3 | 当前模板 + Codex                    | 只做长程任务观测或 snapshot 超时            | 验证 provider 稳定性    |
| Seed-4 | 新 `standard-delivery` + mock/Codex | 只做一个小文档或小测试需求                  | 验证标准流程结构        |
| Seed-5 | 新 gate 后的 `standard-delivery`    | 独立评审、role-scope、QA signoff            | 验证治理强约束          |

## 8. 当前首 PR 范围

本轮建议作为一个最小但完整的 PR：

- 新增 `workflows/standard-delivery.yaml`。
- 更新 `packages/core/__tests__/workflow/template.test.ts`，验证模板可加载、关键节点存在、只使用现有 gate。
- 更新 `packages/core/src/workflow/template.ts`，把 `standard-delivery` 纳入 built-in template union。
- 更新 `roles/pm|rd|qa|reviewer|pmo/system.md`，固化职责边界。
- 更新真实 provider 默认超时常量和 CLI/Web Codex snapshot 测试。
- 归档 P1-0 seed run 失败证据。
- 同步 README、CHANGELOG、主用户手册 Markdown/HTML。

延后到后续 PR：

- `independent-review`、`role-scope`、`qa-signoff`、`ac-evidence` gate runner。
- 新 artifact type 和 manifest 白名单。
- PR package V2 和 readiness AC evidence 强映射。
- Web Cockpit、Artifact Center、成本 telemetry、多 Provider 对比、DAG 并行。

## 9. 验收命令

本轮最小验收：

```bash
pnpm vitest run packages/core/__tests__/workflow/template.test.ts
pnpm vitest run packages/core/__tests__/types/config.test.ts packages/cli/__tests__/run-cli.test.ts packages/web/__tests__/api/write-auth.test.ts
pnpm --filter @tekon/core build
pnpm build
node packages/cli/dist/index.js workflow show standard-delivery --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js workflow preflight standard-delivery --repo /Users/zhaoensheng/Projects/tekon
git diff --check
```

后续 gate/schema PR 追加：

```bash
pnpm vitest run packages/core/__tests__/artifact/schemas.test.ts
pnpm vitest run packages/core/__tests__/gate/runners.test.ts packages/core/__tests__/gate/engine.test.ts
pnpm vitest run packages/core/__tests__/eval/work-readiness.test.ts packages/core/__tests__/delivery/evidence.test.ts packages/core/__tests__/delivery/pr-package.test.ts
```

## 10. 风险

- 长超时会降低误杀，但如果没有进展观测，会让卡死任务占用更久。
- P1-A 的角色边界只是 prompt 层约束，不是确定性强约束。
- QA final signoff 若要绑定 PR head SHA，需要处理 PR 创建发生在 workflow 之后的问题；P1-C 应先支持 delivery branch SHA，再补 PR 创建后的二次校验。
- 当前 engine 仍按 phase/node 顺序执行，不应把模板中的多角色评审理解为已具备复杂 DAG 并行。
- 如果继续用单个 RD node 承担过大 seed 任务，Codex 超时仍可能复现。
