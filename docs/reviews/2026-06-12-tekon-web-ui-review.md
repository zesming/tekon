# Tekon Web UI 最新复审报告

审查日期：2026-06-12

审查对象：用户最新一轮修复后的 `packages/web` Web UI、HTTP/RPC/API、安全边界、E2E 覆盖，以及与 `docs/technical/tekon-web-architecture.md` 的符合度。

审查方式：只读代码审查、本地 fresh 验证命令、独立 subagent 全面复审。未修改 Web UI 代码。

## 1. 总体结论

当前版本基础验证全部通过，且上一轮多个关键缺口已有实质推进：

- `redactTextPreview` 不再使用旧的 `$& [REDACTED]`，直接文本中的 token/Bearer 泄露问题已有改善。
- `delivery.dryRun`、`delivery.ciStatus`、`progress.list` 已进入 `procedureSpecs`。
- `dispatchApiCall` 已返回 `spec.output.parse(result)`，`roleItemSchema` 也已移除 `systemPrompt`。
- 新增 Create PR 确认弹窗 E2E，Playwright 用例从 2 个增加到 4 个。
- `Sec-Fetch-Site` 校验、生产 HTML fallback 也已有实现和测试覆盖。

但按 `docs/technical/tekon-web-architecture.md` 的 MVP 验收口径，当前仍 **不能认定通过**。本轮未发现 P0，但仍有 4 个 P1 必须修复：

1. 展示 DTO 的 server-side redaction 仍不完整。
2. `delivery.dryRun` / `delivery.ciStatus` 只是补了入口，语义没有达到 MVP。
3. fake gh Create PR E2E 仍没有充分证明“只有显式批准后才创建 PR”。
4. `progress.list` 未覆盖架构要求的 progress 摘要。

## 2. 验证结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm --filter @tekon/web typecheck` | 通过 | TypeScript 编译检查通过，exit 0。 |
| `pnpm --filter @tekon/web test` | 通过 | Vitest 5 个测试文件、57 个测试通过。 |
| `pnpm --filter @tekon/web test:e2e` | 通过 | Playwright 4 个测试通过。 |

验证命令全部通过，说明当前版本具备基础可运行性和基础回归保护。但测试通过不等于安全边界、业务语义和架构验收全部达标，下面的 P1 仍需处理。

## 3. 已改善项

### 3.1 直接文本脱敏已有改善

相关位置：

- `packages/web/src/server/api/redaction.ts:25`
- `packages/web/src/server/api/redaction.ts:27`
- `packages/web/__tests__/api/redaction.test.ts:5`

现状：

- `redactTextPreview` 已覆盖 `Bearer ...`、`token=...`、`password: ...`、命令参数中的 `--token ...` 等直接文本场景。
- 新增 `redaction.test.ts`，覆盖 10 个脱敏用例。

仍需注意：

- 展示 DTO 全链路 redaction 仍不完整，详见 P1。

### 3.2 MVP API 名称已进入 RPC contract

相关位置：

- `packages/web/src/shared/rpc-contract.ts:631`
- `packages/web/src/shared/rpc-contract.ts:636`
- `packages/web/src/shared/rpc-contract.ts:688`
- `packages/web/src/client/pages/run-detail/ProgressTab.tsx:92`

现状：

- `delivery.dryRun`、`delivery.ciStatus`、`progress.list` 已进入 `procedureSpecs`。
- `ProgressTab` 已改为优先调用 `progress.list`，并用 `review.get` 做补充。

仍需注意：

- API 名称补齐不等于语义达标。`dryRun`、`ciStatus`、`progress.list` 仍有 P1 语义缺口。

### 3.3 output schema 已成为响应路径的一部分

相关位置：

- `packages/web/src/server/api/dispatch.ts:38`
- `packages/web/src/server/api/dispatch.ts:41`
- `packages/web/src/shared/rpc-contract.ts:402`

现状：

- `dispatchApiCall` 已返回 `spec.output.parse(result)`。
- `roleItemSchema` 已移除 `systemPrompt`，实际响应层不会再带出该字段。

仍需注意：

- Zod object 默认会丢弃未知字段，不会发现 handler 返回了多余字段。详见 P2。

### 3.4 Create PR 确认 E2E 已有初步覆盖

相关位置：

- `packages/web/__tests__/e2e/create-pr-approval.test.ts:122`
- `packages/web/__tests__/e2e/create-pr-approval.test.ts:243`

现状：

- 新增 E2E 覆盖 Create PR 确认弹窗。
- 覆盖取消弹窗和点击背景关闭弹窗场景。

仍需注意：

- 当前 E2E 还没有严密证明 fake `gh` 只有在显式确认后才被调用。详见 P1。

### 3.5 HTTP 安全和生产 fallback 有改善

相关位置：

- `packages/web/src/server/http.ts:141`
- `packages/web/src/server/http.ts:199`
- `packages/web/src/server/http.ts:241`
- `packages/web/__tests__/api/http.test.ts:73`

现状：

- mutation 请求增加了 `Origin + Sec-Fetch-Site` 检查。
- 生产 `vite:false` 路径开始尝试服务 `dist/index.html`。
- HTTP 测试新增 `Sec-Fetch-Site` 覆盖。

仍需注意：

- 生产静态资源路径边界和测试对 ignored `dist` 的依赖仍是 P2。

## 4. P1 必须修复项

### 4.1 展示 DTO 的 server-side redaction 仍不完整

严重级别：P1

相关位置：

- `packages/web/src/server/api/redaction.ts:7`
- `packages/web/src/server/api/mappers.ts:59`
- `packages/web/src/server/api/mappers.ts:155`
- `packages/web/src/server/api/routers/review.ts:23`

事实：

- `redactTextPreview` 的直接文本脱敏已改善。
- 但 `redactObject` 对普通字符串直接原样返回。
- `SENSITIVE_KEYS` 是大小写精确匹配。
- `artifact.summary`、`HumanDecision.note`、readiness/evidence、`nextCommands`、gate triage 等展示文本没有统一递归脱敏。

影响：

- `artifact.list`、`gate.list`、`audit.list`、`review.get` 仍可能从摘要、审批 note、audit payload、建议命令或 evidence 文案泄露 token、secret、Bearer 值。
- 不符合“所有展示型 DTO server-side redaction”的安全边界。

建议：

- 统一复用 core secret redaction / command redaction 能力，或在 Web API 层提供统一递归字符串 redaction。
- 对所有展示字符串递归调用脱敏，而不仅是显式 preview 字段。
- 将 `note`、`summary`、`evidence`、`nextCommands`、`suggestedCommand`、gate triage 纳入 API 测试。

### 4.2 `delivery.dryRun` / `delivery.ciStatus` 语义未达到 MVP

严重级别：P1

相关位置：

- `packages/web/src/server/api/routers/delivery.ts:77`
- `packages/web/src/server/api/routers/delivery.ts:124`
- `packages/core/src/delivery/pr-package.ts:77`

事实：

- `delivery.dryRun` 当前调用 `createPullRequestPreparation()`。
- `createPullRequestPreparation()` 会写 delivery-package artifact、`pr-package.md`、`pr-body.md` 和 audit。
- 这不是无副作用 dry-run。
- `delivery.ciStatus` 当前只读取 `delivery_pull_requests` 状态，并返回一个伪造的 `delivery` check。
- 当前没有调用 core 的远端 CI 查询能力，也不会写回 `ci-status` artifact。

影响：

- 用户点击 Dry Run 会改变运行证据。
- CI Status 页面展示的不是远端 CI 检查结果。
- readiness 无法拿到真实 `ci-status` evidence。

建议：

- `dryRun` 改为真正无副作用的 SCM dry-run / 预览路径；如果必须产生文件，应改名为 `prepare` 或在技术方案中明确其副作用。
- `ciStatus` 调用 core CI 查询能力，执行 fake/real `gh pr checks`，写回 `ci-status` artifact 和 audit。
- 补 fake gh API 测试，断言远端 CI 查询和 artifact 写回。

### 4.3 fake gh Create PR E2E 仍未充分证明显式批准边界

严重级别：P1

相关位置：

- `packages/web/__tests__/e2e/create-pr-approval.test.ts:185`
- `packages/web/__tests__/e2e/create-pr-approval.test.ts:207`

事实：

- 取消弹窗后只断言没有 UI 结果 banner。
- 确认时 `waitForResponse` 匹配任意 200 `/api/rpc`，没有过滤请求体 `path === 'delivery.createPr'`。
- 测试没有检查 fake `gh.log` 在取消、背景关闭、确认前为空。
- 测试也没有强断言确认后 fake `gh` 被调用。

影响：

- 如果首击 `Create PR` 已经触发 `delivery.createPr`，或测试捕获到其他 RPC 响应，该 E2E 仍可能通过。
- 技术方案 14.2 中“fake gh E2E 中只有显式批准后才创建 PR”的验收项没有被真正锁住。

建议：

- 在取消、backdrop dismiss、确认前分别断言 fake `gh.log` 不存在或为空。
- 确认时过滤 RPC 请求体，断言 `path === 'delivery.createPr'` 且 `input.approveHuman === true`。
- 确认后断言 fake `gh` 被调用、PR URL 出现、delivery 状态或 audit 记录更新。

### 4.4 `progress.list` 未覆盖架构要求的 progress 摘要

严重级别：P1

相关位置：

- `packages/web/src/server/api/routers/progress.ts:43`
- `packages/web/src/client/pages/run-detail/ProgressTab.tsx:143`
- `docs/technical/tekon-web-architecture.md` 第 9 节

事实：

- `progress.list` 当前只映射 node/status/started/updated/elapsed/timeout/heartbeat。
- 缺少最近 stdout/stderr 活动、outputDir 活动、接近 no-progress timeout 的风险判断。
- `timeoutReason` 只是字段读取，没有形成语义化展示。
- 关联 command 没有 redacted 展示。

影响：

- Progress 页仍不能回答第 9 节要求的关键问题：是否卡住、最近哪里有活动、是否接近无进展超时、当前命令是什么。

建议：

- 从 progress JSON 映射完整摘要字段。
- 明确只展示 stdout/stderr 活动元信息，不暴露全文。
- 展示 redacted command、last stdout/stderr activity、last outputDir activity、no-progress 风险和 timeout reason。
- 增加 progress API 和 UI 测试。

## 5. P2 风险项

### 5.1 output schema 仍不是 strict drift 检测边界

严重级别：P2

相关位置：

- `packages/web/src/server/api/dispatch.ts:38`
- `packages/web/src/shared/rpc-contract.ts:402`

事实：

- `dispatchApiCall` 现在返回 `spec.output.parse(result)`。
- `roleItemSchema` 已移除 `systemPrompt`。
- 但 Zod object 默认会丢弃未知字段，不会让测试或开发环境发现 handler 返回了多余字段。

影响：

- 实际响应安全性已收紧，但“防止 server DTO 漂移”的契约目标仍偏弱。

建议：

- 对公开 DTO schema 使用 `.strict()` 或 `z.strictObject()`。
- 增加 contract regression test，覆盖 handler 返回多余敏感字段时会失败。

### 5.2 生产静态资源服务缺少路径边界，且测试依赖 ignored `dist`

严重级别：P2

相关位置：

- `packages/web/src/server/http.ts:59`
- `packages/web/__tests__/api/http.test.ts:18`
- `.gitignore:3`

事实：

- 静态资源服务使用 `resolve(distDir, request.url.slice(1))` 后，没有校验 resolved path 仍在 `distDir` 内。
- `dist/` 被 git ignore。
- `http.test.ts` 的生产 fallback 测试依赖当前工作区已有的 ignored `packages/web/dist/index.html`。

影响：

- 静态资源路径边界不够硬。
- 干净 checkout 中直接跑 Web tests 可能因没有 dist 而失败。

建议：

- 解码并规范化 URL path，拒绝 `..`，校验 resolved path 前缀仍在 `distDir` 内。
- 测试内临时构造 dist fixture，或让测试显式先 build。

### 5.3 审阅报告已更新为本轮结论

严重级别：P2

相关位置：

- `docs/reviews/2026-06-12-tekon-web-ui-review.md`
- `docs/reviews/2026-06-12-tekon-web-ui-review.html`

事实：

- 上一版报告已过期。
- 本报告已更新为最新一轮复审结果。

建议：

- 交付前继续确认 Markdown 与 HTML 同步。

## 6. 对 14.2 MVP 验收标准的符合度

| 验收项 | 当前状态 | 说明 |
| --- | --- | --- |
| `pnpm --filter @tekon/web typecheck` 通过 | 通过 | 已验证。 |
| `pnpm --filter @tekon/web test` 通过 | 通过 | 已验证，57 tests passed。 |
| `pnpm --filter @tekon/web test:e2e` 通过 | 通过 | 已验证，4 Playwright tests passed。 |
| 页面刷新后 URL 中 runId、tab、filter 保持 | 部分需继续审查 | 当前未作为本轮主要缺口，但仍建议保留覆盖。 |
| 未输入 token 时所有写操作失败且错误可理解 | 基本通过 | Token hint 和 Create PR 禁用已有覆盖。 |
| 页面代码无法通过 API 自动读取 token | 未发现违反 | 未发现自动下发 token 接口。 |
| `role.list` 不返回完整 `systemPrompt` | 基本通过 | Router 与响应层已修；strict drift 检测仍可加强。 |
| artifact/gate/audit/review/progress 预览不渲染 HTML | 不通过 | 展示 DTO redaction 仍不完整。 |
| `clean`、`delivery.createPr` 等高危动作有明确 confirm | 部分通过 | API 和 UI 有确认，但 fake gh E2E 证明仍不够硬。 |
| fake gh E2E 中只有显式批准后才创建 PR | 不通过 | E2E 仍未严密检查 fake `gh.log` 和 `delivery.createPr` 请求体。 |
| HTML 审阅版和 Markdown 源稿同步 | 本报告已同步更新 | 仍需交付前验证。 |
| 主用户手册按操作路径变化更新 | 待决策 | 若本轮 Web UI 作为正式交付，需要同步用户手册。 |

## 7. 建议修复顺序

1. 先补展示 DTO 全链路 redaction，覆盖所有展示字符串和建议命令。
2. 修 `delivery.dryRun` 语义，避免 dry-run 写 artifact/audit；或调整命名和技术方案。
3. 修 `delivery.ciStatus`，调用真实 core CI 查询并写 `ci-status` artifact。
4. 加硬 Create PR E2E：检查 fake `gh.log`、请求体 `path/input.approveHuman`、PR URL/audit。
5. 补完整 `progress.list` 摘要字段和 UI 展示。
6. 将公开 DTO schema 改为 strict，并补 DTO drift regression test。
7. 加固生产静态资源路径边界，移除测试对 ignored `dist` 的隐式依赖。
8. 修完后同步主用户手册和本审阅报告。

## 8. 最终判断

当前版本已经具备较好的基础可运行性：`typecheck`、单测和 E2E 都通过，并且上一轮 P1 多数有实质推进。

但从 Tekon 的架构目标看，还不能只按“测试全绿”放行。剩余问题集中在生产语义和安全边界：redaction 是否覆盖所有展示 DTO、dry-run 是否真的无副作用、CI status 是否是真实远端证据、Create PR 是否真的只有显式批准后才执行、Progress 是否能判断长任务是否卡住。

因此，本轮结论是：**P0 未发现，但 MVP 仍不通过；需先修 4 个 P1。**
