# 第十轮报告批注整改执行方案

- **日期**：2026-08-31
- **依据**：`docs/reviews/2026-08-31-tekon-human-first-harness-tenth-review.md` 第 16 节批注
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)（分支 `review/human-first-harness-2026-08-28`）
- **基线快照**：`f9f3733`（`pnpm test` 137 文件 / 1469 通过 / 3 跳过；跑 CLI 测试前需 `pnpm --filter @tekon/core build`）
- **DSH 官方基线**：`0a53fb55bea101816fa226bb964ae2bed71c343b`（`dsh@0.1.2-alpha.2`，已 clone 到 `~/Projects/deepseek-harness` 便于后续同步）
- **Tekon tested pin**：保持 `0.1.2-alpha.1`（不盲目升级 alpha.2；理由见报告 §16.5）

## 1. 范围

本方案只收敛批注 16.1 锁定的三项，全部满足"报告已点名 + 代码证据明确 + 改动局部 + 有明确验收信号"。

**在范围内**：

1. workspace summary SSE 背压上限（P1-SESSION-01 的 workspace SSE 部分）；
2. DSH Node 前置条件说明（P1-DSH-01 的文档/指引部分）；
3. 统一 fake-dsh fixture 并移除 bare-line seam（P2-TEST-01）。

**明确不在范围内**（保持报告原裁决，登记为后续顺序）：single-owner daemon、executor 进程隔离、authoritative Session log、ACP vertical slice、Collaborate→Deliver、RunPlan 全字段绑定、模型 compaction、完整历史导出、全站 a11y 专项。这些是季度级重构，本轮不扩张。

**版本 bump 评估**：本轮为 bug 修复（SSE 背压）+ 文档勘误 + 测试诚实度改进，无新功能、无行为契约破坏，按版本号管理规则评估为 **PATCH**：`0.20.0 → 0.20.1`。

## 2. 产品细节

### 2.1 workspace summary SSE 慢客户端保护（用户可感知）

- 当浏览器标签页挂起或网络极慢时，workspace summary SSE 不再让服务端内存无界增长；
- 超限行为与 session SSE 对齐：服务端停止缓冲并关闭连接，客户端自动重连后通过 catch-up 轮询拿到最新 workspace 快照。由于 workspace summary 是低频聚合事件，**不发送 `replay-truncated` 帧**，重连即最新，无用户可感知的数据丢失窗口。

### 2.2 DSH Node 前置条件诚实披露

- `tekon provider preflight dsh-headless` 的安装指引（CLI 文本输出与 `--json` 的 `installHint` 字段）明确写出 Node 版本要求差异；
- 用户手册 §5.7 的 dsh-headless 边界列表补充第四条：DSH 要求 Node `^22.19.0 || >=24.0.0`，与 Tekon 主合同的 Node `^20.19.0 || >=22.12.0` 不同；Node 20 环境下 dsh-headless 可能无法安装或运行，preflight 不会把 Node 不兼容误报为 dsh 缺失。

### 2.3 测试 fixture 诚实度

- CLI 层 fake-dsh 生成逻辑统一为一个 helper，单测与 e2e 共用，消除两份漂移副本；
- adapter 测试的 probe config 从裸行 id 改为标准 YAML `- id: ...` 行，与真实 `dsh --dump-default-config` 输出形状一致；
- 生产 parser 移除 `bareProbeId` 兼容分支，合同校验只接受完整 `id:` YAML 行。

## 3. 设计细节

### 3.1 workspace summary SSE 背压

复用 `handleSessionEventsSse` 的背压模式，按 workspace summary 的低频特性裁剪：

- `writeFrame` 检查 `response.write()` 返回值；返回 `false` 时进入 backpressured 状态，后续帧进入 pending 队列；
- pending 队列双维度上限：事件数与字节数。workspace summary 帧极小且低频，上限取较小值（`MAX_PENDING_WORKSPACE_EVENTS = 100`、`MAX_PENDING_WORKSPACE_BYTES = 256 * 1024`），两个常量与既有 `MAX_PENDING_EVENTS/BYTES` 同处 export（`sse.ts:20` 一带），超限即关闭连接（不发截断帧，理由见 §2.1）；
- `response` 的 `drain` 事件恢复出队；用 `once` 挂载并在 cleanup 后确认无残留监听器，避免 close 竞态下重复挂载或泄漏。

### 3.2 installHint Node 前置条件

- `packages/core/src/runtime/dsh-bridge-probe.ts` 与 `packages/cli/src/commands/provider.ts` 两处 `installHint` 统一为同一文案（core 导出常量或函数，CLI 复用，避免双份漂移）。**CLI provider 的成功路径与失败（catch）路径都改用 core 导出**（`provider.ts:51` 的失败分支字面量必须一并替换，否则失败路径仍缺 Node 片段）：
  `npm install -g @deepseek-ai/dsh@<pin>（DSH 要求 Node ^22.19.0 || >=24.0.0，与 Tekon 的 Node ^20.19.0 || >=22.12.0 不同）`
- CLI 人类可读输出行 `安装指引: ...` 直接渲染该文案；
- e2e 断言从"匹配 npm install 命令"放宽为"包含 npm install 命令且包含 Node 要求片段"，避免文案微调造成假失败。

### 3.3 fake-dsh fixture 统一与 bare-line seam 移除

- 新增 `packages/cli/__tests__/helpers/fake-dsh.ts`，导出 `createFakeDsh(dir, opts)` 与 `VALID_DSH_CONFIG`。**`VALID_DSH_CONFIG` 唯一来源是 `REQUIRED_DSH_PLUGIN_IDS` 生成的标准 YAML 行**（`REQUIRED_DSH_PLUGIN_IDS.map(id => `- id: ${id}`).join('\n')`，与 web fixture 的生成方式一致），CLI 测试层不再保留任何手写的 required-id YAML 字面量列表；
- `packages/cli/__tests__/provider-preflight.test.ts` 与 `packages/cli/__tests__/e2e/provider-preflight.test.ts` 删除各自的本地副本（含手写 `VALID_CONFIG`），改用共享 helper；
- `packages/core/__tests__/runtime/dsh-headless-adapter.test.ts` 的 5 处裸行 probeConfig 改为标准 YAML 行，**`user-approval` 必须显式改写为真实 row id `- id: approval`**（这是本步最易出错的点，因为当前 5 处用例全部依赖 `bareProbeId` seam 才能通过 `approval` 契约）：
  - 4 处正向用例（453/482/570/632 行）：`user-approval` → `- id: approval`，其余裸行同样转为 `- id: <row>`；
  - 1 处负向用例（596 行，"missing sandbox-policy"）：转为 `- id: headless-runner` / `- id: approval` / `- id: session-persistence-jsonl` / `- id: agent-default-model`，**仅缺 `sandbox-policy` 一行，approval 行必须存在且为标准 id**，确保它是纯粹的"单缺 sandbox-policy"负向用例，而不是同时缺两个契约；
- `packages/core/src/runtime/dsh-bridge-probe.ts` 的 `containsConfigRowId` 删除 `bareProbeId` 分支，只保留 YAML `id:` 行匹配；
- `packages/web/__tests__/api/project-run-unrestricted-network.test.ts` 的 `installFakeDsh` 已是标准 YAML，本轮不动（跨包共享 helper 会引入测试依赖耦合，收益不抵成本；登记为后续可选项）。

## 4. 实现顺序（测试先行）

1. **SSE 背压**：先在 `packages/web/__tests__/` 新增/扩展测试——慢客户端（不消费响应体）下持续推送 summary 事件，断言连接被关闭且 pending 不超过上限；再改 `sse.ts`。
2. **installHint**：先改 CLI 单测/e2e 断言（Node 要求片段），再改 core probe 与 CLI provider；同步手册 §5.7。
3. **fixture 统一**：先建共享 helper 并迁移两个 CLI 测试文件（行为不变，纯重构，测试应全绿）；再改 adapter 测试为 YAML（按 §3.3 的 `user-approval` → `approval` 显式约定）；**删 seam 前先跑一次 adapter 负向用例，人工核对其失败原因仅为 sandbox-policy（可用临时断言或错误信息核对，防止 approval 缺失被 `REQUIRED_DSH_PLUGIN_IDS` 遍历顺序掩盖）**；最后删 `bareProbeId` 分支——删分支后 adapter 测试必须仍全绿，证明 YAML 用例不依赖 seam。
4. `pnpm --filter @tekon/core build` 后全量 `pnpm test`。
5. reviewer 循环（最高思考等级）：方案评审 → 代码评审 → 验收评审，直到无必须修复项。
6. 提交到 PR #11，提交信息含 `v0.20.1`。

## 5. 验收标准

- `pnpm test` 全绿：通过用例数 ≥ 基线（1469），跳过数不增（仍为 3）；
- workspace summary SSE 慢客户端测试证明背压上限生效，且 cleanup 后 `response` 上无残留 `drain` 监听器；
- preflight 输出（文本与 JSON，含失败路径）包含 Node 版本要求；手册 §5.7 第四条边界存在；
- 仓库内不再有 `bareProbeId` 与裸行 probeConfig；adapter 负向用例经验证为纯粹"单缺 sandbox-policy"（删 seam 前后各核对一次失败原因）；
- CLI 两个测试文件共用同一 fake-dsh helper，`VALID_DSH_CONFIG` 由 `REQUIRED_DSH_PLUGIN_IDS` 生成，无手写 required-id YAML 字面量列表；
- reviewer 最终一轮未检出必须修复项。

## 6. 风险与回退

- SSE 背压上限取值偏紧可能误杀正常慢客户端：100 帧 / 256KB 对低频 summary 事件余量充足，且超限行为是关闭重连而非数据损坏，风险可控；
- installHint 文案进入 e2e 断言，后续文案微调需同步测试——已在 §3.2 把断言放宽为片段匹配；
- 移除 bare-line seam 后，若外部存在依赖裸行的 fixture 会失败——仓库内取证仅 adapter 测试 5 处，全部迁移；core fixture 与 web fixture 本就是 YAML。
