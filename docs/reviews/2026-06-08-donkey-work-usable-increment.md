# Donkey 工作可用化增量报告

日期：2026-06-08  
范围：把 Phase 3 本地 mock 产品环向“真实工作可用工具”推进的第一批 P0/P1 能力。  
结论：本轮完成 repo profile、角色 prompt 注入、Claude Code adapter CLI 接线、PR 准备包和工作就绪度评估。真实远端 PR 创建、真实 LLM 稳定性和生产级恢复能力仍未声明完成。

## 1. 背景判断

根据飞书方案和本地实现对照，Donkey 当前不应继续扩展组织级大平台能力，而应先把工作中真实需要的闭环打穿：

1. 能识别目标仓库的真实命令和 PR 规则。
2. 能把角色系统真正传给 Agent，而不是只运行 mock。
3. 能生成可审阅 PR 材料，而不是只输出 dry-run 命令计划。
4. 能用明确评估项判断一次 run 是否可进入人工审阅和提交。

## 2. 已完成能力

| 能力                         | 实现位置                                                           | 说明                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 仓库画像                     | `packages/core/src/repo/profile.ts`                                | `init` 时根据 `package.json` 生成 `.donkey/repo-profile.yaml`，记录 build/typecheck/lint/test/e2e、PR base branch 和风险路径。 |
| 角色 prompt 注入             | `packages/core/src/workflow/engine.ts`                             | Engine 执行节点时加载角色 system prompt、skills、knowledge、tools policy 和输入 artifacts，组装为 Agent prompt。               |
| Claude Code adapter CLI 接线 | `packages/cli/src/index.ts`                                        | `run --agent claude-code` 会创建 Claude Code adapter；mock 仍为默认和测试路径。                                                |
| PR 准备包                    | `packages/core/src/delivery/pr-package.ts`、CLI `delivery prepare` | 生成 `.donkey/runs/<runId>/delivery/pr-package.md` 和 `pr-body.md`，记录 `delivery.pr-prepared` 审计事件。                     |
| 工作就绪度评估               | `packages/core/src/eval/work-readiness.ts`、CLI `eval readiness`   | 检查 workflow、audit、验证 gate、delivery package、PR 准备事件和 pending human gate。                                          |

## 3. 验证记录

已通过：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core build
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli typecheck
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli test:e2e
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test:e2e
npm exec --yes -- pnpm@10.12.1 exec prettier --check .
git diff --check
```

新增覆盖：

- `repo/profile.test.ts`：仓库画像自动探测和写入读取。
- `workflow/engine-role-prompt.test.ts`：Engine 注入角色 system、skill、knowledge、tools 和项目上下文。
- `delivery/pr-package.test.ts`：PR 准备包、PR body、delivery artifact 和审计事件。
- `eval/work-readiness.test.ts`：PR 准备前后 readiness 状态变化。
- CLI e2e：覆盖 `repo-profile.yaml`、`delivery prepare` 和 `eval readiness`。

## 4. 仍未完成

- 真实 Claude Code / Codex 在受控真实仓库中的稳定执行证据。
- 真实 worktree lease 进入主 Engine 执行路径；当前主执行路径仍使用 repoPath 作为 synthetic lease。
- 动态 workflow 非 dry-run 执行。
- 真实远端 PR 创建、PR URL 落库和失败恢复。
- Web approval 后自动调用 Engine resume 继续推进。
- 语义级 artifact schema、验收标准逐条证据映射和真实 security scan。

## 5. Reviewer 结论

第一轮最高思考 reviewer 结论：`CHANGES_REQUIRED`。

必须修复项与修复摘要：

- Agent prompt 未注入需求正文：已从 workflow 关联的 demand 读取 title/body，并注入普通节点和 repair 节点 prompt；新增测试断言真实需求进入 prompt。
- Engine 忽略 Agent 非 0 / timeout：已统一检查 `AgentRunResult`，非 0 或 timeout 会中断节点；repair agent 失败会阻断 workflow 并记录 `gate.repair.failed`。
- CLI Claude Code 默认未复用手动 smoke 非交互形态：已将默认 args 调整为 `-p`，并启用 `json` 输出格式。
- 用户手册误写 repo profile 会驱动验证 gate：已降级为“PR 准备包展示仓库画像并使用 PR base branch；workflow gate 仍以模板配置为准”。
- readiness 误把历史失败 gate 算入最终状态：已按 `nodeId + gateType` 取最新验证 gate 结果判定。

第二轮最高思考 reviewer 复查结论：`APPROVED`。

复查确认第一轮 5 个必须修复项已闭环：

- 需求正文已注入普通节点和 repair prompt。
- Agent 非 0 / timeout 已阻断运行；普通节点进入 `interrupted`，repair 失败记录 `gate.repair.failed` 并阻断。
- CLI `--agent claude-code` 默认已接入 `claude -p`、stdin prompt、`json` 输出。
- 用户手册已明确 repo profile 当前只用于 PR 准备包展示和 base branch，不驱动 workflow gate。
- readiness 已按 `nodeId + gateType` 取最新 gate 判定，测试覆盖“先失败后通过”场景。

Reviewer 未检出剩余必须修复项。保留以下非阻塞风险：

- 仍需真实 Claude Code / Codex 在受控真实仓库中的端到端 smoke。
- 主 Engine 仍用 synthetic lease，真实 worktree lease、隔离、释放和冲突处理还没进入主执行路径。
- `delivery prepare` 不 push、不创建远端 PR，PR URL 落库、失败恢复和远端权限边界仍未实现。
- Web approval 后不会自动 resume Engine，Web resume 闭环仍是缺口。
- Artifact 仍偏 Markdown / 文本证据，缺少语义级 schema、验收标准逐条映射和可机器判定的 acceptance evidence。
- `CommandPolicy.network` 仍不是 OS 级网络隔离，后续真实 provider smoke 需要继续验证边界。
