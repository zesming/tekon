# 天工（Tekon）

天工（Tekon）是一个本地 Agent workflow 框架。它把一个研发需求从自然语言输入推进到结构化需求卡、受控 workflow、隔离执行、验证 gate、审阅证据和 PR 准备材料。

天工的核心思路是"受控研发工作台"：让 Agent 承担可自动化的执行和整理工作，让人保留需求批准、风险确认、PR 创建、合入和上线等关键控制权。

## 项目定位

天工解决 AI 辅助研发进入真实工作流后的几个核心问题：

- **需求塑形**：把一句话需求塑形成需求卡，明确目标、非目标、风险、开放问题和验收标准。
- **受控 Workflow**：使用固定模板，而不是让 Agent 自由决定所有步骤。内置 `standard-feature`、`bugfix`、`test-improvement`、`docs-update`、`plan-only`、`standard-delivery`。
- **可审阅产出**：角色产出结构化 artifact，统一收集 gate 日志、审计事件、diff 和 PR 包，通过 `review` 或 Web dashboard 查看。
- **副作用受控**：push、创建 PR 等远端动作必须显式人工批准。
- **效果可评估**：用 readiness、work usability eval 判断一次 run 是否真的可交付。

核心原则是 **Autonomy-first, Risk-gated**：低风险、可验证的工作尽量自动推进；高风险、不可逆或外部副作用动作必须受控。

## 工作流概览

```
需求输入
  -> demand shape 生成需求卡
  -> demand approve 人工批准
  -> workflow select / run 选择并执行模板
  -> role agent 在隔离 worktree 中产出 artifact
  -> build / lint / test / security-scan / human gate 验证
  -> review 聚合证据、日志、diff、失败诊断和下一步建议
  -> delivery prepare 生成 PR 准备包
  -> delivery create-pr --approve-human 受控创建远端 PR
  -> delivery ci-status / ci-watch 记录远端 CI 证据
  -> eval readiness 判断 PR/CI 证据是否完整
```

不同任务可选不同模板；dynamic workflow 当前支持 dry-run 预览。

## 核心能力

| 能力 | 说明 |
|------|------|
| 需求塑形 | `tekon demand shape` 生成需求卡和 Markdown 审阅稿，`demand approve` 批准后进入执行 |
| Workflow 模板 | 内置 6 个受控模板，`workflow select` 自动推荐 |
| 角色系统 | PM、RD、QA、Reviewer、PMO 等角色，决定 prompt、知识和工具策略 |
| 执行隔离 | 真实 git worktree lease，交付分支 `tekon-delivery/<runId>` |
| Provider 接入 | 支持 mock、Claude Code、Codex，通过 artifact manifest 交付结构化产物 |
| Gate 与证据 | build、lint、test、security-scan、schema、human、independent-review、role-scope、ac-evidence、qa-signoff、process-completeness |
| 审阅面 | `tekon review` 和 Web dashboard 汇总 readiness、证据、诊断、diff、PR 包 |
| 交付管理 | dry-run → prepare → create-pr（人工批准）→ ci-status → ci-watch，层层受控 |
| 效果评估 | `eval readiness`（单次 run）、`eval work-usability`（样本集）评估交付质量和工具可用性 |
| Web dashboard | 本地 Vite + React，支持 human approval、run 发起、PR 准备、审阅面 |

## 快速开始

### 安装

```bash
curl -fsSL https://raw.githubusercontent.com/zesming/tekon/main/scripts/install.sh | bash
```

脚本自动完成克隆、安装依赖、构建、配置 PATH。前置依赖：`git`、`node`（>=18）、`npm`。

完成后执行 `source ~/.zshrc`，即可使用 `tekon` 命令。

### 开始使用

```bash
tekon init                                    # 初始化目标仓库
tekon workflow preflight                      # 检查命令画像
tekon demand shape "你的需求描述"               # 塑形需求
tekon demand approve                          # 批准需求卡
tekon run                                     # 发起 workflow（默认 standard-delivery + codex）
tekon run --template standard-delivery --agent mock  # 使用 mock provider 回归
tekon status                                  # 查看状态
tekon review                                  # 查看审阅面
tekon delivery prepare                        # 生成 PR 准备包
tekon delivery create-pr --approve-human      # 受控创建远端 PR
tekon delivery ci-status                      # 查询远端 CI
tekon delivery ci-watch                       # 等待 CI 终态
tekon eval readiness                          # 评估交付完整度
```

## 常用命令

| 场景 | 命令 |
|------|------|
| 初始化目标仓库 | `tekon init` |
| 塑形需求 | `tekon demand shape "<需求>"` |
| 批准需求卡 | `tekon demand approve` |
| 推荐 workflow | `tekon workflow select "<需求>"` |
| 检查命令画像 | `tekon workflow preflight` |
| 发起运行 | `tekon run` |
| 查看状态 | `tekon status` |
| 查看审阅面 | `tekon review` |
| 审批摘要 | `tekon approval summary` |
| 批准 human gate | `tekon resume --approve-human` |
| 拒绝 human gate | `tekon approval reject` |
| 生成 PR 包 | `tekon delivery prepare` |
| 创建 PR | `tekon delivery create-pr --approve-human` |
| 查询 CI | `tekon delivery ci-status` |
| 等待 CI | `tekon delivery ci-watch` |
| 评估 readiness | `tekon eval readiness` |
| 评估样本集 | `tekon eval work-usability --samples <yaml>` |

更多命令和详细参数见[用户手册](#文档入口)。

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
packages/core/          Workflow engine、role/gate/artifact/audit/delivery/eval
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

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 test -- --run
npm run lint:actions
```

## 文档入口

- [用户手册 (Markdown)](docs/manual/tekon-user-manual.md)
- [用户手册 (HTML)](https://htmlpreview.github.io/?https://github.com/zesming/tekon/blob/main/docs/manual/tekon-user-manual.html)
- [Codex provider smoke](docs/manual/codex-provider-smoke.md)
- [V2 技术方案](docs/technical/tekon-v2-technical-plan.md)
- [变更日志](CHANGELOG.md)
