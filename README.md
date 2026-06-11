# 天工（Tekon）

天工（Tekon）是面向技术基建、研发效能和内部工具团队的本地 Agent workflow 系统。它把一个研发需求从自然语言输入推进到结构化需求卡、受控 workflow、隔离执行、验证 gate、审阅证据和 PR 准备材料。

它不是聊天机器人，也不是自动上线平台。更准确地说，天工是一个“受控研发工作台”：让 Agent 承担可自动化的执行和整理工作，让人保留需求批准、风险确认、PR 创建、合入和上线等关键控制权。

## 项目定位

天工解决的是 AI 辅助研发进入真实工作流后的几个核心问题：

- **需求不清楚**：先把一句话需求塑形成需求卡，明确目标、非目标、风险、开放问题和验收标准。
- **流程不可控**：使用受控 workflow 模板，而不是让 Agent 自由决定所有步骤。
- **执行不可审阅**：要求角色产出结构化 artifact，并记录 gate、日志、审计事件、diff 和 PR 包。
- **副作用风险高**：push、创建 PR、继续 human gate 等动作必须显式批准；自动 merge 和自动上线不属于当前能力。
- **可用性难判断**：用 readiness、work usability eval 和审阅面判断一次 run 是否真的可交付，而不是只看 Agent 声称完成。

核心原则是 **Autonomy-first, Risk-gated**：低风险、可验证的工作尽量自动推进；高风险、不可逆或外部副作用动作必须受控。

## 工作流概览

一次典型工作从需求开始，到人工审阅结束：

```text
需求输入
  -> demand shape 生成需求卡
  -> demand approve 人工批准
  -> workflow select / run 选择并执行模板
  -> role agent 在隔离 worktree 中产出 artifact
  -> build / lint / test / e2e-pass / security-scan / human gate 验证
  -> review 聚合证据、日志、diff、失败诊断和下一步建议
  -> delivery prepare 生成 PR 准备包
  -> delivery create-pr --approve-human 受控创建远端 PR
  -> delivery ci-status / ci-watch 只读记录远端 CI 证据
  -> eval readiness 判断 PR/CI 证据是否完整
```

这个流程不是固定必须全跑。文档更新、测试补齐、方案-only、缺陷修复、标准功能和标准交付治理流程可以选择不同模板；dynamic workflow 当前只支持 dry-run。

## 核心能力

| 能力              | 当前状态                                       | 说明                                                                                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 需求塑形          | 已实现本地版                                   | `tekon demand shape` 生成需求卡和 Markdown 审阅稿，`demand approve` 批准后才能默认进入执行。                                                                                                                                                                    |
| Workflow 模板     | 已实现受控模板                                 | 内置 `standard-feature`、`bugfix`、`test-improvement`、`docs-update`、`plan-only`、`standard-delivery`。                                                                                                                                                        |
| Workflow 选择评估 | 已实现                                         | `workflow select` 给出推荐模板，`eval workflow-selection` 检查选择质量。                                                                                                                                                                                        |
| 角色系统          | 已实现                                         | `roles/` 下维护 PM、RD、QA、Reviewer、PMO 等角色的描述、工具、技能和知识。                                                                                                                                                                                      |
| 执行隔离          | 已实现本地 worktree 版                         | Engine 在真实 git worktree lease 中执行节点，交付分支使用 `tekon-delivery/<runId>`。                                                                                                                                                                            |
| Provider 接入     | 已实现 mock、Claude Code 与 Codex adapter 协议 | 真实 provider 通过 artifact manifest 交付结构化产物；Codex 走本机 `codex --profile internal ... exec`，默认真实 provider 总超时为 1 小时、无输出进展超时为 15 分钟，并写入 progress JSON。非 `code-changes` 节点若修改源码会被 Engine 拦截。                    |
| Gate 与证据       | 已实现本地版                                   | 支持 build、lint、test、e2e-pass、security-scan、schema、human、independent-review、role-scope、ac-evidence、qa-signoff、process-completeness 等 gate；QA signoff 会绑定 QA validation 记录的 tested ref。                                                      |
| 审阅面            | 已实现 CLI/Web 聚合视图                        | `tekon review` 和 Web dashboard 汇总 readiness、证据导航、失败诊断、diff、artifact 正文和 PR 包。                                                                                                                                                               |
| 交付准备          | 已实现受控流程                                 | `delivery dry-run` 只生成计划，`delivery prepare` 先通过 pre-PR readiness 再生成本地 PR 包，`delivery create-pr --approve-human` 才产生远端副作用；受控 `git/gh` 命令和 create-pr 前置只读 probe 使用同一 1 小时总超时、15 分钟无输出进展超时和 progress JSON。 |
| 远端 CI 证据      | 已实现只读查询                                 | `delivery ci-status` 和 `delivery ci-watch` 只读查询 GitHub PR checks，不 rerun CI、不 merge、不上线。                                                                                                                                                          |
| 效果评估          | 已实现本地评估                                 | `eval readiness`、`eval work-usability`、`eval approval-summary` 等用于判断证据质量和工作可用性。                                                                                                                                                               |
| Web dashboard     | 已实现本地版                                   | 提供 human approval、run 发起、PR 准备、受控 PR 创建和审阅面。                                                                                                                                                                                                  |

## 当前边界

当前版本适合本地 dogfooding、低到中风险研发任务、试点仓库评估和内部工具链验证。以下能力不应被当作已完成的生产能力：

- 不自动 merge。
- 不自动上线。
- 不绕过 human gate。
- 不提供远程多租户服务。
- 不提供生产级 OS 沙箱、完整 DLP 或密钥平台。
- 不保证真实 LLM provider 在所有仓库、所有任务上稳定完成。
- dynamic workflow 当前仍是 dry-run 能力，非 dry-run 执行不在已完成范围内。

## 快速开始

仓库使用 `pnpm@10.12.1`。在 Tekon 源码仓库根目录安装依赖并构建：

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 build
```

构建后，本地 CLI 入口是：

```bash
node packages/cli/dist/index.js
```

如果 `tekon` 已在 `PATH` 中，以下命令可直接使用 `tekon`。示例默认在目标项目根目录执行；跨仓库操作时追加 `--repo /path/to/project`。

初始化目标仓库：

```bash
tekon init
```

检查目标仓库命令画像：

```bash
tekon workflow preflight
```

塑形并批准需求：

```bash
tekon demand shape "给 Web dashboard 增加审批摘要展示，要求 e2e 通过"
tekon demand approve
```

运行标准交付 workflow。未传 `--template` 时默认 `standard-delivery`，未传 `--agent` 时默认 Codex：

```bash
tekon run
```

明确长程任务可以在 run 级别显式放大外层预算，例如 2 小时总超时、20 分钟无输出进展超时、30 秒 heartbeat：

```bash
tekon run --timeout-ms 7200000 --no-progress-timeout-ms 1200000 --progress-heartbeat-ms 30000
```

离线回归或演示时，可显式切到 mock provider：

```bash
tekon run --template standard-delivery --agent mock
```

Codex provider 使用本机 `codex --profile internal --sandbox workspace-write --ask-for-approval on-request --add-dir <TEKON_OUTPUT_DIR> exec`，其中 `--add-dir` 由 Tekon 受控追加，只开放本节点 artifact 输出目录；产物通过 `TEKON_OUTPUT_DIR` / `$TEKON_ARTIFACT_MANIFEST` 写回 Tekon artifact，`TEKON_ARTIFACT_MANIFEST` 是 manifest 文件路径，不是字面文件名。非 `code-changes` 节点会被要求只写节点 artifact、不修改仓库工作区，Engine 会在 worktree finalize 前拦截这类节点的源码变更；所有需要 artifact 的节点先写 artifact/manifest，再立即退出，不在节点内启动嵌套 subagent 审阅，也不在节点内执行 `git add`、`git commit`、`git push` 或创建 PR。结构化 JSON artifact 必须包含非空 `title` 和 `body`；`demand-card`/`prd` 应使用 `acceptanceCriteria[].id/description`，有效的 `acceptance_criteria[].criterion` 会被兼容归一化。真实 provider 默认总超时为 1 小时，无 stdout/stderr 进展默认 15 分钟超时，CLI `run` 可用 `--timeout-ms`、`--no-progress-timeout-ms`、`--progress-heartbeat-ms` 显式覆盖，Web dashboard 也提供对应输入项；配置会写入 provider snapshot 以支持 resume。命令执行会同步写入 `*.progress.json`，记录状态、最近输出时间、stdout/stderr 字节数、elapsed、总超时、无进展超时、timeoutReason 和 heartbeat 次数。manifest mtime、artifact 文件变化和可恢复 job runner 仍是后续增强。若 Codex 因超时中断但已写完有效 manifest，adapter 会在必需 artifact 校验通过后把该节点视为完成并继续进入 gate；非零退出不会被改写为成功，但已写入的合法 artifact 仍会被入库用于诊断。缺失或非法 manifest、artifact schema、path/symlink 边界仍失败。它不会改变 Tekon 的人工审批边界：创建 PR、合入和上线仍需人控制；`delivery create-pr --approve-human` 的受控 `git/gh` 命令和前置只读 probe 也会写入 progress JSON，并使用同一 1 小时总超时和 15 分钟无 stdout/stderr 进展超时。

查看状态和审阅面：

```bash
tekon status
tekon review
```

准备 PR 材料：

```bash
tekon delivery prepare
```

这一步当前只支持 `standard-delivery` 治理 run，并会先执行 pre-PR readiness：workflow 必须 passed、无 pending human gate、验证 gate 与安全扫描满足、AC evidence 完整、QA release signoff 必须通过且绑定 QA validation 记录的 tested ref。未满足时不会生成 PR 包。

人工确认后创建远端 PR：

```bash
tekon delivery create-pr --approve-human
```

记录远端 CI 证据：

```bash
tekon delivery ci-status
tekon delivery ci-watch --max-attempts 20 --interval-ms 15000
```

PR 准备、真实 PR 创建和远端 CI 证据写回后，再检查完整交付 readiness：

```bash
tekon eval readiness
```

在 `delivery prepare`、`delivery create-pr --approve-human` 或远端 CI 证据写回之前，`eval readiness` 出现 `pr-prepared`、`pr-created` 或 `remote-ci-passed` 失败项是预期结果；但 `delivery prepare` 和 `delivery create-pr` 不会绕过 QA signoff 和所测即所得校验。

## 常用命令

| 场景                   | 命令                                                  |
| ---------------------- | ----------------------------------------------------- |
| 初始化目标仓库         | `tekon init`                                          |
| 塑形需求               | `tekon demand shape "<需求>"`                         |
| 批准最近需求卡         | `tekon demand approve`                                |
| 查看需求卡             | `tekon demand show`                                   |
| 推荐 workflow 模板     | `tekon workflow select "<需求>"`                      |
| 检查 repo profile 命令 | `tekon workflow preflight`                            |
| 运行标准交付模板       | `tekon run`                                           |
| 使用 mock 回归         | `tekon run --template standard-delivery --agent mock` |
| 运行最近已批准需求卡   | `tekon run`                                           |
| 查看状态               | `tekon status`                                        |
| 查看审阅面             | `tekon review`                                        |
| 查看审批摘要           | `tekon approval summary`                              |
| 批准继续 human gate    | `tekon resume --approve-human`                        |
| 拒绝 human gate        | `tekon approval reject`                               |
| 生成 PR 准备包         | `tekon delivery prepare`                              |
| 受控创建 PR            | `tekon delivery create-pr --approve-human`            |
| 查询 PR checks         | `tekon delivery ci-status`                            |
| 等待 PR checks 终态    | `tekon delivery ci-watch`                             |
| 评估 readiness         | `tekon eval readiness`                                |
| 评估样本集             | `tekon eval work-usability --samples <samples.yaml>`  |

更完整的使用说明见主用户手册：[docs/manual/tekon-user-manual.md](docs/manual/tekon-user-manual.md)。

## 本地运行产物

目标仓库初始化和运行过程中会生成 `.tekon/`。该目录是运行态数据目录，不应提交到业务仓库；不同命令会按需创建其中的子目录和文件：

```text
.tekon/
  config.yaml
  repo-profile.yaml
  web-session.json
  tekon.sqlite
  demands/
  runs/
  roles/
  workflows/
  worktrees/
  eval/
```

常见产物包括需求卡、Markdown 审阅稿、workflow run 状态、artifact、gate 日志、审计事件、PR body、PR package、readiness 结果和评估报告。需要长期归档的验收结论、风险 gate、样本评估和审阅记录应写入 `docs/reviews/` 或其它可提交文档。

## 仓库结构

```text
packages/core/              Workflow engine、role/gate/artifact/audit/delivery/eval 核心能力
packages/cli/               tekon CLI
packages/web/               本地 Web dashboard
roles/                      内置角色定义、技能和知识
workflows/                  内置 workflow 模板
docs/manual/                用户手册
docs/technical/             技术方案
docs/reviews/               审阅记录、验收报告和阶段性证据
docs/superpowers/plans/     实施计划
```

## 开发与验证

常用本地验证命令：

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 test -- --run
npm run lint:actions
```

更细粒度的验证入口：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @tekon/cli test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @tekon/web test:e2e
```

## 文档入口

- 主用户使用手册：[docs/manual/tekon-user-manual.md](docs/manual/tekon-user-manual.md)
- 主用户使用手册 HTML：[docs/manual/tekon-user-manual.html](docs/manual/tekon-user-manual.html)
- Codex provider smoke 手册：[docs/manual/codex-provider-smoke.md](docs/manual/codex-provider-smoke.md)
- Codex provider smoke HTML：[docs/manual/codex-provider-smoke.html](docs/manual/codex-provider-smoke.html)
- V2 技术方案：[docs/technical/tekon-v2-technical-plan.md](docs/technical/tekon-v2-technical-plan.md)
- V2 技术方案 HTML：[docs/technical/tekon-v2-technical-plan.html](docs/technical/tekon-v2-technical-plan.html)
- 三阶段实施计划：[docs/superpowers/plans/2026-06-05-tekon-v2-three-phase-implementation.md](docs/superpowers/plans/2026-06-05-tekon-v2-three-phase-implementation.md)
- 三阶段实施计划 HTML：[docs/superpowers/plans/2026-06-05-tekon-v2-three-phase-implementation.html](docs/superpowers/plans/2026-06-05-tekon-v2-three-phase-implementation.html)
- Final acceptance：[docs/reviews/2026-06-05-tekon-v2-final-acceptance.html](docs/reviews/2026-06-05-tekon-v2-final-acceptance.html)
- Dogfooding 报告：[docs/reviews/2026-06-05-tekon-v2-dogfooding-report.html](docs/reviews/2026-06-05-tekon-v2-dogfooding-report.html)
- 工作可用样本评估：[docs/reviews/2026-06-08-tekon-work-usability-eval-increment.html](docs/reviews/2026-06-08-tekon-work-usability-eval-increment.html)
- 变更日志：[CHANGELOG.md](CHANGELOG.md)

## 发布状态

当前仓库是本地 V2 和工作可用化 dogfooding 版本，已经具备 CLI、本地 Web dashboard、受控 workflow、artifact 证据、readiness 评估、PR 准备和受人工批准的 PR 创建路径。它还不是公开生产发布版本；对外说明时应明确自动 merge、自动上线、远程多租户服务、完整 DLP 和生产级真实 LLM workflow 稳定性仍在发布范围外。
