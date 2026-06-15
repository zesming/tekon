# 五方向改进实施方案

> 来源：codex --profile internal 深度分析（2026-06-15），结合外部调研（TanStack Query、OPA、Kubernetes admission、Temporal、飞书 Approval）

## 总体判断

Tekon 当前已经具备 CLI/Web、workflow、gate、role、audit 的核心闭环，但几个扩展点仍偏"内置硬编码"：Web cache key 分散，gate engine 集中分派，role/constraint policy 分散表达，CLI/Web runtime 工厂重复。建议先补测试与一致性，再做 registry/policy 抽象，避免在缺覆盖情况下重构核心执行路径。

---

## 1. Web Dashboard Query Cache Token Invalidation

**A. 现状**：缓存位于 `query-cache.ts`，`invalidate()` 只按 prefix 标记 stale，不清 data/inFlight。`useQuery` 已有组件级 `generationRef`/`abortRef`，但 `queryCache.set()` 会先写全局缓存，且 `rpc.call` 不接收 `AbortSignal`，token 切换时旧请求仍可能污染同 key 缓存。token 由 `auth-context.tsx` 写入模块级 RPC token，header 在 `rpc-client.ts` 注入。key 分散，例如 Dashboard、Delivery、RunDetail 各自拼字符串；mutation invalidation 也不完整。当前复杂度：cache 126 行、hook 174 行，问题不是体积，而是缺统一 key/schema。

**B. 调研**：TanStack Query 的核心做法是用 query key 标识缓存，变量变化应进入 key；mutation 成功后应显式 invalidate 相关 query。Tekon 不一定要引入 TanStack Query，但应借鉴"结构化 query key + mutation 事件化 invalidation"。

**C. 推荐方案**：新增 `packages/web/src/client/lib/query-keys.ts`，集中定义 `project.overview(authScope)`、`gate.list(runId, authScope)`、`review.get(runId, authScope)` 等；新增 `cache-events.ts`，提供 `runChanged(runId)`、`approvalChanged(runId)`、`deliveryChanged(runId)`。扩展 `QueryCache`：`clearAuthScoped(scope)`、`clearInFlight(predicate)`、`invalidateWhere(predicate)`，并把 auth-scoped entry metadata 写入缓存。`AuthProvider.setToken` 在 token 实际变化时生成 `authScope = hash(token|null)`，清旧 scope cache/inFlight；所有 session-auth 查询 key 带 `authScope`。预估改动 250-450 行，风险中等。

**D. 顺序**：先建 `query-keys.ts` 并替换读 key；再改 cache 清理能力；最后把 mutation 改成事件化 invalidation。

**E. 测试**：P0 QueryCache 单测覆盖 token scope clear、inFlight clear、旧 promise 不写新 scope。P0 hook 测试覆盖 token 切换后自动 refetch。P1 Playwright e2e 覆盖 Dashboard/Gates/Review token 切换一致性。

---

## 2. 缺失测试补充

**A. 现状**：`scheduler.ts` 仅 16 行，导出 `createPhaseSchedule`，无直接测试。`write-queue.ts` 18 行，已有最小顺序测试，但只覆盖成功串行，缺错误路径。覆盖薄弱的高复杂模块包括 `prompt-builder` 579 行、`rework` 549 行、`gate-runner` 457 行、`node-executor` 351 行、`lease-service` 174 行、`execution-plan` 131 行。

**B. 调研**：Vitest 已支持 V8 coverage；React Testing Library 推荐从用户行为角度测试组件。Tekon 可先用 coverage 做基线，不建议立刻设置全局硬阈值。

**C. 推荐方案**：
- P0：`scheduler.test.ts` — phase 顺序、节点过滤、节点顺序、空 phase、未知 phaseId
- P0：`write-queue.test.ts` — 不重叠执行、同步/异步返回值、sync throw 后续继续、async reject 后续继续、20 个并发严格顺序
- P1：`execution-plan.test.ts`、`gate-runner.test.ts`、`node-executor.test.ts`、`lease-service.test.ts`、`rework.test.ts`
- P2：`manifest-artifacts.test.ts`、`skill-loader.test.ts`、Web cache/hook 测试

**D. 顺序**：先 P0 小模块，给后续重构建立信心；再覆盖 gate/workflow 执行路径；最后补 Web client 测试配置与缓存测试。

**E. 测试策略**：新增测试必须先失败再实现；每个核心 bug/重构任务至少有单元测试，涉及 CLI/Web 行为时加 e2e。

---

## 3. 方向对齐：约束系统实现 & 角色 agent.yaml 扩展

**A. 现状**：约束逻辑集中在 `validator.ts`，`constraints.yaml` 只是 31 行规则说明源，不是运行时 DSL。`agent.yaml` schema 只支持 role/name/description/injectMode/priority/maxSkills/knowledgeFiles。角色枚举固定在 `domain.ts`。autonomy、risk、human approval、tool policy 目前分散在 role tool policy、CommandGateway、human gate、delivery `approveHuman`。

**B. 调研**：OPA 的模式是把 policy decision 从业务逻辑中解耦；Kubernetes admission webhook 把 mutating 和 validating 策略分开；飞书 Approval 可创建/查询审批实例。对 Tekon 的判断是：可借鉴策略引擎和外部审批入口，但审批事实源仍应保留在 Tekon 的 human decision/audit。

**C. 推荐方案**：新增 `RoleRuntimePolicy` 与 `RiskGatePolicy`。扩展 `agent.yaml` 且兼容旧格式：`autonomy.level: assist|review-gated|auto-pr|restricted`、`riskTolerance`、`requiresHumanApprovalFor`、`defaultTimeoutMs`、`allowedGateTags`。升级 `compileRoleToolPolicy` 为 runtime policy compiler，明确优先级：workflow gate 显式要求 > risk policy > agent.yaml > tools.yaml > CLI/Web runtime override。把 `constraints.yaml` 升级为有限 DSL。预估 600-1200 行，风险中高。

**D. 顺序**：先只扩 schema 和 compiler，不改变现有内置角色行为；再把 validator 硬编码规则迁入 DSL；最后接飞书通知/审批镜像字段。

**E. 测试**：old/new agent.yaml parse、非法 autonomy 拒绝、policy 优先级矩阵、constraints DSL parse/mutation、risk policy 矩阵。

---

## 4. Gate Engine 注册表模式重构

**A. 现状**：Gate 类型固定在 `domain.ts`。执行分派是 `gate/engine.ts` 的 if/else；command gate 集合写在 `gate/engine.ts`；role-scope 权限表写在 `gate/engine.ts`。文件 1100 行，已经成为扩展瓶颈。

**B. 调研**：Backstage extension points 用插件暴露可维护扩展点；Kubernetes admission control 区分内置控制器和运行时 webhook。Tekon 当前适合先做 internal registry，不宜直接上外部动态插件加载。

**C. 推荐方案**：新增 `packages/core/src/gate/registry.ts`，定义 `GateDefinition { type, category, tags, runner, metadata }` 和 `createBuiltInGateRegistry()`。metadata 包含 `commandLike`、`humanBlocking`、`supportsNotApplicable`、`requiredEvidence`、`sideEffect`、`riskTags`。`createGateEngine({ registry })` 通过 registry lookup 执行；`pre-pr-readiness`、`work-readiness` 改读 metadata。预估 700-1400 行，风险中高。

**D. 顺序**：Phase 1 做 registry 外壳，行为不变；Phase 2 迁移 command/security/schema/human runners；Phase 3 拆 semantic gates 到单文件；Phase 4 让 readiness/eval 消费 metadata。可与方向 3 并行设计，但 gate registry 应先落地。

**E. 测试**：registry lookup、unsupported gate、security-scan 不可 skip、human gate 仍创建 pending decision、每类内置 gate 与旧行为 parity、readiness metadata parity。

---

## 5. CLI/Web Adapter 代码去重

**A. 现状**：CLI 工厂 `agent-factory.ts` 245 行，Web 工厂 `agents.ts` 260 行，重复 provider 创建、snapshot 恢复、config summary、runtime override。Web gate router 又复制 resume/snapshot 逻辑。漂移已经出现：CLI 默认 approval 是 `on-failure`，Web 默认是 `on-request`；CLI run 传 `builtInRolesDir`，Web project.run 未传。

**B. 调研**：Temporal task queue 把任务路由与 worker 执行抽象分开；Stripe idempotency key 用于避免重试造成重复副作用。对 Tekon 的判断是：共享 runtime 工厂应只统一 provider/snapshot/权限默认值。

**C. 推荐方案**：新增 `packages/core/src/runtime/agent-runtime.ts`，导出 `createAgentRuntime`、`createAgentAdapterFromSnapshot`、`applyProviderRuntimeOverrides`、`summarizeAgentConfig`、`defaultProviderConfig`。CLI/Web 只保留参数解析、错误包装和 HTTP/CLI 文案。预估 400-800 行，风险中等。

**D. 顺序**：先抽 core runtime 并保持 CLI/Web 行为不变；再删除 Web gate router 重复 resume；最后评估是否统一 approval 默认值。

**E. 测试**：core runtime factory 单测、snapshot 损坏恢复失败、CLI/Web explicit config parity、Web resume/approval e2e。

---

## 建议实施顺序

1. **P0 测试补洞**：`scheduler`、`write-queue`、Web client test config
2. **Web cache token scope** 与 query key 工厂，解决真实用户可见的数据一致性问题
3. **CLI/Web agent runtime 去重**，先不改默认行为
4. **Gate Registry internal 化**，建立 gate 扩展边界
5. **RoleRuntimePolicy + RiskGatePolicy + constraints DSL**
6. **飞书通知/审批镜像接入**，只做入口与通知，不改 Tekon 审批事实源

**并行性**：方向 1 和方向 2 可并行；方向 5 可在方向 2 P0 后并行；方向 3 依赖方向 4 的 metadata 会更稳。方向 4/5 触达核心执行路径，实施前必须有新增测试和 subagent review。
