# Tekon Codex Self-Bootstrap And Priority Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 2026-06-10 两份评估报告、用户修正意见和当前 Tekon 实现状态收敛为一份可执行优先级方案：先完成 Codex 自举真实 PR 闭环，再按证据价值排序推进后续能力。

**Architecture:** Tekon 继续定位为受控 AI 软件交付编排层，编排器保持确定性，Coding Agent 以 Provider 方式接入。近期路线不扩大到自动合入、自动上线或组织级知识平台，而是围绕真实 PR 证据、交付证据包、Provider 稳定性和可观测性逐步扩展。

**Tech Stack:** TypeScript, pnpm workspace, Vitest, Playwright, SQLite, Git worktree, GitHub CLI, Claude Code CLI, Codex CLI.

---

## 1. 结论摘要

### 1.1 我对两份报告的判断

两份报告的方向判断整体合理：Tekon 最有价值的位置不是再做一个 Coding Agent，而是做“受控 AI 软件交付”的编排、门禁、审计和证据层。报告里对确定性调度、产物驱动、风险分级、人类审批边界、真实需求验证的强调都是正确的。

需要调整的是优先级，不是战略方向：

| 报告原判断                     | 我的判断                            | 调整原因                                                                                                          |
| ------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| P0 要尽快跑 10 个真实需求      | P0 先跑 Tekon 自身 1 个真实需求闭环 | 当前还缺 Codex provider 和真实 PR 自举证据，先扩大样本会放大噪声                                                  |
| Trae Agent 应作为优先 Provider | 先 Codex，后 Trae                   | 用户已明确先适配 Codex；Codex CLI 的 `codex exec` 非交互模式和 sandbox/approval 模型适合 Tekon 当前 provider 抽象 |
| Web 驾驶舱应尽快升级           | 放到 P2                             | 没有真实 run/PR/CI 数据前，Dashboard 容易做成漂亮但不验证价值的壳                                                 |
| SWE-bench 评测值得推进         | 放到 P4                             | 先证明 Tekon 能处理自身真实需求，再做外部 benchmark 才有解释力                                                    |
| 技能沉淀、知识层是长期护城河   | 同意，但放到 P3                     | 技能沉淀需要足够真实执行轨迹，否则只能沉淀主观规则                                                                |

### 1.2 当前路线一句话

先让 Tekon 用 Codex provider 为 Tekon 自己创建一个真实 PR，拿到 run id、provider snapshot、gate、readiness、PR URL 和 CI 状态；之后所有功能优先级都围绕“提升真实闭环成功率、缩短到可审阅 PR 的时间、降低审阅风险”排序。

### 1.3 范围边界

- 不自动 merge。
- 不自动上线。
- 不把 `delivery prepare` 当作真实闭环完成。
- 不把 mock provider、dry-run 或人工手工 PR 当作 P0 证据。
- 不在 P0 扩展多团队、权限体系、知识层、成本平台。
- 不因为报告提到 Trae 就提前切换 provider 顺序。

---

## 2. 资料依据

| 资料                                                                                  | 资料内容                                                                                                          | 对 Tekon 的判断依据                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/reviews/2026-06-10-tekon-comprehensive-evaluation.md`                           | 评估 Tekon 当前工程质量、产品完成度、方向合理性和缺口                                                             | 工程骨架质量高，但价值验证不足；真实 PR 闭环应成为最高优先级                                                                                                                                                                        |
| `docs/research/2026-06-10-external-research-report.md`                                | 对 AI Coding Agent、IDP、Governed AI Engineering、ByteDance 生态做外部调研                                        | Tekon 应避开单点 Coding Agent 竞争，聚焦治理、证据和编排                                                                                                                                                                            |
| OpenAI Codex 官方手册：`https://developers.openai.com/codex/noninteractive`           | `codex exec` 面向脚本和 CI 等非交互场景，支持 stdin、JSONL 和显式 sandbox 设置                                    | Codex provider 可以用 `codex exec` 承载 Tekon 节点执行                                                                                                                                                                              |
| OpenAI Codex 官方手册：`https://developers.openai.com/codex/agent-approvals-security` | Codex CLI 支持 `workspace-write`、`on-request`、默认无网络、危险全访问需要显式开启                                | Tekon 默认应使用 `codex --profile internal --sandbox workspace-write --ask-for-approval on-request --add-dir <TEKON_OUTPUT_DIR> exec`；`--add-dir` 只由 Tekon 受控追加到 artifact 输出目录，并拒绝用户绕过 profile/sandbox/approval |
| OpenAI Codex 官方手册：`https://developers.openai.com/codex/cli/reference`            | CLI 参考列出 `codex exec`、`--sandbox`、`--ask-for-approval`、`--dangerously-bypass-approvals-and-sandbox` 等参数 | Adapter 必须固定安全参数，禁止 provider args 覆盖关键安全边界                                                                                                                                                                       |

事实：报告和代码已经证明 Tekon 有确定性工作流、门禁、审计、artifact store、delivery create-pr 等基础能力。

推断：这些基础能力是否能形成产品价值，必须通过真实 provider 真实需求真实 PR 来验证，不能只靠 mock 或 dry-run。

建议：P0 只做最短真实样本闭环；闭环证据稳定后，再推进更大样本、多 provider 和体验层升级。

---

## 3. 优先级总览

| 优先级 | 名称                      | 时间窗口 | 目标                                                         | 退出标准                                                            |
| ------ | ------------------------- | -------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| P0     | Codex 自举真实 PR 闭环    | 0-2 周   | Tekon 使用 Codex provider 为 Tekon 自己创建真实 PR           | PR URL 存在；CI 状态已记录；报告归档到 `docs/reviews/`              |
| P1-A   | Codex provider 产品化补齐 | 1-3 周   | Codex 不只是 core adapter，而是 CLI/Web/docs/eval 全链路可用 | CLI/Web 可选 Codex；resume 可用；文档和测试齐                       |
| P1-B   | 交付证据包 V2             | 2-4 周   | 让人 5 分钟内判断 PR 是否可接收                              | review surface 按结果、风险、证据、审查、PR 决策组织                |
| P1-C   | 自举样本扩容              | 3-6 周   | 从 1 个 Tekon 样本扩到 5-10 个 Tekon 自身需求                | work-usability 样本报告能量化成功率、人工介入和缺口                 |
| P2-A   | Trae provider 评估和接入  | 5-8 周   | 在 Codex 闭环稳定后验证第二 provider                         | 同一 Tekon 需求可用 Codex/Trae 对比，产出 provider 比较报告         |
| P2-B   | Web Cockpit V2            | 6-10 周  | 把真实 run、PR、CI、gate、审批状态放到一个驾驶舱             | Web 能回答“现在卡在哪、风险是什么、下一步谁处理”                    |
| P2-C   | Provider 协议稳定化       | 6-10 周  | 把 Claude/Codex/Trae 共性固化为 provider contract            | provider fixture、错误码、artifact manifest、timeout/retry 语义统一 |
| P3-A   | 并行 DAG 执行             | 2-4 月   | 对独立节点并行，提高长流程效率                               | DAG 调度、并发上限、聚合 gate 和失败恢复均有测试                    |
| P3-B   | 技能沉淀与反技能          | 2-4 月   | 从真实执行轨迹沉淀可复用经验                                 | 高评分样本可提炼为 skill，失败模式可沉淀为 anti-skill               |
| P3-C   | 成本和效率计量            | 2-4 月   | 让团队知道 Agent 成本和节省时间是否划算                      | 按 run/provider/role 统计耗时、token 或可替代成本、人工介入         |
| P4     | 外部 benchmark 与平台化   | 4 月+    | SWE-bench 子集、Backstage 插件、多团队能力                   | 以真实内部样本为基线，再对外做 benchmark 和平台集成                 |

---

## 4. P0：Codex 自举真实 PR 闭环

P0 的目标不是“Codex adapter 能跑”，而是“Tekon 能用 Codex adapter 处理 Tekon 自己的真实需求，并通过 Tekon 的交付链路创建真实 PR”。

### 4.1 P0 需求选择

优先选择 Tekon 自身小而真实的需求，建议首个需求为：

> 补齐 Codex provider 在 CLI/Web/eval/docs 中的可用性，并生成 Codex provider smoke 使用说明。

这个需求合适的原因：

- 属于 Tekon 自身真实需求，不是玩具样本。
- 改动面覆盖 provider、CLI、Web、文档和 eval，能验证核心链路。
- 风险可控，不涉及线上服务、生产凭证、自动合入或不可逆操作。
- 验收标准清晰：测试通过、文档存在、provider snapshot 为 `codex`、真实 PR 创建成功。

### 4.2 P0 任务拆分

| 任务            | 主要文件                                                                                                             | 完成标准                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Provider schema | `packages/core/src/types/config.ts`, `packages/core/src/types/domain.ts`, `packages/core/src/eval/work-usability.ts` | `provider/defaultAgent/expectedProvider` 均接受 `codex`                     |
| Codex adapter   | `packages/core/src/runtime/codex-adapter.ts`, `packages/core/src/runtime/manifest-artifacts.ts`                      | `codex exec` 可执行，manifest ingestion 与 Claude 行为一致                  |
| CLI 接线        | `packages/cli/src/index.ts`                                                                                          | `tekon run --agent codex` 和 snapshot resume 支持 Codex                     |
| Web 接线        | `packages/web/src/server/api/root.ts`, `packages/web/src/client/App.tsx`                                             | Web run 表单可选 `codex`，API 可创建和恢复 Codex run                        |
| Eval 接线       | `packages/core/src/eval/work-usability.ts`, CLI eval 命令                                                            | 样本记录可要求 `expectedProvider: codex` 和 `require-pr`                    |
| 文档            | `README.md`, `CHANGELOG.md`, `docs/manual/tekon-user-manual.md/html`, `docs/manual/codex-provider-smoke.md/html`     | 明确本地 Codex CLI、认证、manifest、权限边界和 smoke 流程                   |
| 自举 PR         | Tekon CLI delivery 流程                                                                                              | `delivery create-pr --approve-human` 创建真实 PR，并记录 CI 状态            |
| 运行报告        | `docs/reviews/YYYY-MM-DD-tekon-codex-self-bootstrap-report.md/html`                                                  | 归档 run id、provider snapshot、gate、readiness、PR URL、CI、风险和后续动作 |

### 4.3 P0 验收门禁

- `codex --version` 或等价命令能证明本机 Codex CLI 可用。
- Codex provider 默认命令使用 `codex --profile internal --sandbox workspace-write --ask-for-approval on-request --add-dir <TEKON_OUTPUT_DIR> exec`，其中 `--add-dir` 只由 Tekon 受控追加到 artifact 输出目录。
- 用户配置不得覆盖 `--profile`、`--sandbox`、`--ask-for-approval`，不得开启 `danger-full-access` 或 bypass approvals。
- Tekon artifact manifest 能被 Codex 节点写出并被 artifact store 接收。
- 缺失 required artifact 时 run 必须失败，不允许用 agent 自述代替产物。
- `delivery prepare` 不能作为完成证据；必须调用 `delivery create-pr --approve-human`。
- PR 创建后记录 CI 状态；CI 失败也要如实写入报告，不把失败掩盖成成功。

### 4.4 当前进展说明

截至本方案创建时，当前工作区已有未提交的 P0 初稿改动：core provider schema、Codex adapter、manifest ingestion 共享 helper 和部分 unit test 已进入实现中。该状态只能说明 P0 已开始，不能说明 P0 完成，因为 CLI/Web 接线、文档、完整验证和真实 PR 证据还未闭环。

---

## 5. P1：把第一条证据变成可重复能力

P1 的核心不是扩张功能，而是把 P0 的一次成功变成可重复、可诊断、可审阅的能力。

### 5.1 P1-A：Codex provider 产品化补齐

**目标：** Codex 成为 Tekon 的一等 provider，而不是只在 core adapter 层可用。

**任务：**

- [ ] CLI 支持 `--agent codex`、default config、snapshot resume。
- [ ] Web 支持 run form provider 选择、server runtime 创建、snapshot resume。
- [ ] `eval work-usability record` 支持 `expectedProvider: codex`、`require-real-provider`、`require-pr` 的组合。
- [ ] provider capability 检查覆盖 Codex 的网络、sandbox、approval 和工具白名单风险。
- [ ] 文档写清楚本地认证、权限、失败模式和不支持事项。

**退出标准：**

- targeted unit/e2e 全部通过。
- `docs/manual/codex-provider-smoke.html` 可直接交给用户审阅。
- 一次失败的 Codex run 能在 review/eval 中呈现明确失败原因。

### 5.2 P1-B：交付证据包 V2

**目标：** 让 reviewer 不需要翻 `.tekon/` 运行目录，就能判断 PR 是否值得接收。

**建议结构：**

| 层级      | 内容                                          | 默认展示策略 |
| --------- | --------------------------------------------- | ------------ |
| 结果层    | 完成状态、建议接收/退回、阻塞原因             | 首屏展示     |
| 风险层    | 高风险变更、失败 gate、人工介入点             | 失败优先     |
| 证据层    | 验收标准、测试、CI、日志、截图、artifact 链接 | 可展开       |
| 审查层    | Diff 摘要、Reviewer 关注点、潜在回归          | 可展开       |
| PR 决策层 | PR URL、分支、CI、合入建议、回滚说明          | 首屏展示     |

**优先原因：**

真实 PR 创建之后，用户真正消费 Tekon 的入口就是证据包。如果证据包不能支持快速验收，Tekon 的自动化越强，人的不信任越强。

### 5.3 P1-C：Tekon 自身样本扩容

**目标：** 从 1 个自举样本扩展到 5-10 个 Tekon 自身真实需求，先形成内部闭环数据。

**样本类型建议：**

| 类型            | 示例                                       | 价值                    |
| --------------- | ------------------------------------------ | ----------------------- |
| provider 小功能 | Codex args 安全策略、Trae adapter 预研文档 | 验证 provider 抽象      |
| eval 增量       | work-usability 指标补字段                  | 验证评价体系            |
| docs/manual     | 用户手册补真实运行章节                     | 验证 docs-update 工作流 |
| Web 小功能      | Run 列表展示 provider/gate 状态            | 验证前端和 API          |
| CLI 维护        | 拆出一个低风险命令域                       | 验证重构能力            |

**指标：**

- 需求输入到 PR 创建耗时。
- 无中途人工介入到 PR 比例。
- required artifact 完整率。
- gate 一次通过率。
- PR 一次审查通过率。
- 人类 5 分钟内可决策比例。

---

## 6. P2：第二 Provider 和用户体验层

P2 要解决两个问题：Tekon 是否真的 provider-agnostic，以及用户是否能舒服地管理真实 run。

### 6.1 P2-A：Trae provider 评估和接入

**顺序判断：** Trae 是重要方向，但不应抢在 Codex P0 前面。更合理的顺序是先用 Codex 打通 provider contract，再用 Trae 检验 contract 是否足够通用。

**任务：**

- [ ] 梳理 Trae Agent CLI 的输入、输出、权限、工作目录、非交互能力和 artifact 写出方式。
- [ ] 写 `TraeAgentAdapter` 的 contract test，先不接 Web。
- [ ] 用同一个 Tekon 自身需求分别跑 Codex 和 Trae。
- [ ] 输出 provider comparison report：成功率、artifact 完整率、耗时、人工介入、失败可诊断性。

**退出标准：**

- Trae 不需要改动 workflow engine 就能作为 provider 接入。
- provider 比较报告能说明“哪类任务更适合哪个 provider”，而不是只给主观排名。

### 6.2 P2-B：Web Cockpit V2

**目标：** Web 不再只是 CRUD，而是 run 的驾驶舱。

**首屏必须回答：**

- 当前 run 到了哪一步。
- 哪个 gate 失败或等待人工确认。
- Provider 是谁，是否真实 provider。
- 当前 PR、CI 和 evidence 状态是什么。
- 下一步建议动作是什么。

**不做的事：**

- 不做营销式首页。
- 不做复杂项目组合管理。
- 不在没有真实数据前做组织级报表。

### 6.3 P2-C：Provider 协议稳定化

**目标：** 将 Claude/Codex/Trae 的共性固化为稳定 provider contract。

**协议内容：**

- prompt 输入方式：stdin、arg、file 的支持矩阵。
- artifact manifest：路径、schema、required artifact、逃逸检查。
- provider snapshot：command、args、envMode、permission profile、版本信息。
- 错误模型：timeout、missing artifact、unsafe config、process exit、schema invalid、permission denied。
- 安全边界：network、sandbox、approval、danger flags、工具 allow/deny。
- resume 语义：provider config 恢复、不可恢复场景、错误提示。

---

## 7. P3：效率、沉淀和治理能力

P3 的前置条件是已经有足够真实 run 数据。否则这些能力容易变成空框架。

### 7.1 P3-A：并行 DAG 执行

**目标：** 对无依赖节点并行执行，缩短长流程耗时。

**前置条件：**

- 顺序 workflow 在真实样本中稳定。
- gate 和 artifact 依赖关系已经能表达清楚。
- 并行失败时有可解释的恢复策略。

**实现边界：**

- 先支持静态 DAG，不做 LLM 动态拆解 DAG。
- 设置最大并行 Agent 数。
- 并行节点各自独立 worktree。
- 聚合节点统一收敛 gate 结果。

### 7.2 P3-B：技能沉淀与反技能

**目标：** 把成功经验和失败模式沉淀为可复用资产。

**最小机制：**

- 每个 run 记录 demand、provider、artifact、gate、review、PR 结果。
- 高评分样本由人确认后提炼为 skill。
- 重复失败模式沉淀为 anti-skill 或 repo profile rule。
- skill 命中率和效果进入 work-usability 统计。

### 7.3 P3-C：成本和效率计量

**目标：** 回答“Tekon 值不值得用”。

**最小指标：**

- 每个 run 的总耗时和人类介入次数。
- 每个 provider 的成功率和失败原因分布。
- 每个 workflow 的 gate 失败率。
- 每个 PR 的审阅轮次和是否一次通过。
- provider 能提供 token/usage 时记录 token；不能提供时记录运行时长和命令成本替代指标。

---

## 8. P4：Benchmark 和平台化

P4 只在内部真实样本证明 Tekon 有价值后推进。

| 方向               | 推进条件                                 | 产出                                 |
| ------------------ | ---------------------------------------- | ------------------------------------ |
| SWE-bench 子集评测 | P1-C 至少 5 个 Tekon 自身样本完成        | Tekon 编排 vs 单 provider 的对比报告 |
| Backstage 插件     | Web Cockpit V2 可稳定展示 run/PR/CI 状态 | 服务目录中的 Tekon delivery 状态卡   |
| 多团队/权限体系    | 单团队真实使用稳定，审批边界清晰         | 用户、角色、项目、审批权限模型       |
| 组织知识层         | 技能沉淀已有真实命中数据                 | 案例库、模板库、复盘和推荐机制       |
| 选择性开源         | provider contract 和 docs 稳定           | 可公开的核心 engine/provider sample  |

---

## 9. 反优先级清单

这些方向不是不重要，而是不应该在 P0/P1 抢资源：

| 方向                      | 暂缓原因                                           | 重新启动条件                                   |
| ------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| 自动 merge / 自动上线     | 风险边界过大，和 Tekon 当前 Iron Man suit 原则冲突 | 至少 20 个真实 PR 数据证明低风险且审批模型稳定 |
| 大规模组织知识层          | 没有足够真实样本会沉淀成主观规则                   | P1-C 样本扩容完成                              |
| 通用 Agent 平台化         | 会偏离技术基建 B/D 类需求 MVP                      | 单团队 MVP 指标达标                            |
| 复杂多角色组织模型        | 当前 5 角色已经够验证                              | 真实样本显示角色瓶颈                           |
| 过早做外部 benchmark 宣传 | 内部真实闭环还未证明                               | P0/P1 数据能解释 benchmark 结果                |

---

## 10. 执行节奏

### 10.1 第一阶段：P0 收口

- [ ] 完成 Codex core/CLI/Web/eval/docs 接线。
- [ ] 跑 targeted tests 和 full baseline。
- [ ] 用 Tekon 创建 Codex 自举真实 PR。
- [ ] 归档自举运行报告 MD/HTML。
- [ ] 提交代码、文档和报告。

### 10.2 第二阶段：P1 打磨

- [ ] 根据 P0 失败点修 Codex provider 诊断和恢复。
- [ ] 重构 review surface 信息层级。
- [ ] 用 5-10 个 Tekon 自身需求扩容样本。
- [ ] 产出 work-usability 汇总报告。

### 10.3 第三阶段：P2 验证扩展

- [ ] 接入 Trae provider 并做同题对比。
- [ ] 做 Web Cockpit V2。
- [ ] 固化 provider contract。

### 10.4 第四阶段：P3/P4 长线能力

- [ ] 基于真实样本推进 DAG 并行。
- [ ] 建立 skill/anti-skill 沉淀闭环。
- [ ] 加入成本和效率计量。
- [ ] 在内部指标稳定后再做 SWE-bench、Backstage 和平台化。

---

## 11. 风险和应对

| 风险                                            | 影响                      | 应对                                                                              |
| ----------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| Codex CLI 本机认证或权限不可用                  | P0 真实 provider 无法执行 | 先用 `codex doctor` 或 `codex --version` 定位，报告中如实记录；不降级为 mock 通过 |
| Codex 无法按 Tekon manifest 协议稳定写 artifact | run 无法形成可信证据      | 强化 prompt 模板、required artifact 检查和失败诊断                                |
| `delivery create-pr` 因 GitHub 权限失败         | 无法完成真实 PR 证据      | 修复 gh/GitHub 认证或权限；不把 prepare 包替代为 PR                               |
| P0 改动过大导致验证周期拉长                     | 自举闭环迟迟不完成        | 首个 PR 限定为 Codex provider 最小可用面，Web 优先只做选择和 resume               |
| 证据包信息过散                                  | 用户无法快速判断是否接收  | P1-B 优先重构 review surface                                                      |
| 过早接入 Trae 导致 provider 抽象反复变动        | 分散 P0 收口              | Codex 先稳定 contract，再用 Trae 检验通用性                                       |

---

## 12. 最终建议

我建议把未来 4-6 周的目标定成一个明确里程碑：

> Tekon 能连续处理 5 个 Tekon 自身真实需求，其中至少 3 个由 Codex provider 创建真实 PR，所有样本都有 work-usability、readiness、gate、review surface 和 CI 状态证据。

这个里程碑比“接更多 provider”或“做更大 Dashboard”更能证明 Tekon 的核心价值。它能直接回答三个产品问题：

- Tekon 是否真的能把需求推进到可审阅 PR。
- 人是否能基于证据快速判断接受或退回。
- Provider、workflow、gate 和 review 哪一层最影响成功率。

达到这个里程碑后，再推进 Trae provider、Web Cockpit V2、provider contract、技能沉淀和 benchmark，优先级就会由真实数据驱动，而不是由愿景文档驱动。
