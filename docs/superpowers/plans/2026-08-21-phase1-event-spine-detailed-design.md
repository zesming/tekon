# Tekon Harness-inspired Replatform 阶段 1 详细技术方案(v3.3 最终评审修订版)

> 基线:`review/deepseek-harness-migration-2026-08-20` @ `2aa49d4`(v0.8.0,阶段 0 已完成)
> 契约:`packages/core/src/types/session-contract.ts`(schema v1 冻结草案)
> 关联:`docs/superpowers/plans/2026-08-20-harness-replatform-execution-plan.md` §4 阶段 1(约束 C1 治理零退化最高优先)
> 范围:Event Spine(5 表 + dual-write)+ 真实后台 Job + SSE + AbortSignal/子进程注册表 + **P0-01/02 修复、P0-03 服务端强制、P1-04 修复、P1-05 部分缓解(仅 interrupted + CLI 适配)、P1-07 run 级状态机 validator** + 评审必修 M1–M9、MF1–MF4
> 不在范围:流式 AgentDriver/turn-step 循环(阶段 2)、Session UI(阶段 3)、CLI 接入 Session(阶段 4)、插件化(阶段 4)、P1-07 的续聊/转向(阶段 2)
> 修订:2026-08-21 v3——v2 整合一轮 reviewer 必修 M1–M9 + 建议 S2–S15;**v3 整合二轮 reviewer 必修 MF1(cancel 缺 session 终态/事件)、MF2(resume 不防双活跃 job)、MF3(web reject 复活终态 run)、MF4(audit 单队列化死锁)+ 建议 SHOULD3/4/5/7/9/13/15/16/17/19/20**;**v3.1 整合三轮 reviewer 必修 M1(cancel 赢竞态时 engine passed 写抛通用错→误判 job failed;改 helper 抛 WorkflowTerminalError)、M2(paused-job 处理规格矛盾 + resume 变 cancel + stale-paused 永久 409;改 cancelStaleActiveJobs/requeueStale/resume 守卫)**;**v3.2 整合确认轮 reviewer 必修 Gap A(helper read→write 非原子致 lost-update,改 CAS 条件写 `casWorkflowInstanceStatus`)、Gap B(paused→passed 抛通用错,engine 末写前补 pause 检查)、Gap C(paused 期间 heartbeat 续租未规格化,明文"running/paused 一视同仁续租")**;主 agent 已逐条源码核验属实。§0.3 为 4 项已定裁决;§8 为决策记录。
>
> **v3.3 整合最终确认轮 reviewer 必修 MUST-FIX 1(pause/running 恢复等"与 engine 并发的状态写"须全部走 CAS,不止 helper;pause 无条件写会覆盖终态——触验收标准 9;helper `paused→passed` 改返回 written=false 不抛错)、MUST-FIX 2(checkpoint fencing 允许 `paused` 状态,否则 node 执行中 pause 会确定性把 job 打成 failed)**。最终确认轮结论:**v3.2 可进入实施,MUST-FIX 1/2 作首批 test-first 用例**;v3.3 已将两者落到规格。设计冻结,进入实施。

## 0. 关键设计决策(先于细节)

### 0.1 基础架构决策(v1 保留,措辞收紧)

1. **dual-write 挂在 web 组合根,不进 engine 内部**:`createApiCaller` 里用 `DualWriteAuditLogger` + `DualWriteRepositories` 包住现有 audit/repositories,engine、gate-runner、adapter、web router 全部无感获得 dual-write。engine 子模块零改动。CLI 路径本阶段不包 dual-write(CLI 维持纯旧链路,理由见 §6 R7),但 **CLI 必须适配 core 行为变更(M5/M8),不是零改动**。
2. **dual-write 是 best-effort**:session_events 是新可观测脊柱,绝不能拖垮治理路径(C1)。包装器先委托原 audit(哈希链不变),再 best-effort 写 session_events,失败仅记录。配对账测试兜底(§4.3)。
3. **startRun 拆成 `prepareRun`(持久化,毫秒级)+ `executePreparedRun`(执行)**:web RPC 调 `prepareRun` 后 enqueue 立即返回;CLI 继续调 `startRun`(= prepareRun + execute,行为不变,C2)。
4. **终态操作统一抛 `WorkflowTerminalError`(P1-04 + M8)**:resumeRun 终态抛错(替换被所有调用方忽略的 `as unknown as WorkflowEngineResult` error 对象);**human-gate 的 approve/reject 落库前同样检查终态**(M8,防 cancelled run 被审批复活)。错误带 `code: 'WORKFLOW_TERMINAL'`,CLI/Web 各自做干净错误映射。
5. **Workflow 状态机 validator 只约束"外部控制面"写入**(web pause/cancel/resume、job runner 的 cancel/pause),engine 内部状态写入保持原样(它是状态机 owner,且被 20 个 core e2e 锁定)。**终态写入一律走幂等 helper(M2,见决策 9),validator 自身保持严格、不加 self-transition 放行。**
6. **Job Runner 是单进程 SQLite 轮询 runner**:原子 claim(单语句 `UPDATE ... WHERE id=(SELECT ...) AND status='queued'`,不依赖 `UPDATE...LIMIT`) + lease 心跳 + stale lease 恢复 + fencing checkpoint。不引入外部队列。
7. **SSE 鉴权用 `x-session-token` 头 + fetch 流式读取**(不用 EventSource,因其不能设头),复用现有 `assertSessionTokenFromFile`;**先订阅后回放(M6),消除回放/订阅交界丢事件窗口**。

### 0.2 评审整合决策(M1–M9、S2–S15)

8. **M1——`workflow/started` 由 router 显式补发**:`prepareRun` 内部 append `run.started` 时 session 尚未建,dual-write 按"查不到 session 静默跳过"规则会永久丢失该事件。改法:`project.run` 在 `createSession` 之后由 router 显式 append `workflow/started`(payload `{runId, templateId, mode, kind:'workflow'}`)。**通则:凡"session 创建晚于 run 首个 audit"的事件,一律由 router 在 createSession 后显式补发,不靠 audit dual-write 兜底。** 映射表第 1 行据此标注。
9. **M2——终态写入幂等(选方案 a)**:cancel 会在 web(running→cancelled)、job executor、node-executor 三处写 cancelled;后两次时状态已是 cancelled,而 `cancelled: []` 不允许自转移 → 抛错 → job 误判 failed。定稿:**新增幂等写 helper `writeWorkflowTerminal`(写前 re-read,已是目标终态则跳过、不写库、不发 audit、不经 validator);三个 cancel 写入点(web project.cancel、job executor signal-aborted、node-executor abort)全部改用 helper。** 不选方案 b(validator self-transition no-op 放行)——validator 保持严格,幂等语义收敛在调用侧 helper,blast radius 最小。
10. **M3/M4——cancel 与 requeue 的终态语义**:
    - M3:`requestCancel` 时若 job 无 owner(queued,无 controller/无子进程/lease 为 NULL),直接置 `cancelled` + `abortState='stopped'`,不进 abort 流程(否则 queued job 永不到终态:claimNext 只捞 queued、requeueStale 要 lease<ttl)。
    - M4:`requeueStale` 对 `abortState IN ('requested','propagated')` 的 stale job 直接置 `cancelled`(仅 `abortState='none'` 的才 requeue 回 queued)——否则用户已请求取消的任务会被重跑,构成治理事故(C1)。
11. **M6——SSE 先订阅后回放**:先 `bus.subscribe`(live 事件入内存缓冲)→ 再 `listEventsSince` 回放并记 `maxReplayedSeq` → flush 缓冲中 `seq > maxReplayedSeq` 的事件(按 seq 去重)→ 转纯 live。回放/订阅交界零丢失。
12. **M7——控制面校验顺序写死**:`assertSessionToken` → `assertRunInScope` → `assertWorkflowInstanceTransition`(或 `writeWorkflowTerminal` 内部校验)→ 写库。**validator 绝不先于 token/scope 校验**,避免击穿既有 web 鉴权测试。
13. **M8——终态不可复活(C1 治理)**:`approveHumanGate`/`rejectHumanGate` 落库前检查 workflow 是否终态(passed/failed/cancelled),终态则抛 `WorkflowTerminalError`,保护所有调用方(CLI+Web);`LEGAL_WORKFLOW_TRANSITIONS` 保持 `cancelled: []`;web gate router 在 enqueue 前做同样检查并映射为 400。
14. **M9——`gate.approve` 异步化**:web `gate.ts` approve 分支现状是"updateHumanDecision → 同步 `resumeWorkflowRun`(阻塞,P0-01 同类)",且 executor 在 human gate 已把 job 置 done,approve 续跑无活跃 job → cancel 中断失效(P0-02 回退)。定稿:approve 改为"终态校验(M8)→ 更新 decision → enqueue `workflow-resume` job → 立即返回 `{decision, sessionId?, jobId?}`";write-auth 里 approve 相关用例改轮询至终态。**优先做成异步,不保留同步路径。**
15. **S2——executor 的 workflow→session 状态映射改对**:engine 等人审批时置的是 workflow `paused`(`human-gate.ts:40`),不是 blocked;blocked 只在依赖缺失/gate 耗尽。executor 结合 pending human decisions 判定 session:`paused` + 有 pending decision → `awaiting-approval`;`paused` 无 pending → `idle`;`blocked` → `awaiting-input`。
16. **S3——同 run 不允许双活跃 job**:resume/approve enqueue 前,把该 run 的可安全清理旧 job(**queued + stale paused**,见 §2.2)置 `cancelled` + `abortState='stopped'`(契约 job 状态无 superseded,用 cancelled);live paused/running/cancelling 不动、交 resume 守卫判 409(M2);`findActiveByRunId` 按 `created_at DESC` 取最新。
17. **S4——孤儿进程/双跑 worktree 记为阶段 1 已知限制**:crash 后 detached provider 子进程成孤儿 + requeue 双跑同 worktree;缓解(jobs 持久化 pid、requeue 前 best-effort 杀进程组)排阶段 2 前,不在阶段 1 强做。见 §6 R10。
18. **S5——crash recovery e2e 两个崩溃点**:① 崩溃点在 node 之间(先 stop 原 runner 再改 lease 再起新 runner);② node 执行中崩溃 → node 置 interrupted → resume 恢复跑完。
19. **S6——audit append 单队列化(MF4:防死锁)**:`createAuditLogger` 新增可选 `db` + `writeQueue` 参数。**关键:不能在 writeQueue 任务内再调 `repositories.appendAuditEvent`(那会在同一串行队列上再 enqueue → 自等待死锁)。** 传入 `{db, writeQueue}` 时,append 走 `writeQueue.enqueue(() => { 同步 select 末条 hash → 算 hash → 直接 db.prepare(insert audit_events) })`——读-算-写在**同一队列任务内直接操作 db**,不经 repositories 再入队。不传 `{db, writeQueue}` 时保持现状(listAuditEvents + appendAuditEvent 两段,CLI 用,同 run 串行自负)。web 组合根**必须**传共享 `{db, writeQueue}`。补并发 append 测试(§4.1)。
20. **S7——engine 自建 gateEngine 的 gateway 也接 registry(二选一定稿)**:选"接 registry"——`CreateWorkflowEngineOptions` 新增可选 `registry`,engine 内部 fallback gateEngine 的 `createCommandGateway` 透传 registry;gate 命令 spawn 时以 runId 为 key register,cancel 时 `killAll(runId)` 同时覆盖 agent 子进程与 gate 命令子进程。web/executor 构造 engine 时传同一 registry;CLI 不传(gate 命令不可中断,同现状)。不选"仅声明 gate 命令边界可取消"——cancel 必须能中断 gate 执行中的命令,否则 P0-02 留缺口。
21. **S8——modelVisible 事件不做 64KB 硬截断**:`present.ts` 对 `modelVisible: true` 的事件放宽限长上限到 1MB(`MODEL_VISIBLE_MAX_BYTES`),超过仍截断;留 TODO(spill reference 阶段 2 才有)。非 modelVisible 保持 64KB。
22. **S9——"显式不映射的 audit 类型"出精确清单**(见 §1.2 末);对账测试断言精确到类型清单:映射集合 == 预期清单,且实际出现的不映射类型 ⊆ 显式清单(不许漏网)。
23. **S12——`project.run` 既有同步校验全部保留在 prepareRun/enqueue 之前**:`assertCleanBase`、template 校验(`assertSafeName` + `loadWorkflowTemplateFile`)、agent runtime 构造(`createWebAgentRuntime`)、P0-03 审批双校验、demandText 非空。**不得下沉到后台 job**——否则 dirty base 会劣化为 200+ 后台 failed。
24. **S13——实现步骤拆 S7a/S7b/S7c/S7d**(见 §5),每步独立可验;既有 web 测试改轮询后,**`api.close()` 前必须等 job 到终态**(否则 stop() 切断在跑 job)。
25. **S14——`jobs.payload` 是契约外附加列**:JobRepository 所有返回值必经 `jobSchema.parse`(zod 默认 strip 剥离 payload);加往返测试断言 payload 不进契约层对象。
26. **S15——不留死代码**:本阶段只加 `markRoleRunInterrupted`(abort/中断用);`markRoleRunFailed` 本阶段无调用点,**不加**(agent 非 signal 失败路径维持现有 interrupted 语义;未来需要 failed 时再补)。

### 0.2b 二轮评审整合(MF1–MF4 + SHOULD,主 agent 已核验)

- **MF1**——cancel 的 session 终态更新 + `agent/cancel-requested`/`agent/cancelled` 发射由 **web cancel 路径统一负责**(§2.10),不依赖 executor 是否运行(修复"queued 窗口/无活跃 job cancel 时 session 与 workflow 状态不一致、缺终态事件");executor signal-aborted 分支只幂等置 session,不再发 `agent/cancelled`(单一发射点,不双发)。
- **MF2**——`project.resume`(及 gate.approve 防御性同改)在清理 queued 旧 job 后 `findActiveByRunId`,仍有 `running`/`cancelling` job → **409**,不 enqueue(闭合"同 run 不允许双活跃 job",防双 engine 并发执行、artifact unique 冲突)。
- **MF3**——web reject 是 `gate.ts` 内联实现、绕过 core `rejectHumanGate`,故在 web reject 分支补 `getWorkflowInstance` 终态检查 → 400(否则 `cancelled → reject → blocked → resume → running` 可复活;§2.11)。
- **MF4**——S6 audit 单队列化**不得**在 writeQueue 任务内再调 `repositories.appendAuditEvent`(同队列再入队 → 自等待死锁);改为队列任务内**直接 db 写**(logger 注入 `{db, writeQueue}`,§0.2-19/§2.10)。
- 已整合建议:SHOULD3(SSE flush drain 交接)、SHOULD4(stale-running 路径也置 role_run interrupted)、SHOULD5(e2e 经 dual-write 组合根)、SHOULD7(dual-write 不拦截 workflow status 写入,防完成事件双发)、SHOULD9(CLI reject try/catch 中文)、SHOULD13(settle 前 owner fencing)、SHOULD15(SSE 经 ApiCaller 暴露 sessions/bus + origin 校验)、SHOULD16(pause 正向用例 + cancel 对终态 run 行为变化)、SHOULD17/19(journey B 两次 job + latch adapter)、SHOULD20(`run.demand-shaped` audit 移至 prepareRun 后)。
- 二轮 reviewer 判定 M1–M9 主体闭合;MF1–MF4 为规格层缺口,改法已落到 §2/§3/§4;其余 SHOULD 已记录。



1. **P0-03 文件式强制,注册表不进阶段 1**:服务端 resolve 路径 + 重读文件 + approved/readyForRun 双校验 + audit 证据;残余面(恶意客户端走自由文本)设计合法,验收记录口径。
2. **CLI 阶段 1 只适配 core 变更(M5/M8),不接入 Session**(阶段 4)。
3. **SSE 用 `x-session-token` 头 + fetch 流式;SSE 分支在 `setSecurityHeaders` 之后**(`http.ts:52` 已是该顺序,新增分支保持)。
4. **run 级完成用 `agent/status`(payload 加 `kind:'workflow'`),不改冻结契约。**

## 1. 数据模型

### 1.1 五张新表 DDL

加在 `packages/core/src/db/migrations.ts` 的同一个 `db.exec` 块内(沿用小写 `create table if not exists` 风格),`WORK_USABLE_SCHEMA_VERSION` 3 → 4。不动任何旧表/旧列(C3)。

```sql
create table if not exists workspaces (
  id text primary key,
  root text not null,
  repo text,
  branch_policy text,
  permission_profile text,
  created_at text not null
);

create table if not exists sessions (
  id text primary key,
  workspace_id text not null references workspaces(id),
  title text,
  profile text not null,
  status text not null,
  run_id text,                       -- 软关联 workflow_instances.id，不加 FK（双轨解耦）
  created_at text not null,
  updated_at text not null
);
create index if not exists idx_sessions_run_id on sessions(run_id);

create table if not exists session_events (
  id integer primary key autoincrement,
  session_id text not null,
  seq integer not null,              -- 单 session 单调递增，append 时在 writeQueue 内 max(seq)+1
  type text not null,
  version integer not null,          -- 固定 SESSION_EVENT_SCHEMA_VERSION = 1
  timestamp text not null,
  payload text not null default '{}',
  visibility text not null default 'ui-only',   -- model | ui-only | internal
  model_visible integer not null default 0,
  source_event_seqs text not null default '[]',
  correlation_id text,
  unique(session_id, seq)
);
create index if not exists idx_session_events_session_seq
  on session_events(session_id, seq);

create table if not exists jobs (
  id text primary key,
  session_id text not null,
  kind text not null,                -- workflow-run | workflow-resume
  status text not null,              -- queued|running|paused|cancelling|cancelled|failed|done
  owner text,                        -- worker 标识 web-<pid>-<rand>
  lease text,                        -- 心跳时间戳（ISO），stale 判定依据
  abort_state text not null default 'none',  -- none|requested|propagated|stopped
  checkpoint text,                   -- 例 node:<nodeId>
  payload text not null default '{}', -- {runId}，契约外附加列（S14，读出时经 jobSchema.parse 剥离）
  created_at text not null,
  updated_at text not null
);
create index if not exists idx_jobs_status_created on jobs(status, created_at);

create table if not exists projection_checkpoints (
  session_id text not null,
  projection_name text not null,
  last_seq integer not null,
  updated_at text not null,
  primary key (session_id, projection_name)
);
```

与 `session-contract.ts` 对齐说明:
- `SessionEvent.payload`(record)→ JSON text;`modelVisible`(boolean)→ integer;`sourceEventSeqs`(array)→ JSON text;`correlationId` nullable。读出时经 zod `sessionEventSchema.parse` 校验,与契约逐字段一致。
- `Job` 字段一一对应;**`jobs.payload` 是 runner 实现细节,契约外的附加列**(契约 `Job` 不含 payload,S14):runId 以 `sessions.run_id` 反查为准,payload 列仅作调试冗余;JobRepository 所有返回值经 `jobSchema.parse` 剥离 payload。
- `projection_checkpoints` 本阶段只建表 + 提供 upsert/read 接口,不实现具体 projection(阶段 3 UI feed 时启用)。

### 1.2 dual-write 事件映射表

包装器在事件发生时按 runId 反查 session(`sessions.run_id` 索引);查不到 session(旧 run)则静默跳过。

**dual-write 对 `updateWorkflowInstanceStatus` 的拦截规则(SHOULD7,防双发)**:workflow 状态写入中,**只有 `status='cancelled'` 需要 dual-write 拦截产出 `agent/cancelled`**(因为 abort 路径经幂等 helper 落库、无对应 audit)——但 MF1 已把 `agent/cancelled` 收敛为 web cancel 路径**显式** append,故 **dual-write 对 workflow 状态写入一律不拦截**(passed/failed 已由 audit `run.passed`/`run.*` 映射为 `agent/status`,再拦截会双发)。dual-write 只拦截**仓储层数据写入**(recordGateResult/recordArtifact/createHumanDecision/updateHumanDecision)与 **audit 事件**两类,不拦截 workflow/node status 写入。§4.1 S9 精确清单测试兜住"无双发"。

| 现有动作(触发点) | session event type | payload(已脱敏/摘要化) |
|---|---|---|
| audit `run.started`(engine.prepareRun) | `workflow/started` | `{runId, templateId, mode, kind:'workflow'}` —— **web 路径由 router 在 createSession 后显式补发(M1);prepareRun 内 audit run.started 的 dual-write 因 session 不存在被静默跳过,不再兜底** |
| audit `run.resumed`(engine.resumeRun) | `workflow/started` | `{runId, resumed: true, kind:'workflow'}` —— web resume/approve 路径 enqueue 前已确保 session 存在(§2.10/§2.11),不丢 |
| audit `run.passed`(executePlan) | `agent/status` | `{runId, status: 'passed', kind: 'workflow'}` |
| audit `node.started`(node-executor:163) | `workflow/node-started` | `{runId, nodeId, role}` |
| audit `node.passed`(node-executor:287 经 checkedTransitionNode) | `workflow/node-ended` | `{runId, nodeId, status: 'passed'}` |
| audit `node.interrupted`(node-executor:216) | `workflow/node-ended` | `{runId, nodeId, status: 'interrupted', error}` |
| audit `node.resumed-at-gates`(node-executor:137) | `workflow/node-started` | `{runId, nodeId, resumed: 'at-gates'}` |
| audit `node.stale-running-detected`(node-executor:111) | `workflow/node-ended` | `{runId, nodeId, status: 'interrupted', reason: 'stale-running'}` |
| audit `pmo.node-checkpoint`(node-executor:311) | `job/checkpointed` | `{runId, nodeId, status, missingArtifacts}` |
| audit `artifact.dependency.missing`(node-executor:66) | `agent/status` | `{runId, nodeId, status: 'blocked', missing: {fromNodeId, type}}` |
| audit `gate.execution.error`(node-executor:251) | `agent/error` | `{runId, nodeId, message}` |
| audit `worktree.lease.created`(lease-service:69) | `worktree/leased` | `{runId, nodeId, leaseId, branchName}`(不含 worktreePath) |
| audit `worktree.lease.finalize.failed`(node-executor:272) | `agent/error` | `{runId, nodeId, message}` |
| repo `recordGateResult`(包装) | `gate/result` | `{runId, nodeId, gateType, gateKey, status, durationMs, retries}` |
| repo `recordArtifact`(包装) | `artifact/created` | `{runId, nodeId, artifactId, type, version, sha256, sizeBytes, summary}`(不含 path) |
| repo `createHumanDecision`(status=pending) | `approval/requested` | `{runId, nodeId, decisionId, request}` |
| repo `updateHumanDecision` | `approval/decided` | `{runId, nodeId, decisionId, decision, actor}` |
| web cancel 请求(job runner) | `agent/cancel-requested` | `{runId, reason}` |
| engine 检测到 abort 并落终态 | `agent/cancelled` | `{runId}` |
| router 显式补发(无 audit 对应,M1) | `workflow/started` | `{runId, templateId, mode, kind:'workflow'}` |
| router/executor 会话生命周期 | `session/created` / `user/message` / `turn/start` / `turn/end` / `assistant/message` | 见 §2.5/§2.10 |

**显式不映射的 audit 类型完整清单(S9,对账测试精确断言此清单)**:

- gate 类:`gate.passed`、`gate.passed-after-repair`、`gate.passed-after-rework`、`gate.previously-passed`、`gate.repair.created`、`gate.repair.failed`、`gate.rework.attempt`、`gate.rework.completed`、`gate.rework.failed`、`gate.rework.lease.finalize.failed`、`gate.rework.review.re-execute.failed`、`human.gate.pending`、`human.gate.approved`、`human.gate.rejected`、`qa.validation.ref`(gate 结果已由 `gate/result` 事件覆盖;human.gate.* 是 web/CLI 审批动作的审计,决策本身由 `approval/decided` 覆盖);
- worktree 类:`worktree.lease.promoted`、`worktree.lease.released`(lease 生命周期由 `worktree/leased` + node 终态事件覆盖);
- run 级:`run.demand-shaped`(P0-03 治理证据,留 audit 链,不进 session 脊柱);
- delivery/eval 模块:`delivery.ci.checked`、`delivery.ci.watch-completed`、`delivery.pr-prepared` 等 `delivery.*`、`ac-evidence`、`build`、`ci-status`、`delivery-package`、`e2e-pass`、`independent-review`、`lint`、`process-completeness`、`qa-signoff`、`role-scope`、`schema`、`security-scan`、`test`(与 workflow run 无直接事件映射;阶段 3+ 按需增补);
- `node.transition.checked`(被 `node.started`/`node.passed` 覆盖)。

契约词汇表无 `workflow/ended`:run 级完成统一用 `agent/status`(legacy engine 在兼容模型里就是 agent,报告 §8.4),**不修改冻结契约**。

## 2. 模块与接口

### 2.1 新增文件清单(packages/core)

```
packages/core/src/session/session-store.ts       # Workspace/Session/SessionEvent/Job 持久化
packages/core/src/session/event-bus.ts           # 进程内 pub/sub
packages/core/src/session/subprocess-registry.ts # 子进程句柄注册表
packages/core/src/session/job-runner.ts          # durable 轮询 runner（lease/心跳/恢复/fencing）
packages/core/src/session/dual-write.ts          # AuditLogger/Repositories 双写包装器 + 映射表
packages/core/src/session/present.ts             # 传输层脱敏/限长（复用 security/secrets.ts）
packages/core/src/workflow/errors.ts             # WorkflowTerminalError + isWorkflowTerminalError
```

全部从 `packages/core/src/index.ts` 导出(沿用现有 `export *` 模式)。

### 2.2 SessionEventStore / JobRepository(`session-store.ts`)

```ts
export interface SessionEventStore {
  getOrCreateDefaultWorkspace(root: string): Promise<Workspace>;
  createSession(input: {
    workspaceId: string; title: string | null;
    profile: string; runId: string | null;
  }): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  findSessionByRunId(runId: string): Promise<Session | null>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  appendEvent(input: {
    sessionId: string; type: string;
    payload?: Record<string, unknown>;
    visibility?: EventVisibility; modelVisible?: boolean;
    sourceEventSeqs?: number[]; correlationId?: string | null;
  }): Promise<SessionEvent>;               // seq 在 writeQueue 内 max(seq)+1
  listEventsSince(sessionId: string, sinceSeq: number): Promise<SessionEvent[]>;
  latestSeq(sessionId: string): Promise<number>;
  upsertProjectionCheckpoint(sessionId: string, name: string, lastSeq: number): Promise<void>;
}

export interface JobRepository {
  enqueue(job: Job): Promise<Job>;
  get(jobId: string): Promise<Job | null>;
  // S3：按 created_at DESC 取最新活跃 job；join sessions.run_id，
  // status in (queued,running,paused,cancelling)
  findActiveByRunId(runId: string): Promise<Job | null>;
  // S3/M2：enqueue resume/approve 前清理同 run 可安全清理的旧 job。
  // 只清 (a) queued（owner 必为 null，直接 cancelled/stopped）
  //      (b) stale paused（lease 已过期，owner 是死进程，cancelled/stopped）
  // live paused / running / cancelling 一律不动 —— 交给 resume 守卫判 409（M2）。
  // 实现注(S1 落地):stale 判据的 lease cutoff 应与 runner 的 leaseTtlMs 一致;
  //   S1 暂用模块常量 30s(= 默认 leaseTtlMs)。S4 落地 runner 可配 TTL 时,
  //   须把 cutoff 提为参数/注入,避免自定义 TTL 时 stale 判定偏离。
  cancelStaleActiveJobs(runId: string, exceptJobId?: string): Promise<number>;
  claimNext(owner: string): Promise<Job | null>;           // 原子 claim，SQL 见下
  updateJob(jobId: string, patch: Partial<Pick<Job, 'status' | 'owner' | 'lease' | 'abortState' | 'checkpoint'>>): Promise<Job | null>;
  requeueStale(leaseOlderThanIso: string): Promise<{ requeued: number; cancelled: number }>;  // M4
}

export function createSessionEventStore(db: TekonDatabase, writeQueue: WriteQueue): SessionEventStore;
export function createJobRepository(db: TekonDatabase, writeQueue: WriteQueue): JobRepository;
```

- 与现有 `createRepositories(db, writeQueue)` **共享同一个 writeQueue 实例**(组合根注入),保证旧表写入与新表写入的串行顺序。
- **S14**:`enqueue`/`get`/`findActiveByRunId`/`claimNext`/`updateJob`/`requeueStale` 的返回值一律经 `jobSchema.parse`(剥离 payload)后再返回;`payload` 只在 `enqueue` 时写入,之后不可变。
- **claim SQL(不依赖 `UPDATE...LIMIT`,better-sqlite3 打包的 SQLite 未必编译该语法)**:

```sql
update jobs
set status = 'running', owner = @owner, lease = @now, updated_at = @now
where id = (
  select id from jobs
  where status = 'queued'
  order by created_at asc
  limit 1
)
and status = 'queued';
-- 随后 select * from jobs where owner = @owner and status = 'running' order by updated_at desc limit 1;
```

  单语句原子 claim(内层 SELECT 与外层 UPDATE 在 better-sqlite3 同步执行中天然串行;若未来切 WAL 多连接,改 `BEGIN IMMEDIATE` 事务 + SELECT + UPDATE)。

- **requeueStale SQL(M4 + M2,一条语句分两支;`paused` 也纳入 stale 回收)**:

```sql
update jobs
set status = case when abort_state in ('requested','propagated') then 'cancelled' else 'queued' end,
    abort_state = case when abort_state in ('requested','propagated') then 'stopped' else abort_state end,
    owner = null, lease = null, updated_at = @now
where status in ('running','cancelling','paused') and lease < @cutoff;
```

  **(M2)`paused` 纳入 WHERE**:worker 在 requestPause 后、settle 前崩溃会遗留 `paused` job,若不回收则该 run 永久卡在"有活跃 job"→ resume 永久 409。stale `paused`(lease 过期)与 running/cancelling 同样回收:`abortState='none'` 的 paused → `queued`(可被重新 claim 继续),已请求 cancel 的 → `cancelled`。返回 `{requeued, cancelled}` 分别计数。

### 2.3 EventBus(`event-bus.ts`)

```ts
export interface SessionEventBus {
  publish(event: SessionEvent): void;
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void;
}
export function createSessionEventBus(): SessionEventBus;
```

`SessionEventStore.appendEvent` 不直接发 bus;由 dual-write/executor/router 在 append 成功后显式 `bus.publish`(保持 store 纯粹、可测)。

### 2.4 SubprocessRegistry(`subprocess-registry.ts`)

```ts
export interface SubprocessHandle {
  readonly pid: number | undefined;
  kill(signal: NodeJS.Signals): void;
}
export interface SubprocessRegistry {
  register(key: string, handle: SubprocessHandle): void;   // key = runId
  unregister(key: string, handle: SubprocessHandle): void;
  killAll(key: string, signal: NodeJS.Signals): number;
  list(key: string): readonly SubprocessHandle[];
}
export function createSubprocessRegistry(): SubprocessRegistry;
```

### 2.5 JobRunner(`job-runner.ts`)

```ts
export interface JobExecutionContext {
  job: Job;
  signal: AbortSignal;
  pauseRequested(): boolean;
  checkpoint(nodeId: string): Promise<void>;  // 落 jobs.checkpoint + fencing 自检（owner 变更则抛 JobFencingError）
}
export interface JobExecutor {
  execute(ctx: JobExecutionContext): Promise<{ status: JobStatus; summary?: string }>;
}
export interface DurableJobRunner extends JobRunner {
  start(): void;             // recoverStale() + 轮询循环（setInterval, unref）
  stop(): Promise<void>;     // 等在跑 job settle（上限 5s）后停止
  requestPause(jobId: string): Promise<void>;
  recoverStale(): Promise<number>;
}
export function createJobRunner(deps: {
  jobs: JobRepository; sessions: SessionEventStore; bus: SessionEventBus;
  registry: SubprocessRegistry; executor: JobExecutor;
  pollIntervalMs?: number;   // 默认 200
  heartbeatMs?: number;      // 默认 10_000
  leaseTtlMs?: number;       // 默认 30_000
  workerId?: string;
}): DurableJobRunner;
```

行为规格:
- `enqueue`:落 `status='queued'`,返回(返回值经 jobSchema.parse)。
- 轮询:`claimNext(workerId)` 原子 claim → `status='running'` + owner + lease;起后台任务执行 `executor.execute`,**每 `heartbeatMs` 续租,续租跟随"后台任务是否在跑"而非 job.status——`running`/`paused` 一视同仁续租,直到 executor settle(Gap C 红线:绝不因 status 变 paused 而停续租)**。
- `requestCancel(jobId, reason?)`(**M3**):
  1. re-read job;不存在直接返回;
  2. **若 `job.owner == null`(queued):直接 `updateJob(jobId, {status:'cancelled', abortState:'stopped'})`,不碰 controller/registry,发 bus 通知后返回**;
  3. 否则(running/paused):置 `abortState='requested'`、`status='cancelling'`;内存 `AbortController.abort()`;`registry.killAll(runId, 'SIGKILL')`;置 `abortState='propagated'`。executor 落终态后 `abortState='stopped'`。
- `requestPause(jobId)`:置内存 pause 标记 + 数据库 `status='paused'`;engine 在下一个 node 边界退出。**(M2 前提,必须实现)pause 标记置位到 engine 抵达边界这段窗口内,该 job 的后台任务仍在运行,`heartbeatMs` 续租不得停**——因此"live paused"(心跳续租中,lease 新鲜)永不被 `requeueStale` 误回收;engine 抵达边界后 executor 返回、workflow=paused → §2.5 映射 job=`done`(不再是 paused)。故 `status='paused'` 且 lease 过期**必然**是崩溃 worker(stale),`lease < cutoff` 判据成立、无误判。**实现红线:不得在 pause 时停心跳。**
- `checkpoint`:更新 `jobs.checkpoint`,re-read job——**若 owner ≠ 自己,或 status ∉ {running, paused},抛 `JobFencingError`**(**MUST-FIX 2:允许 `paused`——pause 常落在 node 执行期间,node 完成时 checkpoint 若拒 paused 会确定性把在跑 job 打成 failed、pause 主流程失效;与 settle fencing 只查 owner 的语义对齐**),engine 据此停手(防双跑)。
- `requeueStale`:按 §2.2 的 M4+M2 SQL——`abortState IN ('requested','propagated')` 的 stale job → `cancelled`;仅 `abortState='none'` 的 → `queued`(owner/lease 清空);**WHERE 含 `running`/`cancelling`/`paused`(M2:stale paused 也回收,防 resume 永久 409)**。
- executor settle 后:**先 re-read job 校验 owner==自己(SHOULD13 settle fencing:zombie executor lease 过期后醒来不得把 requeue/cancelled 的 job 翻成 done/failed)**,通过才按结果置 job `done/failed/cancelled/paused`,清 controller/标记,发 bus 通知;owner 已变则丢弃本次 settle。

**Web 侧 executor**(新文件 `packages/web/src/server/api/job-executor.ts`):

```ts
export function createWorkflowJobExecutor(deps: {
  repositories: TekonRepositories; audit: AuditLogger;
  projectContext: WebProjectContext; sessions: SessionEventStore; bus: SessionEventBus;
  registry: SubprocessRegistry;
}): JobExecutor;
```

每个 job 执行时:
1. 由 `job.sessionId` 反查 session → `runId`;
2. **`updateSessionStatus('active')`(S8:job 开始置 active,契约有该态)** + 发 `turn/start`(payload `{kind: job.kind}`);
3. 按 job.kind 构造 engine(复用 `project.run` 的 gateway/runtime 构造逻辑,抽成 `buildWorkflowEngine({repositories, audit, projectContext, runId, registry})`,web router 与 executor 共用;**S7:engine 构造时透传 registry**):
   - `workflow-run` → `engine.executePreparedRun(runId)`;
   - `workflow-resume` → `engine.resumeRun(runId)`;
   - engine options 注入 `signal`、`isPauseRequested`、`onNodeCheckpoint`(→ `ctx.checkpoint`);
4. 结果映射(**S2 修正版**):
   - workflow `passed` → job `done`,session `done`,发 `turn/end` + `assistant/message`(摘要,`modelVisible: true`);
   - workflow `paused` 且存在 pending human decision(查 `listHumanDecisions(runId)` 过滤 pending)→ job `done`,session `awaiting-approval`,发 `turn/end`;
   - workflow `paused` 无 pending decision → job `done`,session `idle`,发 `turn/end`;
   - workflow `blocked`(依赖缺失/gate 耗尽)→ job `done`,session `awaiting-input`,发 `turn/end`;
   - workflow `interrupted` → job `failed`,session `failed`,发 `agent/error` + `turn/end`;
   - `signal.aborted` → 经 `writeWorkflowTerminal` 置 workflow `cancelled`(M2 幂等)→ job `cancelled`,**session 幂等置 `cancelled`(不再发 `agent/cancelled`——MF1:该事件由 web cancel 路径单一发射)**,发 `turn/end`;
   - `WorkflowTerminalError`(enqueue 后 run 被他路置终态)→ job `cancelled`,session 维持原终态不变,发 `turn/end`(不算失败,不发 `agent/error`);
   - 其他异常 → job `failed`,session `failed`,发 `agent/error` + `turn/end`(message 脱敏后入 payload)。
5. 任何路径都不抛到 runner 外(runner 兜底 catch → job failed)。

### 2.6 engine 改造(`engine.ts` + `node-executor.ts`)

`CreateWorkflowEngineOptions` 新增四个**可选**字段(不传 = 旧行为,CLI 与全部既有测试零影响):

```ts
signal?: AbortSignal;
isPauseRequested?: () => boolean;
onNodeCheckpoint?: (nodeId: string) => Promise<void>;
registry?: SubprocessRegistry;   // S7：透传给内部 fallback gateEngine 的 gateway
```

`WorkflowEngine` 接口变为:

```ts
export interface WorkflowEngine {
  prepareRun(input: WorkflowEngineStartInput): Promise<{ runId: string; workflow: WorkflowInstance }>;
  executePreparedRun(runId: string): Promise<WorkflowInstance>;
  startRun(input: WorkflowEngineStartInput): Promise<WorkflowEngineResult>;  // = prepareRun + executePreparedRun
  resumeRun(runId: string): Promise<WorkflowEngineResult>;                  // 终态抛 WorkflowTerminalError
}
```

- `prepareRun`:现 `startRun` 第 182–231 行原样抽出(mkdir、demand/project/instance、provider config、persistPlan、audit `run.started`),返回 instance(初始 status 维持 `'running'`)。**audit `run.started` 保留在 prepareRun 内**(治理链需要),其 dual-write 丢失由 M1 router 显式补发兜底。
- `executePreparedRun`:`planFromRepository` + `executePlan`。
- `startRun` = 两者组合(CLI 不动)。
- `resumeRun`:终态分支改为 `throw new WorkflowTerminalError(runId, existing.status)`(新错误类,`code: 'WORKFLOW_TERMINAL'`,见 §2.7 末);其余不变。调用方适配见 §2.11(CLI)、§2.10/§2.11(web)。
- `executePlan` 每个 node 迭代顶部:
  ```ts
  if (options.signal?.aborted) { await settleCancelled(runId); return mustGetWorkflow(runId); }
  if (options.isPauseRequested?.()) { await repositories.updateWorkflowInstanceStatus(runId, 'paused'); return mustGetWorkflow(runId); }
  ```
  每个 node 完成后:`await options.onNodeCheckpoint?.(node.id)`(fencing 点)。
- **(Gap B 修复)`executePlan` 末尾写 `passed` 之前,再检查一次 signal/pause**:
  ```ts
  // 所有 node 跑完、写 passed 之前:
  if (options.signal?.aborted) { await settleCancelled(runId); return mustGetWorkflow(runId); }
  if (options.isPauseRequested?.()) { await repositories.updateWorkflowInstanceStatus(runId, 'paused'); return mustGetWorkflow(runId); }
  // 再 writeWorkflowTerminal(runId, 'passed', null)
  ```
  否则 `requestPause` 落在"末个 node 顶部检查通过后、passed 写之前"的窗口(时长 = 末个 node 执行时长,分钟级)时,helper re-read 到 `paused` → `paused→passed` 非法 → 抛通用 Error → executor 误判 job failed。加此检查后,该窗口内的 pause 会让 run 停在 `paused`(可 resume),不撞非法转移。
- **(Gap B + MUST-FIX 1 修复)helper 遇 `from='paused'` + `to='passed'`**:返回 **`{written: false, workflow: current}`**(不抛错)——语义是"并发 pause 赢了这次竞态,run 留在 `paused` 待 resume"。executePlan 据此返回 paused workflow,executor 既有 paused 映射(job `done` + session `awaiting-approval`/`idle`,§2.5)自然正确,**不再误判 job failed + spurious `agent/error`**。这覆盖两条路径:① Gap B 残留的毫秒窗口(末写前检查通过 → helper re-read 之间 pause 落库);② 任何非常规 `paused→passed`。stale-paused 主恢复路径仍经 resumeRun 置 running(engine.ts:256),helper 见 running、正常写 passed,不受影响。`LEGAL_WORKFLOW_TRANSITIONS` 的 `paused` 仍不含 `passed`(该转移非法,只是 helper 对它的**处置**是 written=false 而非抛错)。§4.3 journey B 断言恢复经 resumeRun(running→…→passed)。
- `node-executor.executeNode`:`runAgent` 前检查 signal(aborted 直接走中断路径);catch/finally 里按 signal 区分终态——aborted → node `interrupted` + **`writeWorkflowTerminal(repositories, runId, 'cancelled', node.id)`(M2 幂等)** + `markRoleRunInterrupted`;否则维持现有 interrupted 行为,但把遗留的 running role_run 用 `markRoleRunInterrupted` 置为 interrupted(修 P1-05)。**S15:本阶段不加 `markRoleRunFailed`。**
- **S7**:engine 内部 fallback gateEngine 构造改为 `createGateEngine({ repositories, gateway: createCommandGateway({ repositories, registry: options.registry }) })`;`CommandGatewayRunInput` 新增可选 `signal` + `registryKey`,gate 命令 spawn 后 `registry.register(registryKey, {pid, kill})`,settle 时 unregister。

### 2.7 状态机 validator + 幂等终态写 helper(`state-machine.ts` 扩展)

```ts
export const LEGAL_WORKFLOW_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  pending:     ['running', 'cancelled'],
  running:     ['paused', 'blocked', 'passed', 'failed', 'interrupted', 'cancelled'],
  paused:      ['running', 'blocked', 'cancelled'],
  blocked:     ['running', 'failed', 'cancelled'],
  interrupted: ['running', 'failed', 'cancelled'],
  passed:      [],
  failed:      [],
  cancelled:   [],
};
export function canTransitionWorkflowInstance(from: WorkflowStatus, to: WorkflowStatus): boolean;
export function assertWorkflowInstanceTransition(from: WorkflowStatus, to: WorkflowStatus): void;

// M2：终态幂等写 helper（所有 workflow 终态写入的唯一入口）
export async function writeWorkflowTerminal(
  repositories: TekonRepositories,
  runId: string,
  to: 'passed' | 'failed' | 'cancelled',
  currentNodeId?: string | null,
): Promise<{ written: boolean; workflow: WorkflowInstance }>;
```

`writeWorkflowTerminal` 行为(**Gap A:read→assert→write 非原子,须用条件写 CAS 收敛竞态**):
1. re-read workflow instance;不存在 → 抛错;记 `from = current.status`;
2. **若 `from === to` → 返回 `{written: false, workflow: current}`**(不写库、不发 audit、不经 validator——M2 方案 a);
3. **(M1 修复)若 `from` 已是**其他**终态(passed/failed/cancelled 之一,且 ≠ to)→ 抛 `WorkflowTerminalError(runId, from)`**——**不抛通用 assert 错误**。这样 executor 的既有分支"`WorkflowTerminalError` → job cancelled,session 维持原终态"(§2.5)可正确收敛"cancel 赢竞态、engine 随后写 passed"的时序,不会误落 job failed + spurious `agent/error`;
4. 否则(`from` 非终态)`assertWorkflowInstanceTransition(from, to)`(非法 → 抛通用 Error,不写库);
5. **(Gap A CAS)条件写**:`update workflow_instances set status=@to, current_node_id=@nodeId, updated_at=@now where id=@runId and status=@from`(新增仓储方法 `casWorkflowInstanceStatus(runId, from, to, nodeId)`,走 writeQueue);
   - **`changes===1`** → 写成功,返回 `{written: true, workflow}`;
   - **`changes===0`**(from 在 re-read 与写之间被他路改掉)→ **回到步骤 1 重判**(same-state→written=false;异终态→WTE;非终态→再 CAS)。最多重试 N 次(建议 3)后仍冲突则抛 WTE(视为已被他路终结)。

> **Gap A(必修,确认轮)说明**:原步骤 4 的 `updateWorkflowInstanceStatus` 是无条件写,`getWorkflowInstance`(裸读、不在 writeQueue)与写入队之间有 await 窗口 → lost update:engine re-read running、web cancel re-read running、cancel 写 cancelled 入队、engine assert 通过写 passed 入队 → passed 覆盖 cancelled,取消被静默丢失。CAS(`where status=@from`)把"读到的前态"带进 SQL 原子条件,changes=0 即前态已变、重判,消除窗口。§4.2 state-machine 测试补"re-read 与写之间插入他写(mock repositories 在 CAS 前改状态)→ CAS 返回 0 → 重判为 WTE/written=false"确定性用例。

> **M1 竞态说明**:web 组合根共享单一 writeQueue,engine 的 passed 写(经 helper)与 web 的 cancelled 写在同一队列串行。若 cancel 先写入(cancelled),engine 的 passed 写 re-read/CAS 到 cancelled(异于 passed 的终态)→ 步骤 3/重判抛 `WorkflowTerminalError` → executor 落 job `cancelled`(非 failed)、不发 `agent/error`。§4.3 journey 2b 覆盖。

> **新增仓储方法(Gap A)**:`casWorkflowInstanceStatus(runId, expectedFrom, to, currentNodeId?): Promise<{ changed: boolean; workflow: WorkflowInstance | null }>`——`update ... set status=@to, current_node_id=?, updated_at=? where id=@runId and status=@expectedFrom`,走 writeQueue,返回 `changed = (result.changes === 1)`。
>
> **MUST-FIX 1(C1 相邻,必修):所有"与 engine 并发的状态写"都必须走 CAS,不止 helper。** 原表述"`updateWorkflowInstanceStatus`(无条件写)保留给非竞态写入点(pause 置位、running 恢复)"**错误**——pause 置位、running 恢复恰是竞态点:
> - 变体 A(触验收标准 9):engine helper CAS(running→passed) 与 web pause 的**无条件**写(paused)交错 → paused 覆盖 passed,终态丢失;对称地 engine node-top pause 无条件写可覆盖 web cancel 刚 CAS 的 cancelled。
> - **修法**:下列写入点全部改走 `casWorkflowInstanceStatus(runId, expectedFrom, to, ...)`,`changed=false` 时 re-read 按当前态收敛(**pause 输给终态/cancel 是正确结果**:返回当前态或 400,不覆盖):
>   - web `project.pause`(expectedFrom 应为 `running`;非 running → 不写,返回当前态);
>   - engine node-top / 末写前 pause 置位(expectedFrom = `running`;若已被 cancel 置 cancelled 则 changed=false,engine 转 settleCancelled);
>   - `resumeRun` running 恢复(engine.ts:256;expectedFrom ∈ 可恢复态 paused/blocked/interrupted;若已终态则 §2.6 resumeRun 前置的终态检查已拦,CAS 是二道防线);
>   - human-gate approve/reject 的 running/blocked 恢复(§2.11,M8 终态检查为一道防线,CAS 为二道)。
> - 保留无条件 `updateWorkflowInstanceStatus` 仅用于**确无并发**的写(engine 内部 node 状态推进不涉及 run 级终态竞争的路径);凡可能与 cancel/passed 竞争 run 级状态的写,一律 CAS。
> - §4.2 交错用例补一条"pause 无条件写 vs CAS passed"(mock 强制入队顺序,断言终态不被 paused 覆盖)。

**新增仓储方法(Gap A,续)**:`casWorkflowInstanceStatus` 需加入 `TekonRepositories` 接口并由 dual-write 包装器透传(SHOULD7:dual-write 不因 status 写产出事件)。

**定稿(决策 9)**:validator 自身保持严格(`cancelled: []` 不允许自转移),**不做** self-transition no-op 放行;幂等语义收敛在 helper 调用侧。三个 cancel 写入点必须全部改用 helper:
- web `project.cancel`(§2.10);
- job executor 的 `signal.aborted` 分支(§2.5);
- node-executor 的 abort 分支(§2.6)。

engine `executePlan` 末尾的 passed 写入同样改用 helper(`written=false` 时不发 `run.passed` audit——重复执行不产生重复完成事件)。

依据:逐一核对全部 `updateWorkflowInstanceStatus` 调用点(engine、node-executor、gate-runner:442、human-gate、web project/gate router、CLI approval)的实际 from→to,全部落在表内。reviewer 需逐一核对 8 状态所有现存写入是否被表覆盖,避免误伤既有 e2e。

**错误类(新文件 `packages/core/src/workflow/errors.ts`)**:

```ts
export class WorkflowTerminalError extends Error {
  readonly code = 'WORKFLOW_TERMINAL' as const;
  constructor(readonly runId: string, readonly status: WorkflowStatus) {
    super(`cannot operate on run in terminal status: ${status}`);
    this.name = 'WorkflowTerminalError';
  }
}
export function isWorkflowTerminalError(error: unknown): error is WorkflowTerminalError;
```

### 2.8 取消传播链(修 P0-02,整合 M2/M3/M4/S3/S7)

```
web project.cancel（校验顺序 M7：assertSessionToken → assertRunInScope → writeWorkflowTerminal 内部校验）
  → writeWorkflowTerminal(runId, 'cancelled')        // M2 幂等；状态先行，UI 立即可见
  → jobs.findActiveByRunId(runId)                    // S3：取最新活跃 job
  → jobRunner.requestCancel(jobId)
      → [owner 为 NULL（queued）] 直接 cancelled/stopped（M3）
      → [owner 非 NULL] AbortController.abort()      // job 级信号
      → registry.killAll(runId, SIGKILL)             // 兜底：agent 子进程 + gate 命令子进程（S7）
engine/node-executor
  → signal 传入 AgentRunInput.signal（新增可选字段）
  → adapter.runAgent 透传给 command-gateway（CommandGatewayRunInput 新增可选 signal + registryKey）
  → runProcess：spawn 后 registry.register(runId, {pid, kill});
    signal.addEventListener('abort', () => killChildProcess(child, 'SIGKILL'))
    （复用现有 killChildProcess：process.kill(-pid) 进程组，与 timeout 路径同一机制）
  → gate 命令同样经 registry 注册（S7）
  → settle 时 unregister
mock-agent-adapter：检查 signal.aborted，提前返回 {exitCode: null, cancelled: true}
```

`AgentRunInput` 改动(可选字段,向后兼容):新增 `signal?: AbortSignal`。
`AgentRunResult` 新增可选 `cancelled?: boolean`(adapter 因 signal 提前返回时置 true)。

engine 循环取消检查点:① executePlan 每个 node 顶部;② node-executor `runAgent` 调用前;③ agent 返回后、gates 执行前;④ `onNodeCheckpoint` fencing。node 内部(agent 执行中)的中断靠子进程 SIGKILL;gate 执行中同样靠 registry SIGKILL(S7)。

### 2.9 P0-03 修法(服务端强制审批)

三层修复,治理语义在服务端闭合:

1. **服务端强制(安全边界)**——`project.run` mutation(**S12:保持在 prepareRun/enqueue 之前的同步路径上,不得下沉后台 job**):
   - `demandShapePath` 存在时:沿用 `assertDraftShapePathInScope`(服务端 resolve + realpath 校验),服务端**重新读文件**,要求 `shapedDraft.approved === true` **且** `shapedDraft.readyForRun === true`(现状只查 approved;`readyForRun` 表示 openQuestions 已清空,是 shape.ts 既有字段),否则 400。
   - 审批状态来自**服务端文件**,不来自客户端布尔字段;客户端能影响的只有一个经 scope 校验的路径。
   - 追加 audit 证据:`audit.append({runId, type: 'run.demand-shaped', payload: {shapePath, approved, readyForRun}})`(该类型在 S9 显式不映射清单内,留 audit 治理链)。
   - `demandShapePath` 缺省 = 纯自由文本路径(合法,human-first 与 CLI 都依赖,保留)。
2. **客户端不再静默丢路径**——`StartRunForm.tsx`:`if (shapePath) input.demandShapePath = shapePath;`;draft 已加载且 `(!approved || !readyForRun)` 时禁用提交按钮(UI 引导,非安全边界)。
3. **回归测试**——API 级:未批准 / 未 readyForRun / 路径越界三种 400;e2e:从 DraftCard 发起的运行请求体必含 `demandShapePath`。

兼容性:`projectRunInputSchema` 不变(字段已存在);旧客户端(不发 path)走自由文本,行为同现状。

> 残余面(已裁定,见 §0.3-1):恶意客户端仍可走自由文本,设计上合法;"shaped demand 存在即强制审批"的注册表语义不进阶段 1。

### 2.10 web 组合根接线(M1/M7/S12/S13)

`packages/web/src/server/api/root.ts`:

```ts
const writeQueue = createWriteQueue();                              // S6：与 repositories/audit 共享
const repositories = createRepositories(db, writeQueue);
const audit = createAuditLogger({ repositories, db, writeQueue });  // S6/MF4：append 单队列化，队列内直接写 db（不再入队 repositories，防自等待死锁）
const sessions = createSessionEventStore(db, writeQueue);
const jobs = createJobRepository(db, writeQueue);
const bus = createSessionEventBus();
const registry = createSubprocessRegistry();
const bridge = createSessionDualWriteBridge({ sessions, bus });           // dual-write.ts
const dualRepositories = createDualWriteRepositories(repositories, bridge);
const dualAudit = createDualWriteAuditLogger(audit, bridge);
const executor = createWorkflowJobExecutor({ repositories: dualRepositories, audit: dualAudit, projectContext, sessions, bus, registry });
const jobRunner = createJobRunner({ jobs, sessions, bus, registry, executor });
jobRunner.start();
const context: ServerContext = { db, repositories: dualRepositories, audit: dualAudit, projectContext, sessions, bus, jobRunner };
// close(): await jobRunner.stop(); db.close();
```

`ServerContext` 新增 `sessions`/`bus`/`jobRunner` 三字段。`ApiCaller.close` 先停 runner 再关库。

**`project.run` 新流程(S12 同步校验全部保留 + M1 显式补发)**:

1. `assertSessionToken`(M7 第 1 步);
2. P0-03 审批双校验(draft shape approved + readyForRun,§2.9);
3. demandText 非空、template `assertSafeName` + `loadWorkflowTemplateFile`、`createWebAgentRuntime`、`assertCleanBase`(**全部同步,在 prepareRun 之前,S12**);
4. `engine.prepareRun`(毫秒级,内部发 audit `run.started`——dual-write 此时查不到 session,静默跳过);
5. **(SHOULD20)P0-03 审批证据 audit `run.demand-shaped`**:因需 runId,放在 prepareRun 之后发(校验本身在第 2 步已完成,此处仅落治理证据);
6. `getOrCreateDefaultWorkspace` + `createSession`(profile `'human-web'`,runId 关联);
7. **M1 显式补发,顺序**:`appendEvent(session/created)` → `appendEvent(workflow/started, {runId, templateId, mode, kind:'workflow'})` → `appendEvent(user/message, {text: demandText}, {modelVisible: true})`;
8. `jobRunner.enqueue({sessionId, kind: 'workflow-run'})`;
9. 返回 `{run, sessionId, jobId}`。

**`project.pause`/`cancel`(M7 校验顺序写死)**:

```
assertSessionToken → assertRunInScope → assertWorkflowInstanceTransition（或 writeWorkflowTerminal 内部）→ 写库 → jobRunner.requestPause/requestCancel
```

- `pause`:`assertWorkflowInstanceTransition(current, 'paused')` → `updateWorkflowInstanceStatus('paused')` → `findActiveByRunId` → `requestPause`;
- `cancel`(**MF1:cancel 的 session 终态更新 + `agent/cancel-requested`/`agent/cancelled` 发射由 web 路径统一负责,不依赖 executor 是否运行**):
  1. `writeWorkflowTerminal(runId, 'cancelled')`(M2 幂等,返回 `{written}`);
  2. **`written===false`(幂等重复 cancel)→ 直接返回,不重复发事件**;
  3. `written===true`:`findSessionByRunId(runId)` 命中则 `appendEvent('agent/cancel-requested', {runId, reason})` + publish;
  4. `findActiveByRunId` → `requestCancel`(M3:queued 直终态);
  5. **`updateSessionStatus('cancelled')` + `appendEvent('agent/cancelled', {runId})` + publish(web 路径单一发射点)**;
  6. 返回 `{run, sessionId?, jobId?}`。
  > **单一发射点(MF1)**:phase 1 所有 cancel 均源自 web 控制面,`agent/cancelled` 只在此发一次;executor 的 signal-aborted 分支(§2.5)只**幂等置 session `cancelled`**,**不再发 `agent/cancelled`**,避免 running-job cancel 双发。`writeWorkflowTerminal` 的 re-read 保证与"engine 自然完成"竞态安全:若 workflow 已 `passed`,helper 抛错、事件不发。

**`project.resume`(MF2:防同 run 双活跃 job)**:

1. M7 顺序:`assertSessionToken` → `assertRunInScope`;
2. pending human decisions 校验(保留:有 pending → 400);
3. **M8 终态校验**:`getWorkflowInstance` 终态 → `ApiError 400`(映射 `WORKFLOW_TERMINAL`);
4. **MF2 + M2 活跃 job 守卫**:`cancelStaleActiveJobs(runId)`(只清 queued + stale paused,见 §2.2)→ 之后 `findActiveByRunId`,仍有 `running`/`cancelling`/**live paused(fresh lease)** job → **`ApiError 409`("run 已有活跃 job,请先取消或等待完成")**,不 enqueue。**(M2 语义澄清)`live paused` 只存在于"pause 已触发、engine 尚未抵达 node 边界"的亚秒级窗口**——一旦抵达边界 executor 返回、job 变 `done`(§2.5),该 run 即无活跃 job、resume 正常放行。故 live-paused 409 是极短暂的自愈状态(用户重试即成功),**不对 live paused 做 requestCancel**(那会把 resume 意图变成 cancel);`stale paused`(worker 崩溃遗留、lease 过期)已被 cancelStaleActiveJobs/requeueStale 回收,不会永久 409;
5. `findSessionByRunId`(无 session 的旧 run 则现场 `createSession` 关联,profile `'human-web'`);
6. enqueue `workflow-resume` → 立即返回 `{run, sessionId, jobId}`。

`runWrapperOutputSchema`(`rpc-contract.ts:470`,run/pause/cancel/resume 共用)加两个可选字段:

```ts
export const runWrapperOutputSchema = z.object({
  run: apiWorkflowSchema,
  sessionId: z.string().optional(),
  jobId: z.string().optional(),
});
```

### 2.11 gate.approve 异步化 + CLI 适配(M5/M8/M9)

**web `gate.ts` approve 分支(M9,替换现有同步 `resumeWorkflowRun` 调用)**:

`updateDecision` 的 approve 分支按以下顺序:

1. (既有)`assertSessionToken` → `assertRunInScope` → decision 存在且 pending → `assertRunCanResume`(provider 快照校验,保留);
2. **(新增 M8)**`getWorkflowInstance(runId)`;终态(passed/failed/cancelled)→ `ApiError('BAD_REQUEST', \`Run is in terminal status: ${status}\`)`;
3. (既有)`updateHumanDecision(approved)`、gate result 置 passed、`transitionNode(running→awaiting-gate)`、audit `human.gate.approved`;
4. **(新增 S3)**`jobs.cancelStaleActiveJobs(runId)`;
5. **(新增)**`findSessionByRunId`,无则现场 `createSession`(profile `'human-web'`)关联;
6. **(新增 M9)**`jobRunner.enqueue({sessionId, kind: 'workflow-resume'})`(executor 复用 M8 后的安全 `resumeRun`);
7. 立即返回 `{decision, sessionId, jobId}`。

`decisionOutputSchema`(`gate.approve`/`gate.reject` 共用输出)加可选 `sessionId`/`jobId`。

**web reject 分支(MF3:web reject 是 `gate.ts:161-177` 内联实现,不经 core `rejectHumanGate`,故 core 层 M8 挡不住它)**:reject 现状 `transitionNode(blocked)` + 裸 `updateWorkflowInstanceStatus('blocked')`,`blocked` 非终态 → 可经 `cancelled → reject → blocked → resume → running` 复活。**改法**:web reject 分支在 `updateHumanDecision` 之前加 `getWorkflowInstance(runId)` 终态检查 → 终态则 `ApiError 400`(与 approve 对称);验收标准 9 的"任何路径"清单显式含 web reject。reject 仍同步置 blocked、无 resume(不 enqueue)。

**web 错误映射**:`project.resume` 与 `gate.approve` 捕获 `WorkflowTerminalError` → `ApiError 400`;S2 落地时先给 `agents.ts` 的 `resumeWorkflowRun` 加同样映射(保 S2–S7b 之间 web 全绿);S7d 后 `resumeWorkflowRun` 若无调用点则删除(不留死代码)。

**CLI 适配(M5/M8,`packages/cli/src/commands/approval.ts`)**:

- 第 360 行 `await engine.resumeRun(runId)` 包 try/catch:

```ts
try {
  const result = await engine.resumeRun(runId);
  io.stdout.write(`runId=${runId} status=${result.workflow.status}\n`);
} catch (error) {
  if (isWorkflowTerminalError(error)) {
    throw new Error(`运行已处于终态 ${error.status}，无法恢复： runId=${runId}`);
  }
  throw error;
}
```

  顶层 catch(`cli/src/index.ts:176`)打印 message → exit 1(替换现状"打印终态 exit 0"的隐性 bug 行为)。

- 第 323 行 `humanGate.approveHumanGate(...)` 包 try/catch:捕获 `WorkflowTerminalError` → `throw new Error(\`运行已处于终态 ${error.status}，无法审批： runId=${runId}\`)`。
- **(SHOULD9)第 160-166 行 `humanGate.rejectHumanGate(...)` 同样包 try/catch**:捕获 `WorkflowTerminalError` → `throw new Error(\`运行已处于终态 ${error.status}，无法驳回： runId=${runId}\`)`(与 approve 中文一致,§4.5 补 terminal reject 用例)。

- **core 层 M8**(`human-gate.ts`):`approveHumanGate`/`rejectHumanGate` 在 `updateHumanDecision` 之前 `getWorkflowInstance(runId)`,终态 → `throw new WorkflowTerminalError(runId, status)`(已核实 approve 现状无条件 node→running + workflow→running,会复活 cancelled run;reject 同理可穿透 blocked)。`requestHumanGate` 不改(仅 gate-runner 在 run 执行中调用,run 不可能终态)。

## 3. SSE 端点

### 3.1 路由与协议(M6 先订阅后回放)

`packages/web/src/server/http.ts` 在 `/api/rpc` 分支前新增(**SSE 分支保持在 `setSecurityHeaders`(http.ts:52)之后**):

```
GET /api/sessions/:sessionId/events?sinceSeq=<n>
Headers: x-session-token: <token>   （复用 assertSessionTokenFromFile）
         Last-Event-ID: <seq>       （sinceSeq 缺省时的兜底）
```

新文件 `packages/web/src/server/sse.ts`:

```ts
export async function handleSessionEventsSse(input: {
  request: IncomingMessage; response: ServerResponse;
  sessionId: string; sessions: SessionEventStore; bus: SessionEventBus;
  sessionPath: string;
}): Promise<void>;
```

流程(**M6,顺序不可换**):
0. **接线(SHOULD15)**:`createWebServer` 仅持 `ApiCaller`;需让 `ApiCaller` 暴露 `sessions`/`bus`(或直接暴露 `handleSse(request,response,sessionId)` 方法),`http.ts` 的 SSE 分支经此拿到 store/bus。SSE 分支置于 `setSecurityHeaders` 之后,并复用 RPC 的 origin/`Sec-Fetch-Site` 校验(`http.ts:322-332`)。
1. token 校验(401 JSON 错误,不建立流);session 存在性校验(404);
2. 解析 `sinceSeq`(query 优先,否则 `Last-Event-ID`,否则 0 = 全量回放);
3. 响应头:`content-type: text/event-stream`、`cache-control: no-cache`、`connection: keep-alive`、`x-accel-buffering: no`;
4. **先订阅**:`const buffered: SessionEvent[] = []; const unsubscribe = bus.subscribe(sessionId, e => { if (flushing) buffered.push(e); else writeFrame(e); })`——订阅成立后、回放开始前的 live 事件全部进内存缓冲;
5. **后回放**:`sessions.listEventsSince(sessionId, sinceSeq)` → 逐条写帧,记 `maxReplayedSeq = max(seq)`;
6. **flush 缓冲(SHOULD3 交接窗口)**:循环推送缓冲中 `seq > maxReplayedSeq` 的(按 seq 升序 + 去重),**drain 到缓冲为空后才翻转 `flushing=false`**(翻转后再查一次缓冲防漏);之后转纯 live(新事件直接写帧);
7. `request.on('close')` → unsubscribe + end;
8. 15s 心跳注释帧(`: ping\n\n`),interval unref;
9. 每帧格式:`id: <seq>\nevent: <type>\ndata: <presentEvent(event)>\n\n`。

### 3.2 脱敏与限长(C5 + S8)

`packages/core/src/session/present.ts`:`presentEvent(event: SessionEvent): Record<string, unknown>`
- 递归对 payload 字符串值跑 `redactSecrets`(现有 `security/secrets.ts`);
- 限长(**S8**):`modelVisible: true` 的事件用 `MODEL_VISIBLE_MAX_BYTES = 1MB`(spill reference 阶段 2 才有,本阶段放宽上限 + 代码内 TODO);其余事件保持 64KB;超限截断为 `{_truncated: true, bytes: <n>}`;
- 剔除 `visibility: 'internal'` 事件(不下发);
- 永不携带 token/密钥字段。

### 3.3 断线重连

客户端(阶段 3)记录最后 `id`,重连带 `Last-Event-ID` 或 `?sinceSeq=`:服务端从 `session_events` 表回放缺口再接 live(M6 顺序保证交界不丢)。表是事实源,进程重启后回放同样正确(满足 §13.12 API 级)。

## 4. 测试清单(C4,测试先行)

### 4.1 core 单测(新增)

| 文件 | 关键断言 |
|---|---|
| `__tests__/session/session-store.test.ts` | seq 单 session 单调、跨 session 独立;listEventsSince 排他;payload/数组/布尔往返;workspace get-or-create 幂等;upsertProjectionCheckpoint;**S14:job enqueue 带 payload → get/claimNext/findActiveByRunId 返回对象经 JSON.stringify 断言无 payload 键;payload 写入后不可变** |
| `__tests__/session/job-runner.test.ts` | enqueue→claim→done;requestCancel 置 abortState 且 controller.abort 被调用;checkpoint 落库;fencing:owner 变更后 checkpoint 抛错;requeueStale 只捞过期 lease;pause 标记生效;stop 等待 settle;**M3:queued job(owner NULL)requestCancel → 直接 cancelled/stopped,不调 controller/registry;M4:abortState='requested' 的 stale job requeueStale → cancelled,abortState='none' 的 → queued;M2:stale paused(lease 过期)job requeueStale → 回收(none→queued / requested→cancelled),live paused(fresh lease)不动;(Gap C)paused 状态下 heartbeat 持续续租、lease 保持新鲜、不被 requeueStale 回收;S3:cancelStaleActiveJobs 只清 queued + stale paused、不动 running/live-paused;findActiveByRunId 按 created_at DESC 取最新;SHOULD13:owner 变更后 settle 被丢弃** |
| `__tests__/session/event-bus.test.ts` | subscribe 收到 publish;unsubscribe 后不再收到;按 sessionId 隔离 |
| `__tests__/session/dual-write.test.ts` | 映射表逐行;**audit 哈希链 verify 仍 valid**;session 不存在时静默跳过;bridge 抛错时 audit.append 仍成功;**M1:router 显式补发的 workflow/started 与 audit run.started 不产生重复事件;S9:完整 run 的映射类型集合 == 预期清单,实际不映射类型 ⊆ §1.2 显式清单(精确断言,无漏网)** |
| `__tests__/session/subprocess-registry.test.ts` | register/killAll 返回值;unregister 后不再被杀;killAll 对不存在 key 返回 0 |
| `__tests__/session/present.test.ts` | 密钥模式被替换;64KB 截断标记;internal 事件剔除;**S8:modelVisible 事件 512KB 不截断、2MB 截断且带 _truncated** |
| `__tests__/audit/logger-concurrent.test.ts`(S6) | 共享 writeQueue 下 100 个并发 append(同 run)→ audit.verify 仍 valid;不共享队列的对照组允许断链(文档化契约) |

### 4.2 core 单测(修改)

| 文件 | 新增断言 |
|---|---|
| `__tests__/db/migrations.test.ts` | 5 表存在、索引存在、schema version=4、旧 15 表未动 |
| `__tests__/db/repositories.test.ts` | `markRoleRunInterrupted` 状态与时间戳(S15:不测 markRoleRunFailed——不存在) |
| `__tests__/workflow/state-machine.test.ts` | workflow 转移表全合法/非法用例(含 paused→blocked、running→cancelled、passed→* 全非法);**M2:writeWorkflowTerminal——cancelled→cancelled 返回 written=false 且不写库;running→cancelled written=true;M1:passed→cancelled(异于目标的既有终态)抛 `WorkflowTerminalError`(而非通用 Error);running→非法目标抛通用 Error;(Gap A)CAS 交错写:mock repositories 在 re-read 后、CAS 前把状态从 running 改成 cancelled → CAS changes=0 → 重判为 WTE(不 lost-update 覆盖成 passed);(Gap B)helper `paused→passed` 走非法 Error(不静默放行)** |
| `__tests__/workflow/errors.test.ts`(新增) | WorkflowTerminalError 的 code/status/runId;isWorkflowTerminalError 类型守卫 |
| `__tests__/gate/human-gate.test.ts`(新增或扩展) | **M8:cancelled/passed/failed run 的 approveHumanGate → 抛 WorkflowTerminalError 且 decision/node/workflow 均未写;reject 同;pending decision 的正常 approve 不受影响** |
| `__tests__/workflow/engine-unit.test.ts` | prepareRun 后 adapter 未被调用;startRun 仍执行(CLI 兼容);**resumeRun 终态抛 WorkflowTerminalError(替换原 as unknown as 形状断言)**;signal abort 后 workflow cancelled(幂等:重复 abort 不抛错)、role_run interrupted、agent/cancelled;pause 在 node 边界停住且不杀子进程;onNodeCheckpoint 每 node 调用一次;**(Gap B)末个 node 顶部检查通过后置 isPauseRequested=true → executePlan 末尾 passed 写前的二次检查捕获 → run 停在 paused;(MUST-FIX 1)helper `paused→passed` 返回 written=false、run 停 paused、job 映射 done(不误判 failed);(MUST-FIX 2)node 执行中 pause → node 完成时 checkpoint 见 paused 不抛 JobFencingError、pause 正常在边界生效** |
| command-gateway 既有测试扩展 | signal abort 时 spawn 出的 child 被 kill(fake spawnImpl 记录 kill 调用与信号);registry 注册/注销;**S7:gate 命令经 registryKey 注册,killAll 覆盖 gate 子进程**;mock adapter 遇 signal 提前返回 cancelled |

### 4.3 core e2e(新增)

`__tests__/phase1/session-job-e2e.test.ts`(真实 db + mock adapter + 内存 runner;**SHOULD5:executor/engine 必须经 dual-write 包装的组合根构造,否则 session 事件无来源**;**SHOULD19:cancel journey 需自定义 latch adapter 或给 mock adapter 加可选挂起钩子——现 mock adapter 同步执行,signal 检查不触发**):
1. **run-to-passed journey**:prepareRun → enqueue → runner 驱动至 passed;断言 session_events 依次含 `session/created`、`workflow/started`(M1 显式补发)、`user/message`、`turn/start`、`workflow/node-started`、`gate/result`、`artifact/created`、`workflow/node-ended`、`agent/status(passed, kind:'workflow')`、`assistant/message`、`turn/end`;job `done`;session `done`。
2. **cancel journey**:latch adapter 挂起 → requestCancel → 断言 registry killAll 发生(agent 子进程 + gate 子进程)、job `cancelled`、workflow `cancelled`、存在 `agent/cancel-requested`+`agent/cancelled`(**MF1:经 web cancel 路径发,单发不双发**)、role_run `interrupted`;**M2:cancel 后 engine/node-executor 的二次 cancelled 写入不抛错(job 不被误判 failed)**。
2b. **cancel-赢竞态 journey(M1)**:latch 让 engine 在 `executePlan` 末尾 passed 写入前挂起 → web cancel(先写 cancelled)→ 放行 engine → passed 写经 helper re-read 到 cancelled → 抛 `WorkflowTerminalError` → executor 落 **job `cancelled`(非 failed)**、**无 spurious `agent/error`**;断言事件流不含 `agent/error`。
3. **crash recovery journey A(S5,崩溃点在 node 之间)**:job running 且已过 1 个 node → `runner.stop()`(不 settle)→ 手动把 lease 改旧 → 新 runner `start()` → 同一 job 被 requeue 并跑完(passed node 不重跑)。
4. **crash recovery journey B(S5/SHOULD17,node 执行中崩溃,两次 job)**:mock/latch adapter 在 node 执行到一半模拟 worker 崩溃(强杀在跑任务)→ lease 过期 → **requeue 后 stale-running 检查(node-executor:100-117)使该 job 落 `failed`、workflow `interrupted`**(第一次 job)→ 用户 resume enqueue 第二个 job → 恢复跑完至 passed;**SHOULD4:断言遗留 running role_run 被置 `interrupted`(stale-running 路径也必须调 markRoleRunInterrupted)**。
5. **对账(S9)**:每个 run 的映射类 audit 事件与 session_events 一一对应(计数相等);映射类型集合与 §1.2 清单精确一致;**SHOULD7:passed/failed 不产生双份完成事件**。

### 4.4 web 测试(新增/修改,真实 HTTP server)

| 文件 | 关键断言 |
|---|---|
| `__tests__/api/session-sse.test.ts` | 无 token → 401;未知 session → 404;`sinceSeq` 回放排他;回放后 live 事件实时到达;payload 中密钥被脱敏;`Last-Event-ID` 生效;断连后 unsubscribe(无句柄泄漏,可再连);**M6:回放进行中 publish 的事件必达(确定性用例:回放列表插入 sleep + 并发 publish,断言该事件出现在流中且 seq 连续不重)** |
| `__tests__/api/project-run-job.test.ts` | run RPC 在 2s 内返回且带 sessionId/jobId;后台 job 自动跑完(轮询 job 状态);未批准/未 readyForRun draft → 400(P0-03);pause 非法转移(passed→paused)→ 400 且不改状态;**(SHOULD16)running→paused 正向成功用例**;cancel 经 job runner 杀进程;**(MF1)queued 窗口/无活跃 job cancel → session 落 cancelled 且发 `agent/cancelled`(不只 workflow)**;resume 立即返回并 enqueue resume job;**(MF2)对 running run / live-paused run / 已有活跃 job 的 run resume → 409;(M2)stale-paused run(手动置 lease 过期)resume → cancelStaleActiveJobs 回收后成功 enqueue,不永久 409;M2:对已 cancelled 的 run 重复 cancel → 幂等成功不报错;M8:对终态 run resume → 400;(SHOULD16)cancel 对 passed/failed run → 400(v0.8.0 曾静默成功,行为变化);S12:dirty base 仍同步 400(不产生后台 job)** |
| `__tests__/api/write-auth.test.ts`(修改) | SSE 路由鉴权与 session-auth 程序一致;**M9/S13:approve 用例改为——approve 立即返回 decision+jobId → 轮询 job 至 done → 再断言 run passed 与 run.resumed audit;`api.close()` 前必须等 job 终态(否则 stop() 切断在跑 job);M8:终态 run approve → 400;(MF3)终态 run reject → 400,且 cancelled→reject→resume 复活链被堵** |
| `__tests__/api/gate-approve-async.test.ts`(新增) | approve 后 run 处于 awaiting-approval 时 cancel 能中断续跑 job(P0-02 不回退);approve 后旧活跃 job 被置 cancelled(S3) |

### 4.5 CLI 测试(M5/M8 新增)

| 文件 | 关键断言 |
|---|---|
| `__tests__/approval-terminal.test.ts`(新增,或扩展 run-cli.test.ts) | **M5:对 passed/failed/cancelled run 执行 `tekon resume` → exit 1,stderr 含"终态"中文提示;M8:对 cancelled run 执行 `tekon resume --approve-human` → exit 1 + 中文提示,且 decision 未被改写**;正常 resume/approve-human 路径行为不变(既有 CLI 测试零回归) |

### 4.6 客户端与 e2e

- `StartRunForm.tsx` 改动配组件测试;若现有组件测试体系不覆盖,在 web e2e 中断言请求体含 `demandShapePath`。
- Playwright:本阶段不新增(golden journey 浏览器级在阶段 3);但必须回归既有 8+4——run/approve 变异步后若旧断言依赖同步完成,改为测试内轮询至终态(只改测试等待方式,不改产品语义);**轮询后 `api.close()` 前等 job 终态(S13)**。

## 5. 实现顺序(S13 拆 S7,可并行标注)

| 步骤 | 内容 | 依赖 | 验收信号 |
|---|---|---|---|
| S1 | migrations v4 + session-store + event-bus + **audit append 单队列化(S6,createAuditLogger 加可选 writeQueue)** + 单测 | — | 单测绿;旧 migrations 测试绿 |
| S2 | workflow validator + **writeWorkflowTerminal 幂等 helper(M2)** + WorkflowTerminalError + resumeRun 抛错 + **human-gate 终态检查(M8 core)** + node-executor abort 路径改 helper + markRoleRunInterrupted(S15) + **CLI 适配(M5/M8:approval.ts 两处 try/catch + CLI 测试)** + **web agents.ts resumeWorkflowRun 错误映射(过渡保绿)** | —(与 S1 并行) | 单测绿;core 全量绿;CLI 全量绿;web 全量绿 |
| S3 | AgentRunInput.signal + command-gateway signal/registry + **engine gateEngine registry 接线(S7)** + mock adapter cancelled | —(与 S1/S2 并行) | command-gateway 扩展测试绿 |
| S4 | job-runner(lease/心跳/recovery/fencing + **M3 queued 直 cancel + M4 requeue 分支 + S3 cancelStaleActiveJobs + claim SQL**) | S1 | job-runner 单测绿 |
| S5 | engine prepareRun 拆分 + signal/pause/checkpoint 接线 | S2+S3 | engine-unit 新断言绿;core e2e 20 项全绿 |
| S6 | dual-write 包装器 + present(**S8 modelVisible 放宽 + S9 不映射清单**) | S1 | dual-write/present 单测绿 |
| S7a | web 组合根 + dual-write 接线 + ServerContext + close 顺序(共享 writeQueue) | S4+S5+S6 | 组合根冒烟绿;既有 web 158 测试绿 |
| S7b | project run/pause/cancel/resume 异步化(**M1 显式 workflow/started + S12 同步校验保留 + S3 旧 job 清理 + M7 校验顺序**)+ 既有 web 测试改轮询(**close 前等终态**) | S7a | project-run-job 测试绿;既有 web 测试绿 |
| S7c | P0-03 服务端强制(readyForRun + run.demand-shaped audit)+ StartRunForm | S7b | P0-03 三类 400 测试绿;e2e 请求体断言绿 |
| S7d | **gate.approve 异步化(M8 web 映射 + M9 enqueue)+ decisionOutputSchema 加字段 + write-auth 改轮询**;resumeWorkflowRun 无调用点则删除 | S7a | gate-approve-async 测试绿;write-auth 绿 |
| S8 | SSE 路由 + sse.ts(**M6 先订阅后回放**) | S1+S6 | session-sse 测试绿 |
| S9 | phase1 e2e 四 journey(run/cancel/crash A/crash B)+ **S9 精确清单对账 + S14 payload 往返** + 全套件回归 + 文档/版本 | 全部 | 全套件全绿 |

并行:S1 ∥ S2 ∥ S3;S6 可与 S4/S5 并行。关键路径 S1→S4→S7a→S7b→S9。

**S2 必须包含 CLI 适配与 web 过渡映射**:S2 改了 core 抛错行为,CLI/web 测试在同一 commit 内必须全绿(提交前 `pnpm test` 全量通过)。

每步独立 commit;S9 bump `package.json` 至 **0.9.0**(MINOR:新功能 + run/approve 异步化行为变更;当前已是 0.8.0),同步 CHANGELOG、`docs/manual/tekon-user-manual.md(.html)`(run 异步语义 + approve 异步语义 + SSE 端点 + 终态 resume/approve 的中文报错)、README 如涉及。

**版本裁定(主 agent)**:M8/M9 引入的"CLI resume/approve 对终态 run 从 exit 0 变 exit 1"是**修复 P1-04 吞错缺陷后的正确行为**(命令名/参数不变,非破坏性契约变更),按 MINOR (0.9.0) 处理,不提级 MAJOR。

## 6. 风险与回滚

| # | 风险 | 缓解 |
|---|---|---|
| R1 | engine 改动破坏 20 个 core e2e | 新参数全可选;engine 内部状态写入不动;resumeRun 抛错已核实无测试依赖旧形状;每步跑全量 |
| R2 | dual-write 不一致 | best-effort + 哈希链不变(先委托原 audit)+ §4.3 对账测试;阶段 2+ 再考虑同事务强化 |
| R3 | playwright 既有 e2e 因 run/approve 异步化失败 | 只改测试等待方式(轮询至终态),不放宽产品断言;close 前等 job 终态(S13) |
| R4 | stale 恢复导致双跑 | 原子 claim + checkpoint fencing(owner 变更即抛错停手) |
| R5 | cancel 杀不掉真实 provider 子进程 | 复用 timeout 路径同款 `process.kill(-pid)` 进程组机制 + registry 兜底(agent + gate 子进程,S7);e2e 用 fake spawnImpl 验证信号送达 |
| R6 | SSE 连接/句柄泄漏 | request close 必 unsubscribe;heartbeat unref;`close()` 先停 runner;测试断言可重复连 |
| R7 | CLI 不产 session_events,与 web 行为漂移 | 本阶段 CLI 维持旧链路是刻意取舍(C2 优先);CLI 仅适配 core 变更(M5/M8);CLI 接入 Session 排期阶段 4 |
| R8 | lease TTL 在慢 CI 误判 | TTL 30s / 心跳 10s,均可配 |
| R9 | web 关闭时在跑 job 悬空 | `close()` 先 `jobRunner.stop()`(等 5s settle)再关 db;未 settle 的 job 留 stale lease,下次 recoverStale 兜底 |
| R10 | **S4:crash 后 detached provider 子进程成孤儿 + requeue 双跑同 worktree** | **阶段 1 已知限制,不强解**:checkpoint fencing 防同 run 逻辑双跑(owner 变更即停手),但 worktree 级双跑窗口仍在;缓解(jobs 持久化 pid、requeue 前 best-effort 杀进程组)排阶段 2 前;验收记录口径写明 |
| R11 | **S5:crash 点在 node 执行中** | node 置 interrupted,resume 从 node 边界恢复;node 内部已完成的 agent 工作不回滚(同现状);e2e journey B 覆盖 |
| R12 | M9 approve 异步化后,approve 与 cancel 竞态 | approve enqueue 前终态校验(M8)+ S3 清理旧活跃 job + executor 捕获 WorkflowTerminalError 落 job cancelled;web 测试覆盖 approve 后 cancel 中断 |

**回滚**:全部为新增表/新增文件 + web run/approve 单点行为切换;回滚 = revert S7b/S7d commit(新表保留无害)。无数据迁移、无旧表结构变更。

## 7. 验收标准(阶段 1 出口)

对照报告 §13 与计划 §4 阶段 1:
1. `project.run` 在 2s 内返回 sessionId/jobId,不等 agent 完成(§13.2);
2. cancel 后子进程(agent + gate)被 kill,job/workflow 落 cancelled,有 `agent/cancelled` 终态事件(§13.5);
3. 未批准/未 readyForRun shaped demand 经任何 API 路径 400(§13.8);
4. SSE 回放 + live + 断线重连(Last-Event-ID)可用,**回放/订阅交界零丢失(M6)**,payload 脱敏(§13.12 API 级、C5);
5. 4 条 golden journey(新任务/澄清/inline approval/失败恢复)API 级 e2e 真实通过;
6. 旧 e2e(core 20、cli 34+3、web 158、playwright 8+4)全绿;
7. `as unknown as WorkflowEngineResult` 消失;RoleRun 有 interrupted 对称 API(S15:无 failed 调用点则不加);web pause/cancel 经状态机 validator;终态写入经幂等 helper(M2);
8. crash recovery:stale lease job 自动 requeue 并完成;**node 之间与 node 执行中两个崩溃点均有 e2e 覆盖(S5)**;
9. **M8 终态不可复活:passed/failed/cancelled 的 run 经任何路径(CLI resume、CLI approve-human、web resume、web approve)都不能复活——抛 WorkflowTerminalError / 400,workflow 状态与 decision 均不变;`cancelled: []` 保持**;
10. **M9 approve 异步:`gate.approve` 在 2s 内返回 sessionId/jobId,不等 resume 完成;后台 resume job 自动跑完;approve 后 cancel 能中断续跑(P0-02 不回退);已请求 cancel 的 stale job 不被 requeue 重跑(M4,治理事故零发生)**。

## 8. 决策记录(已全部裁定)

| # | 决策 | 裁定 | 出处 |
|---|---|---|---|
| D1 | P0-03 是否需要服务端 draft 注册表 | **文件式强制,注册表不进阶段 1**;残余面(恶意客户端走自由文本)设计合法,验收记录口径 | §0.3-1、§2.9 |
| D2 | CLI 接入 Session 的时机 | **阶段 4**;阶段 1 CLI 只适配 core 变更(M5/M8),不接入 Session | §0.3-2、§2.11 |
| D3 | SSE 鉴权方式 | **`x-session-token` 头 + fetch 流式**;SSE 分支在 setSecurityHeaders 之后 | §0.3-3、§3.1 |
| D4 | run 级完成事件类型 | **`agent/status`(payload 加 `kind:'workflow'`)**,不改冻结契约 | §0.3-4、§1.2 |
| D5 | M2 终态重复写 | **方案 a:幂等写 helper `writeWorkflowTerminal`**;validator 保持严格,不做 self-transition 放行 | §0.2-9、§2.7 |
| D6 | S7 gate 命令取消 | **engine gateEngine 的 gateway 接 registry**(同 runId key),不选"仅边界可取消" | §0.2-20、§2.6/§2.8 |
| D7 | S4 孤儿进程/双跑 worktree | **阶段 1 已知限制**,缓解排阶段 2 前 | §0.2-17、§6 R10 |
| D8 | S15 markRoleRunFailed | **本阶段不加**(无调用点),只加 markRoleRunInterrupted | §0.2-26、§2.6 |
| D9 | M9 gate.approve | **异步化(enqueue workflow-resume)**,不保留同步阻塞路径 | §0.2-14、§2.11 |
