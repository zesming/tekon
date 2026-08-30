# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-08-30 Tekon 人类可用性与 DeepSeek Harness 架构第八轮全面复审](2026-08-30-tekon-human-first-harness-eighth-review.md)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **用户整改快照**：`692ca76b9452d6cb242e9f746c572ccad5bdd0b4`
- **第八轮批注整改快照**：见第八轮报告第 19 节（v0.19.0）
- **reviewer 代码快照**：`816b097b668d3da98c19b0cbaec85a2234ef976a`
- **当前版本**：`0.19.0`
- **自动化状态**：`816b097b...` 的 Core #302 与 CI #211 均为 `completed/success`。
- **当前裁决**：本轮用户整改与 reviewer 低风险增量通过代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收。

## 第八轮批注整改（v0.19.0）

第 18 节维护者批注后，本轮闭环了 6 项 P1 与 1 项 P0 增量，详见第八轮报告第 19 节：

- canonical RunPlan：digest 绑定完整执行参数、Web workflow 模式强制校验、Run 持久化计划快照；
- DSH preflight 前移到持久副作用之前，新增 `tekon provider preflight dsh-headless`；
- 长 Session 全链路有界（分页上限、重连预算、背压、可见事件分页、客户端窗口）；
- 连接健康缓存哈希化 + 容量/TTL 有界，provider 语义诚实化为 `dshHeadless`；
- Session 子表外键迁移与孤儿 quarantine；
- 配置详情弹窗 focus trap / Escape / 焦点恢复 / inert；
- shutdown 后 db 层 closed 栅栏，迟到写入快速失败（P0-ARCH-02 增量，不宣称关闭）。

架构级冻结项（single-owner daemon、Session 事实源选型、Collaborate 主链路、DSH pin 升级）维持第八轮裁决，按报告第 14 节顺序推进。

## 第八轮确认的实质改进

- Web/CLI Workflow catalog 已统一 built-in 与项目模板；
- 默认与高级 Web 入口均会读取服务端计划并 fail-closed；
- 默认 Session 入口已补发服务端 plan digest；
- DSH adapter 增加 version/help/config capability probe；
- `project.health` 能验证 Web session token，前端不再把原始 token 写入 query key；
- 长 Session 已增加 DB page、SSE tail/catch-up 和客户端窗口；
- Node 版本合同统一为 `^20.19.0 || >=22.12.0`；
- shutdown 的合作路径能够持久化 `interrupted`；
- output-activity 测试的 CI 调度裕量已修复，没有降低断言；
- 配置详情中的空“查看 YAML”操作已删除，并补了基础 dialog 语义。

## 不能按“已关闭”表述的项目

- **Run plan**：digest 可省略，覆盖字段不完整，Goal 不校验，也没有持久化 canonical snapshot；
- **DSH preflight**：发生在真实模型命令前，但晚于 Run/Session/Job/role-run/worktree 等持久副作用；
- **连接健康**：服务端 cache 仍以原 token 为 key，Provider 状态实际只代表 dsh；
- **Shutdown**：hard deadline 只能停止等待，不保证不合作进程内 executor 已 quiescent；
- **长 Session**：API limit、reconnect 总预算、SSE backpressure 和过滤分页仍未全链路有界；
- **可访问性**：详情面板仅补基础语义，focus trap、Escape、焦点恢复和全站验收仍未完成。

## 仍未关闭的主链路

```text
single-owner runtime
→ 可证明的 quiescent shutdown / restart recovery
→ 权威 Session log / durable inbox
→ DeepSeek ACP/SDK 或其它真实 Provider streaming vertical slice
→ follow-up / steer / cancel / resume
→ Collaborate → Deliver + canonical RunPlan snapshot
→ Session 数据、网络、内存、DOM、模型上下文全链路有界
→ 数据引用完整性与全站可访问性
```

允许的成熟度表述：

> Tekon v0.18.0 已形成测试较强、计划与风险边界更透明的实验性受控交付执行与观察基础设施；它尚未完成持续协作产品、单一 Runtime 权威、权威 Session 事实链、可证明的 quiescent shutdown、canonical RunPlan 和全链路长会话有界化。

## 评审资料维护规则

- 本文件是稳定入口；
- 第八轮报告是当前详细裁决；
- 第一至第七轮仅作为判断演进历史；
- CHANGELOG 只记录用户可见行为，不复制 reviewer 过程；
- 小整改更新当前报告 revision log，只有产品或架构基线显著变化时新增报告；
- 任何“验证通过”必须绑定具体 commit 和 `completed + success` 的 GitHub Actions 终态。
