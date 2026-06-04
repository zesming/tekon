# Donkey V2 技术方案

> 本文档是 Donkey 重构版本（V2）的完整技术方案。V2 保留 V1 的核心定位（面向技术基建团队的 AI 自动交付系统），在架构上进行了根本性重构：从单块 CLI 工具演进为基于角色文件系统 + 可编排 Workflow 引擎的 AI 原生产研流程执行系统。

## 一、产品定位与核心思路

### 1.1 定位

Donkey V2 是一个面向技术基建团队的 AI 自动交付系统。用户提出需求目标，Donkey 自动组织可协作的 AI 角色团队，通过动态 Workflow、角色工具链和质量 Gate，把项目从需求推进到可验收的 PR。

**一句话定位**：让技术基建团队从"自己提出需求、自己拆、自己做、自己测、自己催"转向"提出目标，验收交付"。

### 1.2 核心设计思路

- **角色即文件夹**：每个角色（PM/RD/QA 等）以文件夹形式维护（`agent.yaml` + `system.md` + `skills/` + `tools.yaml` + `knowledge/`），运行时自动扫描加载。约定优于配置。
- **流程即 Workflow 模板**：研发流程由可配置的 YAML 模板定义，根据需求类型自动匹配和编排。模板可通过脚手架交互式创建，也可由 Agent 动态生成。
- **引擎是纯确定性调度器**：Orchestrator 不做 LLM 调用，只做状态机和任务调度。所有"智能判断"委托给对应的角色 Agent。
- **产物驱动而非聊天驱动**：角色 Agent 之间通过结构化产物（需求卡、PRD、测试报告等）交接，不以自由聊天推进项目。
- **Autonomy-first, Risk-gated**：执行阶段尽量全自动到 PR，交付阶段强证据验收。高危动作必须动态插入人工确认 Gate。

### 1.3 架构原则

| 原则 | 含义 | 来源 |
|------|------|------|
| 角色原生 | 每个角色是独立实体，有身份、能力、工具、知识 | Multica / CrewAI |
| 生成与评审分离 | 产出 Agent ≠ 评审 Agent | SDD 社区共识 |
| 上下文独立 | Agent 在干净上下文启动，只注入当前阶段必需知识 | 逐级披露策略 |
| 结构化交接 | Agent 间通过结构化产物传递信息 | SDD / spec-first |
| 硬门禁 | Gate 是确定性检查，不是软约束 | autonomous-dev 12-element harness |
| 产物驱动 | 项目推进依据产物和 Gate，不以聊天记录 | Alpha-G 4.3、Beta-G 4.1 |
| 约定优于配置 | 角色文件夹按约定存放，自动发现加载 | OpenClaw 模式 |

### 1.4 术语约定

| 术语 | 含义 |
|------|------|
| **Orchestrator** | 系统级调度中心，统称。包含 Workflow Engine + Constraint Validator + Gate Engine 调度器 |
| **Workflow Engine** | Orchestrator 的核心子模块，负责 Workflow 模板解析、Phase/Node 实例化和执行调度 |
| **Role Runner** | Role System 的子模块，负责角色加载、prompt 组装和 Agent 进程 spawn |
| **Engine** | 在上下文明确时为 Workflow Engine 的简称 |

---

## 二、系统架构

### 2.1 总体架构图

```
┌──────────────────────────────────────────────────────────────┐
│                      Donkey System                            │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────┐  ┌──────────────────────────────────────┐   │
│  │   CLI       │  │         Web Dashboard                 │   │
│  │ (Commander  │  │   (Next.js + tRPC + shadcn/ui)       │   │
│  │  + ink)     │  │                                       │   │
│  └──────┬──────┘  └────────────────┬─────────────────────┘   │
│         │                          │                          │
│         └──────────┬───────────────┘                          │
│                    │                                          │
│         ┌──────────▼──────────────┐                           │
│         │      Core API           │  ← tRPC router            │
│         │  (packages/core)        │     CLI 直接调用函数      │
│         │                         │     Web 通过 HTTP          │
│         │  ┌───────────────────┐  │                           │
│         │  │ Workflow Engine   │  │  纯状态机 + 调度器        │
│         │  │ (pipeline/parallel│  │  不调 LLM                │
│         │  │  /phase 原语)     │  │                          │
│         │  ├───────────────────┤  │                           │
│         │  │ Role System       │  │  扫描→加载→组装→运行     │
│         │  ├───────────────────┤  │                           │
│         │  │ Gate Engine       │  │  build/test/lint/        │
│         │  │                   │  │  e2e/schema/security     │
│         │  ├───────────────────┤  │                           │
│         │  │ Artifact Store    │  │  产物 CRUD + 版本化      │
│         │  ├───────────────────┤  │                           │
│         │  │ Constraint        │  │  hard/conditional/       │
│         │  │ Validator         │  │  soft 三层约束           │
│         │  ├───────────────────┤  │                           │
│         │  │ Audit Logger      │  │  不可变事件日志           │
│         │  └───────────────────┘  │                           │
│         └──────────┬──────────────┘                           │
│                    │                                          │
│         ┌──────────▼──────────────┐                           │
│         │    Agent Runtime        │                           │
│         │  spawn Claude Code/     │                           │
│         │  Codex (子进程)          │                           │
│         │  Git Worktree 隔离      │                           │
│         └──────────┬──────────────┘                           │
│                    │                                          │
│         ┌──────────▼──────────────┐                           │
│         │    Storage              │                           │
│         │  SQLite (better-sqlite3)│  状态机 + 审计 + 元数据   │
│         │  + FS (产物/角色/WF)    │  产物以文件存储           │
│         └─────────────────────────┘                           │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 技术栈

| 层 | 选择 | 理由 |
|---|------|------|
| **语言** | TypeScript | AI Coding 友好度最高；Claude Code/Codex 生态原生 |
| **Monorepo** | pnpm workspaces + tsup | 最简 monorepo 方案，tsup 打包快 |
| **Core** | TypeScript 纯逻辑 | CLI 和 Web 共享 |
| **CLI** | Commander.js + ink | Commander 生态最大；ink = React 渲染终端 UI |
| **Web** | Next.js + shadcn/ui + tRPC | 端到端类型安全；Multica 同款栈 |
| **数据库** | SQLite (`better-sqlite3`) | 零依赖，同步 API，单机场景最优 |
| **测试** | Vitest + Playwright | 单测到 E2E 全覆盖 |
| **Agent 隔离** | Git Worktree | Codex/CC 原生支持，Agent 间互不干扰 |

### 2.3 为什么用 TypeScript

- AI Coding Agent（Claude Code / Codex / Cursor）的训练数据中 TypeScript 压倒性多，代码生成质量和速度明显优于 Go/Rust
- Donkey 本身就是一个会被 AI 辅助开发的项目，技术栈应该对自己最友好
- Node.js 生态的 CLI、Web、测试工具链最完整
- 角色文件夹的动态加载（`fs.readdir` + 模板渲染）在 TypeScript 中最自然

---

## 三、核心数据模型

### 3.1 对象关系

```
Demand ──────→ Project ──────→ WorkflowInstance
（需求卡）      （项目实例）     （流程实例）
                                    │
                          ┌─────────┼─────────┐
                          ▼         ▼         ▼
                       Phase     Phase     Phase
                       （阶段）   （阶段）   （阶段）
                          │
                    ┌─────┼─────┐
                    ▼     ▼     ▼
                  Node  Node  Node
                  （节点：最小执行单元）
                    │
              ┌─────┼─────┐
              ▼     ▼     ▼
          RoleRun  Gate  Artifact
          （一次    （门禁）（产物）
           角色执行）
```

### 3.2 核心对象定义

#### Demand（需求卡）

```typescript
interface Demand {
  id: string;
  title: string;
  description: string;            // 原始需求描述
  scope: string;                  // 范围说明
  nonGoals: string[];             // 非目标
  tags: string[];                 // 分类标签（auth/data/payment 等）
  riskLevel: 'low' | 'medium' | 'high' | 'blocked';
  acceptanceCriteria: AcceptanceCriterion[];
  status: DemandStatus;
  // draft → clarifying → shaped → prioritized → converted → project-linked
}
```

#### Project（项目实例）

```typescript
interface Project {
  id: string;
  demandId: string;
  name: string;
  workflowInstanceId: string;
  status: ProjectStatus;
  // pending → planning → executing → verifying → delivering
  // → completed | rolled-back | cancelled
  repoUrl: string;
  branch: string;
  createdAt: Date;
  updatedAt: Date;
}
```

#### WorkflowInstance（流程实例）

```typescript
interface WorkflowInstance {
  id: string;
  templateRef: string;           // 模板引用或 'dynamic' 标记
  projectId: string;
  phases: Phase[];
  currentPhaseIndex: number;
  status: 'running' | 'paused' | 'completed' | 'failed';
}
```

#### Phase（阶段）

```typescript
interface Phase {
  id: string;
  title: string;
  nodes: Node[];
  parallel: boolean;             // 节点是否并行执行
  gate?: GateConfig;             // 阶段出口 Gate（Phase 内所有 Node 通过后运行，可选）
  status: 'pending' | 'running' | 'completed' | 'failed';
  source: 'template' | 'dynamic' | 'constraint';
  // template: 来自预定义 YAML 模板
  // dynamic: 由 PM Agent 动态生成
  // constraint: 由约束系统自动注入（`requirePhase` 规则触发）
}
```

#### Node（最小执行单元）

```typescript
interface Node {
  id: string;
  role: string;
  task: {
    input: ArtifactRef[];
    output: ArtifactType[];
    instruction: string;
  };
  skills: string[];
  gate?: GateConfig;            // 节点级 Gate（节点完成后、Phase 出口 Gate 之前运行）
  status: NodeStatus;
  // pending → running → awaiting-gate → passed
  // → needs-revision → blocked → skipped
  // running → interrupted（Ctrl+C / 信号中断）
  // interrupted → pending（恢复时从头重新执行，因为产物可能不完整）
  retryCount: number;
  maxRetries: number;
  source: 'template' | 'dynamic' | 'constraint';
}
```

#### RoleRun（角色执行记录）

```typescript
interface RoleRun {
  id: string;
  nodeId: string;
  role: string;
  startTime: Date;
  endTime?: Date;
  status: 'running' | 'completed' | 'failed';
  worktreePath: string;
  logFile: string;
  artifacts: string[];
}
```

#### Gate（门禁）

```typescript
type GateType =
  | 'build' | 'test' | 'lint' | 'e2e-pass'
  | 'schema' | 'security-scan' | 'human';

// 单个门禁检查项
interface GateCheck {
  type: GateType;
  command?: string;          // 确定性 gate 的执行命令（如 npm test）
  autoFix: boolean;          // 失败后是否自动 spawn Agent 修复
}

// 门禁配置：包含检查链和执行策略
interface GateConfig {
  checks: GateCheck[];       // 按顺序执行的检查列表
  retryLimit: number;        // 整条链的最大重试次数
  onExhausted: 'skip' | 'block' | 'escalate-human';
  // skip: 跳过当前 gate（标记 warning），继续执行后续检查
  // block: 停止当前 Node，Node 标记为 blocked，等待人工处理
  // escalate-human: 暂停整个 Workflow，等待人类确认
}
```

**Node.retry 与 GateConfig.retryLimit 的关系**：
- `Node.retry`（模板定义）控制 Node 级别的重试次数
- `GateConfig.retryLimit` 控制 Gate chain 级别
- 合并规则：Node 级 `retry` 优先于角色级 `agent.yaml#maxRetries`，两者都未设置则默认不重试（`maxRetries = 0`，即只执行一次）
- Gate chain 内部每个 check 的重试计入 Node 的 retry 配额

interface GateResult {
  type: GateType;
  status: 'pass' | 'fail' | 'error';
  output: string;
  duration: number;
  retriesUsed: number;
  fixedByAgent: boolean;
}
```

#### ArtifactRef（产物引用）

```typescript
// Node 间产物依赖解析的核心类型
// 引擎按 phase 顺序向前查找匹配的 Artifact
interface ArtifactRef {
  type: ArtifactType;          // 必填：按类型匹配最近的同类产物
  nodeId?: string;             // 可选：精确指定来源 Node
  phaseIndex?: number;         // 可选：限定搜索范围（默认向前搜索所有已完成 phase）
}

// 依赖解析算法（引擎执行时）：
// 1. 若有 nodeId → 精确匹配
// 2. 若有 phaseIndex → 限定在该 phase 及之前的所有产物中找最近匹配
// 3. 若仅 type → 在所有已完成 Node 的产物中找最近匹配
// 4. 若找不到 → Node 进入 blocked 状态，等待人工指定
```

#### Artifact（产物）

```typescript
type ArtifactType =
  | 'demand-card' | 'prd' | 'tech-design'
  | 'task-breakdown' | 'code-changes' | 'test-report'
  | 'review-report' | 'delivery-package' | 'rollback-plan'
  | 'security-report';

interface Artifact {
  id: string;
  projectId: string;
  nodeId: string;
  type: ArtifactType;
  version: number;
  status: 'draft' | 'reviewing' | 'needs-revision' | 'approved' | 'archived';
  summary?: string;            // Agent 产出时一并生成的结构化摘要（≤ 500 字）
                               // 上下文注入时优先用 summary；内容超 context 限制时以 summary 替代
  filePath: string;            // 完整产物文件路径
  createdAt: Date;
  updatedAt: Date;
}

// Artifact 状态流转：
// Node 完成 → draft
// Schema Gate 通过 → reviewing
// Reviewer 角色报告通过 → approved
// 被驳回 → needs-revision
// 项目归档 → archived
```

#### AuditEvent（审计日志事件）

```typescript
interface AuditEvent {
  id: string;
  timestamp: Date;
  projectId: string;
  nodeId: string;
  eventType: 'node_started' | 'node_completed' | 'node_interrupted'
    | 'node_retried' | 'gate_pass' | 'gate_fail' | 'gate_escalated'
    | 'artifact_created' | 'artifact_approved' | 'human_decision';
  payload: Record<string, unknown>;  // 事件相关的结构化数据
  roleSource?: string;               // 角色配置的实际来源路径（用于审计追溯）
}
```

### 3.3 Node 状态流转

```
               ┌──────────────┐
               │   pending    │◄────────────────────┐
               └──────┬───────┘                     │
                      │ Engine 调度                  │
               ┌──────▼───────┐                     │
         ┌─────│   running    │─────┐               │
         │     └──┬───┬───────┘     │               │
         │        │   │             │               │
         │        │   │ Ctrl+C      │               │
         │        │   │ /signal     │               │
         │        │   ▼            │               │
         │        │ interrupted    │               │
         │        │ (恢复时从头重   │               │
         │        │  新执行)───────┘               │
         │        │                                │
    retry < limit  Agent 完成  retry >= limit       │
         │            │             │               │
         │     ┌──────▼───────┐     │               │
         └─────│awaiting-gate │     │               │
               └──────┬───────┘     │               │
                      │             │               │
              Gate 判定              │               │
           ┌──────┼──────┐          │               │
           ▼      ▼      ▼          │               │
        passed  needs-  needs-      │               │
                revision human      │               │
           │      │      │          │               │
           │   ┌──┘      │          │               │
           │   ▼         ▼          │               │
           │  回退重做   等待确认    │               │
           │   │         │          │               │
           ▼   ▼         ▼          ▼               │
       passed needs-revision blocked failed          │
```

---

## 四、角色系统

### 4.1 角色文件夹结构

```
roles/
├── pm/                          # 角色名 = 文件夹名
│   ├── agent.yaml               # 角色元信息
│   ├── system.md                # System Prompt（核心，模板变量渲染）
│   ├── skills/                  # 技能：按需注入的上下文
│   │   ├── clarify.md
│   │   ├── prd-gen.md
│   │   └── acceptance.md
│   ├── tools.yaml               # 可用工具声明
│   └── knowledge/               # 领域知识（可空）
│       └── prd-template.md
│
├── rd/
│   ├── agent.yaml
│   ├── system.md
│   ├── skills/
│   │   ├── implement.md
│   │   ├── refactor.md
│   │   └── debug.md
│   └── tools.yaml
│
├── qa/
│   ├── agent.yaml
│   ├── system.md
│   ├── skills/
│   │   ├── test-plan.md
│   │   └── e2e.md
│   └── tools.yaml
│
├── reviewer/
│   ├── agent.yaml
│   ├── system.md
│   ├── skills/
│   │   ├── code-review.md
│   │   └── security.md
│   └── tools.yaml
│
└── pmo/
    ├── agent.yaml
    ├── system.md
    └── skills/
        └── delivery-summary.md
```

### 4.2 agent.yaml 定义

```yaml
# roles/pm/agent.yaml
name: pm
display: 产品经理
description: 负责需求澄清、PRD 生成、验收标准定义
model: claude-sonnet-4
agent:
  command: claude
  args:
    - --permission-mode
    - bypassPermissions
    - --output-format
    - json
timeout: 600000
maxRetries: 2

outputs:
  - demand-card
  - prd

quality: "输出必须结构化、完整、可验证。验收标准必须可客观判定。"

gate:
  checks:
    - type: schema
  retryLimit: 2
  onExhausted: escalate-human

context:
  maxSkills: 2
  includeHistory: true
  knowledgeFiles:             # 指定要注入的知识文件名
    - prd-template.md         # 显式设置时仅注入列表中的文件；不设/空数组时注入全部 .md
```

#### tools.yaml 格式

```yaml
# roles/rd/tools.yaml
tools:
  - name: git
    description: Git 版本控制（commit、push、创建分支）
    allowedCommands: [status, add, commit, push, branch, checkout]
  - name: npm
    description: Node.js 包管理器和脚本执行
    allowedCommands: [install, test, run, build]
  - name: playwright
    description: 浏览器 E2E 测试
    allowedCommands: [test]
```

`tools.yaml` 定义该角色可调用的外部工具及允许的命令白名单。Engine 在 spawn Agent 子进程时将 `tools.yaml` 内容渲染为人类可读的 Markdown 片段，注入到 system prompt 的 `{{loaded_tools}}` 变量位置。危险命令（如 `rm -rf`、`git push --force`）不在白名单中时，Agent 运行时会被 Donkey 的 Tool Gateway 拦截。

#### system.md 模板变量完整列表

| 变量 | 来源 | 说明 |
|------|------|------|
| `{{display}}` | agent.yaml | 角色显示名 |
| `{{description}}` | agent.yaml | 角色职责描述 |
| `{{loaded_skills}}` | skills/ 目录 | 注入的 skill 内容（Markdown） |
| `{{loaded_tools}}` | tools.yaml | 渲染后的工具列表 |
| `{{knowledge}}` | knowledge/ 目录 | 注入的知识文件内容（Markdown） |
| `{{input_artifacts}}` | 上游 Node 产物 | 上游产物的 summary 或截断内容 |
| `{{project_context}}` | 项目元数据 | 项目名称、仓库 URL、分支等 |
| `{{quality_standards}}` | agent.yaml | 由 `quality` 字段定义的质量标准 |

`agent` 字段支持两种写法：

```yaml
# 简洁版（使用预设名称）
agent: claude-code

# 完整版（自定义 command + args + promptMode）
agent:
  command: claude
  args:
    - --model
    - claude-sonnet-4
    - --permission-mode
    - bypassPermissions
  promptMode: arg-append       # prompt 注入方式（见下文）
  env:
    CLAUDE_CODE_API_KEY: ${CC_API_KEY}
```

#### promptMode：Prompt 注入协议

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `stdin` | 通过子进程 stdin 写入 prompt | 大部分 CLI Agent 的标准方式 |
| `arg-append` | 追加到 args 末尾（如 `-p "<prompt>"`） | Claude Code 的 `-p` 模式 |
| `file` | 写入临时文件，通过环境变量 `DONKEY_PROMPT_FILE` 传入路径 | 超长 prompt 超过 shell argv 限制时 |
| `none` | 不注入 prompt，仅设置环境变量 | Agent 自行从环境变量读取上下文 |

**内置 preset 的默认 promptMode**：
- `claude-code` → `arg-append`（拼接 `-p` flag）
- `codex` → `stdin`

**自动降级**：当 prompt 长度超过 shell argv 限制（通常 ~128KB），Engine 自动从 `arg-append` 降级为 `file` 模式，并在 stderr 输出 warning。

**自定义命令的接管协议**：只要自定义脚本/CLI 能从 stdin 读取 prompt 并将产物写入 `DONKEY_OUTPUT_DIR` 环境变量指定的目录，即可作为 Donkey Agent 使用。Engine 在 spawn 前设置以下环境变量：

| 环境变量 | 值 | 说明 |
|----------|----|------|
| `DONKEY_OUTPUT_DIR` | `<worktree>/.donkey-output/` | Agent 写入产物的目录 |
| `DONKEY_ROLE` | `pm` / `rd` / ... | 当前角色名 |
| `DONKEY_PROJECT_ID` | `proj-xxx` | 项目 ID |
| `DONKEY_NODE_ID` | `node-xxx` | 当前 Node ID |
| `DONKEY_PROMPT_FILE` | 临时文件路径 | `file` 模式时指向 prompt 文件 |

### 4.3 system.md 模板

```
你是 {{display}}，{{description}}。

## 输出规范
你必须以结构化 Markdown 输出，包含：
{{#outputs}}
- {{type}}: {{format}}
{{/outputs}}

## 质量标准
{{quality_standards}}

## 可用技能
{{loaded_skills}}

## 可用工具
{{loaded_tools}}

## 上下文
上游产物：{{input_artifacts}}
项目背景：{{project_context}}
```

### 4.4 角色加载优先级

```
1. 项目级：<project>/.donkey/roles/<roleName>/    ← 使用者自定义
2. 用户级：~/.donkey/roles/<roleName>/            ← 使用者全局自定义
3. 内置：  <donkey-pkg>/roles/<roleName>/         ← 开发者预置
（找到第一个存在的目录即停止，不合并文件。定制角色时需完整复制角色文件夹后修改。Phase 2 将支持文件级 deep merge 覆盖策略，降低定制成本）
```

### 4.5 Role Runner 执行流程

#### Skill 解析规范

Skill 文件支持可选的 YAML frontmatter：

```markdown
---
id: clarify
description: 需求澄清追问——向用户提出关键问题以补全需求背景
injectMode: append       # append: 追加到 system prompt 末尾; replace: 替换系统提示中的指定区块
priority: required       # required: 强制执行; optional: 按匹配度选择
---

## 澄清追问策略

当需求描述不完整时，按以下顺序追问：
1. 用户是谁？目标是什么？
2. 具体场景和触发条件？
3. 边界和约束？
...
```

**映射规则**：
- 文件名（去掉 `.md` 后缀）= skill ID（如 `clarify.md` → id=`clarify`）
- Workflow 模板中 `skills: [clarify, acceptance]` 直接按 ID 匹配
- 只从**当前角色的 `skills/` 目录**中加载——角色间不跨引 skill

**Skills 加载优先级**（同角色三个来源合并）：
1. 项目级 `<project>/.donkey/roles/<role>/skills/`
2. 用户级 `~/.donkey/roles/<role>/skills/`
3. 内置 `<donkey-pkg>/roles/<role>/skills/`
- 同名 skill 高优先级覆盖低优先级；不同名 skill 全部合并可用

**注入策略**：
- 引擎根据 Node 的 `skills` 列表和 skill 文件的 `injectMode` 决定注入方式
- `maxSkills`（来自 `agent.yaml`）限制单次注入数量，按 `priority` 过滤（`required` 必注，`optional` 按匹配度选）
- 注入位置：`append` → system prompt 末尾；`replace` → 替换系统提示中的 `{{loaded_skills}}` 占位符

#### 执行流程

```
1. resolveRole(roleName) → 确定角色目录
2. 读 agent.yaml → 拿到 model / agent / timeout / outputs 等配置
3. 根据 task 匹配需要的 skills → 最多注入 maxSkills 个
4. 收集 input_artifacts（上游产物内容）
5. 渲染 system.md 模板（注入 skills / tools / artifacts / context）
6. 组装完整 prompt = system.md + task instruction + artifacts
7. 创建 Git Worktree（隔离工作区）
8. spawn agent 子进程 → 传入 prompt
9. stdout 收集 → 解析为结构化产物
10. 产物写入 Artifact Store
11. 触发 Gate 检查
```

---

## 五、Workflow 引擎

### 5.1 Workflow 模板文件

```yaml
# workflows/standard-feature.yaml
name: standard-feature
description: 标准功能需求，从需求澄清到交付 PR
match:
  riskLevel: [low, medium]
  types: [feature, enhancement]

phases:
  - title: 需求澄清
    parallel: false
    nodes:
      - role: pm
        task:
          instruction: "理解用户需求，补全背景、范围、非目标和验收标准"
          output: [demand-card]
        skills: [clarify, acceptance]
        retry: 2

  - title: 技术方案与开发
    parallel: false
    nodes:
      - role: rd
        task:
          instruction: "基于需求卡完成技术实现"
          input: [demand-card]
          output: [code-changes]
        skills: [implement, refactor]
        retry: 3
        gate:
          checks:
            - type: build
            - type: test
              autoFix: true
            - type: lint
              autoFix: true
          retryLimit: 3
          onExhausted: escalate-human

  - title: 测试验证
    parallel: false
    nodes:
      - role: qa
        task:
          instruction: "基于需求卡和代码变更生成测试计划并执行 E2E"
          input: [demand-card, code-changes]
          output: [test-report]
        skills: [test-plan, e2e]
        retry: 2
        gate:
          checks:
            - type: e2e-pass
          retryLimit: 2
          onExhausted: escalate-human

  - title: 代码审查
    parallel: false
    nodes:
      - role: reviewer
        task:
          instruction: "审查代码变更，检查安全、规范和边界问题"
          input: [code-changes, test-report]
          output: [review-report]
        skills: [code-review, security]

  - title: 交付
    parallel: false
    nodes:
      - role: pmo
        task:
          instruction: "汇总所有产物，生成交付证据包和 PR"
          input: [demand-card, code-changes, test-report, review-report]
          output: [delivery-package]
```

### 5.2 input/output 简写规则

YAML 模板中 `input` 和 `output` 支持简写，Engine 解析时自动展开：

```yaml
# 简写（裸字符串）→ 自动展开为 { type: "demand-card" }
input: [demand-card]
output: [code-changes]

# 完整对象（精确指定来源时使用）→ 保持原样
input:
  - { type: code-changes, nodeId: node-002 }   # 精确指定来源 Node
  - { type: tech-design }                       # 按类型匹配最近产物
output: [code-changes]
```

**转换规则**：若元素为字符串 → 展开为 `{ type: <string> }`；若元素为对象 → 保持原样，必须包含 `type` 字段。

### 5.3 Engine 原语

```typescript
// Phase 级操作
phase(title: string): void

// Node 执行：驱动一个角色 Agent 执行
agent(opts: AgentOpts): Promise<Artifact>

// pipeline：item 独立流经所有 stage，无 barrier
pipeline<T>(
  items: T[],
  ...stages: Array<(item: T, i: number) => Promise<Result>>
): Promise<Result[]>

// parallel：并行执行，barrier 等待全部完成
parallel(
  thunks: Array<() => Promise<Result>>
): Promise<Result[]>
```

参考 Claude Code Dynamic Workflow 的模式——pipeline 是默认模式，parallel 只在必要时使用。

### 5.4 Engine 执行流程

```
1. 加载 Workflow 模板 → 实例化 phases
2. 遍历 phases：
   a. phase(title) → 标记开始
   b. 执行 nodes（parallel 或串行）：
      - 加载角色配置
      - 渲染 system.md → 组装 prompt
      - 创建 Git Worktree
      - spawn Agent 子进程
      - 等待完成 → 收集产物
      - 运行 Gate chain
      - 写入审计日志
   c. 阶段完成 → 进入下一个 phase
3. 所有 phase 完成 → 项目标记为 completed
4. 生成交付证据包
```

### 5.5 状态持久化

每个 Node 执行前后写 SQLite，支持中断恢复：

```
场景：
donkey run → PM 完成 → RD 执行中 → Ctrl+C
donkey run → Engine 读 SQLite → 从 RD 的 Node 继续
```

### 5.6 动态 Workflow 模式

不依赖预定义模板，由 PM Agent 动态生成 workflow spec。引擎不关心来源。

```bash
donkey run --dynamic "给任务平台加批量重试"
```

执行流程：

```
1. PM Agent 分析需求 → 输出 workflow spec (draft)
2. Constraint Validator 校验：
   - hard constraints → 缺失则强制注入
   - conditional constraints → 根据特征判断触发
   - soft suggestions → 记录 warnings
3. 展示预览（--dry-run 模式）
4. Engine 实例化并执行

--save-as flag: 保存为模板供后续复用
donkey run --dynamic --save-as batch-retry "给任务平台加批量重试"
```

### 5.7 脚手架命令

```bash
# 交互式创建
donkey workflow create

# 从已有模板复制
donkey workflow create --from standard-feature --name my-custom

# 快速生成骨架
donkey workflow create --name api-dev --roles pm,rd,qa --preset api
```

---

## 六、Gate Engine

### 6.1 设计原则

Gate 是**确定性检查**，不是软约束。失败要么自动修复（spawn Agent 修复后重试），要么上升给 Reviewer Agent 或人工。

Gate Engine 不调 LLM。需要智能判断时委托给 Reviewer Agent。

### 6.2 Gate 类型

| Gate | 类型 | 检查方式 | autoFix | 失败策略 |
|------|------|----------|---------|----------|
| build | 确定性 | npm build 退出码 | 是 | spawn RD 修复，最多 retryLimit 次 |
| test | 确定性 | npm test 退出码 | 是 | spawn RD 修复 |
| lint | 确定性 | lint 命令退出码 | 是 | spawn RD 修复 |
| e2e-pass | 确定性 | E2E 命令退出码 | 是 | spawn RD/QA 修复 |
| schema | 确定性 | ajv validate artifact | 是 | spawn 对应角色补全缺失字段 |
| security-scan | 确定性 | 安全扫描命令退出码 | 否 | escalate-human |
| human | 阻塞 | 人确认 | N/A | 暂停等待 |

### 6.3 Gate 层级：Node Gate vs Phase Gate

| 层级 | 触发时机 | 职责 | 示例 |
|------|----------|------|------|
| **Node Gate** | 单个 Node 执行完成后 | 检查该 Node 的产物质量（编译/测试/结构） | RD Node 产出代码后跑 build+test+lint |
| **Phase Gate** | Phase 内所有 Node 通过后 | 跨节点整体质量检查（端到端一致性） | 所有开发 Node 完成后跑 E2E 集成测试 |

**执行顺序**：Phase 内 Node 并行/串行完成 → 各 Node Gate 逐个通过 → Phase 出口 Gate（若配置）运行 → 通过后才进入下一 Phase。

**Phase 1 默认策略**：Gate 统一挂在 Node 级别；Phase 出口 Gate 作为可选增强，在动态模式的高风险需求中由约束系统注入。

### 6.4 Gate 执行顺序

```
build → test → lint → e2e → security → schema → human
 快     快      快     慢      慢         快      阻塞
```

先跑快的，快速失败；慢的后面跑；阻塞的 human gate 总是最后。

### 6.5 Gate Chain 执行流程

```
Node 完成 → Artifact 保存
              │
     ┌───────▼────────┐
     │  Gate 1         │
     └───────┬────────┘
             │
     ┌───────┼───────┐
     pass    fail    error
      │       │        │
      │  autoFix=true?  │
      │    ┌──┴──┐     │
      │   yes   no     │
      │    │     │     │
      │   spawn RD     │
      │   修复   直接标记
      │    │     fail
      │   retry<limit?
      │    ┌──┴──┐
      │   yes   no
      │    │     │
      │    └→Gate│
      │     ┌──┴──────┴──┐
      │     │ onExhausted │
      │     └──┬────┬─────┘
      │     skip block escalate
      └──────┬────────────┘
             │
        Gate 通过 → 下一个 Gate
```

### 6.6 产物 Schema Gate

每个 ArtifactType 有对应的 JSON Schema：

```typescript
const DEMAND_CARD_SCHEMA = {
  type: 'object',
  required: ['title', 'scope', 'nonGoals', 'acceptanceCriteria'],
  properties: {
    title: { type: 'string', minLength: 1 },
    scope: { type: 'string', minLength: 1 },
    nonGoals: { type: 'array', items: { type: 'string' } },
    acceptanceCriteria: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['description'],
        properties: {
          description: { type: 'string', minLength: 1 }
        }
      }
    }
  }
};
```

失败处理：解析 Artifact 内容 → ajv.validate(schema, content) → fail 则 spawn 对应角色 Agent 补全。

---

## 七、约束系统

### 7.1 三层约束

约束系统保证动态生成的 Workflow 质量下限。参考 autonomous-dev 的 12-element harness 设计。

```yaml
# constraints.yaml
constraints:
  # 一、硬约束 — 任何 workflow 不可移除
  hard:
    - rule: "所有代码变更必须经过 build + lint gate"
      appliesWhen: { outputs: [code-changes] }
      gates: [build, lint]

    - rule: "所有 workflow 必须有独立的审查阶段"
      appliesWhen: { phasesCount: '>= 2' }
      requirePhase:
        title: "审查"
        containsRole: reviewer

    - rule: "所有 workflow 必须有验证阶段"
      requiresOneOf:
        - { role: qa }
        - { gate: e2e-pass }

  # 二、条件约束 — 根据需求特征自动触发
  conditional:
    - rule: "高风险需求必须有人工确认 Gate"
      when: { riskLevel: high }
      injectGate: { type: human, at: 'end-of-workflow' }

    - rule: "涉及权限/安全的需求必须有安全审查"
      when: { tags: [auth, security, permission] }
      requireRole: reviewer        # 使用已有 reviewer 角色，注入其 security.md skill
      requireSkills: [security]    # 强制加载安全审查 skill
      injectGate: { type: security-scan, at: 'after-node:rd' }

    - rule: "数据相关变更必须有回滚方案"
      when: { tags: [data, migration, schema-change] }
      requireOutput: rollback-plan

    - rule: "多模块变更建议拆分阶段"
      when: { affectedModules: '>= 3' }
      suggest: { splitPhases: true, mode: per-module }

  # 三、软建议 — 生成时提示，可人工跳过
  soft:
    - rule: "独立模块建议并行开发"
      suggest: { parallel: true }

    - rule: "建议为 E2E 测试预留独立阶段"
      suggest: { separateE2EPhase: true }
```

### 7.2 Gate 注入位置语义

`injectGate.at` 指定 gate 插入到 workflow 中的位置：

| 值 | 含义 |
|----|------|
| `'end-of-workflow'` | 插入到最后一个 phase 的最后一个 node 之后 |
| `'after-node:<role>'` | 插入到匹配角色的 node 之后（如 `after-node:rd`） |
| `'after-phase:<title>'` | 插入到指定 title 的 phase 之后（如 `after-phase:开发实现`） |
| `'before-node:<role>'` | 插入到匹配角色的 node 之前 |

### 7.3 约束注入的默认节点模板

当约束系统通过 `requirePhase` 注入新阶段时，使用以下默认 Node 模板（可在 constraints.yaml 中覆写）：

```yaml
# 约束注入节点的默认配置
defaultNodeTemplate:
  retry: 1
  source: constraint     # 标记为约束注入，在 UI 中显示 [AUTO]
```

每个角色的默认 task instruction 在角色 `agent.yaml` 中定义：

```yaml
# roles/reviewer/agent.yaml
constraintTask:
  instruction: "基于安全审查 skill 对代码变更进行安全分析"
  skills: [security]
  output: [security-report]
```

### 7.4 动态模式注入示例

```
用户输入：--dynamic "给支付模块加退款功能"
→ PM Agent 分析 → demand-card: { tags: [payment, data], riskLevel: high }
→ Constraint Validator：
  ✓ hard 约束全部满足
  → conditional: tags=[payment] → 注入 reviewer（含 security skill）+ security-scan gate
  → conditional: riskLevel=high → 注入 human gate（at: end-of-workflow）
  → conditional: tags=[data] → 注入 rollback-plan 产物要求
  → soft: 提示可考虑并行开发
→ 最终 Workflow: 5 phases → 6 phases（注入 1 个安全审查阶段）
```

---

## 八、Agent Runtime

### 8.1 定位

Agent Runtime 是 Donkey 中最薄的一层。职责：角色配置 → 子进程调用 → 收集结果。

```typescript
interface AgentConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  worktreePath: string;
  timeout: number;
}

async function runAgent(run: AgentRun): Promise<AgentResult> {
  // 1. 构建命令行
  // 2. spawn 子进程
  // 3. 收集 stdout/stderr
  // 4. 等待完成
  // 5. 返回结果
}
```

### 8.2 Git Worktree 隔离

```
<project>/.donkey/worktrees/
├── node-001-pm-clarify/        # PM Agent 工作区
├── node-002-rd-implement/      # RD Agent 工作区
├── node-003-qa-test/           # QA Agent 工作区
└── ...

每个 worktree：
├── <原仓库代码>
└── .donkey-output/             # Agent 写入产物的目录
```

执行完后 Engine 从 `.donkey-output/` 读取产物，worktree 可清理或保留审计。

### 8.3 支持自定义命令

```yaml
# 角色级别
agent:
  command: claude
  args:
    - --permission-mode
    - bypassPermissions
    - --model
    - claude-sonnet-4-6

# 全局默认（donkey.config.yaml）
defaults:
  agent:
    command: claude
    args:
      - --permission-mode
      - bypassPermissions
```

内置 preset（`claude-code` / `codex`）是预设的 command + args 组合，用户可完全替换。只要符合"stdin prompt → stdout 产物"协议即可。

---

## 九、CLI 设计

### 9.1 命令清单

```bash
# ── 项目管理 ──
donkey init                    # 初始化当前目录为 Donkey 项目
donkey run "需求描述"           # 启动需求（默认动态模式）
donkey run --template <name>   # 使用指定模板
donkey run --dynamic           # 强制动态模式
donkey run --dry-run           # 预览 Workflow，不执行
donkey status                  # 查看当前项目状态
donkey pause                   # 暂停
donkey resume                  # 从中断点恢复
donkey cancel                  # 取消

# ── 角色管理 ──
donkey role list               # 列出所有角色（标注来源：内置/用户/项目）
donkey role show <name>        # 查看角色详情
donkey role path <name>        # 输出角色目录路径
donkey role create <name>      # 交互式创建角色

# ── Workflow 管理 ──
donkey workflow list           # 列出所有模板
donkey workflow create         # 交互式创建
donkey workflow create --from <name> --name <new>
donkey workflow show <name>    # 查看模板内容

# ── 约束管理 ──
donkey constraints show        # 查看约束规则

# ── 审计 ──
donkey log [--project <id>]    # 查看审计日志

# ── 清理 ──
donkey clean                   # 清理 worktree
```

### 9.2 status 输出示例

```
Project: 批量重试失败任务 (proj-001)
Status:  executing
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 ✓ 需求澄清          completed · 45s ago
    产物: demand-card.md ✓
 ● 开发实现          running · 12s elapsed
    rd-agent: implementing...
 ○ 测试验证          pending
 ○ 审查              pending
 ○ 交付              pending

Gates: 4 passed, 0 failed, 1 pending
Risk: low · Agent: claude-code
```

---

## 十、Web Dashboard

### 10.1 技术栈

Next.js + shadcn/ui + tRPC（共享 core types）。React Query 做缓存层，SQLite 是单一真相源。

### 10.2 页面结构

```
/                         首页 · 项目列表 + 快速入口
/demand                   需求池 · 提交/查看需求
/project/:id              项目驾驶舱
  /overview                 概览：当前阶段、进度、阻塞
  /artifacts                产物：所有产物的版本历史
  /audit                    审计：完整执行日志
  /gates                    Gate：各阶段通过情况
/roles                    角色管理 · 列表/查看
/workflows                Workflow 模板管理
/settings                 项目设置 · 约束规则 · 关联仓库
```

### 10.3 驾驶舱布局

```
┌─────────────────────────────────────────────────────────┐
│  批量重试失败任务                    Status: Executing   │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Progress                                                │
│  ✓ 需求澄清  ✓ 技术方案  ● 开发实现  ○ 测试  ○ 交付   │
│                                                          │
│  Current Phase: 开发实现                                  │
│  ┌─────────────────────────────────────────────────┐    │
│  │ rd-agent: implementing batch retry logic...      │    │
│  │ [████████░░░░░░░░░░░] 12s elapsed                │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  Gates                    Artifacts                      │
│  build    ✓              demand-card.md     ✓           │
│  test     ○              code-changes       ●           │
│  lint     ○                                              │
│                                                          │
│  [Pause] [Cancel] [View Audit]                           │
└─────────────────────────────────────────────────────────┘
```

---

## 十一、测试与效果评估

### 11.1 测试金字塔

```
     ┌──────┐
     │ E2E  │  完整流程：donkey init → run → 验收 PR
     │ 5-8  │  使用 mock workspace（fixture 仓库）
     ├──────┤
     │ 集成  │  组件间协作：role-loader + runner / engine + gate
     │ 20+  │
     ├──────────┤
     │   单元    │  每个模块独立：template parser / constraint validator
     │   60+    │
     └──────────┘
```

### 11.2 E2E Fixture 设计

```
packages/cli/__tests__/fixtures/
├── mock-repo/                   # 假的目标仓库
│   ├── src/
│   ├── package.json
│   └── .donkey/
│       └── roles/               # 项目级角色覆盖（用于测试）
├── mock-roles/                  # 内置角色
│   ├── pm/
│   ├── rd/
│   └── qa/
└── mock-workflows/
    └── standard-feature.yaml
```

### 11.3 效果评估指标

| 维度 | 指标 | MVP 达标线 |
|------|------|-----------|
| 效率 | 需求输入到 PR 创建耗时 | 比人工流程下降 30%+ |
| 自动化 | 无中途人工介入到 PR 比例 | ≥ 50% |
| 质量 | 验收标准可判定率（逐条有证据） | ≥ 90% |
| 质量 | PR 一次审查通过率 | ≥ 60% |
| 风险 | 高危动作误执行次数 | 0 |

### 11.4 Dogfooding 计划

Phase 1 期间让 Donkey 管理 Donkey 自身的开发：

| 周 | 内容 |
|----|------|
| 1-2 | 角色系统开发 → 用 PM Agent 产需求卡 |
| 3-4 | Workflow Engine 开发 → 用 RD Agent 辅助编码 |
| 5-6 | Gate Engine 开发 → 跑通需求→PR 闭环 |
| 7-8 | 完整自举：Donkey 管理 Donkey 一个完整迭代 |

---

## 十二、Phase 1 范围

### 12.1 交付范围

| 维度 | 范围 |
|------|------|
| **周期** | 6-8 周 |
| **Core** | Workflow Engine + Role System (loader/builder/runner) + Gate Engine + Artifact Store + Constraint Validator + Audit Logger |
| **CLI** | init / run / status / role list·show·path / workflow list·create·show / constraints show / log / clean |
| **Web** | 项目列表 + 驾驶舱 (overview + artifacts + audit) + 角色浏览 |
| **内置角色** | pm / rd / qa / reviewer / pmo（5 个角色文件夹） |
| **内置 Workflow** | standard-feature / bugfix（2 个 YAML 模板） + dynamic 模式 |
| **内置约束** | 硬约束 3 条 + 条件约束 4 条 |
| **底层 Agent** | Claude Code（v1 仅 claude，Codex 后续加） |
| **自动化边界** | checkout 分支 → 开发 → test → lint → commit → push → create PR → 交付证据包 |

### 12.2 明确不做 (V2 Phase 1)

- 不自动合入 PR，不自动上线
- 不做多人协作
- 不做远程部署
- 不做角色版本升级/迁移
- 不做 Codex 集成（通过自定义 command 可自行配置但不保证）
- 不做飞书 IM 通知集成

---

## 十三、风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Agent 产出质量波动 | 高 | 高 | Schema Gate 强制结构校验 + 重试 + onExhausted escalate |
| Agent 陷入修复死循环 | 中 | 中 | maxRetries 限制 + onExhausted block + 审计日志可追溯 |
| Worktree 泄漏磁盘空间 | 中 | 低 | donkey clean 命令 + 定期清理策略 |
| 动态 Workflow 生成不合理 | 中 | 中 | 三层约束系统 + --dry-run 预览 + --save-as 可修正 |
| Claude Code/Codex 版本更新不兼容 | 低 | 中 | Agent command 可自定义，用户可替换任何 CLI |

---

## 十四、关键参考

- **Multica** — Agent 团队管理平台（35.2k stars）[GitHub](https://github.com/multica-ai/multica)
- **CrewAI** — 多 Agent 编排框架（52.8k stars）[GitHub](https://github.com/crewAIinc/crewAI)
- **cc-sdd** — 跨平台 Spec-Driven Development（17 Skills, 8 Agents）[GitHub](https://github.com/gotalab/cc-sdd)
- **autonomous-dev** — 12-Element Production Harness [GitHub](https://github.com/akaszubski/autonomous-dev)
- **Claude Code Dynamic Workflows** — pipeline/parallel/phase 原语 [文档](https://code.claude.com/docs/en/workflows)
- **产品方案 Beta-G** — [飞书文档](https://bytedance.larkoffice.com/docx/ANrCdZCv4oH81sx756HcAUKCnkc)
- **产品方案 Alpha-G** — [飞书文档](https://bytedance.larkoffice.com/wiki/YBDMwjB6nih5mzkdhhpckeCNn7e)
- **产品方案 Alpha-D** — [飞书文档](https://bytedance.larkoffice.com/docx/GrH5d57JEoOF5zxTJ4IcfLmFnkg)
- **产品方案 Alpha-Q** — [飞书文档](https://bytedance.larkoffice.com/docx/JHuId8oJwoc9vVxNiRtcU2pVnHc)
