# Codex Provider Smoke 手册

适用对象：需要验证 Tekon `--agent codex` 是否能在本机真实运行，并用 Tekon 自身创建真实 PR 证据的开发者。

## 1. 目标

本 smoke 只证明 P0 闭环：

- 本机 Codex CLI 可用。
- Tekon 可以通过 `codex --profile internal ... exec` 发起真实 provider run。
- Codex provider 能按 Tekon artifact manifest 协议写回必需 artifact。
- run provider snapshot 记录为 `codex`，后续 resume 不会降级为 mock。
- `delivery prepare` 生成 PR 包。
- 人工确认后，`delivery create-pr --approve-human` 创建真实 PR。

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

上面的 `exec --help` 只验证 CLI 与 internal profile 是否可用；真实 Tekon run 会由 adapter 在 `exec` 前受控追加 `--add-dir <TEKON_OUTPUT_DIR>`，只开放本节点 artifact 输出目录。

## 4. 最小运行命令

```bash
node packages/cli/dist/index.js init --repo /Users/zhaoensheng/Projects/tekon

node packages/cli/dist/index.js run "补齐 Codex provider smoke 证据，要求产出可审阅文档和测试记录。" \
  --template docs-update \
  --agent codex \
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

运行结束后检查：

```bash
node packages/cli/dist/index.js eval readiness --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js eval work-usability record \
  --id tekon-codex-self-bootstrap \
  --expected-provider codex \
  --require-real-provider \
  --require-pr \
  --samples docs/reviews/tekon-codex-work-usability-samples.yaml \
  --repo /Users/zhaoensheng/Projects/tekon
```

如果样本记录失败，不要改成 `expectedProvider: mock`；应先修真实 provider 证据。

## 6. 创建 PR

PR 创建必须显式人工批准：

```bash
node packages/cli/dist/index.js delivery prepare --repo /Users/zhaoensheng/Projects/tekon

node packages/cli/dist/index.js delivery create-pr \
  --approve-human \
  --repo /Users/zhaoensheng/Projects/tekon
```

成功后记录 PR URL：

```bash
node packages/cli/dist/index.js delivery ci-status --repo /Users/zhaoensheng/Projects/tekon
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

| 失败现象                                  | 可能原因                                                                                                                                  | 处理                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Unsupported agent: codex`                | CLI/Web 没有接线 Codex provider。                                                                                                         | 更新到包含 Codex adapter 的版本，并重新构建。                                                    |
| `agent failed: provider=codex exitCode=1` | Codex 没写 manifest、artifact schema 不合法，命令执行失败，或用户 args 试图覆盖 profile、sandbox、approval、文件系统、配置或危险 bypass。 | 查 `.tekon/runs/<runId>/<nodeId>/` 下 stdout/stderr、`artifact-manifest.json` 和 artifact 内容。 |
| resume 拒绝                               | run 缺 provider snapshot 或 snapshot 不能 replay。                                                                                        | 不手工篡改 provider；必要时重新跑真实 Codex run。                                                |
| `delivery create-pr` 等待审批             | 未传 `--approve-human`。                                                                                                                  | 审阅 PR 包和 diff 后再显式批准。                                                                 |
| `ci-status` 失败                          | 没有 PR URL、`gh` 未认证或目标 host 不支持。                                                                                              | 先确认 `gh auth status` 和 `gh pr checks`。                                                      |
