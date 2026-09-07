# Tekon 现行产品范围

2026-09-07 · v0.25.0 · [用户手册](../manual/tekon-user-manual.md) · [运行时合同](../technical/tekon-runtime-contract.md) · [运行控制设计](../design/tekon-run-control-design.md)

## 用户与价值

Tekon 面向需要把研发需求推进到可审阅交付材料的仓库维护者。用户提出目标、确认计划与风险，Agent 在隔离 worktree 中执行角色任务，Tekon 收集 Artifact、Gate、Audit、diff 和 PR 准备包。用户据证据决定是否创建 PR、合入和上线。

适合边界清楚、能用仓库命令验证的小功能、缺陷修复、测试和文档任务。需求不清晰时先塑形和批准需求卡；命令画像不完整时先确认检查如何执行。它是本地工作台，当前不提供远程多租户服务。

## 已开放的路径

| 场景 | 用户操作与得到的结果 | 判断结果 |
| --- | --- | --- |
| 受控交付 Deliver | 默认 Web 入口或 `tekon run` 进入 `standard-delivery`；可选其他固定模板 | 审阅角色产物、Gate 和 diff；Run 通过不等于 PR/CI 已就绪 |
| 可靠发起 | 审阅执行计划、仓库检查和风险后提交；保存 Request ID | 同意图重试找回原 Run/Session/Job；已受理与已执行分别展示 |
| 中断与恢复 | 暂停请求在活动步骤边界生效；取消记录意图并停止受管理执行；显式恢复原 Run | 查看持久状态、旧 Job 退出证据和当前恢复结果；未知退出需人工检查确认 |
| 审批与交付 | 查看证据后批准 human gate；准备 PR 包；显式批准 push/创建 PR | 审批记录、实际运行状态、PR URL 和 CI 证据分别核对 |
| Goal 实验 | `--goal` 使用内置 Goal 模板；实验性 DSH 只用于此路径 | 单次目标结果，不冒充完整 Deliver 或持续对话 |
| 观察与诊断 | Session feed、Run 详情、审批、交付和 eval 页面 | feed 是观察投影；以领域记录与实际产物核对结论 |

Profile `human-web` 保留人工点；`autonomous-delivery` 在长驻服务中可自动准备通过运行的交付包，但不会自动 push 或创建 PR。CLI 退出后不承诺后台自动准备。Goal 不绕过 Deliver 的治理要求来生成已验证交付结论。

## 人工控制与失败恢复

push、创建 PR、合入、上线及高危动作保留人工控制。网络无约束的 Provider 必须显式确认，其风险确认写入运行记录。Provider 报错不能降级为 mock 成功；退出 0 也不能替代 Artifact、Gate 和 readiness 的检查。

发起结果未知时先查原 Request ID，不另建重复任务。目录未就绪时保留身份，修复目录后按原请求恢复。暂停不会立即冻结操作系统进程；取消回执不证明全部进程退出。租约过期的已认领 Job 转为 interrupted，等待显式恢复，不自动重跑旧 Agent/Gate。恢复确认绑定上一代 Job；审批成功但恢复未受理时继续处理原 Run。

## 尚未开放与独立工作项

- 持续协作、follow-up、steer、完整 Provider 增量流，以及 Collaborate→Deliver 升级路径：[SDK/ACP 集成 #14](https://github.com/zesming/tekon/issues/14)、[持续协作 #19](https://github.com/zesming/tekon/issues/19)。
- 完整只读导出、snapshot/manifest、retention/purge 和生命周期安全清理：[#18](https://github.com/zesming/tekon/issues/18)、[#33](https://github.com/zesming/tekon/issues/33)。当前 `clean` 停用，历史分页不等于完整导出。
- DSH 新发行版本与完整依赖树的兼容性验收：[#17](https://github.com/zesming/tekon/issues/17)。tested CLI pin 保持 `0.1.2-alpha.3`，不代表整棵传递依赖树已锁定。
- 全域权威事件日志、OS 级隔离及所有外部副作用的硬 fencing。现有 SQLite owner fence 保护其覆盖的写入，不等于能停止逃逸进程或撤回外部动作。

## 证据与发布口径

[正式审阅入口](../reviews/current.md)记录各轮结论与边界。单元测试、真实 SQLite 竞争、真实进程 e2e、Chromium 交互和真实 Provider 任务各有不同证明范围；mock 或只读 smoke 不能替代真实交付。没有 push/PR/CI 的样本不能宣称 readiness 全通过；浏览器视口矩阵不等于读屏、其他 OS 或生产负载验收。

旧阶段计划已完成归并，不再作为当前能力承诺。历史方案和验收证据仍可追溯至[归并前固定快照](https://github.com/zesming/tekon/tree/31680f9bfd9424dd6466734ac97a8d172debfa42/docs/superpowers/plans)。
