# Donkey 工作真实可用能力缺口分析

日期：2026-06-08

范围：综合 5 份飞书产品方案、本地实现、README/CHANGELOG、V2 用户手册、Phase 3/Dogfooding/Final Acceptance/工作可用化增量报告，判断 Donkey 要成为“我能在真实工作中使用的工具”还需要补齐什么。本文不讨论全面自动化，不把自动 merge、自动上线、生产权限变更、跨团队多租户平台作为近期目标。

## 1. 资料来源

本报告读取并综合了用户提供的 5 份飞书 Docx 文档。为避免把内部高权限 URL 写入仓库，本文只记录标题、版本标识和读取日期，不落原始飞书链接。

| 来源       | 标题 / 版本标识                                                                 | 读取日期   | 使用方式                                                                    |
| ---------- | ------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------- |
| 飞书文档 1 | `[Raw]Donkey-智能化研发流程`                                                    | 2026-06-08 | 提取原始设想：人负责需求澄清，后续由角色 Agent 和 workflow 推进。           |
| 飞书文档 2 | `[Beta-G]Donkey：面向技术基建团队的 AI 自动交付系统产品方案`                    | 2026-06-08 | 作为近期收敛版本，重点采用“技术基建/B-D 类需求/自动到 PR/证据包/高危受控”。 |
| 飞书文档 3 | `[Alpha-Q]Donkey — AI Agent 驱动的智能化研发流程产品方案`                       | 2026-06-08 | 参考完整链路、角色 Agent、人工介入和风险判断。                              |
| 飞书文档 4 | `[Alpha-G]Donkey：AI Native 产研流程执行系统完整产品方案`                       | 2026-06-08 | 参考完整远景对象模型、八大模块、项目驾驶舱、知识沉淀和分阶段规划。          |
| 飞书文档 5 | `[Alpha-D]Donkey — 智能化研发流程 · 产品方案`                                   | 2026-06-08 | 参考角色五元组、工具/技能体系、四级人在环路和全链路审计。                   |
| 本地实现   | `packages/`、`roles/`、`workflows/`                                             | 2026-06-08 | 核对当前已经有代码支撑的能力和 mock/dry-run 边界。                          |
| 本地文档   | `README.md`、`CHANGELOG.md`、`docs/manual/`、`docs/reviews/`、`docs/technical/` | 2026-06-08 | 核对已声明能力、验收证据、已知限制和未完成项。                              |

## 2. 结论

Donkey 当前已经从概念推进到“本地受控 workflow 骨架可跑”的阶段：CLI/Web、SQLite 状态、Artifact/Audit、Gate、worktree、PR 准备包、受人工批准的 PR 创建、readiness 评估都有代码和测试支撑。

但它离“真实工作可用”还差一层证据和体验：真实仓库端到端稳定性、可审阅体验、真实 PR 证据、安全隔离证据和最小数据闭环仍不足。本轮已经补齐真实 provider artifact 协议、repo profile 驱动 gate 和 provider 快照恢复的第一版代码；下一阶段不应该继续扩展远景角色或上线链路，而应先把“给一个真实内部工具仓库的小需求，Donkey 能受控产出可审 PR，人在 5 分钟内判断能不能接受”打实。

优先级最高的补齐方向是：

1. 当前已接线的真实 provider 是 Claude Code；本轮已提供 Donkey artifact manifest 协议，后续需要真实仓库样本证明 provider 能稳定按协议产出结构化 artifacts。Codex 目前属于后续或自定义 provider，同样要先遵守 artifact 协议后才能声明可用。
2. 在 2-3 个受控真实仓库上完成 10 个左右 B/D 类需求的端到端证据，不再只依赖 mock fixture。
3. workflow gate 已开始使用 `.donkey/repo-profile.yaml` 的仓库命令；后续要补缺失命令修复引导，并用非 pnpm 真实仓库验证。
4. resume/recovery 已落库 provider/config snapshot 和 completed marker；后续要用真实长任务中断样本证明不会误推进或降级成 mock。
5. Web/CLI 的验收面需要展示 diff、artifact 正文、gate 日志、readiness 失败原因和下一步命令，而不只是路径和计数。
6. 高风险边界要从“声明式 network/tool policy”升级到可验证的隔离与审计证据，至少证明真实 provider 不能越权写主工作区、不能静默 push、不能泄露密钥。

## 3. 当前事实

### 3.1 飞书方案收敛出的近期目标

5 份飞书方案从完整远景到收敛版逐步形成共识：

- 原始目标是把传统 PM/设计/RD/QA/PMO/Ops 流程抽象为角色化、可编排、可审计的 Agent 研发流程。
- 完整远景包含需求池、Workflow Orchestrator、Role Hub、Tool Adapter、Artifact Center、Quality Gate、Project Cockpit、Knowledge & Learning。
- 近期最现实的落点不是组织级全自动产研系统，而是技术基建/内部工具场景中的 B/D 类需求，默认推进到可验收 PR，最终由人审查和接受。
- 高风险动作必须受控：不自动合入、不自动上线、不自动做生产写操作或权限扩大。

### 3.2 本地已有代码支撑的能力

| 能力                     | 本地依据                                                                                                          | 判断                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CLI 本地入口             | `packages/cli/src/index.ts`                                                                                       | `init/run/status/pause/resume/cancel/role/workflow/constraints/log/clean/delivery/eval` 已有入口。                                        |
| SQLite 状态与审计        | `packages/core/src/db/migrations.ts`、`packages/core/src/db/repositories.ts`、`packages/core/src/audit/logger.ts` | 运行、节点、gate、artifact、human decision、worktree lease、delivery PR 状态可落库。                                                      |
| Artifact Store           | `packages/core/src/artifact/store.ts`、`packages/core/src/artifact/schemas.ts`                                    | artifact 版本化写入 `.donkey/runs`，schema 支持验收标准、criteria evidence 和安全发现。                                                   |
| Workflow Engine          | `packages/core/src/workflow/engine.ts`                                                                            | 模板 workflow 可执行，支持 role prompt、gate、human gate、worktree lease、repair node。                                                   |
| Worktree 隔离            | `packages/core/src/runtime/worktree-manager.ts`                                                                   | 节点在 git worktree 中执行，变更可提交并推进到 `donkey-delivery/<runId>`。                                                                |
| Command Gateway          | `packages/core/src/runtime/command-gateway.ts`                                                                    | 以 argv 执行命令，拒绝 shell 元字符、强制删除、force push、部分网络命令和越界 cwd。                                                       |
| Gate                     | `packages/core/src/gate/runners.ts`                                                                               | 支持 build/test/lint/e2e/security-scan/human/schema；内置 security scan 可扫明显密钥。                                                    |
| Claude Code adapter 接线 | `packages/core/src/runtime/claude-code-adapter.ts`、`packages/cli/src/index.ts`                                   | CLI 支持 `--agent claude-code`，并有 provider capability 检查和 smoke 证据。                                                              |
| PR 准备和创建            | `packages/core/src/delivery/pr-package.ts`、`packages/core/src/delivery/scm.ts`                                   | `delivery prepare` 可生成本地 PR 包；`delivery create-pr --approve-human` 可 push 和 `gh pr create`，状态落库。                           |
| Readiness                | `packages/core/src/eval/work-readiness.ts`                                                                        | required checks 覆盖 workflow、audit、validation gates、delivery package、PR prepared、human gate、验收证据和安全扫描。                   |
| Web Dashboard            | `packages/web/src/client/App.tsx`、`packages/web/src/server/api/root.ts`                                          | 本地 dashboard 可看 overview、readiness、diff、artifact 正文、gate logs、PR 包、audit、roles/workflows/settings，并批准/拒绝 human gate。 |

### 3.3 当前仍主要是 mock/dry-run 或受控 fixture 的能力

| 能力              | 当前状态                                                                                                                           | 判断                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 动态 workflow     | `run --dynamic` 当前强制 `--dry-run`，CLI 使用 `createDynamicMockAdapter`                                                          | 还不是 PM LLM 真实规划，也不会直接进入执行。                                           |
| 真实 Agent 端到端 | Claude provider smoke 已通过，但主 workflow 稳定执行证据不足                                                                       | 证明了 provider 可调用，不证明真实任务能产出合格 artifacts 并通过 gates。              |
| PR 创建           | 代码支持并有 fake fixture 测试；历史 dogfooding 记录 `PR URL=not_created`                                                          | 需要真实受控远端仓库证据。                                                             |
| Web 产品面        | 能审阅最新 run、处理 human gate，查看 readiness、diff、artifact 正文、gate logs 和 PR 包，并可受控发起 run、执行 prepare/create-pr | 仍缺多 run 审阅流和 artifact/gate/audit 深度上下文导航。                               |
| 仓库画像          | init 可生成 `repo-profile.yaml`，内置 workflow gate 通过 `commandRef` 解析画像命令                                                 | 已从硬编码模板命令推进到画像驱动；仍缺更友好的缺失命令修复引导和真实非 pnpm 仓库证据。 |
| 安全隔离          | CommandGateway 有静态拒绝，provider profile 有声明                                                                                 | 还不是 OS/container 级隔离；真实 provider 内部工具调用边界需要证据。                   |

## 4. P0：先补齐，否则不建议用于真实工作

### P0-1 真实 Agent 产物协议

修复前事实：`createMockAgentAdapter` 会直接写结构化 artifacts；`createClaudeCodeAdapter` 仅执行 Claude CLI 并返回 stdout/stderr 路径，没有把 `DONKEY_OUTPUT_DIR`、artifact schema、所需 artifact 类型和写入协议明确传给 provider，也没有把 provider 输出解析为 artifact store 记录。

影响：真实 Claude Code 即使完成了代码修改，也可能因为没有 `demand-card/prd/code-changes/test-report/review-report/delivery-package` 等结构化产物而无法通过 schema/readiness，或者 evidence package 只能看到日志路径。未来 Codex 或自定义 provider 也应先满足同一产物协议，再进入可用性声明。

修复前本地依据：`packages/core/src/runtime/mock-agent-adapter.ts` 由 mock 直接调用 Artifact Store；`packages/core/src/runtime/claude-code-adapter.ts` 只把 stdout/stderr 作为 `outputFiles` 返回；schema gate 依赖 DB 中已记录的 artifact。因此当时 `--agent claude-code` 接线不等于真实 workflow artifact 闭环已经成立。当前已改为通过 manifest 收集并校验 provider artifact。

最低目标：

- Engine 在 prompt 和环境变量中明确声明 `DONKEY_OUTPUT_DIR`、本节点必须产出的 artifact 类型、每类 artifact 的 JSON/YAML/Markdown schema。
- Real adapter 能收集输出目录中的 artifact 文件，验证 schema 后写入 Artifact Store。
- 若真实 Agent 只改代码不产物，节点必须失败并给出可恢复错误，而不是继续推进。

当前状态：2026-06-08 本轮已实现第一版 manifest 协议和失败阻断；仍需真实仓库样本证明 Claude Code 能稳定遵守该协议。

### P0-2 真实仓库端到端验收集

事实：现有 dogfooding 是 `scm-dry-run`；Final Acceptance 明确真实 PR、生产级真实 LLM workflow 不在通过范围内。工作可用化增量报告也把真实 coding provider 在受控真实仓库中的端到端稳定执行证据列为未完成；结合当前 CLI 实现，近期应优先验证已接线的 Claude Code，Codex 仍属于后续或自定义 provider。

影响：没有真实任务样本，就无法判断失败率、返工成本、prompt/role 是否有效、gate 是否足够、人工审阅是否省时间。

最低目标：

- 选择 2-3 个相似内部工具仓库，准备 10 个 B/D 类真实需求或历史 issue。
- 每个样本记录 run id、provider、仓库、需求类型、是否产出 PR 包、是否创建真实 PR、gate 结果、人工介入次数、返工原因。
- 达标线不需要高：先证明 5 个以上需求能从输入走到可审 PR 包，其中至少 2 个创建真实测试 PR。

### P0-3 仓库画像驱动 Gate

修复前事实：`repo-profile.yaml` 能检测 build/typecheck/lint/test/e2e/security 命令，但 `workflows/standard-feature.yaml` 和 `workflows/bugfix.yaml` 仍硬编码 `pnpm build/lint/test`。用户手册也说明“workflow gate 仍以模板内配置为准，尚未自动改写验证命令”。

影响：真实仓库只要不是 pnpm 或脚本名不同，Donkey 就会在 gate 层失败；这会把“工具不适配”误判成“需求实现失败”。

最低目标：

- `donkey init` 后提供 gate preflight，列出将运行的 build/typecheck/lint/test/e2e/security 命令。
- Workflow gate 支持引用 repo profile，例如 `commandRef: build`、`commandRef: test`。
- 缺失命令时不默认跳过；要求用户在 repo profile 中确认替代命令或显式标记“不适用”。

当前状态：2026-06-08 本轮已将内置 workflow 改为 `commandRef`，并新增 `workflow preflight`；后续仍需补更友好的缺失命令修复引导。

### P0-4 恢复与 Provider 一致性

修复前事实：CLI `resume` 固定使用 `createMockAgentAdapter()`，没有沿用原 run 的 provider 配置。Engine 在存在 active lease 且 node 为 `running/paused` 时可能直接切到 `awaiting-gate`，这需要更强的“Agent 已完成”标记支撑，否则中断恢复有误推进风险。

影响：真实 provider 跑到一半暂停或崩溃后，恢复可能换成 mock 或跳过真实执行，readiness 可能建立在错误证据上。

修复前本地依据：`packages/cli/src/index.ts` 的 `commandResume` 固定创建 `createMockAgentAdapter()`；`packages/web/src/server/api/root.ts` 会从 `.donkey/config.yaml` 读 `defaultAgent`，但 run 自身没有落库 provider 快照。CLI 和 Web 的恢复口径不一致。当前已落库 run provider/config snapshot，并在 CLI/Web resume 前校验。

最低目标：

- run 创建时落库 provider、adapter config 摘要和安全 profile，CLI/Web resume 必须沿用或要求人工选择。
- 每个节点有明确 completion marker：Agent exit code、artifact schema 通过、工作区提交结果三者至少两类可验证。
- 对 `running` 旧状态做 stale 检测；不能仅凭 lease 存在就进入 gate。

当前状态：2026-06-08 本轮已落库 provider/config snapshot，CLI/Web resume 会在审批前校验并按 snapshot 重建 adapter；Engine 增加 role-run completed marker。生产级恢复仍需要真实长任务中断样本。

### P0-5 人工验收面可决策

修复前事实：Web 展示 artifact 列表、gate 列表、audit 摘要和 human gate；artifact 只显示 summary/path，不显示正文；没有 diff viewer、gate log viewer、readiness 结果、PR 包内容和下一步命令。

影响：用户仍需要回终端翻 `.donkey` 文件、手动找 diff 和日志；这不满足“真实工作中 5 分钟判断是否接受”的目标。

最低目标：

- Web/CLI 至少能展示：PR body、PR package、git diff 摘要、artifact 正文、gate log、readiness failed checks。
- 结果页默认突出失败项、高风险项、未覆盖验收标准和建议下一步。
- 每个 artifact/gate/audit 事件能互相跳转，减少人工查路径。

当前状态：2026-06-08 本轮已实现第一版 review surface：core 聚合 readiness、PR body/package、delivery diff、artifact 正文、gate log 和下一步命令；CLI 新增 `review --run-id`；Web 新增 Readiness、Diff、Artifact 正文、Gate Logs、PR 包和下一步区块。后续增量已补 Web 使用 session token 发起模板 run、执行 `delivery prepare`、触发受人工批准的 `delivery create-pr` 入口，并提供 artifact/gate/audit 到正文、日志和 PR 包的基础锚点互跳；深度上下文导航仍需继续打磨。

### P0-6 真实 PR 创建的受控证据

事实：`delivery create-pr --approve-human` 有实现和测试，但历史 dogfooding 仍记录真实 PR 未创建。真实工作可用至少要证明 push/PR 在受控仓库可成功，失败恢复可读。

影响：自动跑到本地分支和本地 PR 包仍需要用户手工完成最后一步，工具价值会打折。

最低目标：

- 准备一个专用测试远端仓库，执行至少 2 次真实 `delivery create-pr --approve-human`。
- 记录 `gh auth status` 前置检查、远端 URL、PR URL、失败恢复路径、PR body 脱敏检查。
- 不加入自动 merge；PR 创建后只进入人工审阅。

### P0-7 最小安全隔离证据

事实：CommandGateway 能拒绝部分危险命令；内置 security scan 能扫明显密钥；但 `CommandPolicy.network` 不是 OS 级隔离，provider profile 目前是声明式证据。

影响：真实 Agent 一旦可执行工具，就必须证明它不能越权写主工作区、不能静默 push、不能把密钥写进产物或日志。

最低目标：

- 真实 provider 只在 worktree 下写入，主工作区保持不变，测试覆盖越界 cwd/文件写入。
- provider 子进程环境变量默认脱敏；日志和 artifact 写入前做敏感模式扫描。
- git push、gh pr create、删除、生产写操作只能走显式 human approval，不允许通过角色 prompt 绕过。

## 5. P1：补齐后才像日常工具，而不是验收脚手架

| 缺口               | 当前状态                                                                            | 建议目标                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 需求塑形入口       | CLI 直接把一句话作为 demand body；动态路径是 dry-run mock                           | 增加 `demand create/shape/approve` 或 Web 表单，先生成需求卡、非目标和验收标准，由人确认后再执行。                        |
| Workflow 选择      | 标准模板和 bugfix 模板可用；动态不可执行                                            | 提供受控 workflow selection：标准功能、bugfix、测试补齐、文档更新、仅方案；动态规划先作为建议，人工确认后保存模板再执行。 |
| Gate 失败体验      | 有 autoFix repair node，但真实 provider 证据不足                                    | gate 失败后给出失败分类、关联日志、建议修复命令和是否重试；连续失败后阻断并保留上下文。                                   |
| 角色/工具治理      | 角色目录和 tools.yaml 已有，Web 只读展示                                            | 增加角色版本、变更审查、工具权限预览，修改角色后要求 smoke/e2e 通过。                                                     |
| 通知与审批         | Web 本地处理 human gate                                                             | 接入飞书 IM 或至少生成可复制审批摘要：风险、命令、影响文件、同意/拒绝入口。                                               |
| CI/远端状态        | 可运行本地 gate；release readiness 有远端 CI 证据脚本                               | PR 创建后能查询远端 CI 状态，把结果写回 delivery evidence。                                                               |
| 真实 QA 证据       | 当前主要跑已有 test 命令                                                            | 对 UI/Web 类任务支持 Playwright 截图、失败截图、关键路径步骤和验收标准映射。                                              |
| 基准数据           | 有 metrics/readiness，但缺少持续样本集                                              | 建立 `docs/reviews` 或专门数据文件记录每次真实 dogfooding 的成功率、耗时、人工介入和失败原因。                            |
| 文档验收状态一致性 | 本轮已更新 `docs/reviews/2026-06-08-donkey-work-usable-increment.md` 和 HTML 审阅版 | 后续每次实现后仍需同步 Markdown/HTML，并在最终 reviewer 复查后写入正式结论。                                              |

## 6. P2：增强长期复用，不阻塞第一批工作可用

| 能力                       | 为什么不是 P0                                          | 建议时机                            |
| -------------------------- | ------------------------------------------------------ | ----------------------------------- |
| 多项目/多团队 dashboard    | 当前目标是个人或小团队本地工具，远程多租户不是近期目标 | 等 10-20 个真实需求跑通后再做。     |
| Knowledge & Learning Layer | 没有稳定执行数据前，自动沉淀容易沉淀噪音               | 先人工记录复盘，再抽取模板和规则。  |
| Workflow Studio            | 早做会变成配置平台                                     | 等 P0/P1 模板稳定后再做可视化编辑。 |
| 成本控制                   | 本地 MVP 先可记录 token/cost，完整预算治理可后置       | 真实 provider 连续运行后补。        |
| Ops/Data/上线反馈闭环      | 用户明确不考虑全面自动化，且风险更高                   | PR 交付稳定后再讨论。               |
| 多 Agent 并行协作          | 当前单 Agent 节点稳定性更关键                          | 串行闭环稳定后再增加并行。          |

## 7. 建议的最近 2 周后续实施顺序

1. 用真实 Claude Code 任务验证 artifact manifest 协议：记录缺失 artifact、schema 失败和修复重试成本。
2. 用 1-2 个非 pnpm 或脚本名不同的仓库验证 repo profile gate preflight，补缺失命令修复引导。
3. 制造真实 provider 中断/恢复样本，验证 provider snapshot、completed marker 和 human gate resume。
4. 用真实 run 验证第一版 review surface 和 Web 执行入口是否足够 5 分钟决策，继续打磨 artifact/gate/audit 深度互跳和多 run 审阅流。
5. 建立受控真实仓库验收集，跑 5 个任务，至少 1 个真实 PR。
6. 把每次 run 的结论写入 `docs/reviews/`，形成第一版 dogfooding 数据表。

## 8. 明确不建议近期做

- 不做自动 merge。
- 不做自动上线。
- 不做生产数据库、权限、密钥或发布系统的真实写操作。
- 不做远程多租户服务。
- 不先扩展十几个角色或复杂 UI Studio。

## 9. 最终判断

Donkey 现在已经具备“工作可用工具的骨架”，但还不是“可以直接依赖的工作工具”。最短路径不是扩大自动化范围，而是把真实 provider、真实仓库、真实 PR、真实证据和真实恢复打穿。

只要 P0 补齐，Donkey 就可以进入一个合理的试用边界：在 2-3 个相似内部工具仓库中处理低中风险 B/D 类需求，默认推进到 PR 包或测试 PR，由人审阅、决定合入，并把失败原因沉淀为 repo profile、角色规则和 workflow 模板。

## 10. 2026-06-08 实施进展

本轮已完成 P0-1/P0-3/P0-4/P0-5 的第一版实现：

- P0-1：Claude Code adapter 支持 `DONKEY_OUTPUT_DIR`、`DONKEY_ARTIFACT_MANIFEST`，真实 provider 产物通过 manifest 校验 schema 后写入 Artifact Store；缺少必需 artifact 时节点失败。
- P0-3：内置 workflow 改为 `commandRef` 引用 `.donkey/repo-profile.yaml`，CLI 新增 `workflow preflight` 展示 gate 命令解析结果。
- P0-4：run 创建时落库 provider/config 摘要，CLI/Web resume 使用 provider 快照；Engine 增加 role-run completed marker，避免 stale `running` 节点直接进入 gate。
- P0-5：新增 core review surface、CLI `review --run-id` 和 Web 审阅区，聚合 readiness failed checks、PR body/package、delivery diff、artifact 正文、gate log 和下一步命令；后续补齐 Web 受控发起 run、delivery prepare/create-pr 入口和基础 artifact/gate/audit 锚点互跳。

本轮 P0-5 已完成最高思考 reviewer 复查，结论为 APPROVED。review surface 的 artifact/gate log 读取、readiness/evidence artifact 读取和 delivery diff 均已补安全边界测试；DB 中 `project.repoPath` 指向外部目录时，review readiness 不会采信外部 artifact。

仍未完成并继续保留为后续 P0/P1 工作：真实仓库端到端样本集、artifact/gate/audit 深度互跳体验、至少 2 次真实测试 PR 证据、生产级隔离和真实 provider 长期稳定性数据。
