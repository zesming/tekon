# Codex Provider Smoke 手册

适用对象：需要验证 Tekon `--agent codex` 是否能在本机真实运行，并用 Tekon 自身创建真实 PR 证据的开发者。

## 1. 目标

本 smoke 只证明 P0 闭环：

- 本机 Codex CLI 可用。
- Tekon 可以通过 `codex --profile internal ... exec` 发起真实 provider run。
- Codex provider 能按 Tekon artifact manifest 协议写回必需 artifact。
- run provider snapshot 记录为 `codex`，后续 resume 不会降级为 mock。
- 对于 `standard-delivery` 治理 run，`delivery prepare` 生成 PR 包。
- 对于 `standard-delivery` 治理 run，人工确认后，`delivery create-pr --approve-human` 创建真实 PR。

本 smoke 不证明生产级稳定性，不自动 merge，不自动上线。

## 2. 官方资料和判断依据

| 资料                                                           | 资料内容                                                                                                           | 对 Tekon 的判断依据                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `https://developers.openai.com/codex/noninteractive`           | Codex 非交互模式使用 `codex exec`，适合脚本、CI 和一次性自动化任务。                                               | Tekon provider 可以把每个 workflow node 映射为一次 `codex exec`。                                                                                                                                                              |
| `https://developers.openai.com/codex/agent-approvals-security` | Codex 支持 sandbox、approval 和网络访问边界组合，`workspace-write` + `on-request` 是低摩擦但仍保留批准边界的组合。 | Tekon 默认固定 `codex --profile internal --sandbox workspace-write --ask-for-approval on-request --add-dir <TEKON_OUTPUT_DIR> exec`；`--add-dir` 只由 Tekon 受控追加到 artifact 输出目录，不把 profile 和安全边界交给 prompt。 |
| `https://developers.openai.com/codex/cli/reference`            | CLI 参考列出 `codex exec`、`--profile`、`--sandbox`、`--ask-for-approval`、配置覆盖和危险 bypass 参数。            | Tekon adapter 必须拒绝用户 args 覆盖 profile、sandbox、approval、文件系统、配置或危险 bypass。                                                                                                                                 |

## 3. 前置条件

在 Tekon 源码仓库根目录执行：

```bash
codex --version
codex --profile internal --sandbox workspace-write --ask-for-approval on-request exec --help
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 build
```

如果 `codex --version` 或 `codex --profile internal ... exec --help` 不可用，先安装 Codex CLI 并完成 internal profile 认证。不要用 mock 结果替代 Codex provider smoke。

上面的 `exec --help` 只验证 CLI 与 internal profile 是否可用；真实 Tekon run 会由 adapter 在 `exec` 前受控追加 `--add-dir <TEKON_OUTPUT_DIR>`，只开放本节点 artifact 输出目录。`TEKON_OUTPUT_DIR` 必须匹配当前 run/node 的受控输出目录，不能指向其它 run、其它 node、共享目录或 symlink；排障时如果发现输出目录不匹配当前 run/node，或路径经 symlink 跳转，应视为 artifact 输出目录诊断异常，而不是正常 smoke 结果。

`TEKON_ARTIFACT_MANIFEST` 是环境变量，值是 manifest 文件路径；provider 应把 manifest JSON 写到 `$TEKON_ARTIFACT_MANIFEST` 指向的文件，不应创建一个字面名为 `TEKON_ARTIFACT_MANIFEST` 的文件。

如果 Codex 在写完有效 manifest 后没有及时退出、被 Tekon 超时中断，或 Codex 进程以非零退出码结束，adapter 会尝试读取并校验 `$TEKON_ARTIFACT_MANIFEST` 指向的文件；只要 workflow 必需 artifact 已完整入库，该节点会继续进入后续 gate。若 manifest 缺失、schema 非法、必需 artifact 不齐、artifact path/symlink 边界校验失败，或进程被非 timeout signal 终止，该节点仍会失败。为兼容真实 Codex 误写出的字面文件名，adapter 也会在受控 `TEKON_OUTPUT_DIR` 内按同一 schema 检查 `TEKON_ARTIFACT_MANIFEST` 文件；该兼容路径不改变 provider prompt 的推荐写法。

结构化 JSON artifact 必须包含非空 `title` 和 `body` 字段。`demand-card`/`prd` JSON 应使用 `acceptanceCriteria[].id/description`；如果真实 provider 写出有效的 `acceptance_criteria[].criterion`，Tekon 会兼容归一化为 `acceptanceCriteria[].description`。`test-plan` JSON 应使用 `testBasis` 和 `testCases`；如果真实 provider 写出有效的 `sourceArtifactsReviewed` 和 `testScenarios`，Tekon 会窄归一化为 `testBasis` 和 `testCases`。`code-changes` 的 provider-style JSON 如果包含非空 `summary`，或包含有效 `changedFiles`/`verification` 条目，会被 Tekon 归一化为可审阅 artifact；真实 provider prompt 仍应优先按 Tekon schema 写出完整字段，避免依赖容错恢复。`demand-review`、`requirement-interface-review`、`technical-review`、`test-plan-review`、`code-review` 和 `qa-release-signoff-review` 等评审类 artifact 必须额外包含合法 `reviewScope`、`reviewProcess`、`decision` 和 `findings` 数组；如果有 finding，每项必须包含合法 `severity` 和 `message`。`reviewRole`、`reviewedArtifacts` 或数组/对象形式的 `reviewScope` 不能替代这些字段。若真实 provider 在 finding 里写出非角色枚举的 `ownerRole`，Tekon 会把该值保留进 `message` 并移除无效 `ownerRole`；这不会放宽 `reviewScope`、`reviewProcess.reviewerRole`、`targetRole` 或 `decision`。

## 4. 最小运行命令

```bash
node packages/cli/dist/index.js init --repo /Users/zhaoensheng/Projects/tekon

node packages/cli/dist/index.js run "补齐 Codex provider smoke 证据，要求产出可审阅文档和测试记录。" \
  --template docs-update \
  --agent codex \
  --repo /Users/zhaoensheng/Projects/tekon
```

如果 smoke 需求明确会运行较久，可以显式放大外层预算，同时保留基于 stdout/stderr 与受控输出目录文件变化的无进展超时和 heartbeat：

```bash
node packages/cli/dist/index.js run "补齐 Codex provider 长程 smoke 证据，要求产出可审阅文档和测试记录。" \
  --template docs-update \
  --agent codex \
  --timeout-ms 7200000 \
  --no-progress-timeout-ms 1200000 \
  --progress-heartbeat-ms 30000 \
  --repo /Users/zhaoensheng/Projects/tekon
```

期望输出包含：

```text
runId=run_...
status=passed
```

如果输出 `status=interrupted`、`status=blocked` 或存在 pending human gate，先查看：

```bash
node packages/cli/dist/index.js review --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js status --repo /Users/zhaoensheng/Projects/tekon
```

## 5. 验证 provider snapshot

`docs-update` smoke 只验证 Codex provider、manifest 入库和可恢复快照，不作为真实 PR 样本。运行结束后先检查 provider 证据；`eval readiness` 在 PR 准备、真实 PR 和远端 CI 缺失时返回 `ready=false` 是预期状态，不应据此把 provider 降级成 mock：

```bash
node packages/cli/dist/index.js status --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js review --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js eval readiness --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js eval work-usability record \
  --id tekon-codex-provider-smoke \
  --expected-provider codex \
  --require-real-provider \
  --samples docs/reviews/tekon-codex-work-usability-samples.yaml \
  --repo /Users/zhaoensheng/Projects/tekon
```

如果 provider 样本记录失败，不要改成 `expectedProvider: mock`；应先修真实 provider 证据。

## 6. PR 口径

`docs-update` smoke 用于证明 Codex provider 能按 manifest protocol 产出 artifact，不再直接作为 `delivery prepare/create-pr` 的输入。当前 `delivery prepare` 和 `delivery create-pr` 只支持 `standard-delivery` 治理 run：必须具备 AC evidence、QA release signoff、PMO process checkpoint 等标准交付证据。若要创建真实 PR，先使用 `standard-delivery` 重新跑同一需求或一个小型自举需求，然后显式人工批准 PR 创建：

```bash
node packages/cli/dist/index.js run "补齐 Codex provider smoke 证据，要求产出可审阅文档和测试记录。" \
  --template standard-delivery \
  --agent codex \
  --repo /Users/zhaoensheng/Projects/tekon

node packages/cli/dist/index.js delivery prepare --repo /Users/zhaoensheng/Projects/tekon

node packages/cli/dist/index.js delivery create-pr \
  --approve-human \
  --repo /Users/zhaoensheng/Projects/tekon
```

成功后记录 PR URL：

```bash
node packages/cli/dist/index.js delivery ci-status --repo /Users/zhaoensheng/Projects/tekon

node packages/cli/dist/index.js eval work-usability record \
  --id tekon-codex-self-bootstrap-pr \
  --expected-provider codex \
  --require-real-provider \
  --require-pr \
  --samples docs/reviews/tekon-codex-work-usability-samples.yaml \
  --repo /Users/zhaoensheng/Projects/tekon
```

`ci-status` 是只读查询，不 rerun CI、不 merge、不上线。

## 7. 结果归档

真实自举完成后，把以下内容写入 `docs/reviews/YYYY-MM-DD-tekon-codex-self-bootstrap-report.md` 和对应 HTML：

- 需求摘要。
- run id。
- provider snapshot 摘要，必须是 `codex`。
- readiness 结果。
- gate 结果和失败诊断。
- PR package 路径。
- PR URL。
- CI status。
- 人工介入点。
- 风险和后续动作。

`.tekon/` 运行产物不应作为唯一验收证据；关键结论必须归档到可提交文档。

## 8. 常见失败

| 失败现象                                   | 可能原因                                                                                                                                                                               | 处理                                                                                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Unsupported agent: codex`                 | CLI/Web 没有接线 Codex provider。                                                                                                                                                      | 更新到包含 Codex adapter 的版本，并重新构建。                                                                                                                                        |
| `agent failed: provider=codex exitCode=1`  | Codex 没写 manifest、artifact schema 不合法、必需 artifact 不齐，命令执行失败且没有完整可恢复 artifact，或用户 args 试图覆盖 profile、sandbox、approval、文件系统、配置或危险 bypass。 | 查 `.tekon/runs/<runId>/<nodeId>/` 下 stdout/stderr、`artifact-manifest.json`、字面 `TEKON_ARTIFACT_MANIFEST` 和 artifact 内容。                                                     |
| artifact 输出目录诊断异常                  | 真实 Tekon run 受控追加的 `--add-dir <TEKON_OUTPUT_DIR>` 未匹配当前 run/node，目录指向其它 run/node 或共享位置，或该目录是 symlink。                                                   | 不把该结果当作正常 smoke；确认 `TEKON_OUTPUT_DIR` 对应 `.tekon/runs/<runId>/<nodeId>/` 的真实目录且不是 symlink 后重跑。                                                             |
| `code-changes` artifact schema 不合法      | 非 provider-style、字段为空、正文为空，或无法归一化为含 `title`/`body` 的有效 artifact。                                                                                               | 更新 provider prompt 或 artifact 内容；`changedFiles`/`verification` 等 provider-style 字段只作为兼容输入。                                                                          |
| `demand-card`/`prd` artifact schema 不合法 | 缺少 `acceptanceCriteria`，或 `acceptance_criteria[].criterion` 等兼容字段为空、条目不完整。                                                                                           | 优先按 Tekon schema 写 `acceptanceCriteria[].id/description`；兼容字段只用于真实 provider 字段漂移恢复。                                                                             |
| `test-plan` artifact schema 不合法         | 缺少 `testBasis`/`testCases`，且没有可归一化的 `sourceArtifactsReviewed`/`testScenarios`；或 `testCases` 条目缺少 id/description。                                                       | 优先按 Tekon schema 写 `testBasis` 和 `testCases[].id/description`；provider-style 字段只用于真实 provider 字段漂移恢复。                                                            |
| 评审类 artifact schema 不合法              | 缺少 `reviewScope`、`reviewProcess`、`decision`，`findings` 不是数组，finding 条目的 `severity`、`message` 不合法，或 `reviewScope` / `reviewProcess` 使用非法值。                  | 按节点 prompt 中的 role-scoped review JSON 示例重写 artifact；不要用 `reviewRole`、`reviewedArtifacts` 或数组/对象形式的 `reviewScope` 替代 schema 字段；无效 `ownerRole` 会被窄归一化。 |
| `agent timed out: provider=codex`          | Codex 进程在写完有效 manifest 前超时，或 manifest/artifact 不完整；如果必需 artifact 完整合法，timeout 可被 adapter 恢复为节点完成。                                                   | 查 `artifact-manifest.json`、字面 `TEKON_ARTIFACT_MANIFEST`、必需 artifact 和 progress JSON 的 `lastOutputDirActivityAt`；若不完整，拆小任务或提高总超时并保留 no-progress timeout。 |
| resume 拒绝                                | run 缺 provider snapshot 或 snapshot 不能 replay。                                                                                                                                     | 不手工篡改 provider；必要时重新跑真实 Codex run。                                                                                                                                    |
| `delivery create-pr` 等待审批              | 未传 `--approve-human`。                                                                                                                                                               | 审阅 PR 包和 diff 后再显式批准。                                                                                                                                                     |
| `ci-status` 失败                           | 没有 PR URL、`gh` 未认证或目标 host 不支持。                                                                                                                                           | 先确认 `gh auth status` 和 `gh pr checks`。                                                                                                                                          |
