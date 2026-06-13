# Tekon Cockpit Web UI 技术方案

> 状态：正式技术方案  
> 创建日期：2026-06-12  
> 审阅版：`docs/technical/tekon-web-architecture.html`  
> 关联设计稿：`docs/design/tekon-cockpit-mockup.html`

## 1. 结论

本文定义 Tekon Cockpit Web UI 的下一阶段架构。目标不是重做一个营销式首页，也不是做远程多租户平台，而是把本地 Tekon run 的状态、证据、审批、PR 准备和 CI 结果放进一个可审阅、可操作、可验证的本地驾驶舱。

核心调整：

- **文档位置**：技术方案归档到 `docs/technical/`，HTML 审阅版同步生成。
- **安全边界**：删除自动下发 session token 的设计。Web 写操作继续要求用户显式提供 token；token 默认只进入内存，不写入 `sessionStorage`。
- **契约来源**：RPC 契约改为 schema-first。Zod schema 是运行时事实源，TypeScript 类型由 schema 推导。
- **范围口径**：不再宣称“一次性 CLI 完整覆盖”。新增 API 按 MVP、后续增强和暂不做分层列清。
- **审阅闭环**：Progress、readiness、gate、artifact、delivery、CI evidence 都作为 Web 的一等信息，而不是只展示 run status。
- **实施顺序**：先保行为重构和核心审阅路径，再扩展配置、评估和可视化。

事实：当前 `packages/web/src/client/App.tsx` 约 1040 行，`packages/web/src/server/api/root.ts` 约 1617 行；现有 Web 已支持概览、run 列表、artifact/gate/audit/review、human approval、受控 run、delivery prepare/create-pr 的基本路径。  
推断：继续在单文件 SPA 和单文件 API 上叠 UI 会放大回归风险，必须先收紧契约、拆分服务端和前端边界。  
建议：本文对应路线图 P2-B Web Cockpit V2 的详细技术方案，实施优先级仍以 `docs/superpowers/plans/2026-06-10-tekon-priority-roadmap.md` 为准；进入该阶段后按本文 Phase 0-5 实施，不把所有页面和所有 CLI 能力挤进第一轮。

## 2. 外部资料依据

| 资料 | 资料内容 | 对 Tekon 的判断依据 |
| --- | --- | --- |
| React Router 官方 `createBrowserRouter` 文档：`https://reactrouter.com/api/data-routers/createBrowserRouter` | `createBrowserRouter(routes)` 需要显式 route tree，可支持嵌套路由、错误边界和 data router 能力。 | Tekon Web 需要 URL 可分享、tab 可回退、页面级错误隔离，`react-router` v7 可以作为唯一新增运行时依赖。 |
| Zod 官方文档：`https://zod.dev/` | Zod 是 TypeScript-first schema validation library，提供 static type inference。 | RPC 不能从 TypeScript interface 反推运行时校验；应从 Zod schema 推导 TS 类型。 |
| OWASP HTML5 Security Cheat Sheet：`https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html` | 对浏览器端存储敏感信息给出安全风险提示。 | Web session token 不应自动下发并持久化到浏览器存储；写操作授权必须保持显式。 |
| OWASP Content Security Policy Cheat Sheet：`https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html` | CSP 是浏览器侧 defense-in-depth 控制。 | Tekon 应加 CSP 和文本预览转义，但不能把 CSP 当成 token 或路径边界的替代。 |

## 3. 产品边界

### 3.1 首屏必须回答的问题

Web Cockpit V2 的首屏服务于真实 run 的人工审阅，必须直接回答：

- 当前 run 到了哪一步。
- 哪个 gate 失败、跳过或等待人工确认。
- Provider 是谁，是否真实 provider。
- 当前 PR、CI、readiness 和 evidence 状态是什么。
- 下一步建议动作是什么，执行动作是否需要 token 和人工确认。

### 3.2 MVP 范围

MVP 只覆盖用户高频审阅和交付闭环：

| 路径 | 用户问题 | MVP 内容 |
| --- | --- | --- |
| Dashboard | 最近一次 run 是否可继续处理 | 项目概览、latest run、readiness、pending approval、PR/CI 摘要、下一步动作 |
| Runs | 我有哪些历史 run | run 列表、状态过滤、排序、provider、updatedAt、选中 run |
| Run Detail / Review | 这次 run 具体发生了什么 | Overview、Artifacts、Gates、Audit、Delivery、Progress tabs |
| Approvals | 哪些动作等我确认 | pending human decision、审批摘要、风险标签、批准/拒绝表单 |
| Delivery | PR 是否准备好，CI 是否已写回 | dry-run/prepare/create-pr/ci-status 的状态展示和受控入口 |
| Demand | 需求是否能进入 run | demand shape、approve、从已批准 shape 发起 run |

### 3.3 非目标

- 不做远程多租户认证、团队权限和组织级报表。
- 不自动 merge、不自动上线、不绕过 `delivery create-pr --approve-human`。
- 不提供任意本地文件浏览器。
- 不自动读取并下发 `.tekon/web-session.json` 里的 token。
- 不在第一轮实现 `ci-watch` 的长连接体验；MVP 只做 `ci-status` 单次查询和后续手动刷新。
- 不在第一轮实现 `eval work-usability record` 和 HTML report 生成；这些仍由 CLI 完成。

## 4. 目录结构

目标结构保持现有 `packages/web` 边界，不引入独立前端应用：

```text
packages/web/
├── src/
│   ├── shared/
│   │   ├── rpc-contract.ts      # Zod procedure specs，运行时契约事实源
│   │   ├── rpc-types.ts         # 由 specs 推导的 input/output 类型
│   │   └── api-types.ts         # Web DTO schema 和类型
│   ├── client/
│   │   ├── main.tsx             # createRoot + Providers + RouterProvider
│   │   ├── App.tsx              # createBrowserRouter 路由定义
│   │   ├── styles/
│   │   │   ├── tokens.css
│   │   │   ├── reset.css
│   │   │   └── utilities.css
│   │   ├── lib/
│   │   │   ├── rpc-client.ts
│   │   │   ├── query-cache.ts
│   │   │   ├── route-paths.ts
│   │   │   └── text-format.ts
│   │   ├── hooks/
│   │   │   ├── use-query.ts
│   │   │   ├── use-mutation.ts
│   │   │   ├── use-run-poller.ts
│   │   │   └── use-session-token.ts
│   │   ├── context/
│   │   │   ├── auth-context.tsx
│   │   │   └── flash-context.tsx
│   │   ├── layouts/
│   │   ├── pages/
│   │   └── components/
│   └── server/
│       ├── index.ts
│       ├── http.ts
│       ├── project-context.ts
│       └── api/
│           ├── root.ts          # 只组装 routers，目标约 80 行
│           ├── context.ts       # ServerContext
│           ├── dispatch.ts      # RPC dispatch + schema parse
│           ├── auth.ts          # token 校验、Origin/Fetch Metadata 校验 helper
│           ├── redaction.ts     # 展示 DTO 脱敏
│           ├── validators.ts
│           ├── server-helpers.ts
│           ├── agents.ts
│           ├── mappers.ts
│           └── routers/
│               ├── project.ts
│               ├── demand.ts
│               ├── delivery.ts
│               ├── artifact.ts
│               ├── gate.ts
│               ├── audit.ts
│               ├── review.ts
│               ├── progress.ts
│               ├── role.ts
│               ├── workflow.ts
│               ├── eval.ts
│               └── constraint.ts
```

判断：`shared/` 只允许被 client 和 server 同时 import；client 不能 import `server/`；server 可以 import `@tekon/core`。

## 5. 路由设计

新增唯一运行时依赖：`react-router` v7。

```typescript
import { createBrowserRouter } from 'react-router';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    errorElement: <RouteError scope="app" />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'runs', element: <RunsPage /> },
      {
        path: 'runs/:runId',
        element: <RunDetailPage />,
        errorElement: <RouteError scope="run" />,
        children: [
          { index: true, element: <OverviewTab /> },
          { path: 'artifacts', element: <ArtifactsTab /> },
          { path: 'gates', element: <GatesTab /> },
          { path: 'audit', element: <AuditTab /> },
          { path: 'delivery', element: <DeliveryTab /> },
          { path: 'progress', element: <ProgressTab /> },
        ],
      },
      { path: 'approvals', element: <ApprovalsPage /> },
      { path: 'delivery', element: <DeliveryPage /> },
      { path: 'demand', element: <DraftPage /> },
      {
        path: 'config',
        element: <ConfigPage />,
        children: [
          { index: true, element: <RolesTab /> },
          { path: 'workflows', element: <WorkflowsTab /> },
          { path: 'constraints', element: <ConstraintsTab /> },
        ],
      },
      {
        path: 'evaluations',
        element: <EvaluationsPage />,
        children: [
          { index: true, element: <ReadinessTab /> },
          { path: 'demand-shape', element: <DemandShapeTab /> },
          { path: 'approval-summary', element: <ApprovalSummaryTab /> },
          { path: 'workflow-selection', element: <WorkflowSelectionTab /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
```

URL 状态规则：

- 路径段承载页面和 tab：`/runs/:runId/gates`。
- 查询参数承载 filter/sort/selection：`/runs?status=running&sort=updated_desc`。
- 本地绝对路径不直接进入 URL；`shapePath` 等路径参数通过 server 校验后只展示 basename 或 repo-relative path。

## 6. 状态与缓存

| 状态层 | 存放位置 | 说明 |
| --- | --- | --- |
| URL 状态 | `useParams` / `useSearchParams` | runId、tab、filter、sort，可分享、可回退 |
| 服务端状态 | `QueryCache` | API 数据、in-flight 去重、手动 refetch、mutation 后 invalidation |
| UI 状态 | `useState` + Context | 表单、弹窗、toast、当前 token 输入 |
| Token 状态 | `AuthContext` 内存态 | 刷新即丢失；不落 `sessionStorage`；用户可从 `.tekon/web-session.json` 手动复制 |

### 6.1 QueryCache v1

QueryCache v1 只实现 MVP 所需能力：

- `get/set`
- per-key subscribe/notify
- in-flight promise 去重
- prefix invalidation
- manual refetch
- unmount 后丢弃结果

不在第一版承诺完整 stale-while-revalidate、重试队列、跨 tab 同步和持久化缓存。若实现超过约 220 行且仍需要复杂 stale 策略，再单独评估是否引入 TanStack Query；该评估不属于本方案 MVP。

### 6.2 Hook 规则

不能设计 `useApi().project.overview.useQuery()` 这种容易在对象方法中隐藏 hook 调用的模式。每个 query/mutation 使用独立 hook：

```typescript
export function useOverview() {
  return useQuery('project.overview', () => rpc.call('project.overview'));
}

export function useRunReview(runId: string | null) {
  return useQuery(
    runId ? `review.get:${runId}` : null,
    () => rpc.call('review.get', { runId: runId!, maxContentChars: 1600 }),
  );
}

export function useApproveGate() {
  return useMutation(
    (input: DecisionInput) => rpc.call('gate.approve', input),
    { invalidateKeys: ['gate.list', 'review.get', 'project.overview'] },
  );
}
```

## 7. RPC 契约

### 7.1 Schema-first

`src/shared/rpc-contract.ts` 是唯一契约事实源。TypeScript 类型从 Zod schema 推导，不手写重复 interface。

```typescript
import { z } from 'zod';

const tokenRunInputSchema = z.object({
  runId: z.string().min(1),
  token: z.string().min(1),
});

export const procedureSpecs = {
  'project.overview': {
    auth: 'none',
    input: z.undefined(),
    output: projectOverviewSchema,
  },
  'project.run': {
    auth: 'token',
    input: projectRunInputSchema,
    output: z.object({ run: apiRunSchema }),
  },
  'gate.approve': {
    auth: 'token',
    input: decisionInputSchema,
    output: z.object({ decision: apiDecisionSchema }),
  },
} as const;

export type ProcedureName = keyof typeof procedureSpecs;

export type RpcProcedureMap = {
  [P in ProcedureName]: {
    input: z.input<(typeof procedureSpecs)[P]['input']>;
    output: z.output<(typeof procedureSpecs)[P]['output']>;
  };
};
```

`dispatchApiCall` 必须做四件事：

1. 校验 path 存在。
2. 用 `procedureSpecs[path].input.parse(rawInput)` 校验输入。
3. 调用对应 router handler。
4. 在测试环境或开发模式校验 output，防止 server DTO 漂移。

### 7.2 API inventory

| Procedure | 当前实现 | 目标 MVP 授权 | 对应 CLI / Core | Web 说明 |
| --- | --- | --- | --- | --- |
| `project.list` | 已有，只读 | none | Web read API | 项目列表，本地单仓库主要用于兼容 |
| `project.overview` | 已有，只读 | none | Web read API | Dashboard 主数据 |
| `project.detail` | 已有，只读 | none | Web read API | Runs 列表 |
| `project.run` | 已有，token | token + confirm | `tekon run` | 发起受控 run，保留 dirty-base 显式确认 |
| `project.pause/resume/cancel` | 已有，token | token + confirm | `pause/resume/cancel` | pause/resume/cancel 都必须有明确按钮确认 |
| `project.clean` | 已有，token | token + high-risk confirm | `clean` | 删除 run 目录，高危确认必须单独测试 |
| `demand.shape` | 已有，token | token | `demand shape` | 写 `.tekon/demands/`，需要 token |
| `demand.approve` | 已有，token | token + confirm | `demand approve` | 批准需求卡 |
| `demand.detail` | 新增 MVP | none | `demand show` | 只读已校验 scope 的需求卡 |
| `artifact.list` | 已有，只读 | none + redaction | `review` / artifact store | 返回脱敏摘要和受限文本预览 |
| `gate.list` | 已有，只读 | none + redaction | `status` / `approval summary` | pending decision 和 gate 摘要 |
| `gate.approve/reject` | 已有，token | token + confirm | `resume --approve-human` / `approval reject` | 高风险人工控制入口 |
| `audit.list` | 已有，只读 | none + redaction | audit logger | hash chain、过滤、脱敏 payload |
| `review.get` | 已有，只读 | none + redaction | `review` | 聚合审阅面，所有文本 server-side redaction |
| `delivery.prepare` | 已有，token | token + confirm | `delivery prepare` | 生成本地 PR 包 |
| `delivery.createPr` | 已有，token + `approveHuman`，当前 UI 可单按钮传 true | token + high-risk confirm + explicit approval field | `delivery create-pr --approve-human` | push + 创建 PR，高危动作，UI 必须显示副作用文案 |
| `delivery.dryRun` | 新增 MVP | token | `delivery dry-run` | 可能执行 repo 检查，按写操作授权 |
| `delivery.ciStatus` | 新增 MVP | token | `delivery ci-status` | 查询并写回 `ci-status` artifact |
| `progress.list` | 新增 MVP | none | command progress JSON | 展示 run 关联 progress 摘要 |
| `role.list` | 已有，但当前会返回 `systemPrompt`，需整改 | none，只返回 id/name/summary | `role list` | Phase 0/1 必须改为不返回完整 system prompt |
| `role.detail` | 新增后续 | token + explicit reveal | `role show` | system prompt 默认不展开 |
| `workflow.list` | 已有，只读 | none | `workflow list` | 摘要 |
| `workflow.detail` | 新增后续 | none | `workflow show` | 展示 phases/nodes/gates，不暴露任意文件 |
| `workflow.preflight` | 新增后续 | token | `workflow preflight` | 可能执行命令解析，需授权 |
| `constraint.list` | 新增后续 | none + summary redaction | `constraints show` | 摘要化展示 hard/conditional/soft |
| `eval.readiness` | 新增 MVP | none | `eval readiness` | 对当前 run 重新计算或读取评估 |
| `eval.demandShape` | 新增后续 | none | `eval demand-shape` | 评估需求卡 |
| `eval.workflowSelection` | 新增后续 | none | `eval workflow-selection` | 评估 workflow 选择 |
| `eval.approvalSummary` | 新增后续 | none | `eval approval-summary` | 评估审批摘要 |
| `eval.workUsability` | 后续增强 | token | `eval work-usability --samples` | 第一轮不做 record/report |

判断：`ci-watch`、`work-usability record`、`work-usability report` 暂不进入 MVP。Web 若需要它们，必须另写小方案，因为它们涉及长轮询、样本文件写入和报告产物归档。

## 8. 安全与权限

### 8.1 Token 策略

事实：当前 `.tekon/web-session.json` 是本地 Web 写操作的 session token 来源。  
建议：Web 不提供 `GET /api/session` 读取 token。用户需要写操作时，从 `.tekon/web-session.json` 手动复制 token 到输入框。

客户端规则：

- token 存在 React Context 内存中，刷新页面后丢失。
- 不写 `localStorage`、不写 `sessionStorage`、不写 URL。
- mutation 请求体带 token；日志和 toast 不回显 token。
- 高危动作使用 `ConfirmButton` 二次确认，`delivery.createPr` 需要明确勾选人工批准。

服务端规则：

- 默认 host 为 `127.0.0.1`。
- 不设置 CORS 放开头。
- 对非 API 响应设置 CSP；生产默认禁止 inline script，目标为 `script-src 'self'`，Vite dev 模式如需放宽只能在 dev 生效。
- 对 mutation 请求检查 `Origin` / `Sec-Fetch-Site`，允许缺失这些 header 的本地 CLI/测试请求，但浏览器跨站请求必须拒绝。
- 请求体限制 1MB；超限返回 `BAD_REQUEST`。
- 所有 token 校验失败返回 `UNAUTHORIZED`，不泄漏期望 token。

### 8.2 展示脱敏

所有展示型 DTO 在 server 侧完成脱敏：

- 对 `apiKey`、`token`、`secret`、`password`、`passwd`、`pwd` 等键名做值替换。
- 对命令参数复用 core 里已有 command redaction 规则。
- 文本预览按纯文本渲染，禁止 `dangerouslySetInnerHTML`。
- 预览长度默认 1600 字符，用户可手动扩到 8000 字符；不提供任意路径读取。
- `role.detail` 的 system prompt 不进入 MVP；后续若做，默认只展示摘要，完整展开需要 token 和显式 reveal。

### 8.3 路径边界

任何路径输入都必须满足：

- `runId` 先通过 DB scope 校验，确认属于当前 `projectRoot`。
- demand shape 只能位于真实 `.tekon/demands/` 目录内，拒绝 symlink escape。
- artifact、gate output、progress path 只能来自 DB 或审计记录中的既有路径，不能由浏览器提交任意路径。
- 返回给 client 的路径优先使用 repo-relative path；绝对路径只在复制命令时出现。

## 9. Progress 与长任务体验

当前 long task 机制已经写入 `*.progress.json`，字段包含 `status`、`startedAt`、`updatedAt`、`lastOutputAt`、`elapsedMs`、`timeoutMs`、`noProgressTimeoutMs`、`timeoutReason`、stdout/stderr bytes、受控 outputDir 文件数量和 heartbeat 计数。

Web MVP 必须展示：

- 最近一次 progress 更新时间。
- 最近 stdout/stderr 活动时间。
- 最近 outputDir 活动时间。
- 是否接近 no-progress timeout。
- `timeoutReason` 是 `total` 还是 `no-progress`。
- 关联 command 的 redacted 展示。

Progress API 只读，不允许读取原始 stdout/stderr 全文。Gate log 和 artifact 正文仍通过既有 review surface 受限预览。

## 10. 服务端重构

Phase 0-1 以行为保持重构为主，但明确排除已列明的安全目标修复：`role.list` 摘要化、token 不自动下发、高危动作 confirm。Characterization tests 不能固化这些已知安全缺口。

拆分目标：

| 文件 | 责任 |
| --- | --- |
| `context.ts` | 创建 `ServerContext`，包含 db、repositories、audit、projectContext |
| `dispatch.ts` | RPC path 分发、schema parse、统一错误转换 |
| `auth.ts` | token 校验、browser origin/fetch metadata helper |
| `redaction.ts` | 展示 DTO 脱敏和文本预览限制 |
| `validators.ts` | 纯校验函数，不做业务查询 |
| `server-helpers.ts` | 组合查询 helper，避免循环依赖 |
| `agents.ts` | mock/claude-code/codex runtime 工厂 |
| `mappers.ts` | DB row 到 API DTO |
| `routers/*.ts` | 每个 namespace 一个 router，handler 签名统一 |

Router handler 统一签名：

```typescript
type Handler<I, O> = (ctx: ServerContext, input: I) => Promise<O> | O;
```

判断：`root.ts` 拆分后只负责创建 context、组装 routers、暴露 `createApiCaller()` 和 `close()`，不再混合 SQL、Agent runtime、校验和映射。

## 11. 前端页面

### 11.1 Dashboard

Dashboard 首屏只放决策信息：

- latest run status、provider、current node。
- readiness score 和 failed required checks。
- pending approvals 数量和最高风险项。
- delivery status、PR URL、CI status。
- next command / next Web action。

不放大面积热力图作为 MVP 首屏核心。真实样本数量不足前，热力图容易给出虚假的组织级洞察。

### 11.2 Run Detail

Run Detail tabs：

- Overview：review surface 摘要、readiness、evidence groups、next commands。
- Artifacts：按 node、role、type 过滤，展示脱敏预览。
- Gates：gate 网格、失败分类、重试建议。
- Audit：hash chain verification、事件过滤、脱敏 payload。
- Delivery：PR package、diff summary、PR URL、CI evidence。
- Progress：command progress 摘要和无进展风险。

### 11.3 Approvals

Approvals 是 Web 的高风险入口之一：

- 展示 `createHumanApprovalSummary()` 的摘要和 `evaluateHumanApprovalSummary()` 分数。
- 批准和拒绝都必须要求 token。
- 同一 run 多个 pending decision 时必须精确选择 decisionId。
- 批准后触发 resume 的事实必须在 toast 和 audit 列表中可见。

### 11.4 Delivery

Delivery 页面分成只读证据和写操作：

- 只读：当前 PR package、diff stat、changed files、PR URL、CI evidence。
- 写操作：dry-run、prepare、create-pr、ci-status。
- create-pr 永远要求 token 和人工批准，按钮文案必须明确会 push 分支并调用 GitHub CLI 创建 PR。

## 12. 错误处理

Route `errorElement` 只能覆盖路由渲染、loader/action 等错误，不能代替 mutation、poller、event handler 的错误处理。

错误策略：

- App 级 route error：显示可恢复错误页和返回 Dashboard。
- Page/tab 级 route error：只替换当前页面或 tab。
- Query error：`ErrorBanner` + `refetch`。
- Mutation error：表单内错误 + toast。
- Poller error：指数退避到最长 30 秒，并显示“最近刷新失败”。
- `window.onunhandledrejection`：记录到 console，UI 只显示通用错误，不泄漏敏感 payload。

测试必须覆盖：组件 throw、query reject、mutation unauthorized、poller 连续失败、404 route。

## 13. 构建与依赖

`packages/web/package.json` 的目标依赖快照如下；本阶段新增运行时依赖只有 `react-router`，`zod` 已存在并用于 schema-first RPC 契约。

```json
{
  "dependencies": {
    "@tekon/core": "workspace:*",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "react-router": "^7.6.0",
    "zod": "^4.4.3"
  }
}
```

`vite.config.ts` 增加 alias：

```typescript
resolve: {
  alias: {
    '@shared': resolve(__dirname, 'src/shared'),
    '@client': resolve(__dirname, 'src/client'),
  },
}
```

`http.ts` 变更：

- 增加生产构建 SPA fallback，非 `/api/` 路径返回 `dist/index.html`。
- 增加 JSON body size limit。
- 增加基础安全 header。
- 不增加 `GET /api/session`。

## 14. 测试与验收

### 14.1 测试策略

| 测试类型 | 覆盖 |
| --- | --- |
| Characterization API tests | Phase 0 冻结现有公开 RPC 的安全目标行为，不固化 `role.list` 返回 system prompt 等已知缺口 |
| Router handler unit tests | 每个 router 使用 mock `ServerContext` 覆盖成功和失败 |
| Contract tests | `procedureSpecs` 输入输出 schema、unknown path、错误码 |
| Security tests | token 不自动下发、Origin/Fetch Metadata、body limit、path escape、redaction |
| QueryCache tests | 去重、invalidate、unmount 丢弃、mutation 后刷新 |
| Component tests | StatusBadge、RunTable、ApprovalCard、ProgressPanel |
| Playwright E2E | Dashboard → Run Detail → Approval → Delivery Prepare/Create PR fake gh |
| Responsive visual check | 桌面和移动截图检查文本不重叠，核心 controls 可操作 |

### 14.2 MVP 验收标准

MVP 完成必须满足：

1. `pnpm --filter @tekon/web typecheck` 通过。
2. `pnpm --filter @tekon/web test` 通过。
3. `pnpm --filter @tekon/web test:e2e` 通过。
4. 页面刷新后 URL 中的 runId、tab、filter 保持。
5. 未输入 token 时所有写操作失败且错误可理解。
6. 页面代码无法通过 API 自动读取 token。
7. `role.list` 不返回完整 `systemPrompt`；只有后续 `role.detail` 在 token + explicit reveal 下才能展示完整内容。
8. artifact/gate/audit/review/progress 预览不渲染 HTML。
9. `clean`、`delivery.createPr` 等高危动作有明确 confirm 字段或确认文案测试。
10. `delivery.createPr` 在 fake gh E2E 中只有显式批准后才创建 PR。
11. HTML 审阅版和 Markdown 源稿同步更新。
12. 主用户手册仅在用户操作路径改变时更新；本方案阶段不改变启动命令和 token 来源，因此本次只需在最终交付说明中声明无需更新主手册。

## 15. 实施计划

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| Phase 0：行为快照 | 为现有 API 和 Web E2E 补 characterization tests，同时把 `role.list` 不返回 `systemPrompt`、token 不自动下发和高危 confirm 作为安全目标测试 | 当前 App 和 root 的保留行为被锁定，已知安全缺口不会被固化 |
| Phase 1：服务端拆分 | root.ts 拆成 context/dispatch/auth/redaction/mappers/routers，并完成 `role.list` 摘要化整改 | 老 App 继续工作，所有旧测试通过，`role.list` 不再泄露完整 prompt |
| Phase 2：RPC 契约和路由骨架 | `shared/rpc-contract.ts`、typed rpc client、React Router、AppLayout | 空壳页面可导航，schema parse 生效 |
| Phase 3：核心审阅页 | Dashboard、Runs、Run Detail Overview/Artifacts/Gates/Audit/Progress | 用户可回答“卡在哪、证据是什么、下一步做什么” |
| Phase 4：人工控制和交付 | Approvals、Delivery、Demand，补 delivery.dryRun/ciStatus，并为 clean/create-pr 等高危动作补明确 confirm 字段或确认文案校验 | approve/reject/create-pr/ci-status 全链路可测，高危动作不会被单按钮误触发 |
| Phase 5：配置和评估增量 | Config 摘要页、readiness/demand/workflow/approval eval 页 | 不暴露敏感原文，评估页能解释 pass/fail |

每个阶段结束都必须运行对应测试，并更新 HTML 审阅版。若阶段改动用户命令或 Web 使用方式，再同步更新 `docs/manual/tekon-user-manual.md` 和 HTML。

## 16. 风险与取舍

| 风险 | 判断 | 缓解 |
| --- | --- | --- |
| 自写 QueryCache 变复杂 | 当前 MVP 可控，但继续扩展会接近 TanStack Query 范围 | v1 限定能力；超过边界再单独决策 |
| read API 聚合敏感信息 | 本地工具也可能被浏览器扩展、XSS 或误展示影响 | server-side redaction、纯文本渲染、system prompt 不进 MVP |
| 服务端拆分引入行为回归 | root.ts 现有职责多，直接拆风险高 | Phase 0 行为快照先行，Phase 1 保行为 |
| Web 范围膨胀 | 一次性做完 eval/config/CI watch 会拖慢核心闭环 | MVP 聚焦 run 审阅、approval、delivery |
| progress path 读取不安全 | progress 文件是本地 FS 产物 | 只从 DB/audit/run 目录派生路径，拒绝浏览器任意路径 |

## 17. 当前不变项

- `docs/design/tekon-cockpit-mockup.html` 继续作为视觉设计稿。
- Web 启动方式仍以主用户手册为准。
- `.tekon/web-session.json` 仍由 `tekon init` 创建。
- Codex provider、provider snapshot、长任务 timeout 参数和 delivery create-pr 的人工边界沿用现有手册描述。
- 本方案不要求立即修改 `README.md`、`CHANGELOG.md` 或主用户手册；真正实现代码后再按用户可见行为变化同步。
