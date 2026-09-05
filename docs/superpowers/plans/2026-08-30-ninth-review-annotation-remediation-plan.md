# 第九轮报告批注整改执行方案

- **日期**：2026-08-30
- **依据**：`docs/reviews/2026-08-30-tekon-human-first-harness-ninth-review.md` 第 16 节批注
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **基线快照**：`fafef36680eee9fc74e5ef75f058fdbe45286195d`（`pnpm test` 135 文件 / 1457 通过 / 3 跳过）
- **DSH 官方基线**：`cd5ef8148158c3a752a658978873241fdf8e2bbc`（`dsh@0.1.2-alpha.1`）

## 1. 范围

本方案只收敛批注 16.1 锁定的四项，全部满足"报告已点名 + 代码证据明确 + 改动局部 + 有明确验收信号"。

**在范围内**：

1. DSH pin 升级 `0.1.1-rc.2 → 0.1.2-alpha.1`（P1-DSH-01 pin 部分）；
2. 真正的 backward cursor 历史分页（P1-SESSION-01 cursor + P2-UX-01 按钮无前进）；
3. SSE 慢客户端 pending Map 容量上限（P1-SESSION-01 背压部分）；
4. replay truncation 用户可见提示（P2-UX-01 截断提示部分）。

**明确不在范围内**（保持报告原裁决，登记为后续顺序）：single-owner daemon、executor 进程隔离、authoritative Session log、ACP vertical slice、Collaborate→Deliver、RunPlan 全字段绑定、project router 拆分。这些是季度级重构，本轮不扩张。另登记一项低成本遗留：P1-DATA-01 的迁移后 `foreign_key_check` 独立验证（报告 §4 建议项），非用户可感知缺陷，本轮不纳入，避免下轮遗漏。

## 2. 产品细节

### 2.1 历史分页语义（用户可感知）

- "加载更早历史"按钮必须**真正向前推进**：每次点击后，事件窗口的最小 seq 严格变小；若没有更早可见事件，按钮禁用并显示"已加载最早历史"。
- 修复当前缺陷：返回非空但未前进时 retainFloor 虚增，导致误显示"已加载最早历史"。
- 截断提示：当 SSE 重连因预算超限切换到尾窗时，Session 顶部显示非阻断提示条："连接恢复时历史量超过在线回放预算，已切换到最近记录；完整历史仍可按页读取。" 用户可关闭。

### 2.2 DSH 版本诚实语义

- `dsh --version` 与 pin 不符时，错误信息中的 tested 版本更新为 `0.1.2-alpha.1`；
- 文档/CHANGELOG 如实标注：fixture 契约已更新到 `0.1.2-alpha.1`，但**真实 Provider smoke（带 API key）待有 dsh 二进制的环境执行**，不声称已完成兼容验证。

## 3. 设计细节

### 3.1 backward cursor 合同

新增 RPC 输入字段 `beforeSeq`（可选，非负整数）。当提供 `beforeSeq` 时走 backward 路径：

```text
input: { sessionId, beforeSeq, limit }
server:
  raw = SELECT * FROM session_events
        WHERE session_id = ? AND seq < ?
        ORDER BY seq DESC LIMIT (limit + 1)
  hasMore = raw.length > limit
  visible = presentEvent 过滤后按 seq ASC 排序
  nextBeforeSeq = 本页返回的最小 raw seq（下一页 WHERE seq < nextBeforeSeq，天然不重复边界行；hasMore=false 时为 null）
output: { events, hasMore, latestSeq, nextBeforeSeq }
```

- 客户端 `loadEarlier` 改为传 `beforeSeq = earliestSeq`，不再用 `sinceSeq = earliest - limit - 1` 伪分页；
- 客户端只在 `nextBeforeSeq` 严格变小时认为发生进展，retainFloor 才累加；
- **"到底"信号统一为 `nextBeforeSeq === null`**：`sessionEventsOutputSchema` 中 `nextBeforeSeq` 为可空 number；客户端 `setHasEarlier(false)` 只认 `nextBeforeSeq === null`，**删除现有"空数组即 `setHasEarlier(false)`"旧分支**（`use-session-stream.ts` 收到 `events.length===0` 就停的逻辑正是本轮要修的 bug）；
- 空 visible page 但 `hasMore` 为真时，用 `nextBeforeSeq` 继续翻（不中断）。

### 3.2 SSE pending Map 容量上限

- `sse.ts` 的 `pending` Map 增加容量上限，**事件数与字节双维度**（与 catch-up 的 `RECONNECT_MAX_EVENTS/BYTES` 对齐，避免少量超大 payload 绕过纯计数上限）；
- 超限时：停止接收新事件进入 pending，发送 `replay-truncated` 控制帧（带当前 cursor），关闭连接让客户端重连到尾窗；
- 复用现有 `replay-truncated` 路径，不新增帧类型。

### 3.3 truncation 提示 UI

- `session-stream.ts` 的 `replay-truncated` 分支新增 `onTruncated` 回调（可选）；
- `use-session-stream.ts` 暴露 `truncated` 状态；
- EventFeed 顶部渲染非阻断 banner（`role="status"`，可关闭），不阻塞事件流。

## 4. 实现细节

### 4.1 DSH pin

- `packages/core/src/runtime/dsh-bridge-probe.ts`：`TESTED_DSH_VERSION = '0.1.2-alpha.1'`；
- 重新生成 fixture：
  - `packages/core/__tests__/fixtures/dsh/version.txt` → `0.1.2-alpha.1`；
  - `headless-help.txt` / `headless-dump-default-config.txt`：用官方 `0.1.2-alpha.1` 实测输出替换（本机无 dsh 二进制，用官方仓库 `packages/bundle/headless/src/startup.ts` 的 description 文案与 `--dump-default-config` 插件列表核对后更新；锚点为子串/存在性匹配，已确认五个插件 id 与 help anchor 在 `0.1.2-alpha.1` 全部存在）；**fixture 头部注释标注来源为"官方 `cd5ef81` 代码核对"，不写成"本机实测"，避免误导为真实录制**；help 正文需包含 upstream 新增的 "stream reasoning to stderr" 文案，避免版本号与 help 正文漂移；
- L1 fixture 测试证明 parser 仍接受；L2 live probe 保持 opt-in（`DSH_CLI_PATH`）。

### 4.2 历史分页

- `packages/core/src/session/session-store.ts`：新增 `listEventsBefore(sessionId, beforeSeq, limit)`，SQL 用 `seq < ? ORDER BY seq DESC LIMIT ?+1`；
- `packages/web/src/shared/rpc-contract.ts`：`sessionEventsInputSchema` 增加 `beforeSeq`；`sessionEventsOutputSchema` 增加 `nextBeforeSeq`；
- `packages/web/src/server/api/routers/session.ts`：`events` 方法在 `beforeSeq` 存在时走 backward 路径，返回 `nextBeforeSeq`；
- `packages/web/src/client/hooks/use-session-stream.ts`：`loadEarlier` 改用 `beforeSeq`，按 `nextBeforeSeq` 判断进展；
- 保留 `sinceSeq` 前向路径（SSE catch-up / 初始 tail 仍用），不破坏现有调用。

### 4.3 SSE 背压上限

- `packages/web/src/server/sse.ts`：`pending` Map 加 `MAX_PENDING_EVENTS`，超限触发截断 + 关闭。

### 4.4 truncation 提示

- `packages/web/src/client/lib/session-stream.ts`：`openSessionStream` options 增加 `onTruncated`；
- `packages/web/src/client/hooks/use-session-stream.ts`：新增 `truncated` 状态 + `dismissTruncated`；
- `packages/web/src/client/components/sessions/EventFeed.tsx`：顶部 banner。

## 5. 测试计划（测试先行）

### 5.1 单元/集成

- `dsh-bridge-contract.test.ts`：L1 fixture 断言新 pin `0.1.2-alpha.1`；
- `session-store` 测试：`listEventsBefore` 返回 DESC 原始页、hasMore、边界（beforeSeq=0/1）；
- `session-read-api.test.ts`：backward cursor 连续内部事件页能通过 `nextBeforeSeq` 继续翻，不中断；
- `session-sse.test.ts`：pending Map 超限时发 `replay-truncated` 并关闭连接；
- `use-session-stream` / `session-stream` 测试：`onTruncated` 被调用、retainFloor 只在 cursor 前进时累加。

### 5.2 e2e

- `packages/web/__tests__/e2e/event-feed-boundary.test.ts` 或新增：长历史"加载更早"按钮真实向前推进；
- 新增 truncation banner e2e：模拟 `replay-truncated` 帧后 banner 出现、可关闭、不阻塞事件流。

### 5.3 全量回归

- `pnpm test` 全绿；`pnpm typecheck` 全绿；
- Web Playwright e2e 全绿，UI 无错位/重叠（banner 不遮挡事件流）。

## 6. 验收标准

1. `pnpm test` 全绿（含新增测试）；
2. `pnpm typecheck` 全绿；
3. `TESTED_DSH_VERSION = '0.1.2-alpha.1'`，L1 fixture 测试通过；
4. `loadEarlier` 用 `beforeSeq`，构造"连续 >5 raw 页全为内部事件"的数据（正好触发旧 `MAX_PAGE_SCANS=5` 空页 bug），断言仍能推进到 `nextBeforeSeq=null`，retainFloor 不虚增；
5. SSE pending Map 有容量上限：单测注入超上限事件后断言 `pending.size` 不超过上限、发出一帧 `replay-truncated`、连接进入关闭/重连；
6. truncation banner 出现且可关闭，UI 无错位；
7. 文档（CHANGELOG / current.md / 报告）如实标注 DSH 真实 smoke 缺口；
8. reviewer 循环复查无必须修复项。

## 7. 版本与文档

- 本次为 bug 修复 + 行为改进（历史分页正确性、背压上限、截断提示、pin 升级），按 SemVer 评估为 **MINOR**（`0.19.0 → 0.20.0`）：历史分页与 truncation 提示是用户可感知行为变化，pin 升级改变 tested 版本合同。
- 同步更新：`package.json` version、`CHANGELOG.md`、`docs/reviews/current.md`、本报告第 16 节状态、报告第 11 节 P1-SESSION-01/P2-UX-01/P1-DSH-01 状态行、`docs/manual/tekon-user-manual.md` + `.html`（历史分页与截断提示是用户可感知行为）。
- 验收增加一项：`tekon-user-manual.html` 与 `.md` 内容一致，无两份漂移。
