# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-08-30 Tekon 人类可用性、持续协作与 DeepSeek Harness 第九轮全面复审](2026-08-30-tekon-human-first-harness-ninth-review.md)（含第 16 节批注与 v0.20.0 整改）
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **用户 v0.19.0 整改快照**：`f7be7550680a792f9a619e6de2056612226e9d2b`
- **reviewer 代码快照**：`4d4daeaf176f2457b4d64b084f73fe511661fd4f`
- **当前版本**：`0.20.0`
- **代码自动化状态**：`4d4daeaf...` 的 Core #314 与 CI #223 均为 `completed/success`；Root、CLI unit/e2e、Web build/typecheck/unit、Playwright 全部成功
- **当前裁决**：本轮用户整改与 reviewer 低风险修复通过代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第九轮确认的实质改进

- Session 子表已通过 table rebuild 加入 cascade FK，并 quarantine 旧库孤儿；
- health cache 使用 token SHA-256、容量 128、TTL 清理，Provider 状态明确为 dshHeadless；
- Role/Workflow 详情面板具备 dialog name、focus trap、Escape、焦点恢复、滚动锁定和背景 inert；
- workflow 模式缺少或篡改 plan digest 时服务端拒绝启动；
- Web/CLI DSH preflight 位于 Run 持久化之前；
- RPC event limit 有最大值，SSE 有 tail/reconnect budget 与基础 drain 处理；
- shutdown 后数据库写入有 closed fence；
- 本轮 reviewer 修复后，Web 持久化的是实际通过校验的同一份 canonical plan，且模板不再在校验后二次读取。

## 本轮 reviewer 直接修复

1. **Web RunPlan 一致性**  
   修复“校验扩展计划、持久化 Engine fallback 计划”的断裂；同一 Workflow 对象现在同时用于 digest、prepareRun 和 plan snapshot，避免 YAML validation-to-execution TOCTOU。

2. **DSH preflight 并发串扰**  
   移除 Web composition root 的共享 `pendingAgent`；预检进入 request-scoped async engine factory。

3. **DSH version escape hatch**  
   `TEKON_DSH_ALLOW_VERSION` 与 CLI `--allow-version` 现在真实进入 Core preflight；CLI 删除重复 probe 实现，并增加真实进程测试。

4. **SSE replay control frame**  
   `replay-truncated` 不再被当成 PresentedEvent 送入 EventFeed；客户端只更新 reconnect cursor。

对应 reviewer 代码提交区间：`a034ea89...` 至 `4d4daeaf...`。

## 仍不能按“已关闭”表述的项目

- **RunPlan**：Web 校验与持久化一致性已修，但 snapshot 尚未完整绑定 Demand version、base revision、workspace identity、网络确认、预期 Artifacts 和 resolved Provider config；execute/resume 也未把它当作唯一执行事实。
- **长 Session**：v0.20.0 已改为真正的 `beforeSeq` 反向游标 + `nextBeforeSeq` continuation，空可见页不再中断；慢客户端 SSE pending Map 有事件数/字节双维度上限；截断有可关闭的用户提示。全链路（DB/API/SSE/客户端/DOM/模型上下文）历史预算仍未完全闭环。
- **DSH**：v0.20.0 已把 tested pin 升级到官方 `0.1.2-alpha.1` 并更新 contract fixture；真实 Provider smoke（带 API key）仍待有 dsh 二进制的环境执行。
- **Shutdown**：closed fence 只能让 DB late write 失败，不能证明不合作 executor、文件/Git 副作用或外部 SDK 已 quiescent。
- **数据**：FK migration 基本关闭；建议继续补严格 FK shape 校验与 `foreign_key_check`。
- **可访问性**：当前两个详情 dialog 已闭环，不能外推为全站 screen reader、多浏览器和对比度验收。

## 仍未关闭的主链路

```text
repo 级 single-owner Runtime
→ executor 隔离、真实 join 与 restart recovery
→ authoritative Session log / durable inbox
→ DeepSeek ACP/SDK 或其它真实 Provider execution-time stream
→ follow-up / steer / prompt cancel / resume
→ Collaborate → Deliver
→ canonical RunPlan 成为 execute/resume 的唯一输入
→ DB/API/SSE/client/DOM/model-context 全链路历史预算
```

## 允许的成熟度表述

> Tekon v0.20.0 已形成测试较强、计划和风险边界更透明的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart 和全链路历史预算尚未闭环。

## 评审资料维护规则

- 本文件是稳定入口；
- 第九轮报告是当前详细裁决；
- 第一至第八轮仅作为判断演进历史；
- CHANGELOG 只记录用户可见行为，不复制 reviewer 过程；
- 小整改更新当前报告 revision log，只有产品或架构基线显著变化时新增报告；
- 任何“验证通过”必须绑定具体 commit 和 `completed + success` 的 GitHub Actions 终态。
