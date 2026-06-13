# Tekon 项目全面审查报告（完整版）

> **审查日期**: 2026-06-13
> **审查范围**: 全仓库 200+ 文件 — packages/core、packages/cli、packages/web、workflows/、roles/、docs/
> **当前版本**: v0.5.0
> **审查方法**: 人工审查（15,000+ 行核心源码直接阅读）+ 20-agent 并行 Workflow（429 次工具调用、131 万 tokens）
> **审查结论**: 架构设计优秀、功能大幅超出 MVP 预期，但存在 14 个 BLOCKER 缺陷、约 50 处代码重复，需要分优先级修复后进入稳定化阶段

---

## 一、执行摘要

Tekon（天工）v0.5.0 是一个**具备生产级特征的 Agent 工作流引擎**。它将 AI-assisted R&D 从需求塑形推进到可验收的 PR，通过状态机、Gate 系统和制品协议管理 AI agent 协作。两次全流程自举成功（Tekon 管理 Tekon 自身开发），验证了核心概念可行性。

### 项目健康度

| 维度 | 评级 | 说明 |
|------|------|------|
| 架构完整性 | **A** | 8 层架构全部落地（需求池→编排→角色→工具→制品→质量门禁→驾驶舱→知识层），组件职责清晰 |
| 功能覆盖度 | **A** | 18 个 CLI 命令、12 种 Gate 类型、21 种 Artifact 类型、6 个 Workflow 模板、5 个内置角色、3 种 Provider |
| 代码质量 | **B** | 核心逻辑扎实，但存在 14 个 BLOCKER 缺陷、约 50 处代码重复、2 个超大文件（CLI 3013 行、Engine 1995 行） |
| 测试覆盖 | **B** | 核心路径有覆盖，但 CLI 3 个命令零覆盖、前端零组件测试、测试 helper 大量重复 |
| 文档一致性 | **C** | V2 技术方案与实际交付状态严重脱节，仍以"未来计划"口吻描述已全部实现的功能 |
| 安全性 | **B** | 多层防护到位（provider 验证→command policy→worktree 隔离→human gate），但发现符号链接递归、路径穿越、崩溃式校验 3 个安全漏洞 |
| 目标符合度 | **A-** | MVP 目标达成约 70%，实际交付能力大幅超出 V2 Phase 1 范围（如 3 种 Provider vs 目标 1 种、6 个模板 vs 目标 2 个） |

---

## 二、目标对齐评估

### 2.1 与飞书产品文档对照

| # | 目标 | 来源 | 状态 | 证据 |
|---|------|------|------|------|
| 1 | 用户输入 B/D 类需求全流程自动推进到 PR | Beta-G | **已实现** | `standard-delivery.yaml` 含完整 7 阶段流程；端到端可执行 |
| 2 | 需求塑形（Demand Shape） | Beta-G / Alpha-G | **已实现** | `demand/shape.ts` 含结构化需求卡生成 + 交互澄清 |
| 3 | 受控 Workflow（模板驱动） | Beta-G | **已实现** | 6 个内置模板覆盖 B/D 类需求 |
| 4 | 角色 Agent 系统（PM/RD/QA/Reviewer/PMO） | Alpha-Q / Alpha-G | **已实现** | 5 角色含完整五元组（agent.yaml/system.md/skills/knowledge/tools.yaml） |
| 5 | 自动化边界到 PR，不自动合入/上线 | Beta-G | **已实现** | create-pr 需 `--approve-human`；commit/push 由 engine 控制 |
| 6 | Gate 系统（12 种） | Alpha-D / V2 技术方案 | **已实现** | build/test/lint/e2e/schema/security/independent-review/role-scope/ac-evidence/qa-signoff/process-completeness/human |
| 7 | 动态 Workflow 生成 | V2 技术方案 | **部分实现** | dry-run 预览 + constraint 注入可用；实际执行未开放 |
| 8 | CLI + Web Dashboard | Alpha-Q | **已实现** | 18 个命令 + 7 个页面 |
| 9 | 交付证据包 | Beta-G / Alpha-G | **已实现** | review 命令产出 readiness + evidence + gate triage + diff + artifacts |
| 10 | 效果评估体系 | Beta-G / Alpha-G | **已实现** | 5 种 eval 子命令（readiness/work-usability/demand-shape/workflow-selection/approval-summary） |
| 11 | Worktree 隔离执行 | V2 技术方案 | **已实现** | createLease/commitLeaseChanges/promoteLeaseToRunBranch/releaseLease |
| 12 | Agent Adapter 抽象（mock/claude/codex） | V2 技术方案 | **已实现** | 三种 provider 均有完整 adapter 实现 |
| 13 | 审计事件链（Hash Chain） | Alpha-D | **已实现** | SHA-256 链 + 40+ 事件类型 |
| 14 | 约束系统（三层） | V2 技术方案 | **已实现** | hard(3) + conditional(3) + soft(2) |
| 15 | 角色五元组（身份+知识+技能+工具+记忆） | Alpha-D | **部分实现** | 四元组已实现；记忆系统未独立 |
| 16 | 需求池（多来源/优先级） | Alpha-G | **部分实现** | 单文件草案支持基本生命周期 |
| 17 | Knowledge & Learning Layer | Alpha-G | **未实现** | 无复盘沉淀/自动模板优化 |
| 18 | 飞书 IM 通知 | Beta-G | **未实现** | 无任何通知集成 |
| 19 | Role Hub / Workflow Studio | Alpha-G | **未实现** | 角色/模板通过文件系统管理 |
| 20 | 北极星指标自动采集 | Beta-G | **部分实现** | 评估基础设施完备，自动化追踪未实现 |

### 2.2 与 V2 技术方案 Phase 1 对比

| V2 Phase 1 目标 | 实际交付 | 偏差 |
|---|---|---|
| Core 6 模块 | 全部增强（+ Worktree Manager + Command Gateway） | **超出** |
| CLI 11 条命令 | 18 条 + 多个子命令 | **大幅超出** |
| Web 项目列表 + 驾驶舱 | 7 个页面 | **大幅超出** |
| 内置角色 5 个 | 5 个完整五元组 | **符合** |
| 内置 Workflow 2 个 | 6 个 | **超出** |
| 仅 Claude Code | mock + Claude Code + Codex | **超出** |
| 不做 Codex/飞书/多人 | Codex 已做；飞书/多人未做 | **部分超出** |

---

## 三、代码质量审查

### 3.1 BLOCKER 级 — 必须立即修复（14 项）

#### 3.1.1 工作流引擎核心逻辑

**B-01: `runGateWithRepair` auto-fix 分支 lease key 错误**
- **文件**: `packages/core/src/workflow/engine.ts:540-542`
- **描述**: 修复节点成功后 `executionLeases.set(node.id, repairLease)`，但 `repairLease.nodeId` 是 `repairNode.id`。后续 `runGate` 通过 `executionLeases.get(nodeId)?.worktreePath` 获取 cwd 时拿到修复节点路径而非原节点路径。
- **建议**: 修复 lease 应以修复节点 id 存储，或明确将修复 lease 映射到原节点 id。

**B-02: `attemptChangesRequestedRework` 过早设 passed + target gate 未重跑**
- **文件**: `packages/core/src/workflow/engine.ts:604, 803`
- **描述**: （经复核修正）外层 gate 循环在 rework 成功后仍会继续执行后续 gate，但存在两个实质 bug：(1) 第 604 行在仅 independent-review gate 通过时过早将 review node 标为 `passed`，若后续 gate 失败，节点状态已错误；(2) 第 803 行将原始 target node 直接 transition 回 `passed`，**未重新执行其自身配置的 gate**（如 build、lint、schema 等）。
- **建议**: 移除第 604 行的过早 passed 设置，target node rework 后应重新走 gate 检查。

**B-03: `normalizeGate` 的 retry policy 丢失父级配置**
- **文件**: `packages/core/src/workflow/template.ts:331-361`
- **描述**: gate 设 `maxRetries` 但未设 `retryPolicy` 时，从 `defaultRetryPolicy()` 创建新对象，完全丢弃 template 级 `backoffMs`、`strategy`、`onExhausted`。
- **建议**: `{ ...templateRetryPolicy, maxRetries: rawGate.maxRetries }`。

**B-04: `runRoleScopeGate` 未知角色崩溃**
- **文件**: `packages/core/src/gate/engine.ts:371-372`
- **描述**: `allowedReviewScopesByRole` 仅覆盖 5 种 Role。新增 role 时 `allowed` 为 `undefined`，`.includes()` 抛出 TypeError。
- **建议**: `(allowedReviewScopesByRole[node.role] ?? []).includes(reviewScope)`。

#### 3.1.2 类型与 Schema

**B-05: `agentArtifactManifestSchema` 缺少 `ci-status` 类型**
- **文件**: `packages/core/src/artifact/schemas.ts:212-247`
- **描述**: manifest schema 的 artifacts[].type 枚举遗漏 `ci-status`。agent 声明 CI status artifact 时 schema 校验失败。
- **建议**: 添加 `ci-status` 到枚举；考虑改为引用 `artifactTypeSchema.options` 防止遗漏。

#### 3.1.3 安全漏洞

**B-06: `listScannableFiles` 符号链接安全漏洞**
- **文件**: `packages/core/src/security/secrets.ts:82-101`
- **描述**: `statSync` 跟随 symlink 导致：(1) 读取仓库外部文件；(2) 指向父目录的 symlink 导致无限递归；(3) 损坏的 symlink 抛出 ENOENT 未捕获。
- **建议**: 使用 `lstatSync` 跳过 symlink；添加 maxDepth=20；try/catch；文件数上限。

**B-07: `loadRepoProfile` 崩溃式校验**
- **文件**: `packages/core/src/repo/profile.ts:113-119`
- **描述**: `repoProfileSchema.strict().parse()` 在未知字段/空 YAML/格式无效时直接抛出 ZodError 崩溃。
- **建议**: 改用 `safeParse()`，失败时输出错误信息并返回降级默认 profile。

#### 3.1.4 设计与一致性

**B-08: `stableGateKey` 双重定义**
- **文件**: `packages/core/src/workflow/engine.ts:1910-1946` + `template.ts:378-394`
- **描述**: `stableGateKey` 和 `gatesWithStableKeys` 在两处各自定义，参数类型略有不同，独立维护可能导致 gate key 生成不一致。
- **建议**: 提取到 template.ts 导出，engine.ts 引用。

**B-09: `assertCodeProducerHasBuildAndLint` 遗漏 commandRef 检查**
- **文件**: `packages/core/src/workflow/template.ts:512-527`
- **描述**: 只检查 gate.type 是否 `build`/`lint`，不检查 `commandRef`。`commandRef: 'build'` 的节点可能被错误拒绝。
- **建议**: 同时考虑 gate.type 和 gate.commandRef。

**B-10: `resolveRepoPathForInit` 与 `resolveProjectRepoPath` 完全重复**
- **文件**: `packages/cli/src/index.ts:2562-2582`
- **描述**: 两个函数逐行一致，复制粘贴冗余。
- **建议**: 删除前者，`commandInit` 改用后者。

**B-11: `extractDraftShapePatch` 覆盖性数据丢失**
- **文件**: `packages/cli/src/draft-agent.ts:289-294`
- **描述**: Agent 返回 riskLevel 但未返回 riskTags 时，构造 `tags: []` 在 merge 中用空数组覆盖已有 risk.tags。
- **建议**: 当 `parsed.riskTags` 不存在时不设置 tags 字段。

**B-12: `generateAgentQuestions` 硬编码 Claude Code 参数**
- **文件**: `packages/cli/src/draft-agent.ts:39-48, 75-84`
- **描述**: 硬编码 `-p`、`--output-format json`、`--permission-mode bypassPermissions`。接入其他 Agent 会静默失败。
- **建议**: 将 Agent 特定逻辑提取为策略/Adapter 接口。

**B-13: Web API `resumeWorkflowRun` 等三函数完全重复**
- **文件**: `packages/web/src/server/api/agents.ts:95-176` + `gate.ts:187-268`
- **描述**: `resumeWorkflowRun`、`assertRunCanResume`、`createWebAgentAdapterFromSnapshot` 在两处独立定义完整副本。
- **建议**: gate.ts 从 agents.ts 导入，删除重复定义。

**B-14: 路径安全函数在 demand.ts 和 project.ts 中完全重复**
- **文件**: `packages/web/src/server/api/routers/demand.ts:72-142` + `project.ts:338-408`
- **描述**: `assertDraftShapePathInScope` 等约 70 行安全校验代码完全相同。
- **建议**: 提取到独立共享模块（如 `validators.ts`）。

### 3.2 IMPORTANT 级 — 需近期修复（52 项摘要）

#### 工作流引擎 (3 项)
- **I-01**: `resumeRun` 缺少状态检查——已 passed/failed 的 workflow 被 resume 会重新执行
- **I-02**: `executeNode` 存在 TOCTOU 竞争——先检查后执行，并行场景下可能重复执行
- **I-03**: `persistPlan` 无错误恢复——中途失败残留不完整数据

#### Gate 引擎 (4 项)
- **I-04**: `approveHumanGate`/`rejectHumanGate` 缺幂等检查——已处理的 decision 可被覆盖
- **I-05**: `runSecurityScanGate` 命令/gateway 缺失区分——不同失败场景静默回退到 passed
- **I-06**: `runProcessCompletenessGate` 190 行过大——需拆分
- **I-07**: `runAcceptanceEvidenceGate` 仅检查 passed 状态的 unknown AC——failed/blocked 被忽略

#### 角色系统 (4 项)
- **I-08**: `loadKnowledgeFiles` 路径穿越——knowledge 文件路径无 sanitization
- **I-09**: agent.yaml/system.md 读取缺存在性检查——缺失时抛原始 ENOENT
- **I-10**: `buildRolePrompt` 缺总长度管理——拼接可能超出模型上下文
- **I-11**: `compileRoleToolPolicy` 硬编码 fallback '.'——用错 cwdScope

#### 运行时与适配器 (6 项)
- **I-12**: Claude adapter 超时时无法恢复 artifact——与 Codex 行为不一致
- **I-13**: `SAFE_ENV_KEYS` 在两处独立维护——漂移风险
- **I-14**: 非 codex wrapper 脚本安全检查被跳过——安全参数静默丢失
- **I-15**: `pruneStaleLeases` 不更新数据库——孤儿 lease 记录
- **I-16**: `buildClaudeCodeCommand` args 被隐式 mutation——缓存场景下重复累积
- **I-17**: 烟雾测试证据硬编码日期 `'2026-06-05'`

#### Draft/Demand 系统 (3 项)
- **I-18**: `classifyRisk` 过于激进——单个 tag 即 high 风险强制人工审批
- **I-19**: `updateDraftWithAnswers` 丢失手动调整——完全重构覆盖用户修改
- **I-20**: `writeDraftShapeFile` 命名误导——写两个文件却用单数名

#### 交付系统 (6 项)
- **I-21**: PR 包路径缺安全校验——`input.runId` 直接拼接
- **I-22**: `governanceGatesCheck` 假阳性——per-node 聚合逻辑不准确
- **I-23**: `latestGateResults` 在 4 个文件中完全重复
- **I-24**: `createDeliveryEvidencePackage` 同一 run 调用两次——重复 I/O
- **I-25**: `watchPullRequestCiStatus` 异常未捕获——最终 attempt 失败不返回结果
- **I-26**: `qaSignoffCheck` 对 expectedRef 硬依赖——缺失 audit event 即失败

#### 数据库 (4 项)
- **I-27**: `run_locks` 表为死代码——定义但无 Repository 方法访问
- **I-28**: `markRoleRunCompleted` 硬编码 status='passed'——无法记录 failed/interrupted
- **I-29**: `findRecoverableRun` 缺并发保护——多进程可能重复恢复
- **I-30**: `migrateDatabase` 每次启动完整 DDL——无版本号跳过

#### 评估系统 (4 项)
- **I-31**: eval report HTML 缺少 `artifactIntegrity`——与 Markdown 不一致
- **I-32**: HTML/Markdown Limitations 条数不一致
- **I-33**: `escapeHtml` 重复定义——report.ts 和 work-usability.ts 各一份
- **I-34**: `isSatisfiedValidationGate` 依赖硬编码字符串 `'not-applicable'`

#### CLI (6 项)
- **I-35**: CLI index.ts 3013 行——单体巨石
- **I-36**: `commandRun` 函数过大且依赖注入缺失
- **I-37**: draft-agent 丢弃 stderr——诊断信息丢失
- **I-38**: `parseAgentJson` 无法解析 NDJSON——Claude Code 实际输出是流式 NDJSON
- **I-39**: `runCli` catch 块丢失 stack trace
- **I-40**: `commandUi` 子进程无信号转发——Ctrl+C 可能产生孤儿进程

#### Web Dashboard (5 项)
- **I-41**: `updateDecision` 竞态条件——多步非事务操作
- **I-42**: `count()` SQL 拼接风险——模板字符串拼接 table 名
- **I-43**: Zod 校验失败信息泄露——内部 schema 结构暴露给客户端
- **I-44**: CSRF 防护缺口——mutation 操作仅靠 session token
- **I-45**: `createPullRequestPreparation` 在 delivery 中被重复调用

#### Web 前端 (7 项)
- **I-46**: `TERMINAL_STATUSES` 状态名错误——`completed` vs API 实际 `passed`
- **I-47**: `pendingGates` 计算包含非 pending 状态——可能负数
- **I-48**: `RunControls.invalidateKeys` 前缀范围过大——清空所有运行缓存
- **I-49**: `templateFromDemandId` 是 stub——不做任何转换
- **I-50**: 前端零组件单元测试——违反 CLAUDE.md 测试先行要求
- **I-51**: QueryCache 无淘汰机制——无 TTL/无 LRU/无最大容量
- **I-52**: 格式化函数在 5+ 处重复定义且阈值不一致

### 3.3 MINOR 级 — 可排期修复（44 项，选取代表性）

- **M-01~M-07**: 类型/命名不一致（`artifactOutputs` vs `outputs`、`maxAttempts` vs `maxRetries` 冲突、revision 无上限等）
- **M-08~M-14**: 角色/运行时层（PMO 审批硬编码、sandbox 硬编码、agent.yaml 报错不友好、permission fallback 不防御等）
- **M-15~M-16**: 代码重复（`monitorWritable`/`monitorTransform` 50% 重复、git push deny 列表冗余）
- **M-17~M-26**: Draft/Delivery/Artifact 层（分类检查两次、rawText 直接嵌入可能破坏格式、大文件 OOM 风险、surrogate pair 截断等）
- **M-27~M-36**: CLI（入口检测 Windows 不可靠、中英文混用、`readStdinLine` 只读第一个 chunk、delivery dry-run fall-through 不安全等）
- **M-37~M-44**: Web（symlink 检查缺失、变量命名误导、`assertCleanBase` 阻塞事件循环、死代码组件、ApprovalsPage 认证方式不一致等）

### 3.4 架构层面补充发现

**Engine 文件过大（1995 行）**：承担了计划执行、节点调度、lease 管理、prompt 构建、制品协议、gate 修复、rework 循环等多重职责。建议拆分为 `engine/prompt.ts`、`engine/protocol.ts`、`engine/lease.ts`、`engine/rework.ts`、`engine/plan.ts`。

**CLI 文件过大（3013 行）**：所有 18 个命令 + 40 个辅助函数在一个文件。建议拆分为 `commands/init.ts`、`commands/run.ts`、`commands/demand.ts`、`commands/delivery.ts` 等。

**Type 系统膨胀**：21 种 artifact type + 12 种 gate type 在 `domain.ts` 中平铺，缺少逻辑分组。

**约 50 处代码重复**：分布在 core/cli/web 三个包中，10+ 个函数在 2-4 个文件中完全重复。详见 §6.2。

---

## 四、测试质量审查

### 4.1 覆盖统计

| 包 | 测试文件 | 评估 |
|----|---------|------|
| `packages/core/__tests__/` | 30+ | 核心路径覆盖良好；错误路径和边界条件缺测 |
| `packages/cli/__tests__/` | 4 | CLI 层覆盖不足：`draft show`/`ui`/`update` 零覆盖 |
| `packages/web/__tests__/` | 11 | API 覆盖合理；前端组件零单元测试 |

### 4.2 覆盖缺口（12 项）

- **TG-01**: 状态机未遍历全部 100 个状态对（仅 ~25 个）
- **TG-02**: 角色加载器错误路径全缺（目录不存在/格式错误/文件缺失）
- **TG-03**: constraints.yaml 测试依赖真实文件 ID——文案变更导致无关失败
- **TG-04**: repo profile 错误路径缺（无 .tekon/YAML 错误/字段缺失）
- **TG-05**: CI status 网络失败缺（gh 非 JSON/不在 PATH/超时 vs 不可达）
- **TG-06**: domain 类型校验缺（空 id/负 duration/格式错误 nodeId）
- **TG-07**: mock adapter content 验证缺——仅检查 count 不验证内容
- **TG-08~10**: CLI `draft show`、`ui`、`update` 命令零覆盖
- **TG-11**: audit CLI 命令链验证缺
- **TG-12**: 前端组件零单元测试

### 4.3 伪测试 / 死测试（4 项）

- **FT-01**: `draft-agent.test.ts` 中测试 `typeof x === 'string'` 永远通过——注释承认"compile-time only"
- **FT-02**: `run-tab-content.test.ts` 仅断言 "Progress" 链接可见，不检查内容
- **FT-03**: `demand/shape.test.ts` 全文件 @deprecated——测试已废弃 API
- **FT-04**: `use-run-poller.ts` 死代码——无任何组件引用且终端状态枚举有 bug

### 4.4 冗余测试（7 项）

- `createFixtureRepo` 在 3 个测试文件中独立定义相同副本
- `writeFakeGh` 在 4 个测试文件中重复（实现略有差异）
- `writeFakeCodex` 在 2 个文件中逐字重复
- `createMemoryIo` 在 2 个文件中重复
- Gate engine 测试 helper（`createPassingGateEngine` 等）跨 5 个文件重复
- State-machine 测试 3 个独立测试可用 `it.each` 合并
- Engine-unit 测试复制生产代码实现而非调用真实函数

### 4.5 质量问题（9 项）

- `ci-status.test.ts` 用 `buckets.shift()` 可变数组——并行执行破坏
- `command-gateway.test.ts` spy 清理不完善——Promise.race 非确定性
- engine-template e2e 测试 adapter 绕过 artifact ingestion 代码路径
- SCM 测试 mock 默认静默通过——未知命令不抛错
- 多个 CLI 测试用 `process.chdir()`——共享可变全局状态
- cli-flow e2e 单 `it` 块 80 个断言——前期失败遮蔽后续
- E2E 测试依赖预构建 dist/ 无前置检查——dist 不存在抛出神秘 ENOENT
- `generateAgentQuestions` 用 `node` 做 agent command——依赖 node 特定行为
- Help 测试硬编码中文字符串——文案变更导致大量测试失败

---

## 五、架构评估

### 5.1 优势

1. **清晰的分层架构**：Core → CLI → Web 三层独立，Core 不依赖 CLI/Web。层间通过共享 types 通信。

2. **状态机设计成熟**：`state-machine.ts` 定义 10 种状态 × ~30 种合法转换，`assertWorkflowTransition` 强制校验，`transitionWorkflowNode` 自动记录 revision history。`passed → needs-revision` 支持独立 review 触发 rework 循环。

3. **制品驱动的交接协议**：`appendArtifactProtocol` 向每个 agent 注入详细的制品要求（格式、字段、manifest），确保 agent 之间通过结构化产物而非自由文本交接。**这是项目最核心的设计优势。**

4. **多层安全边界**：
   - Provider 能力声明验证（sandbox/approval/filesystemScope/network）
   - Command policy（工具白名单/黑名单）
   - Git worktree 隔离（节点间源码不交叉）
   - `nodeAllowsSourceChanges`（非 RD 节点不允许修改源码）
   - Human gate（高危操作必须人工确认）

5. **约束系统的分层设计**：hard → conditional → soft 三层约束，保障最低质量底线的同时支持上下文动态增强。

6. **不可变审计**：SHA-256 哈希链保证审计事件不可篡改，40+ 事件类型覆盖完整生命周期。

7. **Worktree 隔离**：每个 Agent 执行拥有独立的 git worktree，lease 管理（create→commit→promote→release）完整。

8. **Provider 抽象**：AgentAdapter 接口支持 mock/Claude/Codex 三种 provider，适配器职责分离良好。

### 5.2 架构关注点

1. **单体 CLI 入口**（3013 行）和 **单体 Engine**（1995 行）是当前最明显的架构债务。
2. **无依赖注入容器**：CLI 中 `commandRun` 直接在函数体内 new 所有依赖，测试 mock 成本高。
3. **类型系统冲突**：`WorkflowTemplate` 在三处独立定义。通过 index.ts 显式导出解决歧义，但应统一或重命名。
4. **代码重复严重**：约 50 处函数级重复。详见 §6.2。
5. **SQLite 并发限制**：`findRecoverableRun` 无事务保护；`migrateDatabase` 每次启动完整 DDL。
6. **公开 API 边界模糊**：42 个 `export *` 暴露了所有内部函数，任何重构都可能破坏下游。
7. **V2 技术方案与实际严重脱节**：文档仍以"未来计划"口吻描述已全部实现的功能，需要更新为"已实现架构记录"。

### 5.3 数据流

```
Demand Input → Demand Shape → Workflow Engine → Node Execution
                                                    ↓
                                              Agent (Worktree)
                                                    ↓
                                              Artifact → Gate Chain
                                                    ↓
                                              Audit Events → Review Surface
                                                    ↓
                                              Delivery Package → PR
```

唯一隐式数据流：`latestQaValidationRef` 通过扫描全量审计事件获取 ref，依赖事件顺序而非显式关联。

### 5.4 错误处理模式

- **不一致**：部分模块使用领域错误包装（gate engine），部分模块直接抛出底层错误（artifact store filesystem、role loader ENOENT）
- **吞错误**：`readPayload`（delivery/evidence.ts）catch 所有错误返回 null，不区分文件不存在 vs schema 校验失败
- **建议**：定义 `TekonError` 基类和子类型，区分用户错误、系统错误和不可恢复错误

---

## 六、精简优化建议

### 6.1 可移除的代码

| 位置 | 原因 |
|------|------|
| `packages/core/src/demand/shape.ts` | 2 行 @deprecated re-export |
| `DemandPage.tsx`、`DemandForm.tsx`、`DemandShapeCard.tsx` | 仅向后兼容重新导出，迁移完可移除 |
| `use-run-poller.ts` | 死代码，无引用且状态枚举有 bug |
| `ConfirmButton.tsx` | 未使用，两击逻辑各处内联实现 |
| `WorkflowSelectionTab.tsx` | Coming Soon 占位符，无实际功能 |
| `run_locks` 表定义 | 无 Repository 方法访问 |

### 6.2 可合并的重复代码（优先级排序）

| 重复函数 | 出现次数 | 建议合并位置 |
|---------|---------|-------------|
| `latestGateResults` | 4（evidence/pre-pr-readiness/gate/eval） | `packages/core/src/gate/utils.ts` |
| `assertSafePathSegment` | 3（artifact store/ci-status/safe-path 自身） | `packages/core/src/repo/safe-path.ts` |
| `stableGateKey` / `gatesWithStableKeys` | 2（engine/template） | template.ts 导出，engine.ts 引用 |
| `escapeHtml` | 2（eval/report + eval/work-usability） | `packages/core/src/util/html.ts` |
| `SAFE_ENV_KEYS` | 2（command-gateway/claude-code-support） | `packages/core/src/security/env-whitelist.ts` |
| `createFixtureRepo` | 3（run-cli/cli-flow/release-flow 测试） | `packages/cli/__tests__/helpers/fixture-repo.ts` |
| `writeFakeGh` | 4（同上 + web api 测试） | `packages/cli/__tests__/helpers/fake-gh.ts` |
| `writeFakeCodex` | 2（run-cli/write-auth 测试） | `packages/cli/__tests__/helpers/fake-codex.ts` |
| `createMemoryIo` | 2（help/run-cli 测试） | `packages/cli/__tests__/helpers/cli-io.ts` |
| `resumeWorkflowRun` + 2 辅助 | 2（web agents/gate） | agents.ts 导出，gate.ts 导入 |
| `assertDraftShapePathInScope` + 辅助 | 2（web demand/project） | `packages/web/src/server/api/validators.ts` |
| 前端格式化函数 | 5+（Dashboard/RunDetail/RunTable/Progress/Artifacts） | `packages/web/src/client/lib/formatting.ts` |
| `resolveRepoPathForInit` / `resolveProjectRepoPath` | CLI 内 2 次 | 删除前者 |
| Gate engine 测试 helper | 5（engine-gate-repair/recovery/template/worktree/role-prompt） | 共享 test helper |

### 6.3 可简化的过度设计

1. **`roleScopedReviewArtifactInstructions` if-else 链**（engine.ts）→ 使用声明式查找表
2. **`gateTriageAdvice` 110 行 if-else**（review/surface.ts）→ Record 查找表
3. **`evaluateWorkReadiness` 173 行** → 拆分为独立函数
4. **`runProcess` 216 行**（command-gateway.ts）→ 拆分为独立可测模块
5. **`renderWorkUsabilityEvaluationReport` 118 行** → Markdown/HTML 渲染分离
6. **`evaluateHumanApprovalSummary` 8 个重复 check 结构** → 声明式 config 数组
7. **`assertSafeCodexArgs` 70 行 if-else** → Set<string> 数据结构驱动
8. **Gate 层级 retry 过多**：Workflow 级 → Node 级 → Gate 级三层 retry → Phase 1 只保留 Gate 级
9. **`createDynamicMockAdapter` 78 行中 60 行静态 JSON** → 提取为 const template
10. **`workUsabilityThresholdsSchema` 被解析两次** → 利用 `.default()` 缓存

---

## 七、后续迭代建议

### P0 — 立即修复（阻塞性缺陷和安全隐患，建议 5-7 天）

> **注**：I-08（`loadKnowledgeFiles` 路径穿越）在代码审查中被标为 IMPORTANT，但因其属于安全漏洞性质，在此提级至 P0 处理。

| # | 项 | 关联 |
|---|-----|------|
| P0-1 | 修复 `runGateWithRepair` auto-fix lease key 错误 | B-01 |
| P0-2 | 修复 `attemptChangesRequestedRework` 跳过其余 gate | B-02 |
| P0-3 | 修复 `normalizeGate` retry policy 丢失父级配置 | B-03 |
| P0-4 | 修复 `runRoleScopeGate` 未知角色时 TypeError | B-04 |
| P0-5 | 修复 `agentArtifactManifestSchema` 缺少 ci-status | B-05 |
| P0-6 | 修复 `listScannableFiles` 符号链接安全漏洞 | B-06 |
| P0-7 | 修复 `loadRepoProfile` 崩溃式校验 | B-07 |
| P0-8 | 修复 `loadKnowledgeFiles` 路径穿越 | I-08 |
| P0-9 | 修复 `extractDraftShapePatch` 数据丢失 | B-11 |
| P0-10 | 删除 Web API agents.ts/gate.ts 重复函数 | B-13, B-14 |

### P1 — 近期修复（重要缺陷，影响可靠性，建议 8-12 天）

| # | 项 | 关联 |
|---|-----|------|
| P1-1 | `resumeRun` 添加状态检查 | I-01 |
| P1-2 | 为 Claude adapter 实现 artifact 补偿机制 | I-12 |
| P1-3 | 修复 `findRecoverableRun` 并发安全 | I-29 |
| P1-4 | 修复 `updateDecision` 竞态条件 | I-41 |
| P1-5 | 添加 PR 包路径安全校验 | I-21 |
| P1-6 | 修复 `governanceGatesCheck` 假阳性 | I-22 |
| P1-7 | 修复 `qaSignoffCheck` 对 expectedRef 硬依赖 | I-26 |
| P1-8 | 消除 `latestGateResults` 等函数 4 份重复 | I-23 |
| P1-9 | 添加 `markRoleRunFailed` Repository 方法 | I-28 |
| P1-10 | 修复 Web 前端 `TERMINAL_STATUSES` 状态名错误 | I-46 |
| P1-11 | 实现北极星指标自动采集 pipeline | §2.2 |
| P1-12 | 修复 `classifyRisk` 对 docs 类型过于激进 | I-18 |
| P1-13 | 补全 Engine rework 循环、dynamic workflow、autoFix 的测试 | TG 缺口 |

### P2 — 排期重构（架构优化和代码清理，2-4 周）

| # | 项 | 关联 |
|---|-----|------|
| P2-1 | **拆分 CLI index.ts**（最高优先级架构债务） | I-35 |
| P2-2 | **拆分 Engine 为独立子模块**（prompt/protocol/lease/rework） | 架构评估 |
| P2-3 | 提取共享测试 helper（消除 7 类重复 fixture） | §6.2 |
| P2-4 | 消除 eval report HTML/Markdown 不一致 | I-31, I-32 |
| P2-5 | 统一错误处理策略（TekonError 基类） | §5.4 |
| P2-6 | 提取共享工具模块（gate/utils、util/html、security/env-whitelist） | §6.2 |
| P2-7 | 拆分超大函数（`runProcessCompletenessGate`、`runProcess` 等） | I-06, §6.3 |
| P2-8 | 用查找表替代大段 if-else 链（role/review/gate triage） | §6.3 |
| P2-9 | 前端格式化函数统一 + QueryCache 添加 TTL | I-51, I-52 |
| P2-10 | 前端组件单元测试补充 | I-50 |
| P2-11 | CLI `draft show`/`ui`/`update` 命令测试补充 | TG-08~TG-10 |
| P2-12 | 实现 dynamic workflow 实际执行（非 dry-run） | 目标 #7 |
| P2-13 | 实现 Phase 级 parallel 执行 | V2 §5.2 |

### P3 — 战略改进（3-6 个月）

| # | 项 |
|---|-----|
| P3-1 | 定义公共 API 边界并收紧 `export *` 暴露 |
| P3-2 | **更新 V2 技术方案为"已实现架构记录"** |
| P3-3 | 实现 run_locks 表对应的 Repository 方法（或移除表） |
| P3-4 | 引入依赖注入容器或 compose 工厂函数 |
| P3-5 | CLI 入口改为 Windows 兼容 |
| P3-6 | 飞书 IM 通知集成 |
| P3-7 | 需求池多来源接入（飞书文档、GitHub Issues） |
| P3-8 | Knowledge & Learning Layer（复盘沉淀、自动模板优化） |
| P3-9 | Role Hub / Workflow Studio（可视化编辑器） |
| P3-10 | 多项目/多团队支持 + API 开放 |

---

## 八、总结

Tekon v0.5.0 从一个概念验证成功演进为**具备生产级特征的 Agent 工作流引擎**。它在三个维度上表现突出：

1. **功能完整度**大幅超出预期：18 个命令 vs 11 个目标、6 个模板 vs 2 个目标、3 种 Provider vs 1 种目标、12 种 Gate vs 原始设计的 7 种。

2. **架构设计**体现了对 AI Agent 编排本质问题的深刻理解：制品驱动（而非聊天驱动）、严格的 Gate 系统、多层安全边界、约束系统保障动态工作流质量。这些设计选择使得 Tekon 区别于简单的 Coding Agent wrapper。

3. **安全边界**被认真对待：不自动合入 PR、高危操作人工确认、worktree 隔离、provider 能力声明验证——这些确保了 Iron Man suit（增强而非替代人类）的设计原则。

当前最大的挑战不是功能缺失，而是快速迭代积累的技术债务：

- **14 个 BLOCKER 缺陷**需要立即修复（核心在 engine.ts 和 template.ts 的 gate/rework 逻辑）
- **约 50 处代码重复**正在侵蚀可维护性
- **2 个超大文件**（CLI 3013 行、Engine 1995 行）需要优先拆分
- **V2 技术方案与现状脱节**需要同步更新

建议按 P0→P1→P2→P3 优先级分阶段推进。完成 P1 后，项目可从"**功能验证级**"提升到"**可靠使用级**"；完成 P2 后，可达到"**生产可维护级**"。

---

*本报告合并自两份独立审查：人工深度审查（聚焦架构/设计/目标对齐，覆盖 15,000+ 行核心源码）和 20-agent 并行 Workflow 审查（聚焦代码级 bug/安全/重复代码，消耗 131 万 tokens、429 次工具调用）。合并报告经最高思考等级 subagent 元审查验证：14 个 BLOCKER 中 13 个完全准确，1 个（B-02）描述已修正。*

### 元审查反馈
合并报告完成后，经独立 subagent review，发现以下补充点：

**已知未覆盖领域**（建议后续补充审查）：
- CI/CD 配置（`.github/workflows/core.yml`）— 当前仅构建 core 包
- 安装/更新脚本（`scripts/install.sh`、`scripts/update.sh`）— 硬编码版本号
- 角色系统内容质量（5 个角色的 agent.yaml/system.md/skills/knowledge 实际内容）
- Workflow 模板深度审查（6 个 YAML 的 gate 配置合理性、节点依赖图正确性）
- 测试覆盖缺口的严重性分级（TG-01~TG-12 缺少 B/I/M 标签）

**已修正项**：
- B-02 描述从"跳过其余 gate"修正为"过早设 passed + target gate 未重跑"
- P0 时间估计从 3-5 天调整为 5-7 天，P1 从 5-8 天调整为 8-12 天
- I-08 从 IMPORTANT 提级至 P0 的理由已注明（安全漏洞性质）
