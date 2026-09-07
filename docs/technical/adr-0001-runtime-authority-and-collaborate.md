# ADR-0001：Runtime 权威与 Collaborate 演进

- 状态：历史决策，2026-09-06 修订；现行合同以[运行时规范](tekon-runtime-contract.md)为准。
- 原决策日期：2026-08-29；[原始全文固定快照](https://github.com/zesming/tekon/blob/31680f9bfd9424dd6466734ac97a8d172debfa42/docs/technical/adr-0001-runtime-authority-and-collaborate.md)。
- 对应证据：[第五轮复审](../reviews/2026-08-29-tekon-human-first-harness-fifth-review.md)。

## 决策与当前状态

| 原决策 | 2026-09-06 状态 |
| --- | --- |
| 单一执行所有者 | repo daemon 仍是候选演进方向，未作为当前部署强制合同。现有 CLI/Web 可各自运行 Runtime，已由 Job/owner 作用域在 SQLite 写事务中 fence 覆盖的领域写入；原“缺少持久 execution authority”不能照搬为当前事实。OS、文件和任意外部副作用不因此获得全域 fencing。 |
| Quiescent shutdown | 当前采用停止 claim、有界等待、abort/kill 和硬上限 drain。CLI/Web 组合根在 runner.stop 返回后、关闭 SQLite 前以 db.markClosed() 设置 closed 栅栏，随后 db.close()；WriteQueue 的 isClosed 检查据此拒绝迟到写入。单独调用 stop 不关闭写队列，硬超时不等于物理退出。退出证据按 Job scope 记录，详见现行合同。 |
| Session Event 事实源 | 继续为观察投影。新 Session 三个开场事件与 Run/Audit/Job 原子受理，后续仍 best-effort；完整模型历史、durable inbox 和全域 outbox 未实现。 |
| Harness 接入 | headless 保留为 experimental Goal-only。SDK stdio JSON-RPC 与 ACP 为不同控制面，SDK 不具备 ACP 的取消/关闭/权限问答合同，持续协作另做纵向验证。 |
| Collaborate | 未开放 follow-up/steer；按 #14/#19 独立推进，不把 Session feed 当作持续对话。 |

## 原配套递延项的修订

Provider preflight、网络风险确认、原子 Admission、恢复确认和受管理退出证据已有实现，不能继续标为“尚无入口”。DSH tested CLI pin 已为 `0.1.2-alpha.3`，顶层 pin 不锁定使用范围版本的内部依赖；升级验收按 [#17](https://github.com/zesming/tekon/issues/17)记录完整树与 L2/L3。

完整数据迁移、全域外部副作用隔离、导出及持续协作仍需独立设计与验证，当前范围见[产品说明](../product/tekon-current-product-scope.md)。旧决策全文和原证据保留在固定快照及 reviews；这份修订不把后续代码修复倒写为历史已通过。

## 资料

[运行时规范 §8](tekon-runtime-contract.md)列出固定上游源码、headless/SDK/ACP/Safety 资料和对 Tekon 的推断，区分当前实现、依赖风险与建议。
