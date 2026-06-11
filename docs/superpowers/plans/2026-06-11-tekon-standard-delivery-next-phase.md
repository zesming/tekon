# Tekon Standard Delivery 下一阶段迭代方案

日期：2026-06-11
状态：已按 Codex 优先、自举优先、真实 PR 不自动 merge 的原则重新调整。
目标：把标准交付流程固化成可复用执行模板，让 Tekon 先用自身需求完成自举验证，再把长程任务、独立评审、QA 交付和 PMO 检查逐步做成稳定能力。

## 1. 当前事实

- P0 Codex 真实闭环已完成：`run_d2350140-b1b7-4fca-b01b-e28daac61e31` 使用 `codex --profile internal` 创建真实 PR #2，CI 通过，未自动 merge。
- P1-0 早期 seed run `run_04b37267-2686-42c6-a0a4-9b37410f65f7` 在 RD Codex 节点 300 秒超时中断，暴露出任务粒度过大和默认超时偏短。
- 本轮已把 `standard-delivery` 从“parser-compatible 种子模板”推进到强治理模板：新增 `demand-review`、`implementation-plan`、`test-plan`、`ac-evidence`、`qa-release-signoff`、`process-checkpoint` 等 artifact，并新增 `independent-review`、`role-scope`、`ac-evidence`、`qa-signoff`、`process-completeness` gate；模板已包含 PM 内审、PM 外部需求意图评审、RD/QA 需求接口评审、RD 技术评审、QA/PM 测试方案评审、独立变更评审、QA final signoff 和 PMO checkpoint。
- 最新自举 run `run_c1cc3995-a8fc-45ac-a4fe-408eba1b9b50` 已跑通完整 `standard-delivery`：workflow `passed`，41 个 gate，19 个 artifact，0 个 pending human decision。
- 该 run 的 readiness 仍为 `ready=false score=0.73`，失败项为 `pr-prepared`、`pr-created`、`remote-ci-passed`。这是预期结果，因为这次自举 run 只验证标准流程和本地 gate，不在 run 内创建远端 PR；本轮已把 `pr-created`、`remote-ci-passed` 调整为 readiness 必需项。
- 真实 provider 和受控 `delivery create-pr` 的 `git/gh` 命令默认总超时已调整为 1 小时，并新增 command progress JSON，记录 `status`、`startedAt`、`updatedAt`、`lastOutputAt`、stdout/stderr 字节数、受控输出目录文件数量和字节数、elapsed、总超时、无进展超时、timeoutReason 和 heartbeat 次数；无 stdout/stderr 或受控输出目录文件进展默认 15 分钟会触发 `no-progress` timeout。CLI `run` 与 Web dashboard 已支持覆盖总超时、无进展超时和 heartbeat，明确长程任务可显式配置 2 小时以上外层预算。

## 2. 对流程问题的判断

用户提出的五个流程补充是合理的，应进入标准模板和角色描述：

| 问题                                               | 判断                                                                                                                                | Tekon 落点                                                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| PM 需求卡后是否有 PM 内部评审，再和 RD/QA 外部评审 | 需要。PM 内审确认必要性、合理性、边界和验收口径；PM 外评确认需求意图对 RD/QA 可交付；RD/QA 外评只评自己接口，不替 PM 决策业务价值。 | `pm-demand-review`、`pm-requirement-intent-review`、`rd-requirement-interface-review`、`qa-requirement-interface-review` |
| RD 开发前的 implementation plan 是否有 RD 技术评审 | 需要。技术评审应限制在设计、风险、改动面、验证和回滚，不评 PM 业务合理性。                                                          | `rd-implementation-plan`、`rd-technical-review`                                                                          |
| QA 测试验收方案是否和 PM 联合验证                  | 需要。QA 评测试可执行性，PM 只评是否覆盖需求意图和验收标准，不替 QA 设计测试细节。                                                  | `qa-test-plan-review`、`pm-test-plan-intent-review`                                                                      |
| PMO 是否每个节点关注产出完整性                     | 需要，但不应让 PMO 逐项替专业角色评审内容。PMO 关注节点状态、必需 artifact、gate、缺失信息和风险升级。                              | 已写入逐节点 `pmo.node-checkpoint` 审计事件，末端仍由 `pmo-checkpoint` 做完整性 gate                                     |
| 最后交付是否由 QA 做                               | 合理。QA 应对“所测即所得”签署 release signoff；PMO 负责交付包完整性和流程证据，远端 PR 创建仍需人工批准。                           | `qa-release-signoff`、`qa-release-signoff-review`、`delivery-package`                                                    |

角色参与评审时必须限制在自身职责范围内。PM 不评技术实现优劣，RD 不评业务必要性，QA 不替 RD 设计方案，reviewer 不改 PM/RD/QA 的职责判断，PMO 不替任何角色做专业结论。所有正式评审必须由独立 agent 或独立进程产出 `reviewProcess.mode=independent-agent|independent-process`，避免自产自测。

## 3. 标准执行模板

`standard-delivery` 固化为以下链路：

```text
pm-demand-card
-> pm-demand-review
-> pm-requirement-intent-review
-> rd-requirement-interface-review + qa-requirement-interface-review
-> rd-implementation-plan
-> rd-technical-review
-> qa-test-plan
-> qa-test-plan-review + pm-test-plan-intent-review
-> rd-code-change
-> reviewer-change-review
-> qa-validation
-> qa-release-signoff
-> qa-release-signoff-review
-> pmo-checkpoint
```

模板强约束：

- 需求必须有 `demand-card` 和 `prd`，且包含可追踪 acceptance criteria。
- 评审类 artifact 必须声明 `reviewScope`、`reviewProcess`、`decision` 和 findings。
- `independent-review` gate 拦截 self review 和未批准 review。
- `role-scope` gate 拦截角色越权 scope 和 reviewerRole/node role 不一致。
- 非 `code-changes` 节点在 worktree finalize 前会被源码变更 guard 拦截，防止 PM/QA/PMO 节点越权修改实现。
- `ac-evidence` gate 要求所有验收标准都有 passed evidence。
- `qa-validation` 会记录被测 delivery ref；`qa-signoff` gate 要求 QA signoff 的 `targetRef`、`validatedRef` 与最新 `qa.validation.ref` 一致，且所有 criteria evidence passed。
- `delivery prepare` 和 `delivery create-pr` 共享 pre-PR readiness：不要求 PR 已创建或远端 CI 已通过，但要求 workflow passed、无 pending human gate、验证 gate/安全扫描满足、AC evidence 完整、QA signoff 通过且绑定 `qa.validation.ref`。
- `process-completeness` gate 要求 PMO checkpoint 中必需节点已 passed 且无缺失信息。
- 每个节点通过后都会写入 `pmo.node-checkpoint` 审计事件，末端 `process-completeness` gate 再检查整体流程证据。
- `workflow preflight` 对无需命令的 schema/semantic gate 输出 `status=not-command-gate`，只把 repo profile 显式不适用输出为 `status=not-applicable`。

## 4. 本轮落地范围

本轮 PR 的实际范围：

- `workflows/standard-delivery.yaml`：完整标准交付链路，包含 PM 外部需求意图评审、RD/QA 外部接口评审、QA/PM 测试方案评审、QA final signoff 和 PMO checkpoint。
- `packages/core/src/types/domain.ts`：新增 artifact/gate 类型。
- `packages/core/src/artifact/schemas.ts`：新增强 schema。
- `packages/core/src/gate/engine.ts`：新增独立评审、角色范围、AC evidence、QA signoff、流程完整性 gate。
- `packages/core/src/delivery/evidence.ts`、`packages/core/src/delivery/pr-package.ts`、`packages/core/src/eval/work-readiness.ts`：把 AC evidence、QA signoff 和远端 CI 纳入交付证据和 readiness。
- `packages/core/src/runtime/command-gateway.ts`：新增 progress JSON，并把 no-progress 续期从 stdout/stderr 扩展到受控 `outputDir` 的 artifact/manifest 文件变化。
- `packages/core/src/workflow/engine.ts`、`packages/core/src/runtime/worktree-manager.ts`：非 code 节点源码变更 guard、QA tested ref 审计、逐节点 PMO checkpoint。
- `packages/core/src/types/domain.ts`、`packages/core/src/gate/engine.ts`、`packages/core/src/workflow/engine.ts`：gate result 增加稳定 `gateKey`，同一节点下重复同类型 gate 会按 artifact/commandRef 区分，PMO checkpoint 也会带 gateKey 证据。
- `packages/core/src/delivery/pre-pr-readiness.ts`、`packages/core/src/delivery/pr-package.ts`：PR 前置 readiness，防止缺 QA signoff、AC evidence 或 security evidence 时生成 PR 包或创建远端 PR。
- `packages/core/src/runtime/command-gateway.ts`、`packages/core/src/delivery/scm.ts`：审批 note 脱敏，PR 创建前置只读 probe 统一走 CommandGateway。
- `packages/core/src/delivery/scm.ts`：delivery branch/base branch 安全 ref 校验，PR 创建写命令改为 exact allow。
- CLI/Web 默认真实 provider 配置：1 小时超时、15 分钟 no-progress timeout 和 progress heartbeat 写入 provider config summary；CLI `run` 和 Web dashboard 可覆盖三项运行预算；受控 PR 创建命令复用默认 command timeout/progress 策略。
- `standard-feature`、`bugfix`、`test-improvement`、`docs-update`：补齐 `qa-release-signoff` 输出和 gate，使 readiness 的 QA signoff 必需项有产物来源。
- 测试：补充 schema、gate、readiness、PR package、command progress、Codex/Web fake provider 和 e2e 断言。
- 文档：README、CHANGELOG、主用户手册、方案和归档 HTML。

## 5. 长程任务方案

用户建议把超时时间拉大到 1h、2h 甚至更长，这个方向合理，但不能只靠总超时。

| 层级          | 能力                                                                                 | 本轮状态 | 判断                                                            |
| ------------- | ------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------- |
| L1 总超时     | 真实 provider 和受控 PR 创建命令默认 `timeoutMs=3600000`，CLI/Web run 支持显式覆盖   | 已落地   | 默认 1 小时合理；2 小时以上应通过 run 显式配置                  |
| L2 进展观测   | progress JSON 记录状态、stdout/stderr、输出目录文件指标、elapsed、timeout、heartbeat | 已增强   | 能判断任务是否仍在输出，或是否仍在写入 artifact/manifest        |
| L3 无进展超时 | `noProgressTimeoutMs` 基于 stdout/stderr 和受控输出目录文件变化续期，默认 15 分钟    | 已增强   | 比无限拉大总超时更稳；diff 级续期和外部 job runner 属于后续增强 |
| L4 可恢复执行 | process registry、resume token、外部 job runner、节点级 checkpoint                   | 待做     | 适合 P1-D/P2，避免本地会话断开导致长任务丢失                    |
| L5 远程调度   | 队列、资源配额、并发、取消、成本和审计                                               | 待做     | 适合平台化阶段，不放进当前 MVP                                  |

推荐默认：

- 普通真实 provider 节点：`maxRuntimeMs=1h`。
- 明确长程任务：允许通过 CLI `run --timeout-ms 7200000 --no-progress-timeout-ms 1200000 --progress-heartbeat-ms 30000` 或 Web dashboard 对应字段配置 `2h+`，但必须启用进展观测和人工可取消入口。
- 无进展超时：当前默认 15 分钟，stdout/stderr 有变化或 `outputDir` 中 artifact/manifest 等文件数量、大小、mtime 有变化就续期；后续补 diff 变化续期和外部 job runner。
- 超时后先读取 manifest；只有 timeout 且 manifest 完整、必需 artifact 合法时允许进入 gate。非零退出不会被改写为成功，但合法 artifact 可入库用于诊断。
- 因此，用户建议把长程任务总超时拉到 1h/2h 是合理的，但应作为“外层预算”；真正判断是否卡死要靠 heartbeat、stdout/stderr、artifact/manifest 文件变化，以及可取消/可恢复机制。

## 6. 自举验证计划

后续 P0/P1 不再用抽象样本，优先用 Tekon 自身需求跑真实流程。

| 批次 | 任务                    | Workflow                                        | 预期输出                                                                     |
| ---- | ----------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| B0   | 本轮标准治理模板和 gate | `standard-delivery`                             | 已完成：`run_c1cc3995-a8fc-45ac-a4fe-408eba1b9b50` passed                    |
| B1   | 本分支创建真实 PR       | 手工受控 `delivery create-pr` 或 `gh pr create` | 真实 PR URL，远端 CI 证据，未自动 merge                                      |
| B2   | 小型文档需求自举        | `standard-delivery` + Codex                     | 新 PR，验证 PM/RD/QA/reviewer/PMO 产物稳定性                                 |
| B3   | 长程任务观测增强        | `test-improvement` 或 `standard-delivery`       | 本轮已补 outputDir artifact/manifest 变化续期；diff 级续期和恢复证据继续后置 |
| B4   | Web 审阅闭环            | `standard-delivery`                             | Web 上查看 artifact/gate/progress，完成审批和 PR 创建                        |
| B5   | 多样本评估              | 3 个低风险 Tekon 需求                           | work-usability 样本集，失败模式归档，规则沉淀                                |

## 7. 后续优先级

| 优先级 | 方向                         | 原因                                                                                              | 退出标准                                                                       |
| ------ | ---------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| P0     | 真实 PR 和远端 CI 闭环       | 当前自举 run 仍缺 `pr-created`、`remote-ci-passed` 必需证据                                       | 本轮分支 PR 创建，CI 通过，证据写入归档                                        |
| P1     | 长程 resume 和更完整进展判定 | 1 小时总超时和 stdout/stderr/outputDir no-progress 已覆盖主要本地产物进展，仍缺 diff 级续期和恢复 | diff 有进展续期；任务可恢复或重跑                                              |
| P1     | PMO 节点观测产品化           | 已有 `pmo.node-checkpoint` 审计事件，但 CLI/Web 展示和风险聚合仍弱                                | 每个阶段可在 CLI/Web 查看 checkpoint、缺失信息和升级建议                       |
| P1     | QA 所测即所得增强            | 当前已绑定 QA validation ref，后续要绑定 delivery branch SHA/PR head SHA 和 PR 更新后的重测要求   | QA signoff 与 delivery branch SHA 或 PR head SHA 一致，PR 更新后可强制重新验证 |
| P1     | Web Artifact Center          | 长链路 artifact 多，CLI 不足以支撑人工审阅效率                                                    | Web 可按角色、节点、gate、风险浏览证据                                         |
| P2     | 外部 job runner              | 长程任务不应依赖单个本地 CLI 会话                                                                 | 任务可后台运行、取消、恢复、限额、审计                                         |
| P2     | 多 provider 对比             | Codex 优先，但后续需要 provider 策略和 fallback                                                   | 同一小样本可对比 Codex/Claude/mock 产物质量                                    |
| P3     | 平台化治理                   | 多仓库、多团队、远程执行、权限和成本治理                                                          | 队列、配额、权限边界、组织报表可用                                             |

## 8. 资料依据

| 资料                                                                                                        | 资料内容                                                        | 对 Tekon 的判断依据                                                  |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| IBM requirements guideline: `https://www.ibm.com/docs/en/erqa?topic=assistant-guidelines-good-requirements` | 好需求应清晰、可验证，支撑沟通、设计、计划和工程活动。          | PM demand-card 后需要需求质量评审，不能只依赖 schema。               |
| ISTQB CTFL syllabus: `https://istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf`          | 测试活动应维护 test basis、testware、测试结果和追踪关系。       | QA test plan、QA validation、AC evidence 和 signoff 需要结构化关联。 |
| DORA change approval: `https://dora.dev/capabilities/streamlining-change-approval/`                         | 高效变更审批应前移到开发过程中的 review，并用自动化检测补充。   | Tekon 应做轻量独立评审和自动 gate，不引入重审批委员会。              |
| Scrum Definition of Done: `https://www.scrum.org/resources/definition-done`                                 | Done 表示增量满足质量标准并处于 usable 状态。                   | QA final signoff 必须绑定确切交付对象，避免“所测非所得”。            |
| Google Engineering Practices: `https://google.github.io/eng-practices/review/`                              | Review 关注设计、功能、复杂度、测试和文档。                     | RD technical review 和 reviewer change review 需要明确 rubric。      |
| Temporal Activity timeouts: `https://docs.temporal.io/encyclopedia/detecting-activity-failures`             | 长程 activity 可通过总时限、单次执行时限和 heartbeat 检测失败。 | Tekon 长程 node 不能只提高总超时，还要记录进展和无进展超时。         |
| Celery worker time limits: `https://docs.celeryq.dev/en/stable/userguide/workers.html#time-limits`          | 任务可以配置 soft/hard time limit，soft limit 给清理留窗口。    | Tekon 应区分温和中断、证据收集和最终强制终止。                       |
| GitHub Actions limits: `https://docs.github.com/en/actions/reference/limits`                                | CI/自动化平台有运行时长、并发和资源限制，需要显式治理。         | Tekon 长程任务要进入可观测队列，不能无限占用本地或 CI 资源。         |

## 9. 验收命令

本轮必须通过：

```bash
pnpm test
pnpm build
pnpm lint
node packages/cli/dist/index.js workflow show standard-delivery --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js workflow preflight standard-delivery --repo /Users/zhaoensheng/Projects/tekon
git diff --check
```

自举证据命令：

```bash
node packages/cli/dist/index.js status --run-id run_c1cc3995-a8fc-45ac-a4fe-408eba1b9b50 --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js eval readiness --run-id run_c1cc3995-a8fc-45ac-a4fe-408eba1b9b50 --repo /Users/zhaoensheng/Projects/tekon
```

## 10. 风险与边界

- 当前强 gate 依赖 artifact 内容声明和 schema，不能替代真实人类业务决策。
- `reviewProcess.mode` 能要求独立 agent/process 证据，但还没有统一的外部 process registry。
- 1 小时总超时适合当前 Codex 长程任务；2 小时以上必须保留 no-progress timeout、人工取消入口和 stdout/stderr/outputDir 进展证据，否则会放大资源占用。
- QA signoff 现在绑定 `targetRef`/`validatedRef` 和最新 `qa.validation.ref`；后续要绑定 delivery branch SHA 或 PR head SHA，并处理 PR 更新后的重新验证策略。
- PMO 已有逐节点 `pmo.node-checkpoint` 审计和末端 checkpoint gate；后续要把节点观测产品化到 CLI/Web，并补风险聚合和人工升级入口。
- Tekon 仍不自动 merge、不自动上线、不绕过 human gate。
