# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-08-31 Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十二轮全面复审](2026-08-31-tekon-product-runtime-harness-twelfth-review.md)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威代码快照**：`19deedfe03d78553102faad355d8aef26d32dd6e`
- **用户 v0.20.3 整改快照**：`1a4700ec8d9e735bdb3fcf25fe0dc1652e2ee007`
- **reviewer 代码修复快照**：`5ff5b430fb839177125fba695198b6ab24c3f87c`
- **当前版本**：`0.20.4`
- **代码自动化状态**：`1c285e0...` 的 Core #33473574591 与 CI #33473574622 均为 `completed/success`；Root typecheck/lint、CLI build/unit/e2e、Web build/typecheck/unit 与 Web Playwright e2e 全部成功
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前官方版本**：`0.1.2-alpha.3`
- **当前裁决**：v0.20.4 整改（DSH pin 升级、版本身份统一、fixture warning 清理、CI audit gate、smoke 断言健壮性、audit 步骤顺序）已提交并通过代码合并门（CI 全绿）；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第十二轮确认的实质改进

- CLI 三个真实子进程 e2e 已统一为 `*.e2e.test.ts`；unit lane 与 e2e lane 不再重复执行同一批文件；
- 根 `packageManager` 继续钉死 `pnpm@10.12.1`，当前依赖 override 已进入根合同与 lockfile；
- 全栈 CI 与 focused Core CI 统一先执行 `corepack enable pnpm`，递归 package script 可以可靠调用裸 `pnpm`；
- `actions/checkout` 与 `actions/setup-node` 已升级到当前 Node 24 runtime 的 v6 系列；
- 上一轮已闭环的 Session/Workspace SSE backpressure、历史 cursor、DSH pin/help/config/Node 合同继续通过回归；
- 当前 reviewer 代码修复快照的 Core、CLI、Web 与 Chromium Playwright 自动化全部成功。

## v0.20.4 批注整改（第十二轮第 17.2 节）

- DSH tested pin 升级到 `0.1.2-alpha.3`（与 alpha.2 合同零差异）；
- 内部 package 版本统一为 `0.20.4`（lockstep），补 smoke 断言防漂移；
- 6 个 CLI fixture 不再 spawn `npm` 子进程，消除 unknown-config warning；
- CI 新增独立 `audit` job（`pnpm audit --prod`），`cli`/`web` 改为 `needs: [typecheck, audit]`，audit 与 typecheck 并行且保留 gate 语义；
- 详见 `docs/superpowers/plans/2026-09-01-twelfth-review-remediation-plan.md`。

## 第十三轮批注（第十二轮第 18 节）

- 第二轮四路交叉评估确认：第 17.2 节四项全部落地、DSH alpha.3 升级风险低、架构冻结裁决全部成立（逐项有代码证据）、测试全绿（138 文件 1477 passed）；
- 新发现 7 项建议/观察级问题（无阻断项），其中 smoke 目录过滤已修复，audit gate 步骤顺序已调整（移到 build/typecheck 之后保留诊断），其余记录交用户决策或另立 PR；
- 详见第十二轮报告第 18 节与 `docs/superpowers/plans/2026-09-01-thirteenth-review-remediation-plan.md`。

## 本轮 reviewer 直接修复

1. **Corepack shim 缺失导致的 CLI e2e 阻断**  
   用户快照中外层 `corepack pnpm` 可以启动，但 package script 内部再次调用 `pnpm` 时得到 `spawn ENOENT`。所有 CI job 现先启用 Corepack shim，再统一使用根 `packageManager` 解析出的 `pnpm`。

2. **两个 CI gate 的 package-manager 合同不一致**  
   `.github/workflows/core.yml` 原先仍保留 `npm exec --yes -- pnpm@10.12.1`。当前 focused Core 与全栈 CI 已共用同一 Node/Corepack/pnpm 合同。

3. **权威文档真实性**  
   用户快照在 CLI e2e 红色且 fixture warning 仍存在时，权威入口提前写成“通过、warning 已清理”。第十二轮报告与本文件现绑定真实成功快照，并把 fixture warning 标为部分完成。

## 已关闭或基本关闭

- CLI unit/e2e 文件命名与 lane 语义；
- CI package script 找不到 `pnpm` 的阻断；
- full-stack/focused-Core package-manager 启动合同；
- 真正的 `beforeSeq` / `nextBeforeSeq` 历史反向游标；
- Session replay budget、Session pending event/byte cap 与 truncation 用户提示；
- workspace summary pending frame/byte cap；
- Session/Workspace heartbeat 背压；
- DSH row-id 假阳性、bare-line parser seam、Node 结构化提示与 alpha.2 版本断层；
- 当前 reviewer 代码修复快照的 Core、Root、CLI、Web unit 和 Chromium Playwright 回归门。

## 仍不能按“已关闭”表述的项目

- **single-owner Runtime**：CLI/Web 仍各自持有 JobRunner、DB、Git/worktree、Provider 和 shutdown 生命周期；
- **Shutdown**：abort/kill/hard deadline + DB fence 不等于 executor、普通文件、Git 和外部 SDK 已 quiescent；
- **Session 事实源**：Event log 仍是 best-effort projection，不是 durable inbox 或权威模型历史；
- **Collaborate**：真实 streaming、follow-up、steer、prompt cancel、restart resume 和 Collaborate → Deliver 仍缺；
- **RunPlan**：校验与持久化一致，但尚未成为 execute/resume 唯一权威输入，也未完整绑定 Demand/mode/base/workspace/resolved Provider/expected Artifacts；
- **长 Session**：在线 replay/pending 已有基础上限，完整历史导出、模型 context compaction、统一 retention policy、真实规模和故障矩阵仍未闭环；
- **DSH**：pin/fixture 合同已追平 alpha.3，但带真实 dsh 二进制与 API key 的 Provider smoke 仍缺；
- **发布身份**：内部 package 版本已与根产品版本 lockstep 统一为 `0.20.4`，smoke 测试有断言防漂移；
- **仓库治理**：`main` 未保护，required status checks enforcement 关闭；红色 CI 不能从仓库规则层阻止合并；
- **测试卫生**：CLI 测试 fixture 不再 spawn `npm` 子进程，该 lane 的 unknown-env warning 已清零（install/update 脚本与 smoke:claude-provider 等路径仍会产生同类告警）；
- **供应链治理**：CI 已强制 `pnpm audit --prod`（生产依赖 advisory gate）；dev 依赖树与 SBOM/provenance 仍无 gate；
- **可访问性**：局部 dialog 与 Chromium lane 不能外推为全站 screen reader、Firefox/WebKit、缩放和对比度验收；
- **PR 可审阅性**：当前 PR 体量过大，建议 squash merge，并把后续架构主链路拆为独立 PR。

## 仍未关闭的主链路

```text
repo 级 single-owner Runtime
→ executor 隔离、真实 join 与 restart recovery
→ authoritative Session log / durable inbox
→ DeepSeek ACP 或其它真实 Provider execution-time stream
→ follow-up / steer / prompt cancel / resume
→ Collaborate → Deliver
→ canonical RunPlan 成为 execute/resume 唯一输入
→ complete-history export / model compaction / 全链路 retention budget
```

## 允许的成熟度表述

> Tekon v0.20.4 已形成测试覆盖较强、执行计划和风险边界较透明、长会话在线观察具有基础资源上限的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart、完整历史导出、模型上下文预算和统一发布身份尚未闭环。

## 评审资料维护规则

- 本文件是唯一稳定入口；
- 第十二轮报告是当前详细裁决；
- 第一至第十一轮只读归档，不再追加新批注或新裁决；
- 产品或架构基线变化时新建报告，不在旧报告尾部继续叠加 revision；
- CHANGELOG 只记录用户可见行为，不复制 reviewer 过程；
- 代码 snapshot 与 `completed + success` 的 Core/CI snapshot 必须成对更新；
- PR Head 若继续变化，必须重新绑定 CI 终态后才能复用“代码门通过”结论；
- 最终建议 squash merge，后续架构主链路拆分为独立 PR。
