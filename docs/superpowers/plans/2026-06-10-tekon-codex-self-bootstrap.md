# Tekon Codex Self-Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex CLI as a first-class Tekon provider, then use Tekon itself to create real PR evidence for Tekon development work.

**Architecture:** Keep the orchestrator deterministic and reuse the existing `AgentAdapter` contract. Codex integration runs through local `codex exec`, receives the same artifact manifest environment as Claude Code, and is recorded in provider snapshots, work-usability samples, review evidence, and docs.

**Tech Stack:** TypeScript, Vitest, Playwright, pnpm workspace, GitHub CLI, local Codex CLI non-interactive mode.

---

## Scope And Exit Criteria

P0 is complete only when all of the following are true:

- `tekon run --agent codex` is supported by CLI and Web run entry points.
- Codex provider snapshots can be resumed safely by CLI and Web.
- `eval work-usability` accepts `expectedProvider: codex`.
- Codex provider has unit coverage for command construction, unsafe arg rejection, prompt delivery, timeout reporting, manifest ingestion, and required artifact failure.
- CLI/eval tests prove `codex` is accepted in sample records and provider snapshots.
- User-facing docs and HTML review docs describe Codex provider usage and boundaries.
- A Tekon self-bootstrap run creates a real PR through `delivery create-pr --approve-human`, then records `run id`, provider, readiness, PR package, PR URL, and CI status in `docs/reviews/`.

## File Map

- `packages/core/src/runtime/codex-adapter.ts`: Codex CLI adapter and command builder.
- `packages/core/src/runtime/manifest-artifacts.ts`: shared artifact manifest ingestion used by real providers.
- `packages/core/src/runtime/claude-code-adapter.ts`: reuse shared manifest ingestion without changing external behavior.
- `packages/core/src/runtime/agent-adapter.ts`: provider union and capability evidence for Codex.
- `packages/core/src/types/config.ts`: schema support for `codex` provider and default agent.
- `packages/core/src/types/domain.ts`: persisted provider union support.
- `packages/core/src/workflow/engine.ts`: default command policy allows `codex`.
- `packages/core/src/eval/work-usability.ts`: `expectedProvider: codex`.
- `packages/core/src/index.ts`: export Codex adapter.
- `packages/cli/src/index.ts`: CLI `--agent codex`, resume snapshot, default config.
- `packages/web/src/server/api/root.ts`: Web `agent=codex`, resume snapshot, default config.
- `packages/web/src/client/App.tsx`: run form provider option.
- `packages/core/__tests__/runtime/codex-adapter.test.ts`: Codex adapter unit tests.
- `packages/core/__tests__/runtime/agent-adapter.test.ts`: real provider capability checks include Codex.
- `packages/core/__tests__/types/config.test.ts`: schemas accept Codex.
- `packages/core/__tests__/eval/work-usability.test.ts`: samples support Codex.
- `packages/cli/__tests__/run-cli.test.ts`: CLI sample record and unsupported-agent behavior include Codex.
- `packages/web/__tests__/api/*` and e2e fixtures: Web accepts Codex selection where provider options are asserted.
- `README.md`, `docs/manual/tekon-user-manual.md`, `docs/manual/tekon-user-manual.html`: user-facing provider docs.
- `docs/manual/codex-provider-smoke.md`, `docs/manual/codex-provider-smoke.html`: manual smoke workflow.
- `docs/reviews/YYYY-MM-DD-tekon-codex-self-bootstrap-report.md/html`: real-run report after the first self-bootstrap PR exists.

## Task 1: Provider Types And Schemas

**Files:**

- Modify: `packages/core/src/types/config.ts`
- Modify: `packages/core/src/types/domain.ts`
- Modify: `packages/core/src/eval/work-usability.ts`
- Test: `packages/core/__tests__/types/config.test.ts`
- Test: `packages/core/__tests__/eval/work-usability.test.ts`

- [ ] **Step 1: Write failing schema tests**

Add assertions that parse `provider: 'codex'`, `defaultAgent: 'codex'`, and `expectedProvider: 'codex'`.

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:unit -- --run packages/core/__tests__/types/config.test.ts packages/core/__tests__/eval/work-usability.test.ts
```

Expected before implementation: Zod enum failures mentioning `codex`.

- [ ] **Step 3: Extend provider unions**

Update the provider enums in config, domain, and work usability schemas from `mock | claude-code | custom` to `mock | claude-code | codex | custom`.

- [ ] **Step 4: Verify green**

Run the same command and confirm both files pass.

## Task 2: Shared Manifest Ingestion

**Files:**

- Create: `packages/core/src/runtime/manifest-artifacts.ts`
- Modify: `packages/core/src/runtime/claude-code-adapter.ts`
- Test: `packages/core/__tests__/runtime/claude-code-adapter.test.ts`

- [ ] **Step 1: Write a guard test through existing Claude coverage**

Use the existing manifest ingestion tests as the behavioral contract: valid manifests enter Artifact Store, missing or invalid manifests fail required real-provider runs, and artifact paths cannot escape `TEKON_OUTPUT_DIR`.

- [ ] **Step 2: Extract shared helper**

Move `ingestManifestArtifacts`, output path resolution, and required artifact checking into `manifest-artifacts.ts` with exports:

```typescript
export async function ingestAgentManifestArtifacts(input: {
  runInput: AgentRunInput;
  manifestPath: string;
}): Promise<Artifact[]>;

export function missingRequiredArtifactTypes(
  required: ArtifactType[] | undefined,
  artifacts: Artifact[],
): ArtifactType[];
```

- [ ] **Step 3: Wire Claude adapter to the helper**

Replace local helper calls in `claude-code-adapter.ts` with imports from `manifest-artifacts.ts`.

- [ ] **Step 4: Verify no regression**

Run:

```bash
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:unit -- --run packages/core/__tests__/runtime/claude-code-adapter.test.ts
```

Expected: all Claude adapter tests still pass.

## Task 3: Codex Adapter

**Files:**

- Create: `packages/core/src/runtime/codex-adapter.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/runtime/agent-adapter.ts`
- Modify: `packages/core/src/workflow/engine.ts`
- Test: `packages/core/__tests__/runtime/codex-adapter.test.ts`
- Test: `packages/core/__tests__/runtime/agent-adapter.test.ts`

- [ ] **Step 1: Write failing Codex adapter tests**

Cover:

- default command is `codex exec`;
- sandbox is `workspace-write`;
- approval is `on-request`;
- prompt is sent through stdin;
- user args cannot override sandbox, approval, or use danger-full-access / bypass flags;
- manifest ingestion mirrors Claude behavior;
- missing required artifact returns `exitCode: 1`;
- default workflow command policy allowlist contains `codex`.

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:unit -- --run packages/core/__tests__/runtime/codex-adapter.test.ts packages/core/__tests__/runtime/agent-adapter.test.ts
```

Expected before implementation: missing export/module or failed enum checks.

- [ ] **Step 3: Implement minimal Codex adapter**

Implement `buildCodexCommand` and `createCodexAdapter` with the same result semantics as `createClaudeCodeAdapter`, using:

```typescript
const defaultArgs = [
  '--sandbox',
  'workspace-write',
  '--ask-for-approval',
  'on-request',
  'exec',
];
```

The adapter must set `TEKON_OUTPUT_DIR`, `TEKON_ARTIFACT_MANIFEST`, `TEKON_RUN_ID`, and `TEKON_NODE_ID`.

- [ ] **Step 4: Add provider capability support**

Allow `codex` as a real provider in capability checks, while still rejecting enabled network, danger-full-access, never approval, root filesystem scope, and wildcard tools without deny rules.

- [ ] **Step 5: Verify green**

Run the same command and confirm all adapter tests pass.

## Task 4: CLI And Web Provider Wiring

**Files:**

- Modify: `packages/cli/src/index.ts`
- Modify: `packages/web/src/server/api/root.ts`
- Modify: `packages/web/src/client/App.tsx`
- Test: `packages/cli/__tests__/run-cli.test.ts`
- Test: `packages/web/__tests__/api/read-api.test.ts`
- Test: `packages/web/__tests__/e2e/dashboard.test.ts`

- [ ] **Step 1: Write failing CLI/Web tests**

Add tests showing:

- `tekon run --agent codex` creates a Codex provider snapshot when using a fixture command config;
- `eval work-usability record` can write `expectedProvider: codex`;
- Web run form contains a `codex` option;
- Web resume accepts a persisted Codex provider snapshot.

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm exec --yes -- pnpm@10.12.1 --filter @tekon/cli test:unit -- --run packages/cli/__tests__/run-cli.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @tekon/web test -- --run packages/web/__tests__/api/read-api.test.ts
```

Expected before implementation: unsupported `codex` or missing UI option.

- [ ] **Step 3: Wire CLI**

Add `defaultCodexConfig(repoPath)` and branches in `createAgentAdapter` / `createAgentAdapterFromSnapshot`.

- [ ] **Step 4: Wire Web**

Add Codex to `createWebAgentRuntime`, `adapterForRunProvider`, `defaultCodexConfig`, and the dashboard select control.

- [ ] **Step 5: Verify green**

Run CLI unit, Web unit, and the targeted dashboard e2e.

## Task 5: Docs And Manual Smoke

**Files:**

- Modify: `README.md`
- Modify: `docs/manual/tekon-user-manual.md`
- Modify: `docs/manual/tekon-user-manual.html`
- Create: `docs/manual/codex-provider-smoke.md`
- Create: `docs/manual/codex-provider-smoke.html`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document Codex provider boundaries**

State that Codex provider is local Codex CLI, uses `codex exec`, must be authenticated locally, writes Tekon artifacts through the manifest protocol, and is not proof of production stability without self-bootstrap samples.

- [ ] **Step 2: Add smoke workflow**

Document:

```bash
npm exec --yes -- pnpm@10.12.1 build
node packages/cli/dist/index.js run "补齐 Codex provider smoke" --template docs-update --agent codex --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js delivery prepare --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js delivery create-pr --approve-human --repo /Users/zhaoensheng/Projects/tekon
node packages/cli/dist/index.js delivery ci-status --repo /Users/zhaoensheng/Projects/tekon
```

- [ ] **Step 3: Verify docs**

Run:

```bash
npm exec --yes -- prettier --check README.md CHANGELOG.md docs/manual/tekon-user-manual.md docs/manual/tekon-user-manual.html docs/manual/codex-provider-smoke.md docs/manual/codex-provider-smoke.html
```

## Task 6: Local Verification

**Files:**

- No source changes expected unless verification exposes defects.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:unit -- --run packages/core/__tests__/runtime/codex-adapter.test.ts packages/core/__tests__/runtime/claude-code-adapter.test.ts packages/core/__tests__/types/config.test.ts packages/core/__tests__/eval/work-usability.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @tekon/cli test:unit -- --run packages/cli/__tests__/run-cli.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @tekon/web test -- --run packages/web/__tests__/api/read-api.test.ts
```

- [ ] **Step 2: Run full baseline**

Run:

```bash
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @tekon/web test:e2e
git diff --check
```

## Task 7: First Self-Bootstrap PR And Report

**Files:**

- Create: `docs/reviews/YYYY-MM-DD-tekon-codex-self-bootstrap-report.md`
- Create: `docs/reviews/YYYY-MM-DD-tekon-codex-self-bootstrap-report.html`
- Modify or create: `.tekon/eval/work-usability-samples.yaml` during runtime only; commit a summarized report, not `.tekon` runtime state.

- [ ] **Step 1: Run a real Tekon demand with Codex**

Use a small Tekon-owned demand, preferably `eval work-usability supports codex provider evidence`, and run through `tekon run --agent codex`.

- [ ] **Step 2: Create a real PR through Tekon**

Run `delivery prepare`, then `delivery create-pr --approve-human`.

- [ ] **Step 3: Record CI evidence**

Run `delivery ci-status` or `delivery ci-watch`.

- [ ] **Step 4: Generate the report**

The report must include run id, provider snapshot, demand summary, gate results, readiness summary, PR package path, PR URL, CI status, failed checks if any, and next actions.

- [ ] **Step 5: Review and commit**

Perform reviewer pass, fix mandatory findings, then commit code, tests, docs, and report.

## Follow-On Priorities After P0

1. **Review Surface V2:** reshape review output around result, risk, evidence, review, and PR decision layers.
2. **Codex Stability:** use self-bootstrap failures to harden manifest prompts, timeout handling, recovery, and diagnostics.
3. **CLI Modularization:** split one high-change command domain after Codex self-bootstrap is stable.
4. **Web Cockpit:** expose self-bootstrap run state, PR, CI, and pending actions as a concise dashboard.
5. **Provider Comparison:** evaluate Trae Agent only after Codex self-bootstrap produces stable evidence.
6. **Benchmarking:** run SWE-bench-style comparisons after internal self-bootstrap metrics exist.
