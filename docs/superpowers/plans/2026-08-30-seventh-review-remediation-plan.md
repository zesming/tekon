# 第七轮复审整改执行方案（2026-08-30）

- **对应报告**：`docs/reviews/2026-08-30-tekon-human-first-harness-seventh-review.md` 第 14 节批注
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **基线**：`4c4197d`（review/human-first-harness-2026-08-28）
- **版本**：`0.17.0` → `0.18.0`（新增功能 + 行为变化，MINOR）
- **范围原则**：只落地可独立验证、不改变架构基线的条目；P0-ARCH-01/03、P0-PRODUCT-01、P1-DATA-01、P1-A11Y-01 维持"仍未关闭"裁决，留给后续架构 PR。

## 1. P1-PRODUCT-03：统一 workflow template catalog

**产品细节**：Web 高级表单与 CLI `workflow list` 展示同一组模板（6 个 built-in + 项目模板）；下拉选项的标识与后端加载标识一致，用户选中的模板一定可执行。

**设计细节**：
- Core 新增 `listWorkflowCatalog(options?: { projectWorkflowsDir?: string }): WorkflowCatalogEntry[]`，每项 `{ id, name, builtin, path? }`。`id` 一律取文件名（不含扩展名），不再使用 YAML 内部 `id` 字段作为标识；项目模板与 built-in 同名时项目模板覆盖。
- CLI `workflow list` 改为消费 catalog，输出保持每行一个 id（去重后排序）。
- Web `workflow.list` 改为消费 catalog（ServerContext 已知 project workflowsDir）。

**实现细节**：
- `packages/core/src/workflow/template.ts`：新增 catalog 函数，复用 core 私有 `getWorkflowsDir`（template.ts:487，dist 相对路径已验证可解析到仓库 `workflows/`）与文件名扫描逻辑。
- `packages/core/src/index.ts`：导出新函数与类型。
- `packages/cli/src/lib/utils.ts:79` 的 `getBuiltInWorkflowsDir`/`listWorkflowNames` 与 `packages/cli/src/commands/workflow.ts:114`：改为消费 core catalog，消除 CLI 与 core 两份并行扫描逻辑。
- `packages/web/src/server/api/routers/workflow.ts:69`：`listWorkflows` 替换为 catalog 消费，删除本地 `extractYamlScalar` 逻辑。

**测试**：
- Core unit：catalog 合并 built-in + 项目、同名覆盖、id 等于文件名、goal 模板包含。
- CLI unit：`workflow list` 输出含 built-in 名称。
- Web API test：`workflow.list` 返回含 built-in 条目且 id 可被 `workflow.plan` 加载。
- E2E：高级表单选择 `bugfix` 模板成功启动（新增断言）。

## 2. P1-UX-01 + P1-PRODUCT-02：高级入口 fail-closed 与 plan digest 绑定

**产品细节**：高级表单在计划服务失败时明确提示"无法读取执行计划，已阻止启动"并禁用提交；用户批准的计划与实际执行的计划通过 digest 绑定，不一致时拒绝启动。

**设计细节**：
- 定位说明：本项是"输入一致性 + 模板漂移检测"的有界版本，不等于报告 12.D.1 的 immutable run-plan snapshot；不关闭 P1-PRODUCT-02 主体，只消除"预览与运行之间模板文件被改动/参数被篡改"的缺口。
- `runPlanSchema` 增加 `digest: string`（对规范化 plan JSON 做 SHA-256，服务端生成）。
- `projectRunInputSchema` 增加 `planDigest: string`（Web 启动时回传 plan 返回的 digest）。
- `project.run`：当传入 `planDigest` 时，用相同参数重新生成 plan 并计算 digest，不一致则 `ApiError('PLAN_DIGEST_MISMATCH')`；未传时维持现状（CLI 路径不受影响）。
- goal 模式不参与 digest 绑定：goal 分支不走 `projectRunPlan`（project.ts:170,207），UI 侧 goal 模式不回传 `planDigest`，服务端 goal 分支忽略该字段。
- StartRunForm：`planError` 时渲染 `role="alert"` 错误 + 重试按钮；`isSubmitDisabled` 增加 `!planData || Boolean(planError)`。

**实现细节**：
- `packages/core/src/workflow/run-plan.ts`：新增 `computePlanDigest(plan)`（canonical JSON + sha256），`projectRunPlan` 返回值附带 digest。
- `packages/web/src/shared/rpc-contract.ts:52,603`：schema 变更。
- `packages/web/src/server/api/routers/project.ts` run handler：digest 校验。
- `packages/web/src/client/components/runs/StartRunForm.tsx:197,341`：fail-closed UI。

**测试**：
- Core unit：digest 对相同 plan 稳定、对字段变化敏感。
- Web API test：digest 不匹配拒绝、匹配通过、未传 digest 维持现状。
- Web unit/E2E：plan 失败时提交禁用且错误可见。

## 3. P1-DSH-01：生产 capability preflight

**产品细节**：使用 dsh provider 启动前，除版本外还验证 headless help 合同与默认配置插件组合；任一不满足则 fail-closed，不进入执行。

**设计细节**：
- `createDshHeadlessAdapter` 增加 `ensureCapabilityGate()`：在 version gate 之后执行 `assertDshHeadlessHelpContract` 与 `assertDshDefaultConfigContract`（复用 `dsh-bridge-probe.ts` 现有函数），结果一次性缓存。
- 未配置真实 dsh（`realDsh` 为空）时跳过，与现有 version gate 行为一致；配置了 dsh 但 probe 失败时 `runAgent` reject。

**实现细节**：
- `packages/core/src/runtime/dsh-headless-adapter.ts:228` 附近扩展 `ensureCapabilityGate()`。
- 现有 `assertDshHeadlessHelpContract`/`assertDshDefaultConfigContract`（dsh-bridge-probe.ts:116/132）只接收字符串、不 spawn；需新增 `probeHelp`/`probeConfig` spawn 逻辑（`dsh --profile headless --help`、`--dump-default-config`），并像 `probeVersion`（dsh-headless-adapter.ts:207,225）一样提供测试注入 hook，使单测无需真实 dsh。
- gate 结果一次性缓存（与 version gate 同生命周期），确保只执行一次。

**测试**：Core unit：probe 失败时 `runAgent` reject 且不执行 agent；probe 成功时正常通过；gate 只执行一次。

## 4. P1-UX-02：连接健康 RPC 与 TopBar 真实状态

**产品细节**：TopBar 徽标反映的是 Tekon 会话凭据（session token）的真实有效性，而不是只凭 token 非空；provider 可用性作为附加维度展示，不覆盖凭据状态。

**设计细节**（按评审 MUST-4 修正：health 以 token 握手/有效性为主轴）：
- 新增 `project.health` RPC：返回 `{ credential: 'not-configured'|'valid'|'invalid', checkedAt, detail?, provider?: 'unavailable'|'available' }`。
- `credential` 判定：未配置 token → `not-configured`；已配置则执行一次服务端真实校验（复用 `packages/web/src/server/api/common.ts:6` 的 token 比对逻辑做一次受控握手调用），token 不匹配/过期 → `invalid`，通过 → `valid`。结果缓存 60s。
- `provider` 为附加维度：对已配置 provider 执行轻量 probe（dsh `--version`），仅在 `credential=valid` 时展示，不允许把 `credential=invalid` 覆盖成"健康"。
- TopBar 消费 `project.health`，文案与可访问名称：`连接凭据：未配置` / `连接凭据：有效` / `连接凭据：无效`（provider 不可用时附加提示，不改变凭据结论）。

**实现细节**：
- `packages/web/src/shared/rpc-contract.ts`：新增 health 契约。
- `packages/web/src/server/api/routers/project.ts`：health handler + 缓存。
- `packages/web/src/client/layouts/TopBar.tsx:81,140`：状态消费。
- E2E 断言迁移到新文案（通过 locator helper）。

**测试**：Web API test（not-configured/valid/invalid 三态 + provider 附加维度不覆盖凭据结论）、E2E（TopBar 有效/无效展示）。

## 5. P1-UX-03：长 Session 数据链路有界

**产品细节**：长会话不再随历史线性增长网络与内存；初次加载最近一页，更早历史按需分段加载。

**设计细节**（按评审 MUST-1/2/3 修正）：
- 不修改 `listEventsSince` 签名（它被 sse.ts:116 及 30+ 处当数组消费）。新增 `listEventsPage(sessionId, sinceSeq, limit)`；复用已存在的 `latestSeq(sessionId)`（session-store.ts:100/462）初始化尾窗 cursor，不新增同义方法。
- SSE 区分两种入口：
  - **fresh connect（无 Last-Event-ID）**：先读 `latestSeq`，把 `cursor` 初始化为 `max(0, latest - REPLAY_WINDOW)`，只 replay 最近 N 条尾窗（有界）。
  - **带 Last-Event-ID 的重连**：仍从 `k` 连续补齐，catch-up 定时器按 `limit` 分片推进，保证 `[k..end]` 无丢无重，不受尾窗限制。
- 客户端 `useSessionStream`：状态只保留最近窗口（如 1000 条），提供"加载更早"分段拉取（`session.events` 分页 API，走 `listEventsPage`）。

**实现细节**：
- `packages/core/src/session/session-store.ts:451`：新增 `listEventsPage`，`listEventsSince` 与 `latestSeq` 不动。
- `packages/web/src/server/sse.ts:47`：fresh connect 尾窗初始化 + 重连连续补齐。
- `packages/web/src/client/hooks/use-session-stream.ts:49`、`lib/session-stream.ts:212`：窗口化。
- `packages/web/src/server/api/routers/session.ts`：events 分页参数。

**测试**：Core unit（page limit/hasMore、latestSeq）、SSE test（fresh connect 只 replay 尾窗、带 Last-Event-ID 重连无丢无重）、E2E（超过窗口的会话只渲染窗口、可加载更早）。

## 6. P1-DOC-01：手册 Node 版本一致性

**产品细节**：用户手册与 package/installer/README 的 Node 合同一致。

**实现细节**：
- `docs/manual/tekon-user-manual.md:167` 与 `.html:411`：`node (>=18)` → `node（^20.19.0 或 >=22.12.0）`。
- 新增 root 级一致性测试 `__tests__/manual-node-range.test.ts`：断言手册 md/html 不含 `>=18` 且包含 `20.19.0`。

**测试**：新增一致性测试本身。

## 7. P2-TEST-01：E2E locator helper

**产品细节**：稳定控件文案单点维护，文案变更不再击穿整套 E2E。

**设计细节**：
- 新建 `packages/web/__tests__/e2e/helpers/locators.ts`：导出稳定文案常量（`CREDENTIAL_HEALTHY` 等，随第 4 项更新）与 role/name 定位 helper（`credentialStatus(page)`、`acknowledgeFailedButton(item)`）。
- 替换 8 个文件中的复制文案为 helper 引用。

**测试**：替换后全套 Web E2E 通过即验证。

## 8. P0-ARCH-02：shutdown hard deadline 与 interrupted 状态

**产品细节**：服务关闭不会被不合作的 executor 永久挂住；被中断的 job 持久标记为 `interrupted`（可恢复语义），不再静默归入 `cancelled`。

**设计细节**：
- `jobStatusSchema` 增加 `interrupted`，并加入 `SETTLEABLE_STATUSES`（job-runner.ts:114）。
- Phase 3 增加 hard deadline：`Promise.race([Promise.allSettled(pending), deadline(stopHardTimeoutMs)])`，默认 10s。
- Shutdown escalation 时对未结算 job 持久写入 `interrupted`（区别于用户主动 cancel）。
- 显式修改 `isJobCancellationAbort` 语义（job-runner.ts:22）：新增 `JOB_ABORT_REASON_SHUTDOWN`，shutdown 路径（job-runner.ts:577）改用 `controller.abort(JOB_ABORT_REASON_SHUTDOWN)`，使 `isJobCancellationAbort` 对 shutdown abort 返回 false；新增 `isJobShutdownAbort(signal)` 判定。
- executor 层同步处理（评审第二轮 P1）：
  - `workflow-job-executor.ts:188,235` 消费 `isJobCancellationAbort` 决定返回状态与 session `turn/end {cancelled}`；shutdown abort 时返回 `interrupted`，不误发 `cancelled` 的 turn/end、不误置 session 为 cancelled。订正 rationale：若不加分支，shutdown 时 workflow 状态为 `interrupted`，会落 `switch` 的 `case 'interrupted'`（workflow-job-executor.ts:266）把 session 误置 failed、job 误置 failed 并发 `agent/error`，而非落入 `default`。
  - `node-executor.ts:230,309,353` 三处消费 `isJobCancellationAbort` 并在取消时 `writeWorkflowTerminal(runId, 'cancelled')`；由于 `isJobCancellationAbort` 语义修改后对 shutdown 返回 false，这三处的 else 分支本就写 `updateWorkflowInstanceStatusIfActive(runId, 'interrupted')`，shutdown 会自然落到 `interrupted`，无需逐点改，但这三点必须纳入回归测试断言。
  - **engine.ts 两处 abort 边界（第三轮复查 P1-A，最常见 shutdown 路径）**：`engine.ts:415-421`（node 边界）与 `:460-465`（全部节点后）检查 `options.signal?.aborted`，只特判 `isJobOwnershipLostAbort`，其余一律 `settleCancelled` → `writeWorkflowTerminal(runId,'cancelled')`（engine.ts:494-499）。shutdown Phase 2 在 node 边界 abort 是最常见路径，会先于 node-executor 把 workflow 持久写成 `cancelled`，使本项目标失效。修复：这两处在 `isJobShutdownAbort(options.signal)` 时复用 `updateWorkflowInstanceStatusIfActive(runId, 'interrupted', nodeId)`（repositories.ts:437，带 `status not in (terminal)` 守卫，recovering owner 已终态时自然 no-op），**不要**沿用 `settleCancelled`/`writeWorkflowTerminal` 类比（`writeWorkflowTerminal` 类型签名排除 `interrupted`，state-machine.ts:154 中 `interrupted` 非终态）。三分流：ownership-lost 站下不写、shutdown 写 interrupted、用户 cancel 写 cancelled。
  - `automation-job-executor.ts:147` 现状是 catch 块对任何 error 一律返回 `{ status: 'failed' }`，不消费 `isJobCancellationAbort`；本项为其新增 shutdown 分支：`isJobShutdownAbort` 时返回 `interrupted` 而非 `failed`。

**实现细节**：
- `packages/core/src/types/session-contract.ts:90`：状态枚举。
- `packages/core/src/session/job-runner.ts:22`（`isJobCancellationAbort` 语义 + `isJobShutdownAbort`）、`:577`（abort reason）、`:594`（hard deadline）、`:212`（settle 语义）。
- `packages/core/src/session/workflow-job-executor.ts:188,235,266`、`packages/core/src/workflow/node-executor.ts:230,309,353`、`packages/core/src/session/automation-job-executor.ts:147`：shutdown abort 分支。
- `packages/core/src/session/session-store.ts`：interrupted 持久化路径（`settleOwnedJob` 取消优先子句不会覆写，因为 shutdown 不设 `abort_state='requested'`）。

**测试**：扩展 `job-runner-stop-race.test.ts`：不合作 executor 下 stop 在 hard deadline 内返回；shutdown 后 job 为 `interrupted`；用户 cancel 仍为 `cancelled`；shutdown 中在途 workflow 的 executor 返回 `interrupted` 且 session 不被误置为 `cancelled`、不误发 `turn/end {cancelled}`；node-executor 三点在 shutdown 时把 workflow 落为 `interrupted` 而非 `cancelled`；engine 在 node 边界 shutdown 中断时 workflow 持久为 `interrupted` 而非 `cancelled`；automation executor 在 shutdown 时返回 `interrupted` 而非 `failed`；三类 abort（用户 cancel / ownership-lost / shutdown）分流不串。

## 9. 文档与版本同步

- `package.json`：`0.17.0` → `0.18.0`。
- `CHANGELOG.md`：记录用户可见变化（template catalog、plan digest、health、有界会话、preflight、shutdown 语义、手册修正）。
- `README.md`、`docs/manual/tekon-user-manual.md/html`：按需同步。
- `docs/reviews/current.md`：更新本轮整改结论与仍未关闭项。

## 10. 评审修订记录

- **r1（2026-08-30）**：最高思考等级 reviewer 首轮评审提出 5 项必须修复，已全部并入本方案：
  - MUST-1：`listEventsSince` 不改签名，新增 `listEventsPage`（复用 `latestSeq`）；
  - MUST-2：SSE fresh connect 用 `latestEventSeq` 初始化尾窗 cursor，避免取到"最早 N 条"；
  - MUST-3：区分 fresh connect 尾窗与 Last-Event-ID 重连续传（分片不丢）；
  - MUST-4：`project.health` 以 token 握手有效性为主轴，provider 探测仅为附加维度；
  - MUST-5：shutdown abort 语义覆盖 `workflow-job-executor.ts`/`automation-job-executor.ts`，新增 `isJobShutdownAbort`。
  - 建议项 SUG-1/2/3/4 一并吸收（digest 定位说明、goal 不参与绑定、probe spawn 注入点、catalog 归并到 core）。
- **r2（2026-08-30）**：第二轮复查确认 MUST-1/2/3/4 与 SUG-1/2/3/4 已解决；追加修复：
  - P1：Item 8 显式声明修改 `isJobCancellationAbort` 语义（新增 `JOB_ABORT_REASON_SHUTDOWN`），把 `node-executor.ts:230,309,353` 三处纳入受影响面与回归测试；
  - 订正 Item 8 对 `automation-job-executor.ts` 的描述（现状返回 `failed`、不消费 `isJobCancellationAbort`），据实说明新增 shutdown 分支；
  - P2：Item 5 复用既有 `latestSeq`，不新增 `latestEventSeq`。
- **r3（2026-08-30）**：第三轮复查追加修复：
  - P1-A：Item 8 纳入 `engine.ts:415-421/460-465` 两处 abort 边界检查，shutdown 时写 `interrupted`，与 ownership-lost/用户 cancel 三分流；
  - 订正 `automation-job-executor.ts` 行号（126→147）、workflow-job-executor rationale（落 `case 'interrupted'` 而非 `default`）、job-runner 行号（575→577、213→212）；
  - 统一 `latestEventSeq`→`latestSeq` 命名漂移。

## 11. 验证顺序

1. `corepack pnpm -r typecheck`
2. `corepack pnpm test`（含新增 unit/一致性测试）
3. `corepack pnpm --filter @tekon/web exec playwright test`（全套 E2E）
4. `corepack pnpm --filter @tekon/web build`
5. UI 抽查：TopBar 健康状态、高级表单 plan 错误态、长会话窗口、模板下拉。
6. reviewer code review → 修复 → 复查。
7. reviewer 按报告第 14 节逐条核对完成情况。
8. 提交到 PR #11，清理临时产物。
