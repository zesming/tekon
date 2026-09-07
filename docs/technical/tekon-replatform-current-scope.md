# Tekon Replatform 历史范围基线

> 状态：2026-08-28 的历史基线，已由 2026-09-06 的[现行产品范围](../product/tekon-current-product-scope.md)与[运行时合同](tekon-runtime-contract.md)接替。此文件保留原路径供历史引用使用。

## 历史判断与修订

原基线正确指出阶段完成标签不能代表完整 Harness 迁移，Session feed 也不等于权威模型日志。这些边界继续成立：当前不提供持续协作、follow-up/steer、完整模型 streaming、durable inbox 或完整导出。

原基线中以下实现缺口已发生变化，不能作为当前结论：原子 Admission 与请求身份、RunPlan v3 检查绑定、历史分页与有界回放、SQLite Job/owner 写 fence、关闭时写队列 fence、取消补偿、Job 退出证据和绑定前代的显式恢复均有实现。当前 workflow resume 已开放；它与尚未开放的持续会话 AgentDriver resume 不同。

当前仍允许 CLI/Web 多 Runtime。已有 SQLite 所有权事务和状态 CAS 不能扩大成 OS 与所有外部副作用的全域保护，旧“没有持久写 fencing”也不再准确。single-owner daemon 保留为演进方向，当前实现与验证范围按运行时合同及正式证据判断。

## 可追溯来源

- [原始全文与当时范围](https://github.com/zesming/tekon/blob/31680f9bfd9424dd6466734ac97a8d172debfa42/docs/technical/tekon-replatform-current-scope.md)
- [修订后的 ADR-0001](adr-0001-runtime-authority-and-collaborate.md)
- [正式审阅与验收入口](../reviews/current.md)

版本策略以仓库 AGENTS.md 为准，本文不再单独维护冲突的发布规则。
