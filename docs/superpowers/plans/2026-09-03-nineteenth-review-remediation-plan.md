# 第十九轮复审整改执行方案（2026-09-03）

> 依据：`docs/reviews/2026-09-03-tekon-product-runtime-harness-nineteenth-review.md`。
> 范围：PR #11 内只关闭可独立验证的 telemetry、Advanced Run 准入测试和正式交付缺口；架构主线继续拆独立 PR。

## 1. 目标与裁决

本方案验收后应完成以下事项：

1. DSH 正式 Run 与 metadata preflight 均明确硬关断内置 session telemetry；
2. Advanced Run 的提交门成为可单测的纯状态选择器，并用同步 latch 防止同一页面内重复提交；
3. 第一批交付同步用户手册（Markdown/HTML）、CHANGELOG 与四包版本号（v0.20.5）；
4. 第二批交付补齐第十九轮复审报告（Markdown 视角批注与完整 HTML 审阅版）、`current.md` 与 PR 元数据；
5. `project.clean` 的即时风险拆为独立 issue #33，完整生命周期继续由 #18 承载。

当前 PR 不实现 daemon、authoritative Session、Run admission saga、ACP、RunPlan schema、完整 purge、DSH alpha.5 升 pin、共享 admission UI 大重构或新的 capability DSL。

## 2. 产品与设计细节

### 2.1 DSH 内置 session telemetry 边界

- 正式 Run 子进程保持 `envMode: exact` 与显式白名单；
- metadata probe 保留 `PATH`、`DSH_HOME` 等运行环境，但删除宿主环境（ambient）中的 `DSH_TELEMETRY_MODE` 与 `DSH_TELEMETRY_OTLP_URL`，并固定设置 `DSH_TELEMETRY_DISABLED=1`；
- 该策略只作用于 Tekon 启动的 DSH 子进程，不修改用户宿主环境中独立运行的 DSH；
- 上游对任意非空 `DSH_TELEMETRY_DISABLED` 都视为关闭，固定 `1` 是 Tekon 的规范化表达，不代表宿主环境中的 `0` 会开启 telemetry；
- 事实澄清：在 alpha.3 中，`--version` 与 `--dump-default-config` 为 boot-free，但 `--profile headless --help` 会进入 profile/plugin boot；无证据表明此前发生外传，但不能用不 boot 排除风险，故 preflight 改动属于纵深防御（defense-in-depth），不表述为已发生的数据外传修复；
- 独立凭证风险：worktree 中的 `.env` 凭证回退读取仍是独立安全风险，不因遥测配置关闭而消除（宿主环境继承不等于凭证隔离）。

### 2.2 Advanced Run 准入与交互

提交门只返回阻断原因，不承载文案或发展为通用 DSL。优先级固定为：

```text
no-token
> submitting
> plan-loading
> plan-error
> no-plan
> no-demand
> draft-not-ready
> missing-plan-digest
> network-unacknowledged
```

组件继续使用既有中文提示和 plan error/digest 重试 UI。空需求的初始状态只禁用按钮，不主动显示警告；程序化绕过时仍由 handler 防御性提示。

重复提交保护使用同步 `useRef` latch：所有校验通过后、调用 mutation 前置位，`finally` 释放。React `isPending` 仅负责视觉与禁用状态，不能独立证明同一 tick single-flight。

### 2.3 `project.clean` 分拆

Issue #33 职责：仅负责在完整生命周期方案前关闭活动期误删入口，首选暂停所有物理删除。即使认证、confirm、格式与 scope 校验均通过，也暂停物理删除，并在返回拒绝前写入不含 token 的 Audit；未认证、非法或越权请求不向目标 Run 写 Audit。

Issue #33 不宣称 lifecycle-safe。完整 export、compaction、retention、tombstone、路径修正和事务/补偿仍归 #18。

## 3. 实现细节

### 3.1 Core

- `dsh-bridge-probe.ts` 在 `runDshPreflight()` 入口构造一次 inherited-minus-telemetry 环境快照；
- 三个默认 probe 复用同一快照；自定义 probe 继续自行负责环境；
- `probeEnvSource` 仅作为程序化测试 seam，不接入 CLI、RPC 或 Provider registry；
- `dsh-headless-adapter.ts` 不改行为，只补宿主环境下的 `DSH_TELEMETRY_DISABLED=0` 被固定为 `1` 的回归断言。

### 3.2 Web

- 新增小型 `startRunSubmitState()` 纯函数与表驱动单测（`packages/web/__tests__/client/start-run-submit-state.test.ts`）；
- `StartRunForm`（`packages/web/src/client/components/runs/StartRunForm.tsx`）使用该函数计算 disabled/reason，并增加同步 in-flight latch；
- 新增合规命名的 `packages/web/__tests__/e2e/start-run-admission.e2e.test.ts`，先证明无 latch 时能观察到两个 `project.run` 请求，再验证修复后只有一个；
- 现有 digest e2e（`packages/web/__tests__/e2e/start-run-form.test.ts`）的响应匹配收窄到 RPC body 中 `path === 'project.run'`。
- 视觉验收发现窄屏选择器文本被裁切后，新增 390px/700px RED→GREEN e2e；768px 及以下使用单列选择器，闭合标签保持简短，完整风险与自动化边界保留在相邻帮助中。

### 3.3 文档与版本

- 第十九轮复审报告（Markdown 视角批注与完整 HTML 审阅版）待第二批一同交付；
- 用户手册 Markdown/HTML 补充 Tekon 子进程 telemetry 边界、流式事实与独立凭证风险说明；README 保持高层摘要，不新增实现细节；
- CHANGELOG 新增 `v0.20.5`，第一批完成；根包与 core/cli/web 四个 `package.json` lockstep bump（v0.20.5）；
- `current.md` 补 HTML 入口、#33、最终验证和新 Head；PR 元数据待第二批同步。

## 4. 测试先行顺序

1. 先新增 Core fake DSH 环境测试，确认现状会继承 telemetry 配置并失败；
2. 先新增 Web submit-state 单测，确认模块缺失而失败；
3. 先新增重复提交 e2e（`packages/web/__tests__/e2e/start-run-admission.e2e.test.ts`），只有能在现状稳定观察到两个 `project.run` 请求才采用；否则重新设计可证伪测试；
4. 实现 Core 与 Web 修复，使上述红灯转绿；
5. 运行相关 Core test 和 Web e2e；
6. 第一批交付（代码、测试、手册、CHANGELOG 与版本号）就绪后执行全量工程门禁与视觉检查；
7. 第二批交付（复审报告 Markdown/HTML、`current.md` 与 PR 元数据）完成后执行 `pnpm test` 与相关门禁再次验证；
8. 代码/测试、技术文档、文字编辑和报告完成度分别交独立 reviewer 复核。

## 5. 验收标准

- 新增行为测试均记录 RED 和 GREEN 证据，不保留天然通过的假测试；
- `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm audit --prod` 全部通过；
- Core/CLI/Web e2e 全部通过，Playwright 无 flaky retry；
- StartRunForm 在桌面与移动视口无错位、重叠或横向溢出；
- 第十九轮报告 HTML 在桌面与移动视口可读，章节、链接和主结论与 Markdown 一致（第二批交付时验收）；
- 报告、手册及其 HTML 无 `TBD`、`TODO`、`FIXME` 或占位内容；
- 根包与三个内部包版本均为 `0.20.5`；
- `project.clean` 生产代码在 PR #11 中不变；
- 最终 reviewer 明确 `hasMustFix=false` 后才提交。

## 6. 设计评审结论

最高思考等级 reviewer 第一轮指出 #33 边界、React state 防重入、plan error 优先级、用户手册和 e2e 命名五项必须修正。以上方案全部吸收后，第二轮复查结论为 `hasMustFix=false`。

第二轮后按技术 review 纠正 `--help` boot 事实（`--profile headless --help` 会进入 profile/plugin boot，不能用不 boot 排除外传风险）并收窄 telemetry 表述为“内置 session telemetry 硬关断”；该纠正属于事实勘误与表述收窄，不改变 PR #11 的范围控制裁决。

实现后的真实浏览器视觉验收发现 390px/700px 选择器文本裁切，并补充单列布局、短标签与对应 e2e；独立 reviewer 复查后 `hasMustFix=false`。
