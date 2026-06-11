# Tekon Standard Delivery Workflow Next-Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Tekon 从“真实 Codex provider 到真实 PR 的 P0 闭环”升级为“有独立评审、角色边界、证据追踪、QA 最终签核和 PMO 全程治理的标准全链路交付流程”。

**Architecture:** 新增 `standard-delivery` 工作流作为默认受控交付模板，保留确定性 workflow engine，不把流程选择和 gate 判断交给 LLM。角色职责写入 `roles/*`，流程顺序写入 `workflows/*`，独立评审、角色越权、AC evidence traceability 和 QA final signoff 通过 artifact schema、gate 与 readiness eval 强制校验。

**Tech Stack:** TypeScript, pnpm workspace, Vitest, Playwright, SQLite, Zod, Git worktree, GitHub CLI, Codex provider, Tekon workflow templates, Tekon role system.

---

## 1. 背景与判断

### 1.1 当前事实

Tekon 已完成一次真实 Codex provider 自举闭环：`run_d2350140-b1b7-4fca-b01b-e28daac61e31` 状态为 `passed`，8 个 gates 通过，真实 PR `https://github.com/zesming/tekon/pull/2` 已创建且远端 CI 通过。该 P0 证明“真实 provider 到真实 PR”成立，但当前 `docs-update` 模板仍是 PM -> RD -> QA -> Reviewer -> PMO 的线性流程，没有 PM 内部需求评审、RD/QA 外部需求接口评审、RD 技术方案评审、QA 测试方案评审、QA final signoff 与 PMO checkpoint。

### 1.2 资料依据

| 资料                                                                                                        | 资料内容                                                                                                        | 对 Tekon 的判断依据                                            |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| IBM requirements guideline：`https://www.ibm.com/docs/en/erqa?topic=assistant-guidelines-good-requirements` | 好需求必须清晰、可验证，是多方沟通、设计、项目计划和工程活动的基础                                              | PM demand-card 后必须有需求质量评审，不能只做 schema 校验      |
| ISTQB CTFL syllabus：`https://istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf`          | 测试流程应维护 test basis、testware、测试结果和角色之间的追踪关系                                               | Tekon 必须把 AC、QA test plan、QA report 和 signoff 自动串起来 |
| DORA change approval：`https://dora.dev/capabilities/streamlining-change-approval/`                         | 高效变更审批更适合前移到开发过程中的 peer review，并用自动化检测补充                                            | Tekon 应做轻量独立评审和自动 gate，不应引入笨重审批委员会      |
| Scrum Definition of Done：`https://www.scrum.org/resources/definition-done`                                 | Done 应描述增量满足产品质量标准、处于 usable 状态                                                               | QA final signoff 应绑定 PR head commit，证明所测即所得         |
| Google Engineering Practices：`https://google.github.io/eng-practices/review/`                              | Review 关注 design、functionality、complexity、tests、documentation                                             | RD technical review 和独立 Reviewer review 应有明确 rubric     |
| `docs/reviews/2026-06-10-tekon-codex-self-bootstrap-report.md`                                              | P0 真实 Codex run 与 PR 归档证据                                                                                | P1 应补强 readiness AC evidence 映射和 PR 包可读性             |
| `docs/reviews/2026-06-10-tekon-comprehensive-evaluation.md`                                                 | 当前能力缺口：角色体系、审计追溯、Artifact Center、Web Cockpit、知识层、成本控制、多 Provider、动态编排、评审面 | 后续能力应分层推进，先治理闭环，再体验和平台化                 |

### 1.3 下一阶段原则

- 先把标准流程可信度做实，再扩更多 provider 和平台化能力。
- 所有评审必须由独立 agent、独立进程或独立 execution 执行，避免自产自测。
- 每个角色只评审自身职责范围；跨角色只评审“接口是否足够支撑自己继续工作”。
- PMO 做流程和证据完整性治理，不替 PM、RD、QA 做专业判断。
- QA 对最终交付质量负责，final signoff 必须绑定具体 PR head SHA 或 delivery branch SHA。
- 高风险动作继续由人类批准：PR 创建、merge、release、deploy、force push。

---

## 2. 阶段总览

| 阶段 | 时间窗口  | 目标                                                                              | 退出标准                                                                        |
| ---- | --------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| P1-A | 0-2 周    | 固化 `standard-delivery` 模板和角色边界                                           | 模板可被 parser 加载；角色说明覆盖评审范围；schema tests 通过                   |
| P1-B | 1-3 周    | 建立独立评审、角色越权和 QA final signoff gate                                    | 同 agent 自评会失败；越权 review 会失败；QA signoff 缺 SHA 会失败               |
| P1-C | 2-4 周    | 建立 AC evidence traceability 和 PR package V2                                    | readiness 不再显示 `acceptance-criteria-evidenced` unknown；PR 包按 AC 展示证据 |
| P1-D | 3-5 周    | 用 Tekon 自身 3 个真实需求跑标准流程                                              | 每个样本都有 run、PR、CI、QA signoff、PMO checkpoint 和复盘记录                 |
| P2   | 5-10 周   | Web Cockpit、Artifact Center、审计回放、成本 telemetry、多 Provider 稳定化        | 人能在 Web 上完成 run 审阅；成本和审计可查询；Codex/Trae 可对比                 |
| P3   | 10 周以后 | DAG 并行、知识/技能飞轮、Architect/UI/DevOps/Ops 角色、release/rollback、组织治理 | 多角色复杂需求可控运行，经验可沉淀，团队级权限可审计                            |

---

## 3. 文件结构

### 3.1 P1 必改文件

| 文件                                                  | 责任                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `workflows/standard-delivery.yaml`                    | 新标准全链路 workflow 模板，定义节点、依赖、artifact、gate 和人工边界 |
| `packages/core/src/artifact/schemas.ts`               | 新增 review、plan、signoff、checkpoint 类 artifact schema             |
| `packages/core/__tests__/artifact/schemas.test.ts`    | 覆盖新 artifact schema 的正反例                                       |
| `packages/core/src/gate/runners.ts`                   | 新增独立评审、角色范围、QA signoff、AC evidence gate runner           |
| `packages/core/__tests__/gate/runners.test.ts`        | 覆盖 gate 失败和通过场景                                              |
| `packages/core/src/eval/work-readiness.ts`            | 将 AC evidence traceability 纳入 readiness 计算                       |
| `packages/core/__tests__/eval/work-readiness.test.ts` | 覆盖 AC 从 demand-card 到 QA evidence 的映射                          |
| `packages/core/src/delivery/pr-package.ts`            | PR package V2 按结果、风险、证据、审查、PR 决策组织                   |
| `packages/core/__tests__/delivery/pr-package.test.ts` | 覆盖 evidence unknown 消除和 PR body 可读性                           |
| `roles/pm/system.md`                                  | 固化 PM 需求与测试方案意图评审边界                                    |
| `roles/rd/system.md`                                  | 固化 RD implementation plan 与技术评审边界                            |
| `roles/qa/system.md`                                  | 固化 QA test plan、验收执行、final signoff 边界                       |
| `roles/reviewer/system.md`                            | 固化独立 reviewer 的审阅边界                                          |
| `roles/pmo/system.md`                                 | 固化 PMO checkpoint 和不越权原则                                      |
| `docs/manual/tekon-user-manual.md`                    | 面向用户说明标准流程如何发起、会得到什么、不能做什么                  |
| `docs/manual/tekon-user-manual.html`                  | 主用户手册 HTML 同步版                                                |
| `README.md`                                           | 更新工作流和能力摘要                                                  |
| `CHANGELOG.md`                                        | 记录标准流程能力变更                                                  |

### 3.2 P2/P3 候选文件

| 能力               | 主要文件                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Web Cockpit V2     | `packages/web/src/server/api/root.ts`, `packages/web/src/client/App.tsx`, `packages/web/src/client/styles.css`  |
| Artifact Center    | `packages/core/src/artifact/store.ts`, `packages/core/src/review/surface.ts`, `packages/web/src/client/App.tsx` |
| 审计回放           | `packages/core/src/audit/logger.ts`, `packages/core/src/eval/report.ts`, `packages/web/src/server/api/root.ts`  |
| 成本 telemetry     | `packages/core/src/eval/metrics.ts`, `packages/core/src/runtime/agent-adapter.ts`, SQLite migrations            |
| 多 Provider 稳定化 | `packages/core/src/runtime/*adapter.ts`, `packages/core/src/types/config.ts`, provider contract tests           |
| DAG 并行           | `packages/core/src/workflow/scheduler.ts`, `packages/core/src/workflow/engine.ts`, workflow e2e tests           |
| release/rollback   | `packages/core/src/delivery/scm.ts`, `packages/core/src/delivery/pr-package.ts`, new delivery docs              |

---

## 4. Standard Delivery Workflow v1

### 4.1 流程骨架

```text
PM demand-card
-> independent PM demand review
-> RD requirement interface review
-> QA requirement interface review
-> requirements baseline freeze
-> RD implementation plan
-> independent RD technical review
-> QA test plan
-> independent QA test-plan review
-> PM test-plan intent review
-> RD implementation
-> RD self-check + deterministic gates
-> independent Reviewer change review
-> QA validation on exact delivery SHA
-> independent QA release-signoff review
-> PMO checkpoint and delivery package
-> create/update PR under human approval
```

### 4.2 新 workflow 模板草案

```yaml
id: standard-delivery
name: Standard Delivery
version: 1
retry:
  maxAttempts: 3
  backoffMs: 500
  strategy: exponential
phases:
  - id: pm-scope
    nodes:
      - id: pm-demand-card
        role: pm
        outputs:
          - demand:demand-card
        gates:
          - type: schema
            artifactType: demand-card
  - id: pm-review
    dependsOn: [pm-scope]
    nodes:
      - id: pm-demand-review
        role: pm
        inputs:
          - demand:demand-card
        outputs:
          - review:demand-review
        gates:
          - type: independent-review
          - type: role-scope
            role: pm
          - type: schema
            artifactType: demand-review
  - id: requirement-interface-review
    dependsOn: [pm-review]
    nodes:
      - id: rd-requirement-interface-review
        role: rd
        inputs:
          - demand:demand-card
          - review:demand-review
        outputs:
          - review:requirement-interface-review
        gates:
          - type: role-scope
            role: rd
          - type: schema
            artifactType: requirement-interface-review
      - id: qa-requirement-interface-review
        role: qa
        inputs:
          - demand:demand-card
          - review:demand-review
        outputs:
          - review:requirement-interface-review
        gates:
          - type: role-scope
            role: qa
          - type: schema
            artifactType: requirement-interface-review
  - id: rd-plan
    dependsOn: [requirement-interface-review]
    nodes:
      - id: rd-implementation-plan
        role: rd
        inputs:
          - demand:demand-card
          - review:requirement-interface-review
        outputs:
          - design:implementation-plan
        gates:
          - type: schema
            artifactType: implementation-plan
  - id: rd-plan-review
    dependsOn: [rd-plan]
    nodes:
      - id: rd-technical-review
        role: rd
        inputs:
          - design:implementation-plan
        outputs:
          - review:technical-review
        gates:
          - type: independent-review
          - type: role-scope
            role: rd
          - type: schema
            artifactType: technical-review
  - id: qa-plan
    dependsOn: [rd-plan-review]
    nodes:
      - id: qa-test-plan
        role: qa
        inputs:
          - demand:demand-card
          - design:implementation-plan
        outputs:
          - test:test-plan
        gates:
          - type: ac-traceability
          - type: schema
            artifactType: test-plan
  - id: qa-plan-review
    dependsOn: [qa-plan]
    nodes:
      - id: qa-test-plan-review
        role: qa
        inputs:
          - test:test-plan
        outputs:
          - review:test-plan-review
        gates:
          - type: independent-review
          - type: role-scope
            role: qa
          - type: schema
            artifactType: test-plan-review
      - id: pm-test-plan-intent-review
        role: pm
        inputs:
          - demand:demand-card
          - test:test-plan
        outputs:
          - review:test-plan-intent-review
        gates:
          - type: role-scope
            role: pm
          - type: schema
            artifactType: test-plan-intent-review
  - id: rd-implementation
    dependsOn: [qa-plan-review]
    nodes:
      - id: rd-code-change
        role: rd
        inputs:
          - demand:demand-card
          - design:implementation-plan
          - test:test-plan
        outputs:
          - code:code-changes
        gates:
          - type: build
            commandRef: build
          - type: lint
            commandRef: lint
          - type: security-scan
            commandRef: security
          - type: schema
            artifactType: code-changes
  - id: independent-change-review
    dependsOn: [rd-implementation]
    nodes:
      - id: reviewer-change-review
        role: reviewer
        inputs:
          - demand:demand-card
          - design:implementation-plan
          - test:test-plan
          - code:code-changes
        outputs:
          - review:review-report
        gates:
          - type: independent-review
          - type: role-scope
            role: reviewer
          - type: schema
            artifactType: review-report
  - id: qa-final-validation
    dependsOn: [independent-change-review]
    nodes:
      - id: qa-validation
        role: qa
        inputs:
          - demand:demand-card
          - test:test-plan
          - code:code-changes
        outputs:
          - test:test-report
          - signoff:qa-release-signoff
        gates:
          - type: test
            commandRef: test
          - type: qa-signoff
          - type: ac-evidence
          - type: schema
            artifactType: test-report
          - type: schema
            artifactType: qa-release-signoff
  - id: qa-signoff-review
    dependsOn: [qa-final-validation]
    nodes:
      - id: qa-release-signoff-review
        role: qa
        inputs:
          - signoff:qa-release-signoff
        outputs:
          - review:qa-release-signoff-review
        gates:
          - type: independent-review
          - type: schema
            artifactType: qa-release-signoff-review
  - id: pmo-delivery
    dependsOn: [qa-signoff-review]
    nodes:
      - id: pmo-checkpoint
        role: pmo
        inputs:
          - demand:demand-card
          - review:demand-review
          - design:implementation-plan
          - review:technical-review
          - test:test-plan
          - test:test-report
          - signoff:qa-release-signoff
          - review:qa-release-signoff-review
        outputs:
          - process:process-checkpoint
          - delivery:delivery-package
        gates:
          - type: process-completeness
          - type: schema
            artifactType: process-checkpoint
          - type: schema
            artifactType: delivery-package
```

---

## 5. Artifact Contract

### 5.1 新 artifact 类型

| Artifact                       | Owner       | 作用                                  | 必要字段                                                                                                  |
| ------------------------------ | ----------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `demand-review`                | PM reviewer | 判断需求必要性、合理性、范围、AC 质量 | `reviewedArtifactId`, `producerAgentId`, `reviewerAgentId`, `scope`, `outOfScope`, `decision`, `findings` |
| `requirement-interface-review` | RD / QA     | 判断需求产物是否足够支撑自身工作      | `role`, `interfaceQuestions`, `blockingIssues`, `assumptions`, `decision`                                 |
| `implementation-plan`          | RD          | 开发前技术计划                        | `targetFiles`, `approach`, `risks`, `testStrategy`, `rollbackPlan`, `openQuestions`                       |
| `technical-review`             | RD reviewer | 评审技术方案合理性                    | `reviewedArtifactId`, `decision`, `designFindings`, `riskFindings`, `requiredChanges`                     |
| `test-plan`                    | QA          | 测试验收方案                          | `acCoverage`, `testCases`, `testData`, `environment`, `riskBasedTests`, `exitCriteria`                    |
| `test-plan-review`             | QA reviewer | 评审测试方案充分性                    | `reviewedArtifactId`, `coverageFindings`, `riskFindings`, `decision`                                      |
| `test-plan-intent-review`      | PM          | 判断测试方案是否覆盖需求意图          | `coveredAcIds`, `missingIntent`, `decision`                                                               |
| `qa-release-signoff`           | QA          | 绑定目标 SHA 的最终质量签核           | `commitSha`, `deliveryBranch`, `prUrl`, `executedTests`, `acEvidence`, `knownRisks`, `decision`           |
| `qa-release-signoff-review`    | QA reviewer | 防止 QA 自签自验                      | `reviewedArtifactId`, `producerAgentId`, `reviewerAgentId`, `decision`, `findings`                        |
| `process-checkpoint`           | PMO         | 过程完整性检查                        | `requiredArtifacts`, `missingArtifacts`, `gateSummary`, `humanDecisions`, `deliveryReadiness`             |

### 5.2 独立评审最小字段

每个 review artifact 必须满足：

```json
{
  "reviewedArtifactId": "artifact-id",
  "producerAgentId": "agent-id-that-produced-reviewed-artifact",
  "reviewerAgentId": "different-reviewer-agent-id",
  "producerExecutionId": "execution-id-that-produced-reviewed-artifact",
  "reviewerExecutionId": "different-review-execution-id",
  "contextMode": "isolated",
  "scope": {
    "role": "pm|rd|qa|reviewer|pmo",
    "allowed": ["role-owned concerns"],
    "outOfScope": ["other role-owned concerns"]
  },
  "decision": "pass|changes-requested|blocked"
}
```

---

## 6. Role Boundary Rules

| 角色     | 允许评审                                                              | 不允许评审                                     |
| -------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| PM       | 需求必要性、业务目标、范围、优先级、AC 表达、测试方案是否覆盖需求意图 | 技术方案优劣、测试用例设计细节、代码实现方式   |
| RD       | 技术可行性、实现路径、依赖、复杂度、风险、回滚                        | 需求是否值得做、测试覆盖是否充分、最终质量签核 |
| QA       | AC 可测性、测试方案、验收口径、风险场景、最终 signoff                 | 业务价值判断、技术实现方案优劣、代码风格       |
| Reviewer | 基于已批准需求和方案审查变更质量、可维护性、风险                      | 重新定义需求目标、替代 PM/RD/QA 的专业结论     |
| PMO      | 产物齐全性、证据链、gate 状态、风险记录、人工决策、交付包完整性       | 替 PM 判需求、替 RD 判技术、替 QA 判质量       |

---

## 7. P1 Implementation Tasks

### Task 1: Create Standard Workflow Template

**Files:**

- Create: `workflows/standard-delivery.yaml`
- Modify: `packages/core/__tests__/workflow/template.test.ts`

- [ ] **Step 1: Write template parser test**

Add a test case that loads `workflows/standard-delivery.yaml` and asserts these node ids exist in dependency order: `pm-demand-card`, `pm-demand-review`, `rd-requirement-interface-review`, `qa-requirement-interface-review`, `rd-implementation-plan`, `rd-technical-review`, `qa-test-plan`, `qa-test-plan-review`, `pm-test-plan-intent-review`, `rd-code-change`, `reviewer-change-review`, `qa-validation`, `qa-release-signoff-review`, `pmo-checkpoint`.

- [ ] **Step 2: Run the failing test**

Run: `pnpm vitest run packages/core/__tests__/workflow/template.test.ts`

Expected before implementation: the test fails because `workflows/standard-delivery.yaml` does not exist.

- [ ] **Step 3: Add `workflows/standard-delivery.yaml`**

Use the YAML skeleton in section 4.2 and keep artifact aliases consistent with existing workflow templates.

- [ ] **Step 4: Run parser test again**

Run: `pnpm vitest run packages/core/__tests__/workflow/template.test.ts`

Expected after implementation: the new test passes and existing workflow template tests still pass.

- [ ] **Step 5: Commit**

```bash
git add workflows/standard-delivery.yaml packages/core/__tests__/workflow/template.test.ts
git commit -m "feat: add standard delivery workflow template"
```

### Task 2: Add Artifact Schemas

**Files:**

- Modify: `packages/core/src/artifact/schemas.ts`
- Modify: `packages/core/__tests__/artifact/schemas.test.ts`

- [ ] **Step 1: Add failing schema tests**

Create positive and negative samples for `demand-review`, `implementation-plan`, `technical-review`, `test-plan`, `qa-release-signoff`, `qa-release-signoff-review`, and `process-checkpoint`. Negative samples must cover missing `reviewedArtifactId`, equal producer/reviewer ids, missing `commitSha` in QA signoff, and missing `acCoverage` in test plan.

- [ ] **Step 2: Run schema tests**

Run: `pnpm vitest run packages/core/__tests__/artifact/schemas.test.ts`

Expected before implementation: new artifact types fail validation because the schemas are not registered.

- [ ] **Step 3: Implement schemas**

Add Zod schemas for the artifact types in section 5.1. Keep the shared review fields as a local helper inside `schemas.ts` unless an existing helper already covers the pattern.

- [ ] **Step 4: Run schema tests again**

Run: `pnpm vitest run packages/core/__tests__/artifact/schemas.test.ts`

Expected after implementation: all schema tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/artifact/schemas.ts packages/core/__tests__/artifact/schemas.test.ts
git commit -m "feat: add standard delivery artifact schemas"
```

### Task 3: Enforce Independent Review And Role Scope Gates

**Files:**

- Modify: `packages/core/src/gate/runners.ts`
- Modify: `packages/core/__tests__/gate/runners.test.ts`
- Modify: `packages/core/src/gate/engine.ts` only if existing gate dispatch needs a new gate type mapping

- [ ] **Step 1: Add failing gate tests**

Add tests for:

- `independent-review` passes when `producerAgentId != reviewerAgentId` and `producerExecutionId != reviewerExecutionId`.
- `independent-review` fails when agent ids or execution ids match.
- `role-scope` fails when PM review includes technical design verdicts, RD review includes business value verdicts, QA review includes implementation-choice verdicts, or PMO review includes professional quality verdicts.

- [ ] **Step 2: Run gate tests**

Run: `pnpm vitest run packages/core/__tests__/gate/runners.test.ts packages/core/__tests__/gate/engine.test.ts`

Expected before implementation: new gate types are unknown or fail.

- [ ] **Step 3: Implement gate runners**

Implement deterministic checks against artifact JSON fields. Do not use LLM judgment inside the gate. Use explicit fields such as `scope.role`, `scope.outOfScope`, `finding.category`, and `decision`.

- [ ] **Step 4: Run gate tests again**

Run: `pnpm vitest run packages/core/__tests__/gate/runners.test.ts packages/core/__tests__/gate/engine.test.ts`

Expected after implementation: tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/gate/runners.ts packages/core/src/gate/engine.ts packages/core/__tests__/gate/runners.test.ts
git commit -m "feat: enforce independent scoped reviews"
```

### Task 4: Add AC Evidence Traceability

**Files:**

- Modify: `packages/core/src/eval/work-readiness.ts`
- Modify: `packages/core/src/delivery/evidence.ts`
- Modify: `packages/core/__tests__/eval/work-readiness.test.ts`
- Modify: `packages/core/__tests__/delivery/evidence.test.ts`

- [ ] **Step 1: Add failing evidence mapping tests**

Create a fixture demand-card with AC ids `AC-01` and `AC-02`, a QA test-plan covering both ids, and a QA test-report with concrete evidence for both. Assert readiness reports `acceptance-criteria-evidenced` as pass.

- [ ] **Step 2: Add failing missing evidence test**

Create a fixture where `AC-02` is absent from QA evidence. Assert readiness reports the missing AC id instead of a generic unknown.

- [ ] **Step 3: Run readiness tests**

Run: `pnpm vitest run packages/core/__tests__/eval/work-readiness.test.ts packages/core/__tests__/delivery/evidence.test.ts`

Expected before implementation: readiness cannot map AC ids through QA evidence.

- [ ] **Step 4: Implement mapping**

Map `demand-card.acceptanceCriteria[].id` to `test-plan.acCoverage[]`, `test-report.acceptanceChecks[]`, and `qa-release-signoff.acEvidence[]`. Treat natural-language evidence as secondary; structured AC id mapping is primary.

- [ ] **Step 5: Run readiness tests again**

Run: `pnpm vitest run packages/core/__tests__/eval/work-readiness.test.ts packages/core/__tests__/delivery/evidence.test.ts`

Expected after implementation: full evidence passes; missing evidence names the exact AC id.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/eval/work-readiness.ts packages/core/src/delivery/evidence.ts packages/core/__tests__/eval/work-readiness.test.ts packages/core/__tests__/delivery/evidence.test.ts
git commit -m "feat: map acceptance criteria evidence"
```

### Task 5: Add QA Final Signoff Gate

**Files:**

- Modify: `packages/core/src/gate/runners.ts`
- Modify: `packages/core/__tests__/gate/runners.test.ts`
- Modify: `packages/core/src/delivery/pr-package.ts`
- Modify: `packages/core/__tests__/delivery/pr-package.test.ts`

- [ ] **Step 1: Add failing signoff tests**

Assert `qa-signoff` fails when `commitSha` is missing, when `decision` is not `pass`, or when signoff SHA does not match the delivery package PR head SHA.

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run packages/core/__tests__/gate/runners.test.ts packages/core/__tests__/delivery/pr-package.test.ts`

Expected before implementation: signoff consistency is not enforced.

- [ ] **Step 3: Implement signoff gate and PR package display**

Require `commitSha`, `deliveryBranch`, `executedTests`, `acEvidence`, `knownRisks`, and `decision`. PR package must show QA signoff before PR decision summary.

- [ ] **Step 4: Run tests again**

Run: `pnpm vitest run packages/core/__tests__/gate/runners.test.ts packages/core/__tests__/delivery/pr-package.test.ts`

Expected after implementation: signoff failures block delivery; valid signoff appears in PR package.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/gate/runners.ts packages/core/src/delivery/pr-package.ts packages/core/__tests__/gate/runners.test.ts packages/core/__tests__/delivery/pr-package.test.ts
git commit -m "feat: require QA final signoff"
```

### Task 6: Update Role Descriptions

**Files:**

- Modify: `roles/pm/system.md`
- Modify: `roles/rd/system.md`
- Modify: `roles/qa/system.md`
- Modify: `roles/reviewer/system.md`
- Modify: `roles/pmo/system.md`
- Modify: `packages/core/__tests__/role/prompt-builder.test.ts`

- [ ] **Step 1: Add failing prompt tests**

Assert each role prompt contains its allowed review scope and explicit out-of-scope boundaries.

- [ ] **Step 2: Run prompt tests**

Run: `pnpm vitest run packages/core/__tests__/role/prompt-builder.test.ts`

Expected before implementation: role prompts do not contain the new boundaries.

- [ ] **Step 3: Update role system files**

Add the role rules from section 6 to the corresponding role files. Keep wording concise and imperative.

- [ ] **Step 4: Run prompt tests again**

Run: `pnpm vitest run packages/core/__tests__/role/prompt-builder.test.ts`

Expected after implementation: all role boundary assertions pass.

- [ ] **Step 5: Commit**

```bash
git add roles/pm/system.md roles/rd/system.md roles/qa/system.md roles/reviewer/system.md roles/pmo/system.md packages/core/__tests__/role/prompt-builder.test.ts
git commit -m "docs: define scoped role review boundaries"
```

### Task 7: Build PR Package V2

**Files:**

- Modify: `packages/core/src/delivery/pr-package.ts`
- Modify: `packages/core/__tests__/delivery/pr-package.test.ts`
- Modify: `packages/core/src/review/surface.ts`
- Modify: `packages/core/__tests__/review/surface.test.ts`

- [ ] **Step 1: Add failing PR package tests**

Assert package output has sections in this order: result, risk, AC evidence, QA signoff, review findings, CI, human decisions, rollback. Assert no `evidence: unknown` remains when structured AC evidence exists.

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run packages/core/__tests__/delivery/pr-package.test.ts packages/core/__tests__/review/surface.test.ts`

Expected before implementation: current package does not satisfy V2 structure.

- [ ] **Step 3: Implement package layout**

Use existing evidence aggregation where possible. Prefer deterministic formatting and stable ordering.

- [ ] **Step 4: Run tests again**

Run: `pnpm vitest run packages/core/__tests__/delivery/pr-package.test.ts packages/core/__tests__/review/surface.test.ts`

Expected after implementation: V2 package tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/delivery/pr-package.ts packages/core/src/review/surface.ts packages/core/__tests__/delivery/pr-package.test.ts packages/core/__tests__/review/surface.test.ts
git commit -m "feat: improve delivery evidence package"
```

### Task 8: Update User-Facing Documentation

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/manual/tekon-user-manual.md`
- Modify: `docs/manual/tekon-user-manual.html`
- Create: `docs/reviews/2026-06-11-standard-delivery-workflow-review.md`
- Create: `docs/reviews/2026-06-11-standard-delivery-workflow-review.html`

- [ ] **Step 1: Update Markdown docs**

Explain how users select `standard-delivery`, what artifacts they receive, how QA final signoff works, and which actions still require human approval.

- [ ] **Step 2: Update HTML docs**

Synchronize the HTML user manual with the Markdown source and include the same constraints.

- [ ] **Step 3: Validate docs**

Run: `rg -n "standard-delivery|QA final signoff|独立评审|角色边界|人工批准" README.md docs/manual/tekon-user-manual.md docs/manual/tekon-user-manual.html`

Expected: all core terms appear in user-facing docs.

- [ ] **Step 4: Scan unfinished-marker terms**

Run the repository unfinished-marker scan against `README.md`, `CHANGELOG.md`, `docs/manual/tekon-user-manual.md`, `docs/manual/tekon-user-manual.html`, `docs/reviews/2026-06-11-standard-delivery-workflow-review.md`, and `docs/reviews/2026-06-11-standard-delivery-workflow-review.html`.

Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md docs/manual/tekon-user-manual.md docs/manual/tekon-user-manual.html docs/reviews/2026-06-11-standard-delivery-workflow-review.md docs/reviews/2026-06-11-standard-delivery-workflow-review.html
git commit -m "docs: document standard delivery workflow"
```

### Task 9: Run Full P1 Verification

**Files:**

- No direct source edits unless verification reveals a defect.

- [ ] **Step 1: Run targeted suites**

Run:

```bash
pnpm vitest run packages/core/__tests__/workflow/template.test.ts packages/core/__tests__/artifact/schemas.test.ts packages/core/__tests__/gate/runners.test.ts packages/core/__tests__/eval/work-readiness.test.ts packages/core/__tests__/delivery/evidence.test.ts packages/core/__tests__/delivery/pr-package.test.ts packages/core/__tests__/role/prompt-builder.test.ts
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run broad verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 3: Run a standard workflow dry run**

Run a local Tekon run using `standard-delivery` on a small documentation-only demand. Expected: the run reaches PM/RD/QA/Reviewer/PMO nodes and produces the new artifact types.

- [ ] **Step 4: Record evidence**

Create a review report under `docs/reviews/` with run id, gate summary, artifact summary, known gaps, and whether a real PR was created.

- [ ] **Step 5: Commit verification report**

```bash
git add docs/reviews/
git commit -m "docs: record standard delivery workflow verification"
```

---

## 8. P2 Capability Plan

### 8.1 Web Cockpit V2

Goal: user can answer “现在卡在哪、风险是什么、下一步谁处理、PR 是否可审” without reading `.tekon/`.

Required views:

- Run timeline with phase/node/gate status.
- Artifact graph from demand-card to QA signoff.
- AC evidence matrix.
- PR and CI status panel.
- Human decision queue.
- Provider/runtime snapshot.

Exit criteria:

- Web shows `standard-delivery` run with all P1 artifact types.
- Failed gate links to exact artifact and command output.
- QA signoff SHA and PR head SHA are visible together.

### 8.2 Artifact Center

Goal: artifacts are first-class review objects, not files hidden under `.tekon/runs`.

Required capabilities:

- Artifact list by run, role, type, status, version.
- Artifact diff between versions.
- Artifact-to-gate and artifact-to-AC links.
- Downloadable Markdown/JSON evidence.

### 8.3 Audit Replay And Causal Trace

Goal: explain why a run reached its final state.

Required capabilities:

- Replay node transitions from audit log.
- Show which gate blocked which node.
- Show which artifact fixed which failure.
- Detect audit hash chain breakage and surface it in review.

### 8.4 Cost And Duration Telemetry

Goal: judge whether AI delivery is worth using.

Required metrics:

- Duration by run, role, node, provider.
- Retry count and repair count.
- Human intervention count.
- Token/cost fields when provider exposes them.
- Time-to-reviewable-PR.

### 8.5 Multi Provider Stabilization

Goal: keep Codex stable, then add Trae as a comparable provider.

Provider contract:

- Non-interactive execution.
- Isolated worktree.
- Controlled artifact output directory.
- Required manifest.
- Deterministic timeout and retry behavior.
- Structured failure classification.

Exit criteria:

- Same Tekon demand can run on Codex and Trae.
- Provider comparison report shows success rate, artifact completeness, duration, human interventions, and failure diagnosability.

---

## 9. P3 Capability Plan

| Capability                             | Goal                                                                         | Entry condition                               |
| -------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| DAG parallel execution                 | Run independent review/planning nodes in parallel                            | P1 workflow stable on at least 3 real demands |
| Knowledge and skill flywheel           | Convert recurring failures and high-quality fixes into repo rules and skills | At least 10 real runs with review feedback    |
| Architect/UI/DevOps/Ops roles          | Handle larger feature, frontend, release and operations work                 | P1 roles and scope gate stable                |
| Release and rollback integration       | Extend beyond PR into controlled release preparation                         | QA signoff and PR evidence stable             |
| Permission and organization governance | Support team use with identity, approval, audit visibility                   | Web Cockpit and audit replay stable           |

---

## 10. Metrics

| Metric                          | Target for P1                                          | Notes                                                 |
| ------------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| Standard workflow parse success | 100% in tests                                          | Template cannot be optional once introduced           |
| Required artifact completeness  | 100% for P1 samples                                    | Missing artifact blocks delivery                      |
| Independent review enforcement  | 100% deterministic                                     | Same agent or execution must fail                     |
| Role-scope violation detection  | Covered by tests for PM/RD/QA/Reviewer/PMO             | Gate checks explicit structured fields                |
| AC evidence coverage            | 100% for accepted PRs                                  | Missing AC evidence blocks readiness                  |
| QA signoff SHA match            | 100%                                                   | Signoff SHA must match PR head or delivery branch SHA |
| Human review time               | Under 5 minutes for documentation and low-risk changes | Measured from PR package readability                  |
| Real sample count               | 3 in P1-D                                              | Use Tekon self-demands first                          |

---

## 11. Risks And Controls

| Risk                                                         | Control                                                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Workflow becomes too heavy for small docs changes            | Keep `docs-update` as lightweight template; use `standard-delivery` for default governed delivery and medium-risk work |
| Role-scope gate overfits keywords                            | Gate should validate structured categories, not natural-language text alone                                            |
| Independent review increases latency                         | Use parallelizable interface reviews after P1; avoid heavyweight approval boards                                       |
| QA signoff blocks PR creation when PR URL does not exist yet | Allow signoff to bind delivery branch SHA before PR creation, then verify PR head SHA after PR creation                |
| PMO becomes professional reviewer by accident                | PMO artifact schema only allows completeness, evidence, gate and decision fields                                       |
| P2 expands before P1 stabilizes                              | P2 starts only after 3 real P1 samples and a review report                                                             |

---

## 12. Execution Recommendation

Recommended sequence:

1. Implement P1-A and P1-B first: workflow template, artifact schemas, independent review gate, role-scope gate.
2. Implement P1-C next: AC evidence traceability, QA signoff, PR package V2.
3. Run P1-D on 3 Tekon self-demands.
4. Use P1 evidence to decide P2 ordering. If review bottleneck is highest, do Web Cockpit first. If run failures dominate, do provider regression and telemetry first.

Do not start Trae provider, DAG parallel execution, or release automation before P1-D produces at least 3 successful or diagnosable real samples.
