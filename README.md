# 天工（Tekon）

天工（Tekon）是一个本地 Agent workflow 框架。它把一个研发需求从自然语言输入推进到结构化需求卡、受控 workflow、隔离执行、验证 gate、审阅证据和 PR 准备材料。

天工的核心思路是"受控研发工作台"：让 Agent 承担可自动化的执行和整理工作，让人保留需求批准、风险确认、PR 创建、合入和上线等关键控制权。

> 📖 **用户手册** — [在线查看 / View Online](https://htmlpreview.github.io/?https://github.com/zesming/tekon/blob/main/docs/manual/tekon-user-manual.html)（中文 / English，页面内可切换语言）

## 项目定位

天工解决 AI 辅助研发进入真实工作流后的几个核心问题：

- **需求塑形**：把一句话需求塑形成需求卡，明确目标、非目标、风险、开放问题和验收标准。
- **受控 workflow**：使用固定模板，而不是让 Agent 自由决定所有步骤。内置 `standard-feature`、`bugfix`、`test-improvement`、`docs-update`、`plan-only`、`standard-delivery`。
- **可审阅产出**：角色产出结构化 artifact，统一收集 gate 日志、审计事件、diff 和 PR 包，通过 `review` 或 Web dashboard 查看。
- **副作用受控**：push、创建 PR 等远端动作必须显式人工批准。
- **效果可评估**：用 readiness、work usability eval 判断一次 run 是否真的可交付。

核心原则是 **Autonomy-first, Risk-gated**：低风险、可验证的工作尽量自动推进；高风险、不可逆或外部副作用动作必须受控。

## 工作流概览

```
需求输入
  -> draft shape 生成需求卡
  -> draft approve 人工批准
  -> workflow select / run 选择并执行模板
  -> role agent 在隔离 worktree 中产出 artifact
  -> build / lint / test / security-scan / human gate 验证
  -> review 聚合证据、日志、diff、失败诊断和下一步建议
  -> delivery prepare 生成 PR 准备包
  -> delivery create-pr --approve-human 受控创建远端 PR
  -> delivery ci-status / ci-watch 记录远端 CI 证据
  -> eval readiness 判断 PR/CI 证据是否完整
```

不同任务可选不同模板，也支持动态 workflow dry-run 预览。

## 核心能力

| 能力          | 说明                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 需求塑形      | `tekon draft shape` 生成需求卡和 Markdown 审阅稿，`draft approve` 批准后进入执行                                                                                |
| workflow 模板 | 内置 6 个受控模板，`workflow select` 自动推荐                                                                                                                   |
| 角色系统      | PM、RD、QA、Reviewer、PMO 等角色，决定 prompt、知识和工具策略                                                                                                   |
| 执行隔离      | 真实 git worktree lease，交付分支 `tekon-delivery/<runId>`                                                                                                      |
| Provider 接入 | 支持 mock、Claude Code、Codex，以及 experimental 的 dsh-headless（DeepSeek Harness，默认关闭、网络不受限、仅 goal 可用），通过 artifact manifest 交付结构化产物 |
| Gate 与证据   | build、lint、test、security-scan、schema、human、independent-review、role-scope、ac-evidence、qa-signoff、process-completeness                                  |
| 审阅面        | `tekon review` 和 Web dashboard 汇总 readiness、证据、诊断、diff、PR 包                                                                                         |
| 交付管理      | dry-run → prepare → create-pr（人工批准）→ ci-status → ci-watch，层层受控                                                                                       |
| 效果评估      | `eval readiness`（单次 run）、`eval work-usability`（样本集）评估交付质量和工具可用性                                                                           |
| Web Dashboard | `tekon ui` 一键启动本地 Vite + React Dashboard，支持 human approval、run 发起、PR 准备、审阅面                                                                  |

## 当前边界与实验性特性

Tekon 的 Session UI / 事件脊柱 / 后台 Job 目前处于**基础设施里程碑**阶段。为避免过度宣称，以下能力的现状明确如下：

- **默认发起 = 受控交付全链路**：Web「启动受控交付」与 `tekon run`（默认 `standard-delivery`）会进入 PM/RD/QA/Reviewer 完整交付流程，而非轻量对话。轻量协作会话（Collaborate）为后续方向。
- **Session feed 非完整模型 streaming**：中间栏的 Agent 消息当前为「产物元数据合成的摘要」（DSH headless 会展示官方最终 assistant 文本），**不是逐块的模型原文增量**（`assistant/chunk`）。真流式为后续里程碑。
- **follow-up / steer 未开放**：进入 Session 后暂不能继续追问或中途转向，Composer 仅用于发起新 run。
- **Event log 是迁移期 best-effort projection**：`session_events` 为 best-effort 双写投影，**`workflow_instances` / `jobs` 等旧表仍是事实源**；迁移期个别事件可能缺失，不保证从 event log 完整重建。
- **automation（自动准备交付 / readiness）仅长驻进程内触发**：由 CLI 完成的 run 不会触发另一 Web 进程的 automation；CLI 交付仍走显式 `tekon delivery prepare`。
- **交付审批记录未绑定内容指纹**：`delivery create-pr` 每次仍要求当次人工批准（安全边界不变），但失败后自动重新准备会保留上一次的 `approvedBy/approvedAt`，若分支或 PR body 已变，审批记录可能与当前内容不一致。绑定内容哈希的能力留待交付治理里程碑。
- **Goal 模式为实验性**：`goal` 单节点 run 无 gate/artifact，且**默认拒绝源码改动**（agent 若改动 worktree 源文件，run 会失败而非静默 promote）；不适合作为交付路径。
- **Workspace 为单项目占位**：暂不支持多 workspace 切换/增删。

## 快速开始

### 安装

```bash
curl -fsSL https://raw.githubusercontent.com/zesming/tekon/main/scripts/install.sh | bash
```

脚本自动完成克隆、安装依赖、构建，并输出 PATH 配置命令。前置依赖：`git`、`node`（`^20.19.0` 或 `>=22.12.0`）、`npm`。

安装完成后，按脚本输出的提示将 `tekon` 加入 PATH，`source` 对应 rc 文件即可使用。

### 更新

```bash
tekon update
```

CLI 的 `--version`、帮助页和安装/更新脚本都以根 `package.json` 作为同一个产品版本来源。

### 最短路径（推荐）

进入目标仓库后直接执行：

```bash
tekon
```

它会显示三条常用入口。普通使用者优先从本地 Web 开始：

```bash
tekon ui
```

需要从命令行直接发起一次受控交付时，也可以写成：

```bash
tekon run "你的需求"
```

> 当前 `run` 默认进入 `standard-delivery` 完整治理链路，并不是轻量对话。真实 streaming、同一 Session 内继续追问和中途转向仍属于后续里程碑。

### 受控交付 CLI（高级）

```bash
tekon init                                    # 初始化目标仓库
tekon workflow preflight                      # 检查命令画像
tekon help                                    # 查看完整命令帮助
tekon draft new                               # 交互式创建需求草案（支持 Agent 澄清）
tekon draft shape "你的需求描述"               # 塑形需求
tekon draft approve                           # 批准需求卡
tekon run                                     # 发起 workflow（默认 standard-delivery + codex）
tekon run --template standard-delivery --agent mock  # 使用 mock provider 回归
tekon run "一次性小任务" --goal --agent mock    # 轻量目标运行（单节点 goal 模板，不接交付）
tekon status                                  # 查看状态
tekon review                                  # 查看审阅面
tekon delivery prepare                        # 生成 PR 准备包
tekon delivery create-pr --approve-human      # 受控创建远端 PR
tekon delivery ci-status                      # 查询远端 CI
tekon delivery ci-watch                       # 等待 CI 终态
tekon eval readiness                          # 评估交付完整度
tekon update                                  # 更新 Tekon 到最新版本
tekon ui                                      # 启动 Web Dashboard
```

## 常用命令

| 场景               | 命令                                         |
| ------------------ | -------------------------------------------- |
| 查看推荐入口       | `tekon`                                      |
| 查看完整命令帮助   | `tekon help`                                 |
| 初始化目标仓库     | `tekon init`                                 |
| 创建需求草案       | `tekon draft new`                            |
| 塑形需求           | `tekon draft shape "<需求>"`                 |
| 批准需求卡         | `tekon draft approve`                        |
| 推荐 workflow      | `tekon workflow select "<需求>"`             |
| 检查命令画像       | `tekon workflow preflight`                   |
| 预检 dsh 环境      | `tekon provider preflight dsh-headless`     |
| 发起运行           | `tekon run`                                  |
| 查看状态           | `tekon status`                               |
| 查看审阅面         | `tekon review`                               |
| 审批摘要           | `tekon approval summary`                     |
| 批准 human gate    | `tekon resume --approve-human`               |
| 拒绝 human gate    | `tekon approval reject`                      |
| 生成 PR 包         | `tekon delivery prepare`                     |
| 创建 PR            | `tekon delivery create-pr --approve-human`   |
| 查询 CI            | `tekon delivery ci-status`                   |
| 等待 CI            | `tekon delivery ci-watch`                    |
| 评估 readiness     | `tekon eval readiness`                       |
| 评估样本集         | `tekon eval work-usability --samples <yaml>` |
| 更新 Tekon         | `tekon update`                               |
| 启动 Web Dashboard | `tekon ui`                                   |

更多命令和详细参数见[用户手册](https://htmlpreview.github.io/?https://github.com/zesming/tekon/blob/main/docs/manual/tekon-user-manual.html)。

## 本地运行产物

目标仓库初始化后生成 `.tekon/` 运行态目录（不提交）：

```text
.tekon/
  config.yaml          repo-profile.yaml      web-session.json
  tekon.sqlite         demands/               runs/
  roles/               workflows/             worktrees/
  eval/
```

常见产物包括需求卡、审阅稿、run 状态、artifact、gate 日志、审计事件、PR body/package、readiness 结果和评估报告。

## 仓库结构

```text
packages/core/          workflow engine、role/gate/artifact/audit/delivery/eval
packages/cli/           tekon CLI
packages/web/           本地 Web dashboard
roles/                  内置角色定义
workflows/              内置 workflow 模板
docs/manual/            用户手册
docs/technical/         技术方案
docs/reviews/           审阅记录和验收报告
scripts/                安装和 CI 脚本
```

## 开发与验证

在 Tekon 仓库目录（默认为 `~/.tekon`）中执行：

```bash
cd ~/.tekon
npx pnpm install --frozen-lockfile
npx pnpm build
npx pnpm typecheck
npx pnpm test -- --run
npm run lint:actions
```

> 如已全局安装 pnpm，可直接用 `pnpm` 替换 `npx pnpm`。

## 文档

- [V2 技术方案](docs/technical/tekon-v2-technical-plan.md)
- [当前权威产品与架构评审](docs/reviews/current.md)
- [变更日志](CHANGELOG.md)
