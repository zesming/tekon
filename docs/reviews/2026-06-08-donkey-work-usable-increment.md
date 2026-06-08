# Donkey 工作可用化增量报告

日期：2026-06-08

范围：把 Phase 3 本地 mock 产品环推进到“可在受控工作场景中真实使用，但不追求全面自动化”的第一批 P0/P1 能力。

结论：本轮已补齐 repo profile、角色 prompt 注入、Claude Code adapter CLI 接线、真实 provider artifact manifest 入库、repo profile 驱动 gate、provider 快照恢复、真实 worktree 主执行路径、PR 准备包、人工批准后的 PR 创建、Web approval 自动继续、语义验收证据、安全扫描、工作就绪度评估和第一版 CLI/Web 聚合审阅面。自动 merge、自动上线、动态 workflow 非 dry-run、生产级真实 LLM 稳定性和远程多租户服务仍未声明完成。

## 1. 背景判断

根据飞书方案和本地实现对照，Donkey 当前最应该补齐的是“人能放心拿去工作”的闭环，而不是扩展组织级全自动平台：

1. Agent 必须在隔离 worktree 中执行，且通过 Gate 的代码改动必须进入一个可推送的交付分支。
2. 交付必须以 evidence package、逐条验收标准、安全扫描和审计链支撑人工判断。
3. 真实远端副作用必须显式人工批准，默认不 push、不创建 PR、不 merge、不上线。
4. Web/CLI 的人工审批必须能推进流程，不让人审批后还要手工修数据库或重跑整条链路。
5. readiness 必须揭示缺口，不能因为没有验收标准或没有安全扫描而误判为 ready。

## 2. 已完成能力

| 能力                         | 实现位置                                                                                                   | 说明                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库画像                     | `packages/core/src/repo/profile.ts`                                                                        | `init` 时根据 `package.json` 生成 `.donkey/repo-profile.yaml`，记录 build/typecheck/lint/test/e2e/security、PR base branch 和风险路径。                                       |
| 仓库画像驱动 Gate            | `workflows/*.yaml`、`packages/core/src/workflow/engine.ts`、CLI `workflow preflight`                       | 内置模板通过 `commandRef` 读取 repo profile 命令；preflight 可列出每个 gate 的解析结果，缺失 build/lint/test 命令时 gate 不会静默跳过。                                       |
| 角色 prompt 注入             | `packages/core/src/workflow/engine.ts`                                                                     | Engine 执行节点时加载角色 system prompt、skills、knowledge、tools policy、需求正文和输入 artifacts，组装为 Agent prompt。                                                     |
| Claude Code adapter CLI 接线 | `packages/cli/src/index.ts`、`packages/core/src/runtime/claude-code-adapter.ts`                            | `run --agent claude-code` 会创建 Claude Code adapter；adapter 读取 `DONKEY_ARTIFACT_MANIFEST`，校验 artifact schema 后写入 Artifact Store。                                   |
| Provider 快照恢复            | `packages/core/src/db/repositories.ts`、`packages/cli/src/index.ts`、`packages/web/src/server/api/root.ts` | run 创建时落库 provider/config 摘要；CLI/Web resume 使用 run 快照，旧 run 缺少快照时拒绝继续；Engine 增加 role-run completed marker，避免 stale running 节点直接进 gate。     |
| 真实 worktree 主路径         | `packages/core/src/workflow/engine.ts`、`packages/core/src/runtime/worktree-manager.ts`                    | CLI run/resume 注入 WorktreeManager；节点在 git worktree 中执行，Gate 在同一 worktree 中验证，通过后提交改动并推进到 `donkey-delivery/<runId>`，随后释放 lease。              |
| 内置安全扫描                 | `packages/core/src/gate/runners.ts`、`workflows/*.yaml`                                                    | `security-scan` gate 可无外部命令运行，扫描明显 private key、`sk-`、AWS key 和 token/secret 赋值；内置模板代码节点已包含该 gate。                                             |
| PR 准备包                    | `packages/core/src/delivery/pr-package.ts`、CLI `delivery prepare`                                         | 生成 `.donkey/runs/<runId>/delivery/pr-package.md` 和 `pr-body.md`，记录 `delivery.pr-prepared` 审计事件，并汇总 acceptance/security evidence。                               |
| 受控 PR 创建                 | `packages/core/src/delivery/scm.ts`、CLI `delivery create-pr`                                              | 不带 `--approve-human` 只落库等待审批；带 `--approve-human` 后要求主工作区除 `.donkey` 外干净，直接 push 交付分支并执行 `gh pr create --body-file`，成功/失败/PR URL 均落库。 |
| PR 失败恢复                  | `packages/core/src/delivery/scm.ts`                                                                        | `gh pr create` 失败后尝试 `gh pr view <branch> --json url --jq .url` 恢复已存在 PR URL，恢复成功按 created 落库并记录 audit。                                                 |
| Web approval 自动继续        | `packages/web/src/server/api/root.ts`                                                                      | Web approve 会更新 human decision/gate/node/workflow 和 audit，然后调用 Engine resume；reject 会阻断 workflow。                                                               |
| 工作就绪度评估               | `packages/core/src/eval/work-readiness.ts`、CLI `eval readiness`                                           | required checks 覆盖 workflow、audit、最新验证 gate、delivery package、PR 准备事件、pending human gate、验收标准证据和安全扫描；PR created 为 recommended。                   |
| 聚合审阅面                   | `packages/core/src/review/surface.ts`、CLI `review`、Web `review.get`                                      | 汇总 readiness 失败项、PR body/package、delivery diff、artifact 正文、gate log 和下一步命令；Web 显示 Readiness/Diff/Artifact 正文/Gate Logs/PR 包/下一步。                   |

## 3. 验证记录

本轮已通过的阶段性验证：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test:e2e
```

新增或强化覆盖：

- `workflow/engine-worktree.e2e.test.ts`：真实 worktree 执行、跨节点改动继承、交付分支推进和 lease release。
- `runtime/claude-code-adapter.test.ts`：真实 provider manifest 写入、schema 校验和 Artifact Store 入库。
- `db/repositories.test.ts`：run provider snapshot、delivery PR 状态和 role-run completed marker。
- `cli` release e2e：`workflow preflight`、repo profile gate 解析、人工批准 PR 创建 fixture。
- `delivery/scm.test.ts`：PR 状态落库、人工审批、`.donkey` 排除、已有分支空 commit 跳过、PR URL 创建/恢复和失败阶段落库。
- `eval/work-readiness.test.ts`：readiness 要求逐条 acceptance evidence 和 security-scan。
- `review/surface.test.ts`：聚合 readiness、artifact 正文、gate log、PR body/package 和 delivery diff，并覆盖 repo 外 artifact/gate log、symlink、DB project repoPath 扩权和 unsafe git ref 不被采信。
- `gate/runners.test.ts`：内置 security scan 的通过和失败路径。
- `delivery/evidence.test.ts` / `delivery/pr-package.test.ts`：验收标准证据和安全扫描证据进入交付包。
- `cli` run-cli unit：`review --run-id` 输出 readiness、artifact、gate log 和 PR body。
- `web` API/e2e：Web approval 后自动 resume，reject 不继续；Web API 和 dashboard 可读取 review surface。

本轮最终收口已通过：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core typecheck
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli typecheck
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web typecheck
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli test:unit
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- prettier --check packages/cli/src/index.ts packages/core/src/runtime/claude-code-adapter.ts packages/core/src/workflow/engine.ts packages/core/src/artifact/schemas.ts packages/core/__tests__/runtime/claude-code-adapter.test.ts packages/web/src/server/api/root.ts
```

## 4. 仍未完成

- 真实 Claude Code / Codex 在受控真实仓库中的端到端稳定执行证据；本轮证明的是 artifact manifest 协议、provider 快照和 fixture 流程，不证明真实任务长期成功率。
- 动态 workflow 非 dry-run 执行。
- 自动 merge、自动上线、生产权限变更等高风险动作。
- 生产级 OS 沙箱、网络隔离和密钥治理；当前 `CommandPolicy.network` 不是 OS 级隔离。
- PR 创建失败后的更复杂恢复策略，例如远端网络抖动后的重试退避、不同 Git host 的 PR 查询差异。
- Web 仍不能直接发起 run、执行 delivery prepare/create-pr，artifact/gate/audit 互跳也仍需继续打磨。
- 团队级多项目权限、成本控制、通知和长期知识沉淀仍是后续阶段能力。

## 5. Reviewer 结论

上一轮最高思考 reviewer 复查结论：APPROVED。第一轮 review 检出的 P0-1/P0-3/P0-4 代码、测试和文档一致性问题已修复；复查确认 Markdown/HTML 不再把已实现的 artifact manifest、repo profile `commandRef` 和 provider snapshot 恢复写成当前缺失。

本次 P0-5 最高思考 reviewer 第一轮结论为 CHANGES_REQUESTED，必须修复项包括：review surface 对 artifact/gate log 的路径读取需要防 symlink/traversal 逃逸；readiness/evidence 不应间接采信 repo 外 artifact；delivery diff 不应接受 unsafe ref 或在 base 缺失时 fallback。

已修复摘要：新增 repo-bound safe path 读取；`delivery/evidence.ts`、`review/surface.ts` 和 artifact/gate log preview 统一按目标 repo 边界读取；delivery diff 使用安全 ref 校验、`rev-parse --verify --end-of-options` 和 commit hash range；base/branch 缺失时返回 unavailable。第二轮 reviewer 又指出 DB 中 `project.repoPath` 可能扩大 review readiness/evidence 读取边界；已通过 `evaluateWorkReadiness` / `createDeliveryEvidencePackage` 的显式 `repoPath` override 修复，并新增“DB project repoPath 指向外部目录时 readiness 不采信外部 artifact”的回归测试。

本次 P0-5 复查结论：APPROVED，必须修复项为无。剩余项均为后续工作：P0-2/P0-6/P0-7 仍保留为真实仓库样本、真实 PR 证据和生产级隔离证据工作；P0-5 还剩 Web 发起 run、prepare/create-pr 和 artifact/gate/audit 互跳体验。
