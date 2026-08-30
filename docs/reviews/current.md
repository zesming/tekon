# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-08-30 Tekon 人类可用性与 Harness 架构第七轮全面复审](2026-08-30-tekon-human-first-harness-seventh-review.md)
- **HTML 审阅版**：[第七轮人类审阅页面](2026-08-30-tekon-human-first-harness-seventh-review.html)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **本轮复审起点**：`97712042208c9197659ed2445c96c4c74f253b27`（与上一轮最终提交相同；本轮开始时未检测到额外用户 commit）
- **当前产品代码快照**：`5bf2fe3423682d1f693da91f656924868d2a205c`
- **第七轮报告快照**：`4298fcc1357fdfc35222d21b836949964b89a76f`
- **当前版本**：`0.18.0`
- **当前裁决**：最终 PR Head 的 Core/CI 完整成功后，当前增量可通过代码合并门；Tekon 尚未通过“面向普通人的稳定持续协作研发工作台”产品验收。

## 2026-08-30 第七轮批注整改（v0.18.0）

交付侧对第七轮报告全部 P0/P1/P2 论断做了逐条代码复核（报告第 14 节批注，15 项论断全部属实），并按四轮最高思考等级 reviewer 评审达成一致的执行方案（`docs/superpowers/plans/2026-08-30-seventh-review-remediation-plan.md`）落地 8 项可独立验证整改：

- Web/CLI 统一 workflow template catalog（built-in + 项目模板，id 即文件名）；
- 高级入口 plan 失败 fail-closed + plan digest 绑定；
- DSH 生产 capability preflight（help/config 合同）；
- `project.health` RPC 与 TopBar 真实握手状态；
- 长会话全链路有界（`listEventsPage` 分页、SSE 尾窗、客户端窗口化、重连续传不丢）；
- 手册 Node 版本一致性 + 一致性测试；
- E2E locator helper；
- shutdown hard deadline + `interrupted` 持久状态（job-runner / workflow-job-executor / automation-job-executor / engine / node-executor 全链路三分流）。

验证：`pnpm -r typecheck` 通过；`pnpm test` 129 文件 1407 测试通过；Playwright 32 项通过无 flaky；桌面/移动 UI 截图抽查无错位重叠。

**仍未关闭（维持第七轮裁决，属后续架构 PR 范围）**：P0-ARCH-01（single-owner Runtime）、P0-ARCH-03（权威 Session log / durable inbox）、P0-PRODUCT-01（Collaborate vertical slice：真实 streaming、follow-up/steer/resume、重启恢复）、P1-DATA-01（Session 子表外键与孤儿迁移）、P1-A11Y-01（全站可访问性与多浏览器专项）。

## 本轮纠正与关闭

- 纠正上一轮在最终 CI 未结束时即宣称验证完成的结论；后续只以 `completed + success` 为通过依据；
- 修复 TopBar 凭据状态、失败会话操作和不存在运行页的 Playwright 断言漂移，没有关闭 strictness 或弱化产品断言；
- 根包、installer 与 README 统一到 Vite 7 所需 Node.js `^20.19.0 || >=22.12.0`；
- 修复自定义 `TEKON_HOME` 安装后 wrapper 仍指向 `$HOME/.tekon` 的真实安装缺陷；
- CI 增加 installer shell 语法检查；
- README 重新指向本文件，不再把第一轮历史报告当作当前权威入口。

## 主要闭环继续成立

- Web/CLI 的 dsh 不受限网络确认、runtime guard 与 Audit 已贯通；
- 默认 Session 主入口在权威计划不可用时 fail-closed；
- 失败会话禁止预确认，list/get 和后续失败代际语义基本统一；
- 连接凭据为草稿 + 显式应用，文案只声明“凭据已设置”；
- JobRunner stop 与 active poll late-claim 竞态已有屏障和故障测试；
- workspace SSE process-local 路径按 workspace membership 隔离；
- query key 切换不再短暂展示上一 provider/mode/auth scope 的旧数据。

## 部分完成，不能按“已关闭”表述

- **Shutdown**：主竞态已修，但不合作 executor/provider 的 hard deadline 和 durable interrupted/recoverable 语义未定；
- **Run plan**：默认入口 fail-closed，高级入口仍 fail-open；计划未与实际 run 通过 snapshot/digest 绑定；
- **连接管理**：只证明凭据已设置，未证明服务端连接健康；
- **长 Session**：只限制初始 DOM，客户端内存、服务端 replay 和网络仍无界；
- **DSH preflight**：生产 adapter 只验证版本，help/config capability 检查仍主要在 fixture/opt-in test；
- **可访问性**：核心路径改善，不代表全站屏幕阅读器和多浏览器验收。

## 本轮新增或重新确认的主要问题

- Web 高级模板目录只扫描 `.tekon/workflows`，不展示六个 built-in 模板；项目 YAML `id` 与文件名不同时 selector 可能不可执行；
- 用户手册 Markdown/HTML 仍宣称 Node 18 可用，与 package/installer/README 的真实合同冲突；
- Session 子表外键、权威 Session log、single-owner Runtime 和 Collaborate vertical slice 仍未关闭；
- 测试中稳定控件文案跨文件复制，需建立小型 locator helper，避免再次产生全套 E2E 合同漂移。

## 仍未关闭的主链路

```text
single-owner runtime
→ shutdown / recovery 持久语义
→ 权威 Session log / durable inbox
→ DSH SDK/ACP 或其它真实 Provider streaming
→ follow-up / steer / resume / restart recovery
→ Collaborate → Deliver + 权威 run plan
→ Session 数据、网络、内存、DOM 全链路有界化
→ 数据引用完整性与全站可访问性
```

允许的成熟度表述：

> Tekon v0.17.0 已形成测试较强、启动与风险边界较透明的实验性受控交付执行与观察基础设施；它尚未完成持续协作产品、单一 Runtime 权威、权威 Session 事实链、权威 run plan 和全链路长会话有界化。

## 评审资料维护规则

- 本文件是稳定入口；
- 第七轮报告是当前详细裁决；
- 第一至第六轮只作为判断演进历史；
- CHANGELOG 只记录用户可见行为，不复制评审过程或 reviewer 批注；
- 后续小整改更新当前报告 revision log；只有产品或架构基线显著变化时才新增一轮报告；
- 任何“验证通过”必须绑定具体 commit 和已完成的 GitHub Actions 终态。
