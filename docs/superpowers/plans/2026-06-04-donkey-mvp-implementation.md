# Donkey MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Donkey Phase 0/1 的本地可运行 MVP。

**Architecture:** MVP 采用 TypeScript CLI + 文件态状态存储 + Local Runner。它实现 Intent/Target Stage Gate、可裁剪 Workflow、Agent Registry、Tool Gateway、Evidence/HTML 报告和历史任务 replay 评测；CI Runner、Container Runner、外部 Coding Agent 先保留 adapter 边界。

**Tech Stack:** Node.js、TypeScript、Node 内置 `node:test`、文件系统 JSON 存储、HTML 报告。

---

### Task 1: 项目骨架与测试基线

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`
- Create: `tests/intent.test.ts`
- Create: `tests/policy.test.ts`
- Create: `tests/workflow.test.ts`
- Create: `tests/runner.test.ts`
- Create: `tests/eval.test.ts`

- [ ] 写入 TypeScript 工程配置和行为测试。
- [ ] 运行 `npm test`，预期失败，因为实现模块尚不存在。

### Task 2: 核心模型、Intent 与 Gate

**Files:**
- Create: `src/intent.ts`
- Create: `src/policy.ts`
- Modify: `src/types.ts`

- [ ] 实现输入类型判断、目标阶段选择、高危降级。
- [ ] 实现命令和需求风险策略。
- [ ] 运行 `npm test -- --test-name-pattern "intent|policy"`。

### Task 3: Registry、Workflow 与默认配置

**Files:**
- Create: `src/defaults.ts`
- Create: `src/registry.ts`
- Create: `src/workflow.ts`

- [ ] 实现默认 Repo Profile、Agent Profiles、Workflow Definition。
- [ ] 实现 Workflow 裁剪，支持从想法、需求、技术方案、PR 进入不同目标阶段。
- [ ] 运行 `npm test -- --test-name-pattern "workflow"`。

### Task 4: Tool Gateway、Runner 与 Evidence

**Files:**
- Create: `src/fs-store.ts`
- Create: `src/tool-gateway.ts`
- Create: `src/html.ts`
- Create: `src/evidence.ts`
- Create: `src/runner.ts`

- [ ] 实现 `.donkey/runs/<runId>` 文件态存储。
- [ ] 实现 Local Runner 执行测试命令、记录 ToolRun、生成证据。
- [ ] 实现 HTML 交付证据包。
- [ ] 运行 `npm test -- --test-name-pattern "runner"`。

### Task 5: CLI 与 Eval

**Files:**
- Create: `src/cli.ts`
- Create: `src/eval.ts`
- Modify: `package.json`

- [ ] 实现 `donkey init`、`donkey run`、`donkey status`、`donkey show`、`donkey eval`。
- [ ] 实现 `donkey-eval` 历史样本 replay。
- [ ] 运行完整 `npm test`。

### Task 6: 文档、验收报告与最终验证

**Files:**
- Modify: `README.md`
- Create: `docs/reviews/2026-06-04-mvp-acceptance-report.html`

- [ ] 更新 README，说明安装、初始化、运行、评测和报告路径。
- [ ] 运行 `npm run build`、`npm test`、CLI smoke、eval smoke。
- [ ] 启动 reviewer 复查，修复必须修复项。
- [ ] 生成 HTML 验收报告并提交。
