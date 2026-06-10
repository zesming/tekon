# Tekon Codex 自举闭环归档报告

日期：2026-06-10  
范围：Codex provider P0 真实样本闭环、Tekon 自身自举验证、真实 PR 创建。  
结论：P0 目标已达成。Tekon 已使用真实 `codex --profile internal` 完成一次 `docs-update` 工作流，工作流状态为 `passed`，本地 gates 全部通过，远端 PR 已创建且 CI 通过；未执行 merge 或 release。

## 1. 用户约束

- 先适配 Codex，不先适配 Trae。
- 真实 provider 启动方式必须是 `codex --profile internal`。
- P0 只做真实样本闭环，从 Tekon 自身需求开始自举验证。
- 最终只需要创建真实 PR，不自动合入、不上线。

## 2. 真实运行结果

| 项目              | 结果                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| 成功 run id       | `run_d2350140-b1b7-4fca-b01b-e28daac61e31`                                                                          |
| Workflow          | `docs-update`                                                                                                       |
| Agent             | `codex`                                                                                                             |
| Provider 启动证据 | provider stderr 显示 OpenAI Codex，并使用 `workdir` 下的 node worktree；既有修复固定使用 `codex --profile internal` |
| Workflow 状态     | `passed`                                                                                                            |
| Gates             | 8 passed, 0 failed                                                                                                  |
| Artifacts         | demand-card, code-changes, test-report, review-report, delivery-package, ci-status                                  |
| PR                | https://github.com/zesming/tekon/pull/2                                                                             |
| PR 状态           | Open，base `main`，head `tekon-delivery/run_d2350140-b1b7-4fca-b01b-e28daac61e31`                                   |
| Remote CI         | `Core build and tests` pass；`Lint GitHub Actions workflows` pass                                                   |
| Readiness         | `score=0.90`，`ready=false`，剩余缺口为 `acceptance-criteria-evidenced` 结构化映射不足                              |

## 3. 闭环内容

本次真实自举样本选择了一个 Tekon 自身需求：补充 `docs/manual/codex-provider-smoke.md` 与 `docs/manual/codex-provider-smoke.html` 中 artifact 输出目录诊断说明。真实 RD 节点改动了 smoke 文档，明确写出：

- 真实 Tekon run 会由 adapter 在 `exec` 前受控追加 `--add-dir <TEKON_OUTPUT_DIR>`。
- `TEKON_OUTPUT_DIR` 必须匹配当前 run/node 的受控输出目录。
- 输出目录不能指向其它 run、其它 node、共享目录或 symlink。
- 排障时若输出目录不匹配当前 run/node，或路径经 symlink 跳转，应视为 artifact 输出目录诊断异常。

这次样本覆盖了 PM scope、RD 文档修改、build/lint/security/schema gates、QA 验收、reviewer 独立审阅、PMO delivery package、PR prepare、真实 push/PR 创建、远端 CI 查询。

## 4. 关键失败与修复

| 阶段              | 失败现象                                                            | 根因                                                                                     | 处理                                                                                              |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Codex 认证        | `401`                                                               | internal profile 未生效或凭据未正确进入 provider                                         | 固定 Codex provider 使用 `codex --profile internal`                                               |
| Artifact 输出目录 | Codex sandbox 无法写主仓库 `.tekon/runs/...`                        | artifact 输出目录未加入 Codex workspace-write 可写范围                                   | adapter 受控追加 `--add-dir <TEKON_OUTPUT_DIR>`                                                   |
| Provider 协议     | Codex 写 manifest 后继续做无关动作，或启动嵌套审阅                  | prompt 没有足够明确地要求 artifact/manifest 完成后停止                                   | 强化 artifact protocol：禁止 provider 节点内部 subagent、git add/commit/push、manifest 后继续执行 |
| Artifact schema   | `code-changes`、`demand-card` 字段漂移                              | 真实模型输出 provider-style 字段或兼容字段                                               | 增加 schema 归一化和字段兼容，但保持 schema 边界                                                  |
| 安全扫描          | 测试 fixture 假 key 被真实 scanner 命中                             | 测试字符串静态命中过于接近真实密钥                                                       | 测试改为运行时拼接，不削弱生产 scanner                                                            |
| Worktree finalize | ignored `.tekon` 运行态被 `git add .` 拖入                          | finalize 过于宽泛地 stage 文件                                                           | 改为解析 `git status --porcelain=v1 -z` 的真实可提交改动                                          |
| RD timeout        | RD 新增测试并尝试 `pnpm install --frozen-lockfile`，没先写 manifest | RD 角色 TDD 技能与 provider artifact protocol 顺序冲突                                   | 对 RD/code-changes 节点增加 manifest 优先约束；验证由 Tekon gates 在 artifact ingestion 后运行    |
| PR 创建           | `shell metacharacters are not allowed in argv commands`             | CommandGateway 把 PR title/body argv 数据中的 `<TEKON_OUTPUT_DIR>` 误判为 shell 控制语法 | 保持 `spawn(..., shell:false)`，仅拒绝独立 shell 控制 token，允许 argv 数据字面值                 |

## 5. 本地与远端验证

已在主工作区完成的关键验证：

- `pnpm vitest run packages/core/__tests__/workflow/engine-role-prompt.test.ts packages/core/__tests__/workflow/engine-recovery.e2e.test.ts packages/core/__tests__/runtime/codex-adapter.test.ts packages/core/__tests__/runtime/worktree-manager.test.ts`：84 tests passed。
- `pnpm vitest run packages/core/__tests__/runtime/command-gateway.test.ts packages/core/__tests__/delivery/scm.test.ts packages/core/__tests__/delivery/ci-status.test.ts`：32 tests passed。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `scanFilesForSecrets(process.cwd())`：0 findings。
- `git diff --check`：通过。

成功 run 的 gates：

- PM `demand-card` schema：passed。
- RD build：passed。
- RD lint/typecheck：passed。
- RD security-scan：passed，findings 为空。
- RD `code-changes` schema：passed。
- QA `test-report` schema：passed。
- Reviewer `review-report` schema：passed。
- PMO `delivery-package` schema：passed。

远端 PR checks：

- `Core build and tests`：pass。
- `Lint GitHub Actions workflows`：pass。

## 6. 人工控制边界

本次执行使用 `delivery create-pr --approve-human` 创建真实 PR。该批准只覆盖用户明确要求的“创建真实 PR”。以下动作没有执行：

- 未 merge PR。
- 未发布版本。
- 未上线。
- 未执行 force push。

PR 当前保持 open 状态，后续合入仍应由人类审阅和批准。

## 7. Readiness 解读

`tekon eval readiness` 当前输出为：

- `ready=false`
- `score=0.90`
- `prCreated=true`
- `prUrl=https://github.com/zesming/tekon/pull/2`
- failed：`acceptance-criteria-evidenced`

判断：这不是 P0 真实闭环阻断项。QA、reviewer、PMO artifact 已用自然语言记录了验收依据，PR 与 CI 也已完成；但当前 readiness 的结构化 AC 映射没有把这些证据自动归因到 PM demand-card 的 6 条 AC，因此仍显示 `0/6 acceptance criteria evidenced`。这应进入后续 P1/P2 的证据索引与 AC 自动映射能力，不影响本次“真实 provider 到真实 PR”的 P0 结论。

## 8. 后续优先级建议

1. P0 收尾：保留 PR open，等待人工审阅，不自动 merge。
2. P1：改进 readiness 的 AC evidence 映射，把 QA/reviewer/PMO artifact 中的验收证据结构化关联到 demand-card AC。
3. P1：减少 PR body 标题截断和 evidence unknown，提升 PR 包可读性。
4. P1：沉淀 Codex provider 的失败样本回归集，覆盖 manifest、schema、timeout、worktree finalize、create-pr argv 数据值。
5. P2：在 Codex 闭环稳定后，再规划 Trae provider，不抢占当前 Codex 自举路径。

## 9. 总结

事实：Tekon 已经完成一次真实 Codex provider 自举闭环，并创建真实 PR。  
推断：当前实现达到 P0 验证目标，但 readiness 的 AC evidence 自动映射仍不足，属于证据产品化能力缺口。  
建议：本 PR 进入人工 review；不要自动 merge。下一阶段优先做证据索引、AC 映射和 provider 失败样本回归。
