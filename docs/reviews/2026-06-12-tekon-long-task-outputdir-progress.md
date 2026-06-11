# Tekon 长程任务产物进展观测增强验证归档

日期：2026-06-12  
Run ID：`run_5cfee596-1540-40fd-af31-8e6652e62258`  
节点：`run_5cfee596-1540-40fd-af31-8e6652e62258_rd-code-change`  
需求：验证并归档 Tekon 长程任务产物进展观测增强，确认 CommandGateway 能把受控 `outputDir` 下 artifact/manifest 文件变化计为 no-progress 进展，progress JSON 记录 outputDir 活动指标，并说明 1h/2h 长程预算仍需 heartbeat、no-progress 与产物进展观测共同约束。

## 结论

事实：`packages/core/src/runtime/command-gateway.ts` 已在 CommandGateway 中创建受控 `outputDir` activity monitor，排除当前命令自身的 stdout/stderr/progress 文件，并把文件数量、总字节数和最新 mtime 写入 progress JSON。本次新增定向测试覆盖 `artifact-manifest.json` 与 artifact 正文写入，断言 `lastOutputDirActivityAt`、`outputDirFileCount`、`outputDirBytes`、`outputDirLatestMtimeMs` 和 `timeoutReason`。

推断：在 Codex/Claude adapter 将 `outputDir` 绑定到当前节点 artifact 输出目录、且 provider 只通过受控目录写 artifact/manifest 的前提下，该能力可以降低长程节点只写 artifact/manifest 时被误判为 no-progress 的风险。

建议：继续保留 heartbeat、no-progress 和受控 `outputDir` 产物进展观测三者组合约束；不得把任意目录文件变化、自动 PR、自动 merge 或上线纳入本次范围。

## 变更摘要

| 文件 | 变更 |
| --- | --- |
| `packages/core/__tests__/runtime/command-gateway.test.ts` | 新增 `treats controlled artifact and manifest writes as no-progress activity` 定向测试，使用 fake child 在受控 `outputDir` 写入 `artifact-manifest.json` 与 `implementation-plan.json`，并读取 progress JSON 断言 outputDir 活动指标。 |
| `README.md` | 明确 1 小时默认预算和 2 小时级长程预算仍需 heartbeat、no-progress 与受控 outputDir 产物进展观测共同约束。 |
| `CHANGELOG.md` | 在长程任务产物进展观测条目补充 1h/2h 预算约束说明。 |
| `docs/manual/tekon-user-manual.md` | 同步用户手册正文，说明长程预算放大不替代 heartbeat、no-progress 与受控 outputDir 产物进展观测。 |
| `docs/manual/tekon-user-manual.html` | 同步用户手册 HTML 审阅版，避免 Markdown/HTML 漂移。 |
| `docs/reviews/2026-06-12-tekon-long-task-outputdir-progress.md` | 新增本归档报告。 |
| `docs/reviews/2026-06-12-tekon-long-task-outputdir-progress.html` | 新增 HTML 审阅版。 |

## Artifact 正文说明

本次 code-change 节点的内部 artifact 将写入 `TEKON_OUTPUT_DIR`，记录变更文件、验证状态、未执行 gate 的原因和后续外层 gate 期望。归档文档本身不包含密钥、token、生产 URL 或远端 PR 链接。

## Gate Evidence

| Gate | Command | Result | Evidence |
| --- | --- | --- | --- |
| focused-test | `pnpm exec vitest --run packages/core/__tests__/runtime/command-gateway.test.ts -t "controlled artifact and manifest writes"` | 本节点未执行 | Tekon artifact protocol 要求先写 code-changes artifact 和 manifest，且 manifest 写入后立即停止；该命令应由外层 Tekon gate 或后续 QA 执行。 |
| runtime-test | `pnpm exec vitest --run packages/core/__tests__/runtime/command-gateway.test.ts` | 本节点未执行 | 同上；新增测试位于该测试文件内。 |
| typecheck | `pnpm --filter @tekon/core typecheck` | 本节点未执行 | 同上；本次未改 production TypeScript。 |
| build | `pnpm --filter @tekon/core build` | 本节点未执行 | 同上；本次 runtime 代码未变更。 |
| format | `pnpm format:check` | 本节点未执行 | 同上；需由外层 gate 收集格式化证据。 |
| lint | `pnpm lint` | 本节点未执行 | 同上；需由外层 gate 收集 lint 证据。 |
| test | `pnpm test -- --run` | 本节点未执行 | 同上；需由外层 gate 收集全量测试证据。 |
| security | repo profile security gate | 本节点未执行 | 本节点无生产写操作、无依赖新增、无权限扩大；security 是否适用以外层 repo profile gate 为准。 |
| review-surface | `tekon review` | 本节点未执行 | Tekon Engine 应在 artifact 入库后生成 readiness 与 gate evidence。 |
| delivery-package | `tekon delivery prepare` | 本节点未执行 | 本需求明确不在 run 内创建远端 PR；delivery prepare 是否可用由外层交付节点判定。 |

## Human Gate 与回滚

- Human approved：需求声明为 yes；merge、release、生产写操作、接受残余高风险和创建远端 PR 仍需人类 owner。
- Rollback：回滚本次提交中 `packages/core/__tests__/runtime/command-gateway.test.ts`、`README.md`、`CHANGELOG.md`、`docs/manual/tekon-user-manual.md`、`docs/manual/tekon-user-manual.html` 和本归档文档即可；本次未修改 production code、未做数据库迁移、未新增权限或外部系统配置。
- No remote side effects：本节点不运行 `git push`，不创建远端 PR，不 merge，不上线，不执行生产写操作。

## Non-goals 对照

| Non-goal | 对照结论 |
| --- | --- |
| 不自动 merge、不自动上线、不执行生产写操作 | 未执行相关命令；文档继续强调人工控制。 |
| 不在 run 内创建远端 PR | 未创建远端 PR；delivery 行为留给外层受控节点。 |
| 不扩大需求范围之外的重构、权限或外部系统改动 | 未改权限、依赖、provider 接线或外部系统；新增内容限定为定向测试、文档说明和归档证据。 |
| 不把 artifact/manifest 活动替代 heartbeat 或 no-progress 机制 | README、CHANGELOG、用户手册和归档文档均说明三者共同约束。 |

## AC 对照

| AC | 状态 | 证据 |
| --- | --- | --- |
| AC-1 用户可审阅需求结果 | 已准备 | 归档 Markdown/HTML、code-changes artifact、目标 diff 和外层 review surface 共同提供变更摘要、artifact 正文和 gate 状态。 |
| AC-2 build/lint/test/security gate 通过或显式不适用 | 待外层 gate | 本节点按 Tekon artifact protocol 不执行 gate；已记录需由外层 Tekon gate 收集的命令和适用性说明。 |
| AC-3 范围保持在需求内 | 已控制 | diff 范围限定为 CommandGateway 定向测试、文档说明和归档报告；未修改 production runtime。 |
| AC-4 高风险影响具备人工审批、回滚或风险说明 | 已记录 | 本文记录 human gate、rollback、no remote side effects 和残余风险；最终接受残余高风险仍由人类 owner 控制。 |

## 风险

- 可接受风险：outputDir 活动签名依赖文件数量、字节数和 mtime；极短间隔内可能受文件系统 mtime 精度影响。现有 heartbeat、no-progress 和总超时组合约束继续降低误判影响。
- 必须控制：不得把任意工作区文件变化计为进展，必须限定在 CommandGateway 调用传入的受控 `outputDir`。
- 必须控制：artifact/manifest 活动只能刷新 no-progress 进展，不得替代 heartbeat、总超时、人类 gate、PR/merge/release 控制。

