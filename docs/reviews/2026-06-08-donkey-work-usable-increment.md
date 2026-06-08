# Donkey 工作可用化增量报告

日期：2026-06-08

范围：把 Phase 3 本地 mock 产品环推进到“可在受控工作场景中真实使用，但不追求全面自动化”的第一批 P0/P1 能力。

结论：本轮已补齐 repo profile、角色 prompt 注入、Claude Code adapter CLI 接线、真实 provider artifact manifest 入库、repo profile 驱动 gate、缺失命令修复引导和显式不适用语义、provider 快照恢复、真实 worktree 主执行路径、PR 准备包、人工批准后的 PR 创建、PR 创建后的远端 CI 状态证据和 watch 轮询、Web approval 自动继续、Web 受控发起 run/prepare/create-pr、需求塑形、受控 workflow selection、语义验收证据、安全扫描、命令日志脱敏、artifact 入库敏感信息拦截、工作就绪度评估、工作可用样本评估和第一版 CLI/Web 聚合审阅面。自动 merge、自动上线、动态 workflow 非 dry-run、生产级真实 LLM 稳定性和远程多租户服务仍未声明完成。

## 1. 背景判断

根据飞书方案和本地实现对照，Donkey 当前最应该补齐的是“人能放心拿去工作”的闭环，而不是扩展组织级全自动平台：

1. Agent 必须在隔离 worktree 中执行，且通过 Gate 的代码改动必须进入一个可推送的交付分支。
2. 交付必须以 evidence package、逐条验收标准、安全扫描和审计链支撑人工判断。
3. 真实远端副作用必须显式人工批准，默认不 push、不创建 PR、不 merge、不上线。
4. Web/CLI 的人工审批必须能推进流程，不让人审批后还要手工修数据库或重跑整条链路。
5. readiness 必须揭示缺口，不能因为没有验收标准或没有安全扫描而误判为 ready。

## 2. 已完成能力

| 能力                         | 实现位置                                                                                                                       | 说明                                                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库画像                     | `packages/core/src/repo/profile.ts`                                                                                            | `init` 时根据 `package.json` 生成 `.donkey/repo-profile.yaml`，记录 build/typecheck/lint/test/e2e/security、PR base branch 和风险路径。                                                                                                      |
| 仓库画像驱动 Gate            | `workflows/*.yaml`、`packages/core/src/workflow/engine.ts`、CLI `workflow preflight`                                           | 内置模板通过 `commandRef` 读取 repo profile 命令；preflight 可列出每个 gate 的解析结果，缺失普通命令时 gate 不会静默跳过，并给出 repo profile 写入提示和候选脚本建议；显式 `notApplicable` 的普通命令 gate 记录为 `skipped/not-applicable`。 |
| 角色 prompt 注入             | `packages/core/src/workflow/engine.ts`                                                                                         | Engine 执行节点时加载角色 system prompt、skills、knowledge、tools policy、需求正文和输入 artifacts，组装为 Agent prompt。                                                                                                                    |
| Claude Code adapter CLI 接线 | `packages/cli/src/index.ts`、`packages/core/src/runtime/claude-code-adapter.ts`                                                | `run --agent claude-code` 会创建 Claude Code adapter；adapter 读取 `DONKEY_ARTIFACT_MANIFEST`，校验 artifact schema 后写入 Artifact Store。                                                                                                  |
| Provider 快照恢复            | `packages/core/src/db/repositories.ts`、`packages/cli/src/index.ts`、`packages/web/src/server/api/root.ts`                     | run 创建时落库 provider/config 摘要；CLI/Web resume 使用 run 快照，旧 run 缺少快照时拒绝继续；Engine 增加 role-run completed marker，避免 stale running 节点直接进 gate。                                                                    |
| 真实 worktree 主路径         | `packages/core/src/workflow/engine.ts`、`packages/core/src/runtime/worktree-manager.ts`                                        | CLI run/resume 注入 WorktreeManager；节点在 git worktree 中执行，Gate 在同一 worktree 中验证，通过后提交改动并推进到 `donkey-delivery/<runId>`，随后释放 lease。                                                                             |
| 内置安全扫描                 | `packages/core/src/gate/runners.ts`、`workflows/*.yaml`                                                                        | `security-scan` gate 可无外部命令运行，扫描明显 private key、`sk-`、AWS key 和 token/secret 赋值；内置模板代码节点已包含该 gate。                                                                                                            |
| 敏感信息治理                 | `packages/core/src/security/secrets.ts`、`packages/core/src/runtime/command-gateway.ts`、`packages/core/src/artifact/store.ts` | 共享 secret scanner 覆盖内置 security-scan、命令 stdout/stderr 落盘前脱敏和 artifact 写入前拦截；当前是基础模式治理，不是完整 DLP。                                                                                                          |
| PR 准备包                    | `packages/core/src/delivery/pr-package.ts`、CLI `delivery prepare`                                                             | 生成 `.donkey/runs/<runId>/delivery/pr-package.md` 和 `pr-body.md`，记录 `delivery.pr-prepared` 审计事件，并汇总 acceptance/security evidence。                                                                                              |
| 受控 PR 创建                 | `packages/core/src/delivery/scm.ts`、CLI `delivery create-pr`                                                                  | 不带 `--approve-human` 只落库等待审批；带 `--approve-human` 后要求主工作区除 `.donkey` 外干净，直接 push 交付分支并执行 `gh pr create --body-file`，成功/失败/PR URL 均落库。                                                                |
| PR 失败恢复                  | `packages/core/src/delivery/scm.ts`                                                                                            | `gh pr create` 失败后尝试 `gh pr view <branch> --json url --jq .url` 恢复已存在 PR URL，恢复成功按 created 落库并记录 audit。                                                                                                                |
| 远端 CI 状态证据             | `packages/core/src/delivery/ci-status.ts`、CLI `delivery ci-status`                                                            | PR 创建后只读调用 `gh pr checks`，把 checks 汇总为 `passed/failed/pending/skipped/unknown`，写入 `ci-status` artifact、delivery evidence 和 `delivery.ci.checked` audit。                                                                    |
| 远端 CI watch                | `packages/core/src/delivery/ci-status.ts`、CLI `delivery ci-watch`                                                             | 只读轮询 `gh pr checks`，每次查询都写入 `ci-status` artifact；到 `passed/failed/skipped` 终态或达到次数上限后记录 `delivery.ci.watch-completed` audit。                                                                                      |
| Web approval 自动继续        | `packages/web/src/server/api/root.ts`                                                                                          | Web approve 会更新 human decision/gate/node/workflow 和 audit，然后调用 Engine resume；reject 会阻断 workflow。                                                                                                                              |
| Web 受控执行入口             | `packages/web/src/server/api/root.ts`、`packages/web/src/client/App.tsx`                                                       | Web 使用 session token 发起模板 run、执行 PR 准备和触发受人工批准的 create-pr；复用 Engine、PR package 和 SCM delivery 语义，不绕过 dirty base 和人工审批。                                                                                  |
| Web 多运行审阅流             | `packages/web/src/server/api/root.ts`、`packages/web/src/client/App.tsx`、`packages/web/__tests__/fixtures/project.ts`         | Web 读取项目 run 列表，可选择历史 run 或 latest run，并按选中 run 加载 readiness、artifact 正文、gate log、audit 和 PR 包；PR 准备/创建也作用在选中 run。                                                                                    |
| 需求塑形入口                 | `packages/core/src/demand/shape.ts`、CLI `demand`、Web dashboard                                                               | 先把原始需求塑形成需求卡、风险、非目标、开放问题和验收标准；CLI/Web 都要求人工批准后再用 `run --demand-file` 或 Web shape path 进入 workflow。                                                                                               |
| 受控 Workflow 选择           | `workflows/*.yaml`、`packages/core/src/demand/shape.ts`、CLI `workflow select` / `eval workflow-selection`、Web dashboard      | 新增 `test-improvement`、`docs-update`、`plan-only` 受控模板；需求塑形可推荐模板，CLI 可评估人工选择是否匹配需求，Web 模板选择器可直接选择这些模板。                                                                                         |
| 工作就绪度评估               | `packages/core/src/eval/work-readiness.ts`、CLI `eval readiness`                                                               | required checks 覆盖 workflow、audit、最新验证 gate、delivery package、PR 准备事件、pending human gate、验收标准证据和安全扫描；PR created 和 remote CI passed 为 recommended。                                                              |
| 工作可用样本评估             | `packages/core/src/eval/work-usability.ts`、CLI `eval work-usability`                                                          | 读取样本清单并按阈值检查样本数、ready run、真实 provider run、created PR、security scan、worktree 隔离和远端副作用审批，把 P0-2/P0-6/P0-7 变成可执行评估。                                                                                   |
| 聚合审阅面                   | `packages/core/src/review/surface.ts`、CLI `review`、Web `review.get`                                                          | 汇总 readiness 失败项、Evidence Navigation、PR body/package、delivery diff、artifact 正文、gate log 和下一步命令；Web 显示 Readiness/Evidence Links/Diff/Artifact 正文/Gate Logs/PR 包/下一步。                                              |
| Gate 失败诊断                | `packages/core/src/review/surface.ts`、CLI `review`、Web dashboard                                                             | review surface 新增 Gate Failure Triage，把失败 gate 的 classification、日志锚点、retry 建议和 suggested command 结构化展示。                                                                                                                |

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
- `repo/profile.test.ts`：覆盖缺失 build 时从 `compile` 脚本建议 `npm run compile`，以及 pnpm 仓库缺失 e2e 时从 `test:e2e` 建议 `pnpm test:e2e`。
- `repo/profile.test.ts`：覆盖 repo profile 显式 `notApplicable` 不被当作 missing，并在 guidance 中输出 reason。
- `gate/engine.test.ts` / `workflow/engine-template.e2e.test.ts`：覆盖显式不适用的普通 command gate 记录为 `skipped/not-applicable`，并允许 workflow 继续通过。
- `eval/work-readiness.test.ts` / `delivery/pr-package.test.ts`：覆盖 `skipped/not-applicable` 进入 readiness 和 PR 包，而不是被静默吞掉。
- `cli` run-cli unit：覆盖 `workflow preflight` 在缺失 `commands.build` 时输出 `status=missing`、`profilePath`、`hint`、`suggestedScript` 和 `suggestedCommand`。
- `cli` run-cli unit：覆盖 `workflow preflight` 在显式 `notApplicable` 时输出 `status=not-applicable` 和 `notApplicableReason`。
- `delivery/scm.test.ts`：PR 状态落库、人工审批、`.donkey` 排除、已有分支空 commit 跳过、PR URL 创建/恢复和失败阶段落库。
- `eval/work-readiness.test.ts`：readiness 要求逐条 acceptance evidence 和 security-scan。
- `review/surface.test.ts`：聚合 readiness、artifact 正文、gate log、PR body/package 和 delivery diff，并覆盖 repo 外 artifact/gate log、symlink、DB project repoPath 扩权和 unsafe git ref 不被采信。
- `review/surface.test.ts`：覆盖失败 gate 的 triage 输出，包含 `exit-code`、`missing-command`、日志锚点、retry 建议和 suggested command。
- `demand/shape.test.ts`：覆盖需求分类、风险识别、验收标准生成、开放问题、人工批准、Markdown/JSON 文件写入和需求塑形评估。
- `demand/shape.test.ts` / `workflow/template.test.ts`：覆盖 `test-improvement`、`docs-update`、`plan-only` 受控模板推荐、错误模板选择评估失败，以及所有内置模板可被解析。
- `eval/work-usability.test.ts`：覆盖样本阈值通过、真实 provider/PR/隔离证据缺失失败，以及缺失 run 的样本级失败证据。
- `gate/runners.test.ts`：内置 security scan 的通过和失败路径。
- `security/secrets.test.ts`：覆盖共享 secret scanner 的文本扫描、脱敏和忽略 `.donkey` 运行态目录。
- `runtime/command-gateway.test.ts`：覆盖命令 stdout/stderr 落盘前脱敏。
- `artifact/store.test.ts`：覆盖 artifact 写入前敏感内容拦截且不落盘。
- `delivery/evidence.test.ts` / `delivery/pr-package.test.ts`：验收标准证据和安全扫描证据进入交付包。
- `delivery/ci-status.test.ts`：覆盖 PR checks 只读查询、`ci-status` artifact、delivery evidence、readiness 推荐项、失败 checks、pending exit code、历史 passed 后最新 failed 不通过、未审计伪造 `ci-status` artifact 不被信任、unsafe run id 和 escaped outputDir 不执行 `gh` 的场景。
- `delivery/ci-status.test.ts`：覆盖 `delivery ci-watch` 的 pending 到 passed 轮询、每次尝试 artifact 入库、sleep/backoff 调用和 max attempts 后非终态返回。
- `artifact/schemas.test.ts`：覆盖 `ci-status` payload schema，并覆盖 agent manifest 拒绝 `ci-status`。
- `cli` run-cli unit：`review --run-id` 输出 readiness、artifact、gate log 和 PR body。
- `cli` run-cli unit：覆盖 fake `gh pr checks` 下的 `delivery ci-status` 命令输出。
- `cli` run-cli unit：覆盖 `demand shape --write`、未批准 `run --demand-file` 阻断、`demand approve`、`eval demand-shape` 和批准后的 `run --demand-file`。
- `cli` release e2e：覆盖 `eval work-usability --samples` 在受控 fixture 中读取样本清单并验证 ready run、created PR 和隔离证据。
- `web` API/e2e：Web approval 后自动 resume，reject 不继续；Web API 和 dashboard 可读取 review surface；Web 可塑形并批准需求、发起 mock run、执行 prepare、将 create-pr 落库为 awaiting-approval，并在 e2e 中完成 dashboard 需求塑形、发起 run 和准备 PR。
- `web` API/e2e：fixture 增加历史 run，API 覆盖 `project.detail` 返回多 run 和指定 run review；dashboard e2e 覆盖选择历史 run 查看 artifact/gate log，再切回 latest run 继续审批和 PR 准备。

本轮最终收口已通过：

```bash
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test:e2e
git diff --check
npm exec --yes -- prettier --check CHANGELOG.md README.md docs/manual/donkey-v2-user-manual.md docs/manual/donkey-v2-user-manual.html docs/reviews/2026-06-08-donkey-work-usability-gap-analysis.md docs/reviews/2026-06-08-donkey-work-usability-gap-analysis.html docs/reviews/2026-06-08-donkey-work-usable-increment.md docs/reviews/2026-06-08-donkey-work-usable-increment.html docs/reviews/2026-06-08-donkey-remote-ci-status-increment.md docs/reviews/2026-06-08-donkey-remote-ci-status-increment.html docs/reviews/2026-06-08-donkey-repo-profile-command-guidance-increment.md docs/reviews/2026-06-08-donkey-repo-profile-command-guidance-increment.html docs/reviews/2026-06-08-donkey-repo-profile-not-applicable-increment.md docs/reviews/2026-06-08-donkey-repo-profile-not-applicable-increment.html packages/cli/__tests__/run-cli.test.ts packages/cli/src/index.ts packages/core/__tests__/artifact/schemas.test.ts packages/core/__tests__/delivery/ci-status.test.ts packages/core/__tests__/delivery/pr-package.test.ts packages/core/__tests__/eval/work-readiness.test.ts packages/core/__tests__/gate/engine.test.ts packages/core/__tests__/repo/profile.test.ts packages/core/__tests__/workflow/engine-template.e2e.test.ts packages/core/src/artifact/schemas.ts packages/core/src/delivery/ci-status.ts packages/core/src/delivery/evidence.ts packages/core/src/delivery/pr-package.ts packages/core/src/eval/work-readiness.ts packages/core/src/gate/engine.ts packages/core/src/index.ts packages/core/src/repo/profile.ts packages/core/src/types/domain.ts packages/core/src/workflow/engine.ts packages/core/src/workflow/template.ts
```

## 4. 仍未完成

- 真实 Claude Code / Codex 在受控真实仓库中的端到端稳定执行证据；本轮证明的是 artifact manifest 协议、provider 快照和 fixture 流程，不证明真实任务长期成功率。
- 真实样本清单本身；`eval work-usability record` 和 `--report-md/--report-html` 已经降低样本沉淀和报告归档成本，但不会替代 2-3 个真实仓库、10 个需求和至少 2 个真实 PR 的实际 dogfooding。
- 真实 PR 上的远端 CI 状态证据；当前 `delivery ci-status` / `delivery ci-watch` 已有 fake `gh` fixture 和本地入库测试，但仍需在受控 GitHub PR 上记录 `gh pr checks` 输出、PR URL、状态变化和失败恢复。
- 动态 workflow 非 dry-run 执行。
- 真实 PM/LLM 多轮需求澄清；当前需求塑形是确定性启发式和人工批准入口，不代表自动理解所有需求。
- 动态 workflow 自动规划和人工确认后保存模板的产品流；当前 workflow selection 只在受控内置模板之间做确定性推荐和评估。
- 自动 merge、自动上线、生产权限变更等高风险动作。
- 生产级 OS 沙箱、网络隔离和密钥治理；当前 `CommandPolicy.network` 不是 OS 级隔离。
- 完整 DLP、密钥轮换和生产级安全审计；当前新增的是基础敏感模式扫描、命令日志脱敏和 artifact 入库拦截。
- PR 创建失败后的更复杂恢复策略，例如远端网络抖动后的重试退避、不同 Git host 的 PR 查询差异。
- 远端 CI 查询的无 checks 场景细分、不同 Git host 或非 GitHub CI provider 适配。
- Web 已能直接发起模板 run、选择历史 run、执行 delivery prepare 和触发 create-pr 入口；artifact/gate/audit 互跳和 Gate Failure Triage 仍是基础锚点级体验，还需继续打磨成更完整的上下文导航。
- 团队级多项目权限、成本控制、通知和长期知识沉淀仍是后续阶段能力。

## 5. Reviewer 结论

上一轮最高思考 reviewer 复查结论：APPROVED。第一轮 review 检出的 P0-1/P0-3/P0-4 代码、测试和文档一致性问题已修复；复查确认 Markdown/HTML 不再把已实现的 artifact manifest、repo profile `commandRef` 和 provider snapshot 恢复写成当前缺失。

本次 P0-5 最高思考 reviewer 第一轮结论为 CHANGES_REQUESTED，必须修复项包括：review surface 对 artifact/gate log 的路径读取需要防 symlink/traversal 逃逸；readiness/evidence 不应间接采信 repo 外 artifact；delivery diff 不应接受 unsafe ref 或在 base 缺失时 fallback。

已修复摘要：新增 repo-bound safe path 读取；`delivery/evidence.ts`、`review/surface.ts` 和 artifact/gate log preview 统一按目标 repo 边界读取；delivery diff 使用安全 ref 校验、`rev-parse --verify --end-of-options` 和 commit hash range；base/branch 缺失时返回 unavailable。第二轮 reviewer 又指出 DB 中 `project.repoPath` 可能扩大 review readiness/evidence 读取边界；已通过 `evaluateWorkReadiness` / `createDeliveryEvidencePackage` 的显式 `repoPath` override 修复，并新增“DB project repoPath 指向外部目录时 readiness 不采信外部 artifact”的回归测试。

本次 P0-5 复查结论：APPROVED，必须修复项为无。后续又补齐 Web 发起 run、prepare/create-pr 入口和基础锚点互跳；本轮新增 Web 执行入口第一轮 reviewer 指出项目 workflow 优先级和文档过期表述问题，均已修复，并补充 approved create-pr fake `gh` 测试。后续继续补齐 Web 多运行审阅流，dashboard 能选择历史 run 或 latest run 并让 review/prepare/create-pr 跟随选中 run。最终复查结论：APPROVED，必须修复项为无。

本次远端 CI 状态证据第一轮 reviewer 结论为 CHANGES_REQUIRED，必须修复项包括：`remote-ci-passed` 不应被历史 passed `ci-status` artifact 误导；CLI `delivery ci-status` 错误路径必须关闭 SQLite 连接。已修复：delivery evidence 只输出最新 `ci-status`，readiness 只按最新状态判断；CLI DB 连接改为 `try/finally` 关闭；补充 stale CI evidence 和 CLI 无 selector 失败后的回归测试。最终复查结论以 reviewer 返回为准。

第二轮 reviewer 结论仍为 CHANGES_REQUIRED，必须修复项为：执行 `gh` 前未校验 runId/path segment，恶意 run id 搭配 selector 可能让 CommandGateway 日志 outputDir 逃逸 `.donkey/runs`。已修复：`queryPullRequestCiStatus` 在执行 `gh` 前校验 run 存在和 safe path segment，默认 outputDir 使用安全 run segment，显式 outputDir 必须位于仓库 `.donkey` 内，并补充 unsafe run id / escaped outputDir 不执行 gateway 的回归测试。最终复查结论以 reviewer 返回为准。

第三轮 reviewer 结论仍为 CHANGES_REQUIRED，必须修复项为：agent manifest 允许 `ci-status` 会让真实 provider 伪造远端 CI 通过，delivery evidence 也不应信任任意 `ci-status` artifact。已修复：agent manifest schema 拒绝 `ci-status`；delivery evidence 只信任 `delivery.ci.checked` 审计事件关联的 `ci-status` artifact；补充 manifest 拒绝和未审计伪造 artifact 不影响 readiness 的回归测试。最终复查结论：APPROVED，必须修复项为无。

本次仓库画像缺失命令修复引导最高思考 reviewer 结论：APPROVED，必须修复项为无。复查确认本轮 guidance 只生成建议，不写入 repo profile、不自动执行候选脚本、不改变普通命令缺失时的 `missing-command` 失败语义；当时文档也未把尚未实现的 `notApplicable`、真实非 pnpm 仓库验证或自动跳过 gate 写成已完成。后续同日增量已补齐显式 `notApplicable` 语义。

本次仓库画像显式不适用语义最高思考 reviewer 结论：APPROVED，必须修复项为无。复查确认 `notApplicable` 只注入普通 command gate；`security-scan` 在 workflow 和 gate engine 两层都不会被跳过，CLI 也会显示 `notApplicableIgnoredFor=security-scan`；readiness 只把 `skipped/not-applicable` 的验证类 gate 视为 satisfied，安全扫描和 pending human gate 仍独立检查。

剩余项均为后续工作：P0-2/P0-6/P0-7 仍保留为真实仓库样本、真实 PR 证据和生产级隔离证据工作；P0-5 的 Evidence Navigation 已有第一版，但仍需真实 run 反馈继续打磨。
