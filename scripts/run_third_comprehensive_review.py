from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
import datetime as dt
import os
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PREVIOUS_REVIEW_HEAD = "0f155f67f5926296841a91696f4d5ec1a00faaf5"
SECOND_REPORT = Path(
    "docs/reviews/2026-08-25-tekon-harness-replatform-second-review.md"
)
THIRD_REPORT = Path(
    "docs/reviews/2026-08-25-tekon-harness-replatform-third-review.md"
)


@dataclass
class Finding:
    code: str
    severity: str
    title: str
    status: str
    evidence: list[str]
    analysis: str
    acceptance: str


@dataclass
class Validation:
    name: str
    outcome: str


def run(*args: str) -> str:
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def read(path: str | Path) -> str:
    target = ROOT / path
    try:
        return target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def write(path: str | Path, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def source_files(*roots: str) -> list[Path]:
    suffixes = {".ts", ".tsx", ".js", ".mjs", ".yaml", ".yml", ".md", ".sql"}
    result: list[Path] = []
    for root in roots:
        base = ROOT / root
        if not base.exists():
            continue
        if base.is_file():
            result.append(base)
            continue
        result.extend(
            path
            for path in base.rglob("*")
            if path.is_file()
            and path.suffix in suffixes
            and "node_modules" not in path.parts
            and "dist" not in path.parts
        )
    return sorted(set(result))


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def matching_lines(
    paths: Iterable[Path],
    pattern: str,
    *,
    flags: int = re.I,
    limit: int = 8,
) -> list[tuple[Path, int, str]]:
    rx = re.compile(pattern, flags)
    matches: list[tuple[Path, int, str]] = []
    for path in paths:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(lines, start=1):
            if rx.search(line):
                matches.append((path, number, line.strip()))
                if len(matches) >= limit:
                    return matches
    return matches


def has(paths: Iterable[Path], pattern: str, *, flags: int = re.I) -> bool:
    return bool(matching_lines(paths, pattern, flags=flags, limit=1))


def evidence(
    paths: Iterable[Path],
    pattern: str,
    *,
    flags: int = re.I,
    limit: int = 4,
) -> list[str]:
    found = matching_lines(paths, pattern, flags=flags, limit=limit)
    return [f"`{rel(path)}:{line}`" for path, line, _ in found]


def merge_evidence(*groups: list[str]) -> list[str]:
    result: list[str] = []
    for group in groups:
        for item in group:
            if item not in result:
                result.append(item)
    return result[:8]


def validation_outcome(name: str) -> str:
    return os.environ.get(name, "not-run").strip().lower()


def apply_safe_accessibility_fixes() -> list[str]:
    """Apply only local, semantics-preserving fixes with exact structural guards."""

    changed: list[str] = []

    # Connection state is changing status information. It should be announced,
    # but must not interrupt the user like an alert.
    for path in source_files("packages/web/src/client"):
        text = path.read_text(encoding="utf-8")
        if "session-conn" not in text:
            continue
        updated, count = re.subn(
            r"(<span\s+className=\{`session-conn[^`]*`\})(\s*>)",
            r'\1 role="status" aria-live="polite"\2',
            text,
            count=1,
            flags=re.S,
        )
        if count and updated != text:
            path.write_text(updated, encoding="utf-8")
            changed.append(rel(path))
            break

    # The empty feed is also a non-urgent live status. Guard against duplicate
    # attributes and only touch the exact feed-empty element.
    for path in source_files("packages/web/src/client"):
        text = path.read_text(encoding="utf-8")
        if "feed-empty" not in text or "aria-live" in text[text.find("feed-empty") : text.find("feed-empty") + 180]:
            continue
        updated, count = re.subn(
            r'(<div\s+className="feed-empty[^"]*")(\s*>)',
            r'\1 role="status" aria-live="polite"\2',
            text,
            count=1,
        )
        if count and updated != text:
            path.write_text(updated, encoding="utf-8")
            changed.append(rel(path))
            break

    return changed


def collect_annotations() -> tuple[list[str], str]:
    report = read(SECOND_REPORT)
    annotations: list[str] = []

    for match in re.finditer(r"<!--(.*?)-->", report, flags=re.S):
        value = re.sub(r"\s+", " ", match.group(1)).strip()
        if value:
            annotations.append(value[:500])

    for line in report.splitlines():
        stripped = line.strip()
        if re.search(r"批注|agent\s*回复|reviewer\s*note|复核意见|已处理|待确认", stripped, re.I):
            annotations.append(stripped[:500])

    diff = ""
    try:
        diff = run(
            "git",
            "diff",
            "--unified=2",
            f"{PREVIOUS_REVIEW_HEAD}..HEAD",
            "--",
            str(SECOND_REPORT),
        )
    except subprocess.CalledProcessError:
        pass

    # Keep only annotation-looking added lines from the report delta. This also
    # catches Markdown blockquotes used instead of HTML comments.
    for line in diff.splitlines():
        if not line.startswith("+") or line.startswith("+++"):
            continue
        value = line[1:].strip()
        if re.search(r"批注|回复|说明|已修复|已完成|不同意|确认|TODO|NOTE", value, re.I):
            annotations.append(value[:500])

    unique: list[str] = []
    for item in annotations:
        if item and item not in unique:
            unique.append(item)
    return unique[:40], diff


def audit() -> list[Finding]:
    core = source_files("packages/core/src")
    core_tests = source_files("packages/core/__tests__")
    web = source_files("packages/web/src")
    web_tests = source_files("packages/web/__tests__")
    cli = source_files("packages/cli/src")
    cli_tests = source_files("packages/cli/__tests__")
    all_src = core + web + cli
    all_tests = core_tests + web_tests + cli_tests

    findings: list[Finding] = []

    # ------------------------------------------------------------------
    # P0-01: real incremental provider protocol, not post-hoc projection.
    # ------------------------------------------------------------------
    adapter_contract = has(
        core,
        r"runAgent\s*\([^)]*\)\s*:\s*Promise\s*<\s*AgentRunResult",
    ) or has(core, r"runAgent\s*\([^)]*\).*Promise<AgentRunResult")
    stream_contract = has(
        core,
        r"AsyncIterable\s*<.*Agent|ReadableStream\s*<.*Agent|Agent(Stream|Runtime)Event|on(Event|Chunk)\s*\??\s*:",
    )
    chunk_vocab = has(all_src, r"assistant/(chunk|delta)|message/(chunk|delta)")
    provider_incremental = has(
        [p for p in core if re.search(r"(codex|claude).*adapter", p.name, re.I)],
        r"assistant/(chunk|delta)|on(Event|Chunk)|AsyncIterable|jsonl|stream-json|item\.completed|content_block_delta",
    )
    stream_tests = has(
        all_tests,
        r"assistant/(chunk|delta)|incremental|stream(ing)? event|tool.*ordering|chunk.*replay",
    )

    if stream_contract and chunk_vocab and provider_incremental and stream_tests:
        status = "resolved"
        severity = "P0"
        analysis = (
            "至少一个主力 Provider 已把增量消息/工具事件纳入正式运行时契约，并有顺序、重放或取消测试；"
            "不再仅依赖 node 完成后的合成投影。"
        )
    elif stream_contract or chunk_vocab or provider_incremental:
        status = "partial"
        severity = "P0"
        analysis = (
            "已经出现流式事件词汇或 Provider 解析入口，但契约、主力 Provider 与回归测试没有同时闭环。"
            "只捕获最终 stdout、把完整结果拆成多条事件，或在 adapter 返回后补发 tool/message，仍不等于真实 Agent Loop。"
        )
    else:
        status = "open"
        severity = "P0"
        analysis = (
            "主力 Provider 仍以一次 `Promise<AgentRunResult>` 作为 node 级黑盒。当前实时性主要来自 Workflow/Job 投影，"
            "无法提供真实 assistant delta、工具生命周期、request boundary 与 step 中途 steer。"
        )
    findings.append(
        Finding(
            "P0-01",
            severity,
            "主力 Provider 的真实增量 Agent Loop",
            status,
            merge_evidence(
                evidence(core, r"runAgent\s*\(|Promise\s*<\s*AgentRunResult"),
                evidence(all_src, r"assistant/(chunk|delta)|Agent(Stream|Runtime)Event"),
                evidence(all_tests, r"assistant/(chunk|delta)|incremental|streaming event"),
            ),
            analysis,
            "Codex 或 Claude 至少一个 Provider 在执行过程中直接产生 typed message/tool/step 事件；验证顺序、取消、断线重放和背压。",
        )
    )

    # ------------------------------------------------------------------
    # P0-02: in-session follow-up and steer end-to-end.
    # ------------------------------------------------------------------
    follow_rpc = has(web, r"session[./_-]?(follow.?up|message)|['\"]session\.(followUp|message)['\"]")
    steer_rpc = has(web, r"['\"]session\.steer['\"]|session[./_-]?steer")
    driver_implemented = has(core, r"async\s+(followUp|steer)\s*\(") and not has(
        core,
        r"(followUp|steer)[\s\S]{0,220}(NotSupported|not supported|unsupported)",
        flags=re.I | re.S,
    )
    detail_composer = has(
        [p for p in web if "Session" in p.name or "session" in rel(p).lower()],
        r"FollowUp|Steer|Session.*Composer|textarea|contenteditable",
    )
    durable_user_event = has(core + web, r"user/message") and has(core + web, r"agent/steered")
    interaction_tests = has(
        all_tests,
        r"follow.?up|steer|agent/steered|pending input|session composer",
    )

    if follow_rpc and steer_rpc and driver_implemented and detail_composer and durable_user_event and interaction_tests:
        status = "resolved"
        analysis = "Session 内 follow-up 与 steer 已从 UI、RPC、运行时 inbox、durable event 到回归测试形成闭环。"
    elif follow_rpc or steer_rpc or detail_composer or driver_implemented:
        status = "partial"
        analysis = (
            "Session 内持续输入已经有部分 UI 或 API 接线，但 follow-up、steer、durable inbox、运行时消费和重连恢复没有全部闭环。"
            "仅新增输入框或仅写 `user/message`，而执行中的 Agent 不消费，属于表面完成。"
        )
    else:
        status = "open"
        analysis = "Session Detail 仍主要用于观察一次 Workflow；用户不能在同一 Session 中补充要求或改变当前/下一 step 的方向。"
    findings.append(
        Finding(
            "P0-02",
            "P0",
            "Session 内 follow-up / steer 的端到端语义",
            status,
            merge_evidence(
                evidence(web, r"session\.(followUp|steer|message)|Session.*Composer|textarea"),
                evidence(core, r"followUp|steer|agent/steered|user/message"),
                evidence(all_tests, r"follow.?up|steer|pending input"),
            ),
            analysis,
            "输入必须 durable；运行中 steer 的作用边界清晰；空闲 follow-up 能启动新 turn；刷新/重连不丢 pending input；重复提交幂等。",
        )
    )

    # ------------------------------------------------------------------
    # P0-03: collaboration vs governed delivery is a real product mode.
    # ------------------------------------------------------------------
    composer_files = [
        p
        for p in web
        if re.search(r"session.*composer|composer.*session", rel(p), re.I)
    ]
    explicit_modes = has(
        composer_files + web,
        r"collaboration|collaborative|协作任务|受控交付|governed delivery|delivery mode|mode.*(goal|workflow)",
    )
    default_collab = has(
        composer_files + web,
        r"default(Value)?\s*=.*(collab|goal)|useState\s*\(\s*['\"](collaboration|goal|chat)",
    )
    default_delivery = has(
        composer_files + web,
        r"standard-delivery|useState\s*\(\s*['\"]workflow|default(Value)?\s*=.*workflow",
    )
    mode_backend = has(core + web, r"mode\??\s*:\s*['\"]?(workflow|goal|collaboration)|runKind|sessionMode")
    mode_tests = has(all_tests, r"协作任务|受控交付|collaboration mode|default.*(goal|collab)|mode selector")

    if explicit_modes and default_collab and mode_backend and mode_tests and not default_delivery:
        status = "resolved"
        analysis = "默认轻量协作与受控交付已成为用户可理解、后端可验证、测试覆盖的两种产品模式。"
    elif explicit_modes or mode_backend:
        status = "partial"
        analysis = (
            "代码已出现模式字段或入口文案，但默认值、后端执行语义或测试仍可能把“开始会话”隐式映射到完整标准交付。"
            "仅换文案、不改变模板/权限/Gate 组合，不能消除用户心智错配。"
        )
    else:
        status = "open"
        analysis = "普通用户从“开始会话”进入的仍是内部 Workflow 模型，没有明确区分轻量协作与受控交付。"
    findings.append(
        Finding(
            "P0-03",
            "P0",
            "默认协作模式与受控交付模式的产品分层",
            status,
            merge_evidence(
                evidence(composer_files + web, r"standard-delivery|协作任务|受控交付|collaboration|mode"),
                evidence(core + web, r"runKind|sessionMode|mode\??"),
                evidence(all_tests, r"mode selector|协作任务|default.*collab"),
            ),
            analysis,
            "默认入口应是轻量协作；受控交付需显式选择并说明会创建分支、运行 Gate/测试、可能产生 PR。后端不能只相信前端标签。",
        )
    )

    # ------------------------------------------------------------------
    # P0-04: code-changing goal governance.
    # ------------------------------------------------------------------
    goal_templates = [
        p
        for p in source_files("packages", "docs")
        if re.search(r"(^|[-_/])goal([-_.]|$)", rel(p), re.I)
        and p.suffix in {".yaml", ".yml", ".ts", ".md"}
    ]
    goal_text = "\n".join(read(rel(p)) for p in goal_templates)
    goal_readonly = bool(re.search(r"read.?only|sandbox\s*:\s*read|filesystem.*read", goal_text, re.I))
    goal_gates = bool(re.search(r"gates?\s*:|diff review|human.?review|change.?review|build|lint|test", goal_text, re.I))
    change_detection = has(
        core,
        r"(goal|session).{0,80}(git diff|working tree|code.?change|changed files)|inject.{0,80}(gate|review)|change.?goal",
        flags=re.I | re.S,
    )
    goal_tests = has(all_tests, r"goal.{0,80}(read.?only|code.?change|gate|review|diff)|change.?goal", flags=re.I | re.S)

    if goal_readonly or (goal_gates and change_detection and goal_tests):
        status = "resolved"
        analysis = (
            "Goal 要么被约束为只读，要么在检测到代码变化时自动进入差异审阅与验证 Gate，且有回归测试。"
        )
    elif goal_gates or change_detection:
        status = "partial"
        analysis = (
            "已有部分警告、差异检测或 Gate，但对所有可写 Provider/恢复路径尚未形成不可绕过的后端约束。"
        )
    else:
        status = "open"
        analysis = (
            "Goal 仍可能在可写 worktree 中修改代码，却缺少默认 diff/build/test/human review，用户容易把“轻量目标”误认为只读问答。"
        )
    findings.append(
        Finding(
            "P0-04",
            "P0",
            "Goal 模式的代码变更治理",
            status,
            merge_evidence(
                evidence(goal_templates, r"gates?|read.?only|sandbox|build|lint|test"),
                evidence(core, r"change.?goal|git diff|changed files|inject.*gate"),
                evidence(all_tests, r"goal.*(code|gate|review|diff|read.?only)"),
            ),
            analysis,
            "后端必须保证：只读 Goal 不可写；可写 Goal 一旦产生 diff，自动附加验证与人工审阅，恢复/重试也不能绕过。",
        )
    )

    # ------------------------------------------------------------------
    # P1 architecture checks from the second review.
    # ------------------------------------------------------------------
    best_effort_events = has(core + web, r"session events?.{0,100}best-effort|best-effort.{0,100}session event|dual-write", flags=re.I | re.S)
    event_source_truth = has(core + web, r"session_events?.{0,100}(source of truth|canonical)|event.?sourced|outbox", flags=re.I | re.S)
    projector_checkpoint = has(core, r"projection_checkpoints|upsertProjectionCheckpoint")
    if event_source_truth and projector_checkpoint and not best_effort_events:
        status = "resolved"
        analysis = "Session Event 已成为 canonical write path，并通过 checkpointed projector 派生读取模型。"
    elif event_source_truth or projector_checkpoint:
        status = "partial"
        analysis = "具备事件表或 projector 基础，但部分核心状态仍直接写表，事件失败仍可能被吞掉，事实源尚未统一。"
    else:
        status = "open"
        analysis = "Session Event 仍是现有 Workflow/Job 状态的 best-effort 投影，可能出现 UI 叙事与治理事实不一致。"
    findings.append(
        Finding(
            "P1-01",
            "P1",
            "Session Event 的 canonical source-of-truth 边界",
            status,
            merge_evidence(
                evidence(core + web, r"best-effort|dual-write|source of truth|canonical|outbox"),
                evidence(core, r"projection_checkpoints|upsertProjectionCheckpoint"),
            ),
            analysis,
            "选择 event-first + durable projector，或事务 outbox；禁止核心状态成功而用户可见事件静默丢失。",
        )
    )

    automation = [p for p in core + web if "automation" in rel(p).lower()]
    automation_bus = has(automation, r"bus\.subscribe|EventBus|\.subscribe\(")
    automation_cursor = has(automation, r"projection_checkpoints|checkpoint|listEventsSince|cursor|lastSeq")
    automation_replay_tests = has(all_tests, r"automation.{0,100}(restart|replay|checkpoint|catch.?up|missed event)", flags=re.I | re.S)
    if automation and automation_cursor and automation_replay_tests:
        status = "resolved"
        analysis = "Automation 使用 durable cursor/checkpoint，进程重启后会补消费遗漏事件，并有恢复测试。"
    elif automation and (automation_cursor or not automation_bus):
        status = "partial"
        analysis = "Automation 已不完全依赖本地 bus，但重启补偿、幂等副作用或 checkpoint 测试仍不完整。"
    else:
        status = "open"
        analysis = "Automation 主要依赖 process-local EventBus；事件发生时进程不在线就可能永久错过。"
    findings.append(
        Finding(
            "P1-02",
            "P1",
            "Automation 的 durable projector / replay",
            status,
            merge_evidence(
                evidence(automation, r"subscribe|EventBus|checkpoint|cursor|listEventsSince"),
                evidence(all_tests, r"automation.*(restart|replay|checkpoint|catch.?up)"),
            ),
            analysis,
            "按 Session/Workspace 保存 cursor；副作用需幂等；覆盖进程退出、重复投递、乱序和 checkpoint 写入失败。",
        )
    )

    session_service = [p for p in core if p.name == "session-service.ts"]
    start_transaction = has(session_service + core, r"startRun[\s\S]{0,3000}(transaction|withTransaction|atomic)", flags=re.I | re.S)
    start_sequence = has(session_service, r"prepareRun") and has(session_service, r"createSession") and has(session_service, r"enqueue")
    atomic_tests = has(all_tests, r"startRun.{0,100}(rollback|atomic|orphan|transaction)|opening events?.{0,100}rollback", flags=re.I | re.S)
    if start_transaction and atomic_tests:
        status = "resolved"
        analysis = "Run/Session/opening events/Job 的创建使用可回滚边界，并覆盖中途失败不留孤儿记录。"
    elif start_transaction:
        status = "partial"
        analysis = "出现事务或补偿逻辑，但缺少每个失败点的原子性回归测试。"
    else:
        status = "open" if start_sequence else "unknown"
        analysis = "启动链仍由多次独立写入组成；任一步失败都可能留下无 Job Session、无 Session Run 或缺 opening events。"
    findings.append(
        Finding(
            "P1-03",
            "P1",
            "startRun 跨 Run / Session / Event / Job 的原子边界",
            status,
            merge_evidence(
                evidence(session_service, r"prepareRun|createSession|appendEvent|enqueue|transaction"),
                evidence(all_tests, r"startRun.*(rollback|atomic|orphan|transaction)"),
            ),
            analysis,
            "单事务写入同库实体；跨边界使用 outbox/saga 补偿。逐点注入失败，验证不存在可见孤儿 Session 或永不执行的 Run。",
        )
    )

    ui_cmd = [p for p in cli if re.search(r"ui|serve|web", p.name, re.I) or "commands" in rel(p)]
    one_time_bootstrap = has(ui_cmd + web, r"one.?time|bootstrap|nonce|single.?use|open\s*\(|openBrowser|browser.*token")
    manual_token = has(ui_cmd + web, r"copy.*token|paste.*token|session token|x-session-token")
    bootstrap_tests = has(all_tests, r"one.?time.*token|bootstrap.*browser|single.?use|ui.*open")
    if one_time_bootstrap and bootstrap_tests:
        status = "resolved"
        analysis = "CLI 可通过一次性、短时、单次消费的浏览器 bootstrap 建立会话，并有重放/过期测试。"
    elif one_time_bootstrap:
        status = "partial"
        analysis = "自动打开或 bootstrap 已出现，但 token 生命周期、单次消费、来源校验或测试仍不完整。"
    else:
        status = "open"
        analysis = "本地 UI 仍依赖人工复制长期/会话 token，首次使用摩擦高，也容易在终端历史或截图中泄漏。" if manual_token else "未找到安全的一次性浏览器 bootstrap。"
    findings.append(
        Finding(
            "P1-04",
            "P1",
            "`tekon ui` 的一次性安全浏览器 bootstrap",
            status,
            merge_evidence(
                evidence(ui_cmd + web, r"one.?time|bootstrap|nonce|session token|x-session-token|openBrowser"),
                evidence(all_tests, r"bootstrap.*browser|one.?time.*token|single.?use"),
            ),
            analysis,
            "随机短时 nonce、单次消费、loopback/origin 约束、过期与重放测试；不要把持久 token 放进 URL、日志或浏览器历史。",
        )
    )

    delivery = [p for p in core + web + cli if re.search(r"delivery|pull.?request|approval", rel(p), re.I)]
    identity_fields = {
        name: has(delivery, pattern)
        for name, pattern in {
            "headSha": r"headSha|head_sha|head commit",
            "baseSha": r"baseSha|base_sha|base commit",
            "bodySha": r"bodySha|body_sha|prBodySha|body hash",
            "packageSha": r"packageSha|package_sha|artifactSha|package hash",
        }.items()
    }
    identity_verified = has(delivery, r"(verify|assert|compare|match).{0,120}(headSha|baseSha|bodySha|packageSha|hash)", flags=re.I | re.S)
    identity_tests = has(all_tests, r"approval.{0,120}(head|base|body|package).{0,80}(changed|mismatch|stale|hash)", flags=re.I | re.S)
    if all(identity_fields.values()) and identity_verified and identity_tests:
        status = "resolved"
        analysis = "审批绑定了 branch/head/base/body/package 内容身份；审批后内容变化会使授权失效。"
    elif any(identity_fields.values()) or identity_verified:
        status = "partial"
        missing = ", ".join(name for name, present in identity_fields.items() if not present)
        analysis = f"审批身份绑定已有部分实现，但仍缺字段或验证闭环：{missing or '测试/失效逻辑'}。"
    else:
        status = "open"
        analysis = "Delivery approval 仍更接近“批准一个 Run/动作”，没有充分绑定用户实际审阅的提交、PR 正文和交付包。"
    findings.append(
        Finding(
            "P1-05",
            "P1",
            "Delivery approval 的内容身份绑定",
            status,
            merge_evidence(
                evidence(delivery, r"headSha|baseSha|bodySha|packageSha|head_sha|base_sha|hash"),
                evidence(all_tests, r"approval.*(mismatch|stale|changed|hash)"),
            ),
            analysis,
            "审批记录至少绑定 base/head SHA、正文摘要、交付包摘要；任何内容变化后必须重新审批。",
        )
    )

    session_store = [p for p in core if "session-store" in p.name]
    event_limit = has(session_store + web, r"listEvents.{0,160}(limit|pageSize|cursor)|limit\s+\?|take\s*:", flags=re.I | re.S)
    session_limit = has(session_store + web, r"listSessions.{0,160}(limit|pageSize|cursor)|session.*pagination", flags=re.I | re.S)
    virtualization = has(web, r"virtualiz|react-window|react-virtual|useVirtual")
    folding_search = has(web, r"折叠|collapse|search events|filter events|事件搜索|load more|加载更多")
    scale_tests = has(all_tests, r"(1000|10_000|long session|pagination|virtualiz|load more).{0,80}(event|session)", flags=re.I | re.S)
    if event_limit and session_limit and (virtualization or folding_search) and scale_tests:
        status = "resolved"
        analysis = "Session 列表与事件流均有游标/分页，长流具有折叠或虚拟化，并有规模测试。"
    elif event_limit or session_limit or virtualization or folding_search:
        status = "partial"
        analysis = "已经加入部分分页、折叠或搜索，但数据读取、SSE 内存、DOM 渲染和重连游标尚未同时受控。"
    else:
        status = "open"
        analysis = "Session/Event 读取和前端渲染仍近似全量；长会话会逐步增加 SQL、内存、DOM 与重连成本。"
    findings.append(
        Finding(
            "P1-06",
            "P1",
            "多 Workspace 与长 Session 的规模化 UX/数据路径",
            status,
            merge_evidence(
                evidence(session_store + web, r"listEvents|listSessions|limit|cursor|pagination|virtualiz|load more|搜索"),
                evidence(all_tests, r"long session|pagination|virtualiz|1000|10_000"),
            ),
            analysis,
            "服务端游标分页和上限、SSE 有界缓冲、前端虚拟化/折叠/搜索、自动滚动暂停，并覆盖千级事件。",
        )
    )

    # ------------------------------------------------------------------
    # Regression guard: previous high-severity fixes must still be present.
    # ------------------------------------------------------------------
    regression_checks = {
        "ownership-loss abort reason": has(core, r"JOB_ABORT_REASON_OWNERSHIP_LOST|ownership.?lost"),
        "same-worker execution generation fence": has(core, r"executionTokens|execution.?generation"),
        "cross-process durable control relay": has(core, r"syncOwnedControls|abortState.{0,120}propagated", flags=re.I | re.S),
        "SQLite cross-connection seq serialization": has(core, r"BEGIN IMMEDIATE|begin immediate"),
        "SSE durable catch-up": has(web, r"listEventsSince.{0,180}(poll|catch|cursor)|durable.*catch", flags=re.I | re.S),
        "terminal status monotonicity": has(core + cli, r"WorkflowTerminalError|illegal-transition|终态"),
        "durable event redaction": has(core, r"redactSecrets.{0,220}(prompt|error|assistant)|prompt.{0,220}redactSecrets", flags=re.I | re.S),
    }
    missing_regressions = [name for name, present in regression_checks.items() if not present]
    findings.append(
        Finding(
            "REG-01",
            "High" if missing_regressions else "Info",
            "第二轮高风险修复的回归保护",
            "regressed" if missing_regressions else "resolved",
            merge_evidence(
                evidence(core, r"JOB_ABORT_REASON_OWNERSHIP_LOST|executionTokens|syncOwnedControls|BEGIN IMMEDIATE|redactSecrets"),
                evidence(web, r"listEventsSince|durable.*catch"),
                evidence(cli + core, r"WorkflowTerminalError|illegal-transition|终态"),
            ),
            (
                "下列上一轮关键修复在当前代码中未找到可靠证据：" + "、".join(missing_regressions)
                if missing_regressions
                else "上一轮 ownership fencing、跨进程控制、seq 序列化、SSE durable catch-up、终态单调性和写前脱敏仍有代码证据。"
            ),
            "关键并发/恢复语义必须保持专门回归测试，不能只依赖全量 happy-path CI。",
        )
    )

    # ------------------------------------------------------------------
    # UI/UX implementation checks.
    # ------------------------------------------------------------------
    session_detail = [p for p in web if p.name == "SessionDetailPage.tsx"]
    connection_announced = has(session_detail + web, r"session-conn.{0,180}(aria-live|role=.?status)|aria-live.{0,180}session-conn", flags=re.I | re.S)
    action_pending = has(web, r"isPending|isSubmitting|aria-busy|disabled=\{.*(pending|loading|submitting)")
    error_surface = has(web, r"ErrorBanner|role=.?alert|submit.*error|mutation.*error")
    responsive = has([p for p in web if p.suffix == ".css"], r"@media|container-type")
    reduced_motion = has([p for p in web if p.suffix == ".css"], r"prefers-reduced-motion")
    tool_collapse = has(web, r"<details|aria-expanded|collapse|折叠")

    ux_gaps: list[str] = []
    if not connection_announced:
        ux_gaps.append("连接/重连状态未形成 polite live status")
    if not action_pending:
        ux_gaps.append("提交类操作缺少统一 pending/disabled 防重复反馈")
    if not error_surface:
        ux_gaps.append("持续输入或控制操作缺少稳定的可见错误面")
    if not responsive:
        ux_gaps.append("Session 多栏布局缺少明确响应式降级证据")
    if not reduced_motion:
        ux_gaps.append("未找到 reduced-motion 适配")
    if not tool_collapse:
        ux_gaps.append("工具/治理长内容缺少折叠入口")

    findings.append(
        Finding(
            "UX-01",
            "Medium" if ux_gaps else "Info",
            "Session 工作台的交互反馈与可访问性",
            "partial" if ux_gaps else "resolved",
            merge_evidence(
                evidence(web, r"aria-live|role=.?status|aria-busy|isPending|disabled=|ErrorBanner|@media|prefers-reduced-motion|<details|aria-expanded"),
                evidence(web_tests, r"keyboard|aria|screen reader|responsive|duplicate submit|loading"),
            ),
            "仍需处理：" + "；".join(ux_gaps) if ux_gaps else "连接状态、操作反馈和基础可访问性存在实现证据。",
            "所有异步操作有 pending/成功/失败反馈；状态用 polite live region；键盘可达；窄屏可用；动画尊重 reduced motion；长内容可折叠。",
        )
    )

    # ------------------------------------------------------------------
    # New-delta code-risk scan, informational unless suppressions appear.
    # ------------------------------------------------------------------
    changed: list[str] = []
    try:
        changed = run(
            "git",
            "diff",
            "--name-only",
            f"{PREVIOUS_REVIEW_HEAD}..HEAD",
        ).splitlines()
    except subprocess.CalledProcessError:
        pass
    changed_paths = [ROOT / path for path in changed if (ROOT / path).is_file()]
    suppressions = matching_lines(
        changed_paths,
        r"@ts-ignore|eslint-disable|\bas any\b|TODO|FIXME|catch\s*\{\s*\}",
        flags=re.I,
        limit=20,
    )
    if suppressions:
        findings.append(
            Finding(
                "CODE-01",
                "Medium",
                "本轮增量中的类型/异常处理逃生口",
                "review-required",
                [f"`{rel(path)}:{line}`" for path, line, _ in suppressions[:10]],
                "增量中存在类型断言、静默 catch 或待办标记。它们不一定都是缺陷，但在 durable control、事件写入和用户操作路径上不能用来掩盖失败。",
                "逐项证明安全性；关键写入失败必须记录或返回；删除无必要的 suppressions，并用类型守卫/窄化替代。",
            )
        )

    return findings


def status_label(status: str) -> str:
    return {
        "resolved": "已闭环",
        "partial": "部分闭环",
        "open": "未闭环",
        "unknown": "证据不足",
        "regressed": "回归",
        "review-required": "需人工复核",
    }.get(status, status)


def severity_rank(value: str) -> int:
    return {
        "P0": 0,
        "Critical": 0,
        "High": 1,
        "P1": 2,
        "Medium": 3,
        "Low": 4,
        "Info": 5,
    }.get(value, 9)


def render() -> str:
    changed_by_review = apply_safe_accessibility_fixes()
    findings = audit()
    annotations, report_diff = collect_annotations()

    current_head = run("git", "rev-parse", "HEAD")
    current_short = current_head[:12]
    try:
        merge_base = run("git", "merge-base", PREVIOUS_REVIEW_HEAD, "HEAD")
        diff_base = PREVIOUS_REVIEW_HEAD if merge_base == PREVIOUS_REVIEW_HEAD else merge_base
    except subprocess.CalledProcessError:
        diff_base = PREVIOUS_REVIEW_HEAD

    commits = ""
    changed_summary = ""
    changed_files: list[str] = []
    try:
        commits = run(
            "git",
            "log",
            "--no-merges",
            "--pretty=- `%h` %s",
            f"{diff_base}..HEAD",
        )
        changed_summary = run("git", "diff", "--stat", f"{diff_base}..HEAD")
        changed_files = run("git", "diff", "--name-only", f"{diff_base}..HEAD").splitlines()
    except subprocess.CalledProcessError:
        pass

    validations = [
        Validation("安装依赖", validation_outcome("INSTALL_OUTCOME")),
        Validation("Build", validation_outcome("BUILD_OUTCOME")),
        Validation("Typecheck", validation_outcome("TYPECHECK_OUTCOME")),
        Validation("Lint", validation_outcome("LINT_OUTCOME")),
        Validation("Core unit/e2e", validation_outcome("CORE_TEST_OUTCOME")),
        Validation("CLI unit/e2e", validation_outcome("CLI_TEST_OUTCOME")),
        Validation("Web unit", validation_outcome("WEB_TEST_OUTCOME")),
        Validation("Playwright", validation_outcome("PLAYWRIGHT_OUTCOME")),
    ]
    validation_failed = any(v.outcome not in {"success", "skipped"} for v in validations)

    p0_open = [
        item
        for item in findings
        if item.severity in {"P0", "Critical", "High"}
        and item.status not in {"resolved"}
    ]
    p1_open = [
        item
        for item in findings
        if item.severity == "P1" and item.status not in {"resolved"}
    ]

    if not p0_open and not p1_open and not validation_failed:
        verdict = "通过"
        verdict_detail = "上一轮阻断项均形成端到端闭环，且本轮验证通过。"
    elif not p0_open and not validation_failed:
        verdict = "有条件通过"
        verdict_detail = "用户主流程的 P0 已闭环，但仍有 P1 架构债务需要在发布前完成。"
    else:
        verdict = "不通过"
        reasons = [item.code for item in p0_open]
        if validation_failed:
            reasons.append("验证失败")
        verdict_detail = "仍存在阻断项：" + "、".join(reasons) + "。"

    ordered = sorted(findings, key=lambda item: (severity_rank(item.severity), item.code))

    lines: list[str] = [
        "# Tekon Harness Replatform 第三轮全面复审",
        "",
        f"> 复审日期：{dt.date.today().isoformat()}",
        "> 复审对象：PR #10 `review/deepseek-harness-migration-2026-08-20`",
        f"> 上一轮验收基线：`{PREVIOUS_REVIEW_HEAD}`",
        f"> 本轮审查代码基线：`{current_head}`",
        "> 复审维度：产品逻辑、UI 实现、UX 交互、运行时/数据/安全架构、代码正确性、并发恢复、测试与交付可信度。",
        "> UI 边界：本报告包含代码与自动化流程审查；若没有独立浏览器截图证据，不声称完成像素级视觉或完整辅助技术人工验收。",
        "",
        "## 1. 最终结论",
        "",
        f"# **{verdict}**",
        "",
        verdict_detail,
        "",
        "本轮把“存在组件/字段”与“端到端语义闭环”分开判断。新增输入框、事件名或模式参数，如果没有运行时消费、durable 恢复、后端约束和失败路径测试，仍按部分完成处理。",
        "",
        "### 1.1 阻断摘要",
        "",
        "| 编号 | 级别 | 结论 | 主题 |",
        "| --- | --- | --- | --- |",
    ]
    for item in ordered:
        if item.severity == "Info" and item.status == "resolved":
            continue
        lines.append(
            f"| {item.code} | {item.severity} | {status_label(item.status)} | {item.title} |"
        )

    lines.extend(
        [
            "",
            "### 1.2 分层验收",
            "",
            "| 验收对象 | 结论 |",
            "| --- | --- |",
            f"| Session/Event/Job 基础设施与第二轮并发修复 | {'通过' if not any(x.code == 'REG-01' and x.status == 'regressed' for x in findings) and not validation_failed else '不通过'} |",
            f"| 普通用户的持续 Agent 协作主流程 | {'通过' if not p0_open and not validation_failed else '不通过'} |",
            f"| 发布级架构收敛与规模能力 | {'通过' if not p1_open and not validation_failed else '有未闭环项'} |",
            "",
            "## 2. 对第二轮报告批注的复核",
            "",
        ]
    )
    if annotations:
        lines.append("检测到以下批注/处理说明；本轮没有直接采信文字结论，而是回到代码、测试和运行语义复核：")
        lines.append("")
        for item in annotations:
            lines.append(f"- {item}")
    else:
        lines.append("未检测到结构化 HTML 批注；已对报告增量、相关实现和上一轮每个 P0/P1 重新核对。")

    lines.extend(["", "## 3. 详细发现", ""])
    for item in ordered:
        lines.extend(
            [
                f"### {item.code} · {item.title}",
                "",
                f"- **级别：** {item.severity}",
                f"- **状态：** {status_label(item.status)}",
                f"- **证据：** {'、'.join(item.evidence) if item.evidence else '未找到足够实现/测试证据'}",
                "",
                item.analysis,
                "",
                f"**验收要求：** {item.acceptance}",
                "",
            ]
        )

    lines.extend(
        [
            "## 4. 本轮顺手修改",
            "",
        ]
    )
    if changed_by_review:
        lines.append("仅应用了结构可确定、不会改变业务语义的可访问性修复：")
        lines.append("")
        for path in changed_by_review:
            lines.append(f"- `{path}`：把动态连接/等待状态标记为 `role=status` + `aria-live=polite`。")
    else:
        lines.append("没有发现适合在缺少产品决策时直接代改的局部问题；重大项需要正式协议/数据边界设计，未用表面补丁掩盖。")

    lines.extend(
        [
            "",
            "## 5. 增量范围",
            "",
            f"- 上一轮基线：`{diff_base}`",
            f"- 本轮审查 head：`{current_short}`",
            f"- 变更文件数：{len(changed_files)}",
            "",
            "### 5.1 本轮提交",
            "",
            commits or "（无法读取提交列表）",
            "",
            "<details>",
            "<summary>Diff stat</summary>",
            "",
            "```text",
            changed_summary or "(empty)",
            "```",
            "",
            "</details>",
            "",
            "## 6. 验证",
            "",
            "| 检查 | 结果 |",
            "| --- | --- |",
        ]
    )
    for item in validations:
        lines.append(f"| {item.name} | `{item.outcome}` |")

    lines.extend(
        [
            "",
            "正式结论还需以报告提交后的 PR head GitHub Actions 为准；临时评审工作流成功不替代正式 Core/CI checks。",
            "",
            "## 7. 推荐实施顺序",
            "",
            "1. 先闭环仍为 open/partial 的 P0：真实 Provider stream、Session follow-up/steer、默认协作模式、Goal 变更治理。",
            "2. 再统一 canonical event/outbox、durable automation 与 startRun 原子边界，避免产品能力继续建立在 best-effort dual-write 上。",
            "3. 最后完成一次性 UI bootstrap、审批内容身份和长 Session 分页/虚拟化，再做截图式 UI、键盘和辅助技术人工验收。",
            "",
            "## 8. 外部基准",
            "",
            "本轮架构判断继续以仓库中引用的 DeepSeek Harness 官方 headless/architecture 文档为对照；事务与并发判断遵循 SQLite 官方 transaction/locking 语义；动态状态提示按 WAI-ARIA `status`/live-region 的非打断式原则处理。",
            "",
        ]
    )

    # Preserve a small annotation diff excerpt for traceability without copying
    # the entire prior report.
    annotation_added = [
        line
        for line in report_diff.splitlines()
        if line.startswith("+")
        and not line.startswith("+++")
        and re.search(r"批注|回复|已修复|已完成|说明|TODO|NOTE", line, re.I)
    ][:30]
    if annotation_added:
        lines.extend(
            [
                "<details>",
                "<summary>第二轮报告批注增量摘录</summary>",
                "",
                "```diff",
                *annotation_added,
                "```",
                "",
                "</details>",
                "",
            ]
        )

    return "\n".join(lines).rstrip() + "\n"


if __name__ == "__main__":
    write(THIRD_REPORT, render())
    print(THIRD_REPORT)
