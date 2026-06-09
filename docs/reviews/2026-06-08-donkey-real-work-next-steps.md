# Donkey 真实工作可用下一步清单

日期：2026-06-08

范围：综合 5 份飞书产品方案、本地实现、本地审阅文档和当前 SQLite 落库模型，判断 Donkey 要成为“我能在工作上真实使用的工具”还需要补齐什么。本文不以全面自动化为目标，不把自动合入、自动上线、生产权限变更、组织级多租户平台纳入近期范围。

## 0. 资料来源

为避免把内部高权限 URL 写入仓库，本文只记录资料标题和使用方式：

- `[Raw]Donkey-智能化研发流程`：提取原始目标，即人负责前期需求澄清，后续由角色 Agent 和 workflow 推进。
- `[Beta-G]Donkey：面向技术基建团队的 AI 自动交付系统产品方案`：采用近期收敛方向，即技术基建/B-D 类需求、推进到 PR、证据包和高危受控。
- `[Alpha-Q]Donkey — AI Agent 驱动的智能化研发流程产品方案`：参考角色 Agent、人工介入、全链路自动化远景和非目标。
- `[Alpha-G]Donkey：AI Native 产研流程执行系统完整产品方案`：参考八大模块、Project Cockpit、Knowledge & Learning 和阶段规划。
- `[Alpha-D]Donkey — 智能化研发流程 · 产品方案`：参考角色五元组、工具/技能体系、四级人在环路和审计透明。
- 本地实现与文档：`packages/`、`workflows/`、`README.md`、`CHANGELOG.md`、`docs/manual/`、`docs/reviews/`、`docs/technical/`。

## 1. 判断口径

本文把“真实工作可用”定义为：

- 用户能把一个低到中风险的真实工作需求交给 Donkey。
- Donkey 能在受控仓库里完成需求塑形、执行、验证、审阅材料整理和 PR 准备。
- 人能在 5 到 10 分钟内判断本次结果是否值得继续推进。
- 远端副作用只发生在明确批准之后，且不自动 merge、不自动上线。
- 失败时能看到失败点、证据、下一步命令和是否需要人工介入。

这个口径比“Demo 能跑”更高，但比“全自动研发组织”低很多。

## 2. 已经具备的事实基础

飞书方案收敛出的近期方向很明确：Donkey 的完整远景包含需求池、Workflow Orchestrator、Role Hub、Tool Adapter、Artifact Center、Quality Gate、Project Cockpit、Knowledge & Learning；但近期最应该落在技术基建和内部工具的 B/D 类需求，默认推进到可审 PR，由人最终决策。

本地实现已经具备一批工作可用骨架：

- CLI/Web 入口：`run`、`status`、`resume`、`review`、`delivery`、`eval`、Web dashboard 和 human approval。
- 需求塑形：`demand shape/approve/show`、`run --demand-file`、Web 需求塑形和批准入口。
- 受控 workflow：`standard-feature`、`bugfix`、`test-improvement`、`docs-update`、`plan-only`，以及 `workflow select` / `eval workflow-selection`。
- 状态与审计：SQLite 已落库 demand、project、workflow、node、artifact、gate、human decision、audit、worktree lease、delivery PR、provider snapshot。
- 执行隔离：workflow 主路径已接入 git worktree lease，节点变更会进入 `donkey-delivery/<runId>` 分支。
- Gate 与 evidence：repo profile 驱动验证命令，支持 `notApplicable` 明示不适用，内置 security scan，artifact schema 和 readiness。
- 交付链路：`delivery prepare`、人工批准后的 `delivery create-pr`、只读 `delivery ci-status` / `delivery ci-watch`。
- 审阅面：CLI/Web review surface 能聚合 readiness、diff、artifact 正文、gate log、PR 包、Evidence Navigation 和 Gate Failure Triage。
- 样本评估：`eval work-usability --samples` 和 `record` 已具备真实样本、真实 provider、真实 PR、隔离证据和远端审批的记录与报告字段。

当前仓库根目录没有保留 `.donkey` 运行态库，因此本文对“本地落库”的判断主要来自数据库表结构、仓库内可提交审阅报告和已实现的读写路径；真实 run 级证据仍需要后续用样本清单沉淀。

## 3. 核心结论

Donkey 现在已经不是纯概念或脚手架，它具备“受控执行到可审材料”的骨架。但它还不能被直接当成日常稳定工具，主要缺的是三类东西：

1. **真实样本证据**：现在代码路径和 fixture 覆盖多，真实 Claude Code / Codex / 自定义 provider 在真实仓库中持续跑通的证据少。
2. **人的决策体验**：review surface 已经能看材料，但通知、审批摘要、影响文件、风险说明和批准/拒绝入口还不够贴近日常工作流。
3. **安全与恢复信任**：已有 worktree、CommandGateway、secret scan 和 human gate，但还缺生产级隔离证据、真实中断恢复样本和远端副作用审计样本。

所以最近不应该继续扩远景角色或做更复杂的自动规划，而应该把“真实仓库、真实 provider、真实 PR、真实证据、真实失败恢复”打穿。

## 4. P0：不补齐不建议日常使用

| 缺口                     | 现在的状态                                                                                                 | 真实可用最低目标                                                                                                        | 建议下一步                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 真实 provider 端到端证据 | Claude Code artifact manifest 协议已有，mock/fixture 覆盖较多                                              | 至少 5 个真实 provider run 能产出合格 artifacts，通过 schema/readiness 或给出可恢复失败                                 | 选 1 个内部工具仓库先跑 3 个小需求，记录缺 artifact、schema fail、gate fail 和人工修复成本 |
| 真实样本集               | 有 `eval work-usability` 和报告导出，样本本身还不足                                                        | 10 个样本、5 个 ready run、5 个真实 provider run、2 个真实 PR、全部有隔离证据                                           | 建立 `docs/reviews` 可提交样本清单，每次真实 run 后用 `record` 写入                        |
| 审批与通知               | CLI/Web 已生成可复制审批摘要，并支持 `eval approval-summary`；Web 可处理 human gate，CLI 可 approve/reject | 用真实 run 验证摘要是否足够让 reviewer 在飞书或 Web 中判断风险；后续再接飞书 IM                                         | 收集真实审批样本，检查风险、命令、影响文件、证据链接和批准/拒绝入口是否完整                |
| 真实 PR 与远端 CI        | `delivery create-pr`、`ci-status`、`ci-watch` 已有实现和 fake 测试；当前主要围绕 GitHub CLI / `gh` 路径    | 至少 2 次受控远端 PR，记录 PR URL、checks、失败恢复和无 checks 场景；非 GitHub host 或其它 CI 聚合需要明确 adapter 边界 | 准备专用测试远端仓库，固定 `gh auth status`、base branch、PR body 脱敏检查                 |
| 仓库画像适配             | repo profile、`commandRef`、preflight、`notApplicable` 已有                                                | 在非 pnpm 或脚本名不同的真实仓库也能正确给出命令建议和阻断                                                              | 用 1 到 2 个不同技术栈仓库验证，不把工具不适配误判成需求失败                               |
| 中断恢复                 | provider snapshot 和 completed marker 已有                                                                 | 真实长任务被中断后，不换 provider、不误推进、不丢 evidence                                                              | 人为制造 CLI/Web 中断和 pending human gate 恢复样本                                        |
| 安全隔离                 | worktree、CommandGateway、secret scan、artifact 拦截已有                                                   | 证明主工作区不被改、push/PR 只能走 delivery、人类未批准时无远端副作用，日志不泄密                                       | 加真实 provider 越界写入/静默 push/密钥输出的对抗样本；必要时引入 OS/container 级隔离      |

## 5. P1：补齐后才像日常工具

| 能力               | 为什么重要                       | 建议形态                                                                                   |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------------------------ |
| 5 分钟审阅工作台   | 人不能靠翻 `.donkey` 文件做决策  | Web/CLI 默认突出失败项、高风险项、影响文件、验收标准覆盖、PR body 和下一步命令             |
| Gate 失败修复闭环  | 真实使用里失败是常态             | 对 missing command、test fail、schema fail、secret fail 给出可执行修复建议，并支持局部重试 |
| QA 证据            | UI/Web 改动只跑单测不够          | 支持 Playwright 步骤、截图、失败截图和验收标准映射进入 evidence                            |
| 需求入口贴近工作流 | 当前需求塑形是确定性启发式       | 支持从飞书文档、issue、PRD 摘要导入；保留人工批准，不把开放问题当成已解决                  |
| 角色和工具治理     | 角色资产化是长期价值，但不能失控 | 角色版本、变更审查、工具权限预览、角色修改后的 smoke/e2e 要求                              |
| 数据飞轮           | 没有样本就无法判断真实成功率     | 每次 run 记录成功率、耗时、人工介入、失败原因、返工次数和最终是否采纳                      |

## 6. P2：后置，不阻塞第一批真实使用

- 动态 workflow 非 dry-run 自动执行。
- 多 Agent 并行协作和复杂角色矩阵。
- Workflow Studio / 可视化配置平台。
- Knowledge & Learning 自动沉淀。
- 多项目、多团队、远程多租户 dashboard。
- 成本预算治理和组织级权限平台。
- 上线、运营、反馈闭环和生产写操作。

这些方向都与飞书完整远景一致，但都不应该抢在真实 provider 与真实 PR 证据之前。

## 7. 推荐的最近实施顺序

### 第 1 步：把“可试用边界”固定下来

只允许以下场景进入第一批真实使用：

- 内部工具、研发效能、测试补齐、文档补齐、低风险 bugfix。
- 不涉及生产数据写入、权限扩大、密钥、支付、强合规、复杂视觉设计。
- 必须有仓库画像、验证命令、人工验收标准和回滚/拒绝路径。

### 第 2 步：验证真实审批样本和通知入口

CLI/Web 已有可复制审批摘要；下一步不再是补入口，而是用真实 run 检查摘要是否足够 reviewer 独立判断。每个真实审批样本至少记录：

- run id、node id、decision id。
- 需求标题和当前 workflow 阶段。
- 风险标签和触发 human gate 的原因。
- exact command 或将要产生的远端副作用。
- 影响文件和 diff 摘要。
- readiness 失败项、gate log、artifact 和 PR 包链接。
- 可直接复制执行的批准命令、拒绝命令、Web 入口。
- reviewer 是批准、拒绝还是要求补材料。

真实样本证明摘要稳定后，再接飞书 IM 推送；通知只做分发和链接，不绕过 human gate。

### 第 3 步：跑真实样本，不再只跑 fixture

第一批样本建议这样定：

- 2 到 3 个相似内部工具仓库。
- 10 个真实或历史需求。
- 至少 5 个使用真实 provider。
- 至少 2 个创建真实测试 PR。
- 每个样本写入 `eval work-usability record`，生成 Markdown/HTML 报告。

### 第 4 步：用失败样本改工具

不要只记录成功样本。每次失败至少归因到：

- 需求边界不清。
- provider 没按 artifact 协议输出。
- repo profile 命令不适配。
- gate 失败但建议不可操作。
- 人工审批上下文不足。
- 安全边界或远端副作用不可信。
- 恢复/重试后状态不一致。

这些归因应反向进入 repo profile、workflow 模板、角色 prompt、审批摘要和 readiness 规则。

## 8. “可以开始真实试用”的判定线

达到以下条件后，可以把 Donkey 作为个人或小团队的受控工作工具试用：

- 10 个样本有记录，`eval work-usability` 达到默认阈值或有明确豁免理由。
- 至少 2 个真实 PR 创建成功，PR body、CI 状态和失败恢复路径有证据。
- 至少 2 次中断恢复样本通过，恢复时 provider 不被替换，未误推进 workflow。
- 审批摘要能让 reviewer 不打开本地目录也能判断风险和下一步。
- 所有远端副作用都有 human decision、audit event、批准人和时间。
- 真实 provider 样本没有出现主工作区越界写入、未脱敏密钥、未批准 push/PR。

## 9. 明确不建议近期做

- 不做自动 merge。
- 不做自动上线。
- 不做生产数据库、权限、密钥或发布系统写操作。
- 不做远程多租户服务。
- 不先扩展复杂角色矩阵。
- 不把动态 workflow 直接从建议升级为自动执行。

## 10. 最终判断

作为“真实工作可用工具”，Donkey 下一阶段最缺的不是更多概念模块，而是更硬的闭环证据和更顺手的人类决策体验。

最近最值得做的三件事是：

1. **真实审批样本和通知入口**：当前已有可复制审批摘要；下一步要用真实 run 验证摘要质量，并在需要时接入飞书 IM。
2. **真实样本集**：用 10 个受控需求证明真实 provider、真实仓库、真实 PR 的稳定边界。
3. **安全与恢复样本**：证明失败、中断、拒绝和高风险动作都不会把系统带到不可解释状态。

只要这三件事打实，Donkey 就可以从“本地验收骨架”进入“受控工作试用工具”。在此之前，它应该只用于低风险、可回滚、有人工审阅的研发辅助场景。
