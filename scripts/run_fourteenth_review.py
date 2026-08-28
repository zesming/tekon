from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE_13 = "97ad2f5a7ac413a3adcca814c0a9727caf85cbb0"
REPORT_PATH = ROOT / "docs/reviews/2026-08-28-tekon-harness-replatform-fourteenth-authoritative-review.md"
SCOPE_PATH = ROOT / "docs/technical/tekon-replatform-current-scope.md"


def run(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        args,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(args)}\n{result.stdout}")
    return result.stdout.strip()


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}")
    write(path, text.replace(old, new, 1))


def replace_regex_once(path: str, pattern: str, replacement: str) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.M | re.S)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex match, found {count}")
    write(path, updated)


def first_line(path: str, pattern: str) -> int | None:
    regex = re.compile(pattern)
    for index, line in enumerate(read(path).splitlines(), start=1):
        if regex.search(line):
            return index
    return None


def grep_source(pattern: str, roots: list[str]) -> list[tuple[str, int, str]]:
    regex = re.compile(pattern)
    results: list[tuple[str, int, str]] = []
    for root_name in roots:
        root = ROOT / root_name
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in {".ts", ".tsx", ".js", ".mjs", ".sql"}:
                continue
            if "__tests__" in path.parts or "dist" in path.parts:
                continue
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except UnicodeDecodeError:
                continue
            for line_no, line in enumerate(lines, start=1):
                if regex.search(line):
                    results.append((str(path.relative_to(ROOT)), line_no, line.strip()))
    return results


def detect_implementation_head() -> str:
    for sha in run("git", "rev-list", "HEAD").splitlines():
        message = run("git", "show", "-s", "--format=%s", sha)
        if message.startswith("chore: stage fourteenth"):
            continue
        if "[fourteenth-review]" in message:
            continue
        if message.startswith("fix(review14):"):
            continue
        return sha
    raise RuntimeError("could not detect implementation head")


def apply_fixes() -> None:
    # Review-only annotations are not a product release. Keep the last runtime
    # version and convert the v0.15.5 section to an explicitly unreleased note.
    package = json.loads(read("package.json"))
    if package.get("version") == "0.15.5":
        package["version"] = "0.15.4"
        write("package.json", json.dumps(package, ensure_ascii=False, indent=2) + "\n")

    changelog = read("CHANGELOG.md")
    if "## v0.15.5" in changelog:
        changelog = changelog.replace(
            "## v0.15.5\n",
            "## 复审记录（2026-08-28，非产品发布）\n\n"
            "> 本节只记录第十二轮报告批注与验收口径订正；没有产品或 Runtime 行为变化，"
            "不构成 SemVer 发布。根版本保持 `0.15.4`。\n",
            1,
        )
        changelog = changelog.replace(
            "- `0.15.4` → `0.15.5`（PATCH：报告批注 + `persistToken` 措辞订正，无代码变更、无用户可见行为变化）。",
            "- 不提升产品版本：报告批注与措辞订正不构成运行时 PATCH；根版本保持 `0.15.4`。",
            1,
        )
        write("CHANGELOG.md", changelog)

    plan_path = "docs/superpowers/plans/2026-08-20-harness-replatform-execution-plan.md"
    plan = read(plan_path)
    marker = "> 当前状态提示（2026-08-28）"
    if marker not in plan:
        plan = plan.replace(
            "# Tekon Harness-inspired Replatform 总体执行方案\n",
            "# Tekon Harness-inspired Replatform 总体执行方案\n\n"
            "> 当前状态提示（2026-08-28）：本文件保留为长期完整目标与历史执行计划。"
            "PR #10 的当前完成范围和验收口径以 "
            "[`docs/technical/tekon-replatform-current-scope.md`](../../technical/tekon-replatform-current-scope.md) 为准；"
            "当前不是阶段 0–5 全部完成。\n",
            1,
        )
        write(plan_path, plan)

    phase2_path = "docs/superpowers/plans/2026-08-24-phase2-streaming-agent-loop-design.md"
    phase2 = read(phase2_path)
    phase2 = re.sub(
        r"^> 状态：.*$",
        "> 状态：**阶段 2a 兼容投影切片已实施（S1–S6，v0.10.0）；原始阶段 2 整体未完成**。"
        "真正的 Provider execution-time streaming、durable inbox 与 follow-up/steer/resume 仍属后续独立里程碑。",
        phase2,
        count=1,
        flags=re.M,
    )
    write(phase2_path, phase2)

    phase3_path = "docs/superpowers/plans/2026-08-24-phase3-session-ui-design.md"
    phase3 = read(phase3_path)
    phase3 = re.sub(
        r"^- 状态：.*$",
        "- 状态：**3a–3d observer/control UI 切片已完成（v0.11.0）；原始阶段 3 整体未完成**。"
        "持续输入、真实模型流、Diff 与完整 Final Result 仍按当前范围基线递延。",
        phase3,
        count=1,
        flags=re.M,
    )
    write(phase3_path, phase3)


def evidence(path: str, pattern: str, fallback: str) -> str:
    line = first_line(path, pattern)
    return f"`{path}:{line}`" if line else fallback


def check_static() -> dict[str, dict[str, object]]:
    migrations = read("packages/core/src/db/migrations.ts")
    job_runner = read("packages/core/src/session/job-runner.ts")
    repos = read("packages/core/src/db/repositories.ts")
    session_store = read("packages/core/src/session/session-store.ts")
    topbar = read("packages/web/src/client/layouts/TopBar.tsx")
    detail = read("packages/web/src/client/pages/SessionDetailPage.tsx")

    run_agent_hits = grep_source(r"await\s+adapter\.runAgent\s*\(", ["packages/core/src"])
    chunk_producers = grep_source(
        r"(?:type\s*:\s*['\"]assistant/chunk['\"]|recordFromRun\([^)]*assistant/chunk)",
        ["packages/core/src", "packages/web/src", "packages/cli/src"],
    )
    unsupported = grep_source(
        r"NotSupportedYet|not supported yet|尚未支持",
        ["packages/core/src/runtime", "packages/core/src/session"],
    )

    inbox_schema = bool(
        re.search(
            r"create\s+table[^;]*(?:inbox|session_messages|agent_messages)",
            migrations,
            re.I | re.S,
        )
    )
    inbox_states = bool(
        re.search(r"\b(?:claimed|processed|poison|idempotency_key|claim_generation)\b", migrations)
    )

    collaborate_hits = grep_source(
        r"['\"]collaborate['\"]|CollaborateMode|collaborate-mode",
        ["packages/core/src", "packages/web/src", "packages/cli/src"],
    )

    claim_authority = bool(re.search(r"claim_generation|claim_token|execution_authority", migrations))
    claim_authority = claim_authority and bool(
        re.search(r"claimGeneration|claimToken|executionAuthority", session_store)
    )

    transition_match = re.search(
        r"async\s+transitionNode\b.*?\n\s*},",
        repos,
        flags=re.S,
    )
    transition_text = transition_match.group(0) if transition_match else ""
    node_cas = bool(
        re.search(r"where\s+id\s*=\s*\?\s+and\s+(?:status|revision)", transition_text, re.I)
        or re.search(r"expectedFrom|expectedRevision", transition_text)
    )

    stop_match = re.search(r"async\s+stop\(\).*?\n\s*},", job_runner, flags=re.S)
    stop_text = stop_match.group(0) if stop_match else ""
    shutdown_abort = "controller.abort" in stop_text or "controllers.values" in stop_text
    shutdown_kill = "killAll" in stop_text or "kill" in stop_text
    shutdown_join = "allSettled" in stop_text or "Promise.all" in stop_text
    shutdown_quiescence = shutdown_abort and shutdown_kill and shutdown_join

    projection_health = bool(
        re.search(r"projection_health|projectionHealth|projection lag|projectionLag|backfill", migrations + session_store + detail, re.I)
    )

    bounded_replay = bool(
        re.search(r"listEventsSince\([^,]+,[^,]+,[^)]+\)", session_store)
        or re.search(r"\blimit\b", re.search(r"async\s+listEventsSince.*?\n\s*},", session_store, re.S).group(0) if re.search(r"async\s+listEventsSince.*?\n\s*},", session_store, re.S) else "", re.I)
    )
    virtualization = bool(grep_source(r"virtualiz|react-window|react-virtual", ["packages/web/src/client"]))

    explicit_token_apply = "TOKEN_APPLY_DELAY_MS" not in topbar and bool(
        re.search(r">\s*(?:应用|Apply)\s*<", topbar)
    )

    header_event_status = bool(
        re.search(r"derive.*status.*events|events.*status", detail, re.I | re.S)
    )

    checks: dict[str, dict[str, object]] = {
        "provider_streaming": {
            "passed": not run_agent_hits and bool(chunk_producers) and not unsupported,
            "title": "Provider execution-time streaming 与可转向 AgentHandle",
            "severity": "P0",
            "evidence": [
                *(f"`{p}:{ln}` `{text}`" for p, ln, text in run_agent_hits[:3]),
                *(f"`{p}:{ln}` `{text}`" for p, ln, text in unsupported[:3]),
                f"生产 assistant/chunk producer：{len(chunk_producers)} 处",
            ],
            "reason": "事件类型或 AsyncIterable 契约只有在 Provider 尚未结束时持续产生 delta，并且 follow-up/steer/resume 真正进入生产调用链时，才构成真实 Agent Session。",
        },
        "durable_inbox": {
            "passed": inbox_schema and inbox_states,
            "title": "Durable inbox、唯一 claim、幂等消费与重启恢复",
            "severity": "P0",
            "evidence": [
                evidence("packages/core/src/db/migrations.ts", r"create table if not exists jobs", "jobs table"),
                f"独立 inbox/message 状态表：{'有' if inbox_schema else '无'}",
                f"claimed/processed/idempotency authority：{'有' if inbox_states else '无'}",
            ],
            "reason": "append-only user/message 只能证明消息被记录；可靠消费还需要 pending→claimed→processed/failed、幂等键、lease、retry 与 restart recovery。",
        },
        "dual_track": {
            "passed": len(collaborate_hits) >= 2,
            "title": "Collaborate / Deliver 后端双轨",
            "severity": "P0",
            "evidence": [
                f"生产 Collaborate 语义命中：{len(collaborate_hits)} 处",
                "默认入口仍以 standard-delivery / 受控交付为主要纵向链路",
            ],
            "reason": "双轨必须在权限、成本、角色、Git 副作用、Gate、结果与恢复单元上具有可验证的后端差异，而不只是 Profile、模板名或文案。",
        },
        "runtime_authority": {
            "passed": claim_authority,
            "title": "Persistent per-claim execution authority",
            "severity": "P0",
            "evidence": [
                evidence("packages/core/src/db/migrations.ts", r"create table if not exists jobs", "jobs table"),
                f"claim_generation / claim_token：{'存在并进入仓储契约' if claim_authority else '未形成'}",
                evidence("packages/core/src/session/job-runner.ts", r"executionTokens = new Map", "process-local execution token"),
            ],
            "reason": "Web 与 CLI 可成为不同 owner；进程内 Symbol 不能让跨进程 reclaim 后的旧执行权永久失效。",
        },
        "node_cas": {
            "passed": node_cas,
            "title": "Node 与领域副作用 CAS / fencing",
            "severity": "P0",
            "evidence": [
                evidence("packages/core/src/db/repositories.ts", r"async transitionNode", "transitionNode"),
                f"transitionNode expected-from/revision CAS：{'有' if node_cas else '无'}",
                "Git expected-old OID CAS 已存在，但不能替代 Node/Artifact/Audit/Gate/Delivery authority",
            ],
            "reason": "旧 owner 在下一次 heartbeat 前恢复时，仍可能先写 Node 或其他领域副作用；最终 Git CAS 只能保护 ref，不能回滚前序写入。",
        },
        "shutdown": {
            "passed": shutdown_quiescence,
            "title": "Shutdown abort / kill / join / quiescence",
            "severity": "P0",
            "evidence": [
                evidence("packages/core/src/session/job-runner.ts", r"async stop", "JobRunner.stop"),
                f"stop 同时具备 abort/kill/join：{'是' if shutdown_quiescence else '否'}",
                evidence("packages/core/src/session/job-runner.ts", r"STOP_SETTLE_TIMEOUT_MS", "fixed settle timeout"),
            ],
            "reason": "停止领取新任务后还必须 abort executor、kill 子进程、join Agent/Gate/Git 副作用并持久化可恢复状态；固定等待并清 Map 不等于 quiescence。",
        },
        "projection_health": {
            "passed": projection_health,
            "title": "Projection health、lag、backfill 与 UI degraded 提示",
            "severity": "P1",
            "evidence": [
                evidence("packages/core/src/session/dual-write.ts", r"best-effort", "best-effort event projection"),
                f"持久 projection health/backfill：{'有' if projection_health else '无'}",
                "append 失败不会分配 seq，客户端无法从序号缺口识别丢失",
            ],
            "reason": "projection-only 可以接受，但必须让运维和用户知道 Feed 是否完整，并提供持久 cursor、lag、重建和降级提示。",
        },
        "session_projection": {
            "passed": header_event_status,
            "title": "Session List / Detail / Inspector 单一稳定投影",
            "severity": "P1",
            "evidence": [
                evidence("packages/web/src/client/pages/SessionDetailPage.tsx", r"const session = data", "Session detail header"),
                evidence("packages/core/src/session/session-store.ts", r"order by created_at desc", "session ordering"),
                f"Header 从实时 Events 派生状态：{'是' if header_event_status else '否'}",
            ],
            "reason": "Header 读取一次性 session.get，而右栏读取实时 Events 时，运行中可能出现 running/passed/active 相互矛盾；列表也应按 needsAction/lastActivity 排序。",
        },
        "token_fallback": {
            "passed": explicit_token_apply,
            "title": "认证状态化与手工 Token 兜底",
            "severity": "P1",
            "evidence": [
                evidence("packages/web/src/client/layouts/TopBar.tsx", r"TOKEN_APPLY_DELAY_MS", "debounced token apply"),
                f"显式 Apply：{'有' if explicit_token_apply else '无'}",
                "默认 bootstrap + 同标签页 refresh 已有正式 E2E",
            ],
            "reason": "自动 bootstrap 成立后，顶栏应以连接状态为主；手工 Token 应本地编辑后显式应用，避免输入停顿即切换 auth scope。",
        },
        "long_session": {
            "passed": bounded_replay and virtualization,
            "title": "长 Session 有界 replay、内存与 DOM",
            "severity": "P1",
            "evidence": [
                evidence("packages/core/src/session/session-store.ts", r"async listEventsSince", "unbounded event query"),
                f"服务端 bounded replay：{'有' if bounded_replay else '无'}",
                f"客户端 virtualization：{'有' if virtualization else '无'}",
            ],
            "reason": "append fast path 只降低正常合并 CPU；没有分页、有界 replay、客户端上限和虚拟化时，网络、内存与 DOM 仍无界。",
        },
    }
    return checks


def render_checks(checks: dict[str, dict[str, object]]) -> str:
    parts: list[str] = []
    for index, item in enumerate(checks.values(), start=1):
        verdict = "通过" if item["passed"] else "未通过"
        evidence_lines = "\n".join(f"- {entry}" for entry in item["evidence"])
        parts.append(
            f"### {index}. {item['severity']}：{item['title']} — **{verdict}**\n\n"
            f"**理由**：{item['reason']}\n\n"
            f"**依据**：\n\n{evidence_lines}\n"
        )
    return "\n".join(parts)


def parse_validation(validation_file: Path) -> tuple[list[dict[str, object]], str]:
    if not validation_file.exists():
        return [], "未提供验证记录"
    data = json.loads(validation_file.read_text(encoding="utf-8"))
    rows = data.get("commands", [])
    playwright_log = Path(data.get("playwrightLog", ""))
    playwright_summary = "未执行"
    if playwright_log.exists():
        text = playwright_log.read_text(encoding="utf-8", errors="replace")
        matches = re.findall(r"(\d+) passed \(([^)]+)\)", text)
        retries = len(re.findall(r"retry #\d+", text, flags=re.I))
        if matches:
            count, duration = matches[-1]
            playwright_summary = f"{count} passed ({duration})，retry 标记 {retries}"
        else:
            playwright_summary = f"未识别 passed 汇总，retry 标记 {retries}"
    return rows, playwright_summary


def write_report(validation_file: Path) -> None:
    implementation_head = detect_implementation_head()
    current_head = run("git", "rev-parse", "HEAD")
    commits = run(
        "git", "log", "--reverse", "--pretty=%h %ad %s", "--date=iso-strict",
        f"{BASE_13}..{implementation_head}",
        check=False,
    )
    changed_files = run("git", "diff", "--name-status", f"{BASE_13}..{implementation_head}", check=False)
    delta_names = [line.split("\t")[-1] for line in changed_files.splitlines() if line.strip()]
    code_delta = [
        path for path in delta_names
        if path.startswith(("packages/core/src/", "packages/web/src/", "packages/cli/src/"))
    ]

    checks = check_static()
    p0_failures = [item["title"] for item in checks.values() if item["severity"] == "P0" and not item["passed"]]
    p1_failures = [item["title"] for item in checks.values() if item["severity"] == "P1" and not item["passed"]]
    overall_pass = not p0_failures

    validation_rows, playwright_summary = parse_validation(validation_file)
    validation_table = "\n".join(
        f"| `{row.get('name')}` | `{row.get('exitCode')}` |"
        for row in validation_rows
    ) or "| 未记录 | — |"

    metrics = run("git", "diff", "--shortstat", "main...HEAD", check=False) or "无 diff 统计"
    commit_count = run("git", "rev-list", "--count", "main..HEAD", check=False) or "未知"

    report = f"""# Tekon Harness Replatform 第十四轮权威全面复审

> 复审日期：2026-08-28  
> PR：#10 `review/deepseek-harness-migration-2026-08-20` → `main`  
> 第十三轮报告提交：`{BASE_13}`  
> 实施方第十三轮后 HEAD：`{implementation_head}`  
> 本轮验证快照：`{current_head}`  
> 维度：产品逻辑、UI、UX、整体架构、并发与恢复、代码实现、测试可信度、版本治理、过度实现与过度设计

---

## 1. 最终结论

# **{'通过' if overall_pass else '第十三轮批注没有关闭核心实现缺口；当前 PR 整体仍不通过'}**

第十三轮之后的实施方增量为：

```text
{commits or '(无提交)'}
```

增量文件：

```text
{changed_files or '(无文件变化)'}
```

生产代码增量共 **{len(code_delta)}** 个文件。{('本轮确有产品/Runtime 代码，需要逐项按下文验收。' if code_delta else '本轮仍然只有报告批注、CHANGELOG 与版本元数据，没有 Provider、Session 或 Runtime 行为修改。')}

因此，批注可以说明为何某些工作需要 ADR 或独立 PR，但不能将尚未实现的验收项改写成“已经通过”。

### 分层裁决

| 验收对象 | 第十四轮结论 |
| --- | --- |
| 第十三轮实施方批注事实核验 | **部分接受** |
| 范围与阶段状态文档 | **本轮进一步收敛，通过** |
| 纯复审文档的版本治理 | **本轮已纠正，通过** |
| 第十三轮后的产品/Runtime 整改 | **{'存在代码增量，见逐项结果' if code_delta else '无代码增量，不能判为完成'}** |
| 默认并发 Web/CLI Runtime | **{'通过' if checks['runtime_authority']['passed'] and checks['node_cas']['passed'] and checks['shutdown']['passed'] else '不通过'}** |
| 普通用户持续协作产品 | **{'通过' if checks['provider_streaming']['passed'] and checks['durable_inbox']['passed'] and checks['dual_track']['passed'] else '不通过'}** |
| Experimental / partial infrastructure 快照 | 可继续研究；合并仍需代码级 Runtime ownership 边界 |

---

## 2. 对实施方批注的裁决

### 接受

- 当前剩余的 single-owner daemon 或完整 multi-owner fencing 是重大架构工作，不应继续无边界堆入超大 PR；
- Session Event 当前是 best-effort projection-only，而不是 Harness 式 authoritative interaction log；
- 真实 streaming、durable inbox、follow-up/steer、Collaborate、长 Session 均尚未实现；
- Git expected-old OID CAS、Job owner/status 条件写、认证 bootstrap、移动端和现有 CI 改善应保留；
- 当前 PR 应被描述为 partial / experimental infrastructure。

### 不接受

- “需要用户 ADR 决策”不等于当前实现已经安全，也不等于默认 Runtime 可合入；
- “已披露的未来里程碑”不能覆盖当前产品实际允许 Web/CLI 双 owner、但缺持久 authority 的事实；
- 报告批注没有运行时行为变化，不应单独提升产品 PATCH 版本并触发 `tekon update`；
- 阶段 2/3 详细设计头部仍写“已实施/全部完成”时，即便另有基线文档，仍会给后续维护者和 Agent 制造错误完成感。

---

## 3. 逐项验收：理由与依据

{render_checks(checks)}

---

## 4. 产品逻辑与 UI/UX 综合判断

### 已经健康并应保留

- Session-first 默认入口与 `/advanced` 治理 Cockpit 分层；
- “启动受控交付”的诚实命名；
- 生产 `#token` bootstrap、同标签页 refresh、URL/Referer 不泄漏；
- 移动端 Drawer 的 modal、focus trap、Escape、focus restore 与 background inert；
- inline approval、PR 创建确认、Git ref CAS；
- SSE replay、跨进程 catch-up 与现有测试可信度改进。

### 仍不适合普通用户长期使用

1. **Session 仍是观察器，不是持续协作面板。** 当前页面没有当前 Session 的消息 Composer，也没有 queued/claimed/processed 输入状态。
2. **Feed 仍偏底层事件墙。** 默认叙事应聚合“理解→计划→修改→验证→审批→结果”，raw seq/checkpoint/correlation 应进入 Advanced/Audit。
3. **Inspector 仍复制历史。** 应改成当前 Plan、Changed Files、Checks/Gates、Pending Approval、Risks、Final Result、PR/CI 与 Recovery Action。
4. **Final Result 过浅。** 需要结构化 Changed Files、Diff、Build/Lint/Test、Gate、Independent Review、风险、分支/PR/CI 和下一步。
5. **复制清理后的深链到新标签页仍缺认证闭环。** 当前 `sessionStorage` 只属于当前标签页；需要一次性 nonce、同源安全 cookie 或页面内生成的新标签页链接。
6. **Projection-only 缺健康提示。** UI 无法判断 Event Feed 是否完整，也没有 durable lag/backfill/rebuild 状态。

---

## 5. 架构与过度设计判断

以下能力不是过度设计，应继续保留：Workflow、Gate、Artifact、Worktree、Audit、Delivery、Human Approval、Independent Review。它们是 Tekon 的核心差异化。

过度设计仍集中在横向 replatform 层：Event vocabulary、Profile、Automation、Projection checkpoint、AgentDriver/AgentHandle 契约、DSH bridge 和多 owner 恢复语义，增长速度领先于一个真实 Provider 的纵向闭环。

当前 PR 规模：`{commit_count}` 个分支提交；`{metrics}`。继续在同一 PR 中加入 daemon、Provider、Inbox、Collaborate 与长 Session，会进一步降低可评审性、可回滚性和故障定位能力。

建议冻结当前 PR，后续按以下顺序拆分：

1. Runtime ownership ADR + single-owner daemon / project lock；
2. shutdown abort/kill/join 与两进程竞争测试；
3. 一个真实 Provider 的 execution-time streaming；
4. durable inbox + follow-up/steer/resume + restart recovery；
5. Collaborate 纵向产品切片；
6. Narrative/Final Result 与长 Session bounded architecture。

---

## 6. 本轮直接修改

1. 将根版本从 docs-only 的 `0.15.5` 恢复为最后一个含运行时改动的 `0.15.4`；
2. 将 CHANGELOG 顶部改为“复审记录（非产品发布）”，避免 `tekon update` 将报告批注误报为产品更新；
3. 在总体执行方案顶部加入当前范围基线提示；
4. 将阶段 2 状态改为“2a compatibility projection 已完成，阶段整体未完成”；
5. 将阶段 3 状态改为“observer/control UI slice 已完成，阶段整体未完成”；
6. 新增本第十四轮权威报告。

没有用更多合成事件伪装真实 streaming，也没有用零散 `signal.aborted` 判断伪装完整 Runtime fencing。

---

## 7. 官方架构对照

- DeepSeek Harness：durable Session Events 是模型历史和恢复的事实源；“model-visible means logged”，Turn/Step 内真实产生 assistant chunk、tool lifecycle 与 inbox claim。
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- OpenAI Codex Harness/App Server：长驻双向协议在 item 执行期间产生 UI-ready lifecycle/delta，而不是等待完整结果后投影。
  https://openai.com/index/unlocking-the-codex-harness/
- Semantic Versioning：PATCH 表达向后兼容的 bug fix；纯复审批注不应制造产品更新信号。
  https://semver.org/

Tekon 继续采用 anti-corruption adapter、而不绑定 Harness preview 内部 schema，是合理选择；但“借鉴模式”不能只复制类型名和事件词汇，必须完成实际执行语义。

---

## 8. 验证

| 命令 | Exit code |
| --- | ---: |
{validation_table}

Playwright：**{playwright_summary}**。

只有退出码为 0 的命令才被视为通过；报告不会将 retry 后绿色描述成首轮稳定通过。

---

## 9. 最终裁决

> **{'第十四轮通过。' if overall_pass else '第十四轮整体仍不通过。'}**
>
> {'核心产品与 Runtime P0 已关闭。' if overall_pass else '当前 CI 可以全绿，但真实 streaming、durable inbox/持续 Session、Collaborate 双轨、持久 execution authority、Node/领域副作用 fencing 与 shutdown quiescence 仍未同时闭环。'}
>
> 当前 PR 可以继续作为诚实标注边界的 experimental infrastructure 研究快照；在 Runtime ownership 没有代码级保证之前，不建议作为默认 Web/CLI Runtime 合入 `main`。

未执行 merge、release 或 deploy。
"""
    # Keep Markdown content free of trailing whitespace so the generated review
    # can pass `git diff --check` and actually be committed by the workflow.
    report = "\n".join(line.rstrip() for line in report.splitlines()) + "\n"
    REPORT_PATH.write_text(report, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply-fixes", action="store_true")
    parser.add_argument("--write-report", action="store_true")
    parser.add_argument("--validation-file", type=Path, default=Path("/tmp/fourteenth-validation.json"))
    args = parser.parse_args()
    if args.apply_fixes:
        apply_fixes()
    if args.write_report:
        write_report(args.validation_file)
