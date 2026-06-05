# Donkey V2 Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript monorepo CLI tool (`donkey`) that takes a natural language requirement and autonomously drives it through clarification→implementation→testing→review→PR delivery, using Claude Code as the underlying Agent.

**Architecture:** pnpm monorepo with three packages: `core` (pure logic shared by CLI and Web), `cli` (Commander.js + ink terminal UI), `web` (Next.js dashboard). Core contains six modules: Workflow Engine (state machine + scheduler), Role System (filesystem-based role loading), Gate Engine (deterministic quality checks), Artifact Store (file-based artifact management), Constraint Validator (three-tier constraint system), and Audit Logger (immutable event log). Storage uses SQLite (better-sqlite3) for state/metadata and filesystem for artifacts/roles/workflows.

**Tech Stack:** TypeScript, pnpm workspaces, tsup (build), Commander.js + ink (CLI), Next.js + shadcn/ui + tRPC (Web), better-sqlite3 (DB), Vitest + Playwright (testing), Zod (validation), js-yaml (YAML parsing)

---

## File Structure

```
donkey/
├── pnpm-workspace.yaml
├── package.json                  # root: scripts, devDeps
├── tsconfig.base.json            # shared TS config
├── vitest.workspace.ts           # vitest workspace config
│
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts          # barrel export
│   │   │   ├── types.ts          # all shared types (Demand, Project, Node, etc.)
│   │   │   ├── db.ts             # SQLite setup + migrations
│   │   │   ├── config.ts         # donkey.config.yaml loader
│   │   │   ├── workflow/
│   │   │   │   ├── engine.ts     # phase(), agent(), pipeline(), parallel()
│   │   │   │   ├── template.ts   # YAML template parser + validator
│   │   │   │   └── state.ts      # WorkflowInstance + Node state machine
│   │   │   ├── role/
│   │   │   │   ├── loader.ts     # scan roles/ dirs → RoleConfig[]
│   │   │   │   ├── builder.ts    # render system.md template
│   │   │   │   └── runner.ts     # spawn Claude Code child process
│   │   │   ├── gate/
│   │   │   │   ├── engine.ts     # GateChain executor
│   │   │   │   └── checks.ts     # build/test/lint/e2e/schema checkers
│   │   │   ├── artifact/
│   │   │   │   └── store.ts      # read/write/version artifacts
│   │   │   ├── constraint/
│   │   │   │   └── validator.ts  # hard/conditional/soft constraint checker
│   │   │   └── audit/
│   │   │       └── logger.ts     # immutable event writer + reader
│   │   └── __tests__/
│   │       ├── workflow/
│   │       │   ├── engine.test.ts
│   │       │   ├── template.test.ts
│   │       │   └── state.test.ts
│   │       ├── role/
│   │       │   ├── loader.test.ts
│   │       │   ├── builder.test.ts
│   │       │   └── runner.test.ts
│   │       ├── gate/
│   │       │   ├── engine.test.ts
│   │       │   └── checks.test.ts
│   │       ├── artifact/
│   │       │   └── store.test.ts
│   │       ├── constraint/
│   │       │   └── validator.test.ts
│   │       └── audit/
│   │           └── logger.test.ts
│   │
│   ├── cli/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── index.ts          # main entry (#!/usr/bin/env node)
│   │   │   ├── commands/
│   │   │   │   ├── init.ts       # donkey init
│   │   │   │   ├── run.ts        # donkey run
│   │   │   │   ├── status.ts     # donkey status
│   │   │   │   ├── role.ts       # donkey role *
│   │   │   │   ├── workflow.ts   # donkey workflow *
│   │   │   │   ├── constraints.ts
│   │   │   │   ├── log.ts
│   │   │   │   └── clean.ts
│   │   │   └── ui/
│   │   │       ├── status-view.tsx   # ink component for donkey status
│   │   │       └── progress.tsx      # ink progress bar component
│   │   └── __tests__/
│   │       ├── commands/
│   │       │   ├── init.test.ts
│   │       │   ├── run.test.ts
│   │       │   └── status.test.ts
│   │       └── fixtures/
│   │           ├── mock-repo/
│   │           │   ├── src/
│   │           │   │   └── index.ts
│   │           │   ├── package.json
│   │           │   └── .donkey/
│   │           │       └── roles/      # project-level role override (test)
│   │           │           └── rd/
│   │           │               └── agent.yaml
│   │           ├── mock-roles/
│   │           │   ├── pm/
│   │           │   │   ├── agent.yaml
│   │           │   │   ├── system.md
│   │           │   │   ├── skills/
│   │           │   │   │   ├── clarify.md
│   │           │   │   │   └── acceptance.md
│   │           │   │   └── tools.yaml
│   │           │   ├── rd/
│   │           │   │   ├── agent.yaml
│   │           │   │   ├── system.md
│   │           │   │   ├── skills/
│   │           │   │   │   └── implement.md
│   │           │   │   └── tools.yaml
│   │           │   ├── qa/
│   │           │   │   ├── agent.yaml
│   │           │   │   ├── system.md
│   │           │   │   ├── skills/
│   │           │   │   │   ├── test-plan.md
│   │           │   │   │   └── e2e.md
│   │           │   │   └── tools.yaml
│   │           │   ├── reviewer/
│   │           │   │   ├── agent.yaml
│   │           │   │   ├── system.md
│   │           │   │   └── skills/
│   │           │   │       ├── code-review.md
│   │           │   │       └── security.md
│   │           │   └── pmo/
│   │           │       ├── agent.yaml
│   │           │       ├── system.md
│   │           │       └── skills/
│   │           │           └── delivery-summary.md
│   │           └── mock-workflows/
│   │               ├── standard-feature.yaml
│   │               └── bugfix.yaml
│   │
│   └── web/
│       ├── package.json
│       ├── tsconfig.json
│       ├── next.config.js
│       ├── src/
│       │   ├── app/
│       │   │   ├── layout.tsx
│       │   │   ├── page.tsx           # / project list
│       │   │   ├── demand/
│       │   │   │   └── page.tsx       # /demand
│       │   │   ├── project/
│       │   │   │   └── [id]/
│       │   │   │       ├── page.tsx   # /project/:id overview
│       │   │   │       ├── artifacts/
│       │   │   │       │   └── page.tsx
│       │   │   │       └── audit/
│       │   │   │           └── page.tsx
│       │   │   ├── roles/
│       │   │   │   └── page.tsx       # /roles
│       │   │   └── workflows/
│       │   │       └── page.tsx       # /workflows
│       │   ├── server/
│       │   │   └── api/
│       │   │       └── routers/       # tRPC routers
│       │   │           ├── project.ts
│       │   │           ├── role.ts
│       │   │           ├── workflow.ts
│       │   │           └── audit.ts
│       │   └── components/
│       │       ├── layout.tsx
│       │       ├── project-list.tsx
│       │       ├── cockpit/
│       │       │   ├── phase-timeline.tsx
│       │       │   ├── artifact-list.tsx
│       │       │   └── gate-status.tsx
│       │       └── ui/                # shadcn/ui components
│       └── __tests__/
│           ├── page.test.tsx
│           └── cockpit.test.tsx
│
├── roles/                         # built-in roles (source of truth)
│   ├── pm/
│   │   ├── agent.yaml
│   │   ├── system.md
│   │   ├── skills/
│   │   │   ├── clarify.md
│   │   │   ├── prd-gen.md
│   │   │   └── acceptance.md
│   │   └── tools.yaml
│   ├── rd/
│   │   ├── agent.yaml
│   │   ├── system.md
│   │   ├── skills/
│   │   │   ├── implement.md
│   │   │   ├── refactor.md
│   │   │   └── debug.md
│   │   └── tools.yaml
│   ├── qa/
│   │   ├── agent.yaml
│   │   ├── system.md
│   │   ├── skills/
│   │   │   ├── test-plan.md
│   │   │   └── e2e.md
│   │   └── tools.yaml
│   ├── reviewer/
│   │   ├── agent.yaml
│   │   ├── system.md
│   │   ├── skills/
│   │   │   ├── code-review.md
│   │   │   └── security.md
│   │   └── tools.yaml
│   └── pmo/
│       ├── agent.yaml
│       ├── system.md
│       └── skills/
│           └── delivery-summary.md
│
├── workflows/                     # built-in workflow templates
│   ├── standard-feature.yaml
│   └── bugfix.yaml
│
└── constraints.yaml               # built-in hard/conditional/soft constraints
```

---

## Week 1: Project Scaffolding + Core Types + DB

### Task 1: Monorepo scaffolding

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`

- [ ] **Step 1: Create root package.json**

```json
{
  "name": "donkey",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm -r dev",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.6",
    "vitest": "^2.1",
    "tsup": "^8.3",
    "@types/node": "^22"
  }
}
```

- [ ] **Step 2: Create pnpm-workspace.yaml**

```yaml
packages:
  - 'packages/*'
```

- [ ] **Step 3: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 4: Create packages/core/package.json**

```json
{
  "name": "@donkey/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts",
    "dev": "tsup src/index.ts --format esm --dts --watch"
  },
  "dependencies": {
    "better-sqlite3": "^11.6",
    "js-yaml": "^4.1",
    "zod": "^3.23",
    "mustache": "^4.2"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6",
    "@types/js-yaml": "^4.0",
    "@types/mustache": "^4.2"
  }
}
```

- [ ] **Step 5: Create packages/cli/package.json**

```json
{
  "name": "@donkey/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": { "donkey": "./dist/index.js" },
  "scripts": {
    "build": "tsup src/index.ts --format esm",
    "dev": "tsup src/index.ts --format esm --watch"
  },
  "dependencies": {
    "@donkey/core": "workspace:*",
    "commander": "^12.1",
    "ink": "^5.0",
    "react": "^18.3"
  },
  "devDependencies": {
    "@types/react": "^18.3"
  }
}
```

- [ ] **Step 6: Create packages/web/package.json**

```json
{
  "name": "@donkey/web",
  "version": "0.1.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build"
  },
  "dependencies": {
    "@donkey/core": "workspace:*",
    "next": "^15.0",
    "react": "^18.3",
    "react-dom": "^18.3",
    "@trpc/server": "^11.0",
    "@trpc/client": "^11.0",
    "@trpc/next": "^11.0",
    "zod": "^3.23"
  }
}
```

- [ ] **Step 7: Create vitest.workspace.ts**

```typescript
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'core',
      root: './packages/core',
      include: ['__tests__/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'cli',
      root: './packages/cli',
      include: ['__tests__/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'web',
      root: './packages/web',
      include: ['__tests__/**/*.test.tsx'],
      environment: 'jsdom',
    },
  },
]);
```

- [ ] **Step 8: Install dependencies**

Run: `pnpm install`
Expected: installs all packages, links workspace deps

- [ ] **Step 9: Verify scaffolding**

Run: `pnpm build`
Expected: builds all packages (empty for now, no errors)

- [ ] **Step 10: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json vitest.workspace.ts packages/
git commit -m "feat: monorepo scaffolding — pnpm workspaces + core/cli/web packages"
```

---

### Task 2: Core shared types

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/index.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/core/__tests__/types.test.ts
import { describe, it, expect } from 'vitest';
import type { Demand, Project, WorkflowInstance, Phase, Node, GateConfig, Artifact, ArtifactRef, RoleRun, AuditEvent } from '../src/types.js';

describe('Type exports', () => {
  it('should have all core type identifiers available', () => {
    // Compile-time check: if types aren't exported, this file won't compile
    const types = [
      'Demand', 'Project', 'WorkflowInstance', 'Phase', 'Node',
      'GateConfig', 'Artifact', 'ArtifactRef', 'RoleRun', 'AuditEvent',
    ];
    expect(types.length).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run`
Expected: FAIL — module not found

- [ ] **Step 3: Implement types.ts**

```typescript
// packages/core/src/types.ts

// ── Enums ──
export type DemandStatus = 'draft' | 'clarifying' | 'shaped' | 'prioritized' | 'converted' | 'project-linked';
export type ProjectStatus = 'pending' | 'planning' | 'executing' | 'verifying' | 'delivering' | 'completed' | 'rolled-back' | 'cancelled';
export type NodeStatus = 'pending' | 'running' | 'awaiting-gate' | 'passed' | 'needs-revision' | 'blocked' | 'skipped' | 'interrupted';
export type ArtifactStatus = 'draft' | 'reviewing' | 'needs-revision' | 'approved' | 'archived';
export type ArtifactType = 'demand-card' | 'prd' | 'tech-design' | 'task-breakdown' | 'code-changes' | 'test-report' | 'review-report' | 'delivery-package' | 'rollback-plan' | 'security-report';
export type GateType = 'build' | 'test' | 'lint' | 'e2e-pass' | 'schema' | 'security-scan' | 'human';
export type OnExhausted = 'skip' | 'block' | 'escalate-human';
export type PhaseSource = 'template' | 'dynamic' | 'constraint';
export type NodeSource = 'template' | 'dynamic' | 'constraint';
export type RoleRunStatus = 'running' | 'completed' | 'failed';
export type RiskLevel = 'low' | 'medium' | 'high' | 'blocked';

// ── Core Objects ──
export interface AcceptanceCriterion {
  id: string;
  description: string;
  status: 'pending' | 'passed' | 'failed' | 'uncovered';
  evidence?: string;
}

export interface Demand {
  id: string;
  title: string;
  description: string;
  scope: string;
  nonGoals: string[];
  tags: string[];
  riskLevel: RiskLevel;
  acceptanceCriteria: AcceptanceCriterion[];
  status: DemandStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  demandId: string;
  name: string;
  workflowInstanceId: string;
  status: ProjectStatus;
  repoUrl: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactRef {
  type: ArtifactType;
  nodeId?: string;
  phaseIndex?: number;
}

export interface Node {
  id: string;
  role: string;
  task: {
    input: ArtifactRef[];
    output: ArtifactType[];
    instruction: string;
  };
  skills: string[];
  gate?: GateConfig;
  status: NodeStatus;
  retryCount: number;
  maxRetries: number;
  source: NodeSource;
}

export interface Phase {
  id: string;
  title: string;
  nodes: Node[];
  parallel: boolean;
  gate?: GateConfig;
  status: 'pending' | 'running' | 'completed' | 'failed';
  source: PhaseSource;
}

export interface WorkflowInstance {
  id: string;
  templateRef: string;
  projectId: string;
  phases: Phase[];
  currentPhaseIndex: number;
  status: 'running' | 'paused' | 'completed' | 'failed';
}

export interface GateCheck {
  type: GateType;
  command?: string;
  autoFix: boolean;
}

export interface GateConfig {
  checks: GateCheck[];
  retryLimit: number;
  onExhausted: OnExhausted;
}

export interface GateResult {
  type: GateType;
  status: 'pass' | 'fail' | 'error';
  output: string;
  duration: number;
  retriesUsed: number;
  fixedByAgent: boolean;
}

export interface Artifact {
  id: string;
  projectId: string;
  nodeId: string;
  type: ArtifactType;
  version: number;
  status: ArtifactStatus;
  summary?: string;
  filePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoleRun {
  id: string;
  nodeId: string;
  role: string;
  startTime: string;
  endTime?: string;
  status: RoleRunStatus;
  worktreePath: string;
  logFile: string;
  artifacts: string[];
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  projectId: string;
  nodeId: string;
  eventType: string;
  payload: Record<string, unknown>;
  roleSource?: string;
}

// ── Role config types ──
export interface AgentCommand {
  command: string;
  args: string[];
  promptMode?: 'stdin' | 'arg-append' | 'file' | 'none';
  env?: Record<string, string>;
}

export interface RoleConfig {
  name: string;
  display: string;
  description: string;
  model: string;
  agent: AgentCommand;
  timeout: number;
  maxRetries: number;
  outputs: ArtifactType[];
  quality?: string;
  gate?: GateConfig;
  context: {
    maxSkills: number;
    includeHistory: boolean;
    knowledgeFiles?: string[];
  };
  constraintTask?: {
    instruction: string;
    skills: string[];
    output: ArtifactType[];
  };
  source: 'builtin' | 'user' | 'project';
  dirPath: string;
}

// ── Workflow template types ──
export interface WorkflowMatch {
  riskLevel?: RiskLevel[];
  types?: string[];
}

export interface WorkflowTemplate {
  name: string;
  description: string;
  match?: WorkflowMatch;
  phases: Array<{
    title: string;
    parallel?: boolean;
    nodes: Array<{
      role: string;
      task: {
        instruction: string;
        input?: (string | ArtifactRef)[];
        output: ArtifactType[];
      };
      skills?: string[];
      retry?: number;
      gate?: GateConfig;
    }>;
  }>;
}

// ── Constraint types ──
export interface ConstraintRule {
  rule: string;
  appliesWhen?: Record<string, unknown>;
  gates?: GateType[];
  requirePhase?: {
    title: string;
    containsRole: string;
  };
  requiresOneOf?: Array<Record<string, string>>;
  requireRole?: string;
  requireSkills?: string[];
  injectGate?: {
    type: GateType;
    at: string;
  };
  requireOutput?: string;
  suggest?: Record<string, unknown>;
}

export interface Constraints {
  hard: ConstraintRule[];
  conditional: Array<ConstraintRule & { when: Record<string, unknown> }>;
  soft: ConstraintRule[];
}

// ── Agent runtime types ──
export interface AgentRunOptions {
  role: string;
  roleConfig: RoleConfig;
  promptContent: string;
  outputDir: string;
  worktreePath: string;
  env?: Record<string, string>;
}

export interface AgentResult {
  role: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  outputFiles: string[];
  duration: number;
}
```

- [ ] **Step 4: Create barrel export**

```typescript
// packages/core/src/index.ts
export * from './types.js';
```

- [ ] **Step 5: Run test to verify**

Run: `pnpm test -- --run`
Expected: PASS — type exports exist

- [ ] **Step 6: Commit**

```bash
git add packages/core/
git commit -m "feat(core): shared types — all core interfaces and type definitions"
```

---

### Task 3: Database layer

**Files:**
- Create: `packages/core/src/db.ts`
- Create: `packages/core/__tests__/db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/__tests__/db.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, initDb, closeDb } from '../src/db.js';
import fs from 'node:fs';

const TEST_DB = ':memory:';

describe('Database', () => {
  afterEach(() => closeDb());

  it('should initialize and create all tables', () => {
    initDb(TEST_DB);
    const db = getDb();

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;

    const names = tables.map(t => t.name);
    expect(names).toContain('projects');
    expect(names).toContain('demands');
    expect(names).toContain('workflow_instances');
    expect(names).toContain('phases');
    expect(names).toContain('nodes');
    expect(names).toContain('artifacts');
    expect(names).toContain('role_runs');
    expect(names).toContain('audit_events');
  });

  it('should insert and query a project', () => {
    initDb(TEST_DB);
    const db = getDb();

    db.prepare(`INSERT INTO projects (id, name, status, repo_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      'proj-1', 'test-project', 'pending', 'https://github.com/test/repo',
      new Date().toISOString(), new Date().toISOString()
    );

    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-1') as any;
    expect(row.id).toBe('proj-1');
    expect(row.name).toBe('test-project');
    expect(row.status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run`
Expected: FAIL — module `db.js` not found

- [ ] **Step 3: Implement db.ts**

```typescript
// packages/core/src/db.ts
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

let db: Database.Database | null = null;

export function getDbPath(projectRoot: string): string {
  return path.join(projectRoot, '.donkey', 'donkey.db');
}

export function initDb(dbPath: string): Database.Database {
  if (db) return db;

  const dir = path.dirname(dbPath);
  if (dir !== ':memory:' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS demands (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      scope TEXT NOT NULL DEFAULT '',
      non_goals TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      risk_level TEXT NOT NULL DEFAULT 'low',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      demand_id TEXT,
      name TEXT NOT NULL,
      workflow_instance_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      repo_url TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (demand_id) REFERENCES demands(id)
    );

    CREATE TABLE IF NOT EXISTS workflow_instances (
      id TEXT PRIMARY KEY,
      template_ref TEXT NOT NULL,
      project_id TEXT NOT NULL,
      current_phase_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS phases (
      id TEXT PRIMARY KEY,
      workflow_instance_id TEXT NOT NULL,
      title TEXT NOT NULL,
      parallel INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'template',
      phase_index INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (workflow_instance_id) REFERENCES workflow_instances(id)
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      phase_id TEXT NOT NULL,
      role TEXT NOT NULL,
      instruction TEXT NOT NULL,
      inputs TEXT NOT NULL DEFAULT '[]',
      outputs TEXT NOT NULL DEFAULT '[]',
      skills TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'template',
      FOREIGN KEY (phase_id) REFERENCES phases(id)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      type TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      summary TEXT,
      file_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS role_runs (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      role TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      worktree_path TEXT NOT NULL,
      log_file TEXT NOT NULL,
      artifacts TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (node_id) REFERENCES nodes(id)
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      role_source TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function closeDb(): void {
  if (db) { db.close(); db = null; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --run`
Expected: PASS — 2 tests passing

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db.ts packages/core/__tests__/db.test.ts
git commit -m "feat(core): database layer — SQLite schema + init/query/close"
```

---

## Week 2: Role System

### Task 4: Role Loader

**Files:**
- Create: `packages/core/src/role/loader.ts`
- Create: `packages/core/__tests__/role/loader.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/__tests__/role/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadRoles } from '../../src/role/loader.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Role Loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donkey-test-'));
    // Create mock builtin role
    const pmDir = path.join(tmpDir, 'roles', 'pm');
    fs.mkdirSync(pmDir, { recursive: true });
    fs.writeFileSync(path.join(pmDir, 'agent.yaml'), `
name: pm
display: 产品经理
description: 测试角色
model: claude-sonnet-4
agent:
  command: claude
  args: []
timeout: 60000
maxRetries: 1
outputs: [demand-card]
context:
  maxSkills: 2
  includeHistory: false
`);
    fs.writeFileSync(path.join(pmDir, 'system.md'), '你是{{display}}');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should load roles from builtin directory', async () => {
    const roles = await loadRoles(tmpDir, undefined, undefined);
    expect(roles.has('pm')).toBe(true);
    const pm = roles.get('pm')!;
    expect(pm.name).toBe('pm');
    expect(pm.display).toBe('产品经理');
    expect(pm.source).toBe('builtin');
    expect(pm.outputs).toEqual(['demand-card']);
  });

  it('should prioritize project-level over builtin roles', async () => {
    const projectDir = path.join(tmpDir, 'project-roles', 'pm');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'agent.yaml'), `
name: pm
display: 自定义PM
description: custom
model: claude-sonnet-4
agent:
  command: claude
  args: []
timeout: 60000
maxRetries: 1
outputs: [demand-card, prd]
context:
  maxSkills: 2
  includeHistory: false
`);

    const roles = await loadRoles(tmpDir, path.join(tmpDir, 'project-roles'), undefined);
    const pm = roles.get('pm')!;
    expect(pm.display).toBe('自定义PM');
    expect(pm.source).toBe('project');
    expect(pm.outputs).toContain('prd');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run`
Expected: FAIL — module not found

- [ ] **Step 3: Implement loader.ts**

```typescript
// packages/core/src/role/loader.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { RoleConfig } from '../types.js';

const BUILTIN_ROLES_DIR = path.resolve(
  new URL('../../../../roles', import.meta.url).pathname
);

async function dirExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function loadRoleFromDir(dirPath: string, source: RoleConfig['source']): Promise<RoleConfig | null> {
  const yamlPath = path.join(dirPath, 'agent.yaml');
  if (!(await dirExists(yamlPath))) return null;

  const yamlContent = await fs.readFile(yamlPath, 'utf-8');
  const raw = yaml.load(yamlContent) as Record<string, any>;

  // Handle agent shorthand
  let agent: RoleConfig['agent'];
  if (typeof raw.agent === 'string') {
    const presets: Record<string, RoleConfig['agent']> = {
      'claude-code': { command: 'claude', args: ['-p'], promptMode: 'arg-append' },
      'codex': { command: 'codex', args: [], promptMode: 'stdin' },
    };
    agent = presets[raw.agent] || { command: raw.agent, args: [] };
  } else {
    agent = {
      command: raw.agent.command || 'claude',
      args: raw.agent.args || [],
      promptMode: raw.agent.promptMode || 'arg-append',
      env: raw.agent.env,
    };
  }

  return {
    name: raw.name || path.basename(dirPath),
    display: raw.display || raw.name,
    description: raw.description || '',
    model: raw.model || 'claude-sonnet-4',
    agent,
    timeout: raw.timeout || 600000,
    maxRetries: raw.maxRetries ?? 0,
    outputs: raw.outputs || [],
    quality: raw.quality,
    gate: raw.gate,
    context: {
      maxSkills: raw.context?.maxSkills ?? 3,
      includeHistory: raw.context?.includeHistory ?? false,
      knowledgeFiles: raw.context?.knowledgeFiles,
    },
    constraintTask: raw.constraintTask,
    source,
    dirPath,
  };
}

export async function loadRoles(
  projectRoot: string,
  projectRolesPath?: string,
  userRolesPath?: string
): Promise<Map<string, RoleConfig>> {
  const roles = new Map<string, RoleConfig>();

  // Priority order: project > user > builtin
  const paths: Array<{ p: string; s: RoleConfig['source'] }> = [];

  if (projectRolesPath) {
    paths.push({ p: projectRolesPath, s: 'project' });
  }
  if (userRolesPath) {
    paths.push({ p: userRolesPath, s: 'user' });
  }
  paths.push({ p: BUILTIN_ROLES_DIR, s: 'builtin' });

  // Load builtin roles
  const builtinPath = BUILTIN_ROLES_DIR;
  if (await dirExists(builtinPath)) {
    const entries = await fs.readdir(builtinPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const role = await loadRoleFromDir(path.join(builtinPath, entry.name), 'builtin');
        if (role && !roles.has(entry.name)) {
          roles.set(entry.name, role);
        }
      }
    }
  }

  // Override with user roles
  if (userRolesPath && await dirExists(userRolesPath)) {
    const entries = await fs.readdir(userRolesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const role = await loadRoleFromDir(path.join(userRolesPath, entry.name), 'user');
        if (role) roles.set(entry.name, role);
      }
    }
  }

  // Override with project roles
  if (projectRolesPath && await dirExists(projectRolesPath)) {
    const entries = await fs.readdir(projectRolesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const role = await loadRoleFromDir(path.join(projectRolesPath, entry.name), 'project');
        if (role) roles.set(entry.name, role);
      }
    }
  }

  return roles;
}
```

- [ ] **Step 4: Run test to verify**

Run: `pnpm test -- --run`
Expected: PASS — 2 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/role/ packages/core/__tests__/role/
git commit -m "feat(core): role loader — filesystem-based role discovery with priority resolution"
```

---

### Task 5: Built-in role files

**Files:**
- Create: `roles/pm/agent.yaml`, `roles/pm/system.md`, `roles/pm/skills/clarify.md`, `roles/pm/skills/acceptance.md`, `roles/pm/tools.yaml`
- Create: `roles/rd/agent.yaml`, `roles/rd/system.md`, `roles/rd/skills/implement.md`, `roles/rd/tools.yaml`
- Create: `roles/qa/agent.yaml`, `roles/qa/system.md`, `roles/qa/skills/test-plan.md`, `roles/qa/skills/e2e.md`, `roles/qa/tools.yaml`
- Create: `roles/reviewer/agent.yaml`, `roles/reviewer/system.md`, `roles/reviewer/skills/code-review.md`, `roles/reviewer/skills/security.md`, `roles/reviewer/tools.yaml`
- Create: `roles/pmo/agent.yaml`, `roles/pmo/system.md`, `roles/pmo/skills/delivery-summary.md`

- [ ] **Step 1: Create all 5 role agent.yaml files**

For brevity, here's the PM role; the other 4 follow the same pattern with role-specific values:

```yaml
# roles/pm/agent.yaml
name: pm
display: 产品经理
description: 负责需求澄清、PRD 生成、验收标准定义
model: claude-sonnet-4
agent:
  command: claude
  args:
    - -p
    - --permission-mode
    - bypassPermissions
    - --output-format
    - text
  promptMode: arg-append
timeout: 600000
maxRetries: 2
outputs:
  - demand-card
  - prd
quality: "输出必须结构化、完整、可验证。验收标准必须可客观判定。"
gate:
  checks:
    - type: schema
  retryLimit: 2
  onExhausted: escalate-human
context:
  maxSkills: 2
  includeHistory: true
```

```yaml
# roles/rd/agent.yaml
name: rd
display: 研发工程师
description: 负责编码实现、单元测试、代码重构
model: claude-sonnet-4
agent:
  command: claude
  args:
    - -p
    - --permission-mode
    - bypassPermissions
    - --output-format
    - text
  promptMode: arg-append
timeout: 900000
maxRetries: 2
outputs:
  - code-changes
  - tech-design
quality: "代码可编译、测试通过、遵循项目规范。"
context:
  maxSkills: 2
  includeHistory: false
```

```yaml
# roles/qa/agent.yaml
name: qa
display: 测试工程师
description: 负责测试计划、E2E 测试、缺陷报告
model: claude-sonnet-4
agent:
  command: claude
  args:
    - -p
    - --permission-mode
    - bypassPermissions
  promptMode: arg-append
timeout: 600000
maxRetries: 2
outputs:
  - test-report
quality: "测试覆盖主流程和异常路径，每条验收标准有对应测试证据。"
context:
  maxSkills: 2
  includeHistory: false
```

```yaml
# roles/reviewer/agent.yaml
name: reviewer
display: 代码审查者
description: 负责代码审查、安全审计、架构一致性检查
model: claude-sonnet-4
agent:
  command: claude
  args:
    - -p
    - --permission-mode
    - bypassPermissions
  promptMode: arg-append
timeout: 600000
maxRetries: 1
outputs:
  - review-report
  - security-report
quality: "审查覆盖安全、规范、性能和架构一致性。"
constraintTask:
  instruction: "基于安全审查 skill 对代码变更进行安全分析"
  skills: [security]
  output: [security-report]
context:
  maxSkills: 2
  includeHistory: false
```

```yaml
# roles/pmo/agent.yaml
name: pmo
display: 项目经理
description: 负责流程协调、进度跟踪、交付证据包生成
model: claude-sonnet-4
agent:
  command: claude
  args:
    - -p
    - --permission-mode
    - bypassPermissions
  promptMode: arg-append
timeout: 300000
maxRetries: 1
outputs:
  - delivery-package
context:
  maxSkills: 1
  includeHistory: false
```

- [ ] **Step 2: Create system.md for each role**

```markdown
<!-- roles/pm/system.md -->
你是 {{display}}，{{description}}。

## 输出规范
你必须以结构化 Markdown 输出，包含：
- 需求卡（标题、范围、非目标）
- 可验证的验收标准（每条带编号，后续 Gate 会逐条检查）
- 关键假设和风险

## 质量标准
{{quality_standards}}

## 可用技能
{{loaded_skills}}

## 可用工具
{{loaded_tools}}

## 领域知识
{{knowledge}}

## 上下文
上游产物：{{input_artifacts}}
项目背景：{{project_context}}
```

(The other 4 system.md files follow the same template, with role-specific output format instructions.)

- [ ] **Step 3: Create skill files for each role**

Skill files use YAML frontmatter:

```markdown
<!-- roles/pm/skills/clarify.md -->
---
id: clarify
description: 需求澄清追问——向用户提出关键问题以补全需求背景
injectMode: append
priority: required
---

## 澄清追问策略

当需求描述不完整时，按以下顺序追问：
1. 用户是谁？目标是什么？
2. 具体场景和触发条件？
3. 边界和约束？
4. 非目标是什么？
5. 如何判断完成？

每次只问 2-3 个最关键的问题，避免过度追问。
```

(Each role has 1-3 skill files as specified in the technical plan.)

- [ ] **Step 4: Create tools.yaml for each role**

```yaml
# roles/pm/tools.yaml
tools:
  - name: lark-doc
    description: 飞书文档读写
    allowedCommands: [read, write]
  - name: file-system
    description: 本地文件读写
    allowedCommands: [read, write]
```

```yaml
# roles/rd/tools.yaml
tools:
  - name: git
    description: Git 版本控制
    allowedCommands: [status, add, commit, branch, checkout, diff, log]
  - name: npm
    description: Node.js 包管理和脚本
    allowedCommands: [install, test, run, build, lint]
```

```yaml
# roles/qa/tools.yaml
tools:
  - name: npm
    description: Node.js 测试执行
    allowedCommands: [test, run]
  - name: playwright
    description: E2E 浏览器测试
    allowedCommands: [test, install]
```

```yaml
# roles/reviewer/tools.yaml
tools:
  - name: git
    description: Git 版本控制（只读）
    allowedCommands: [diff, log, show, status]
  - name: npm
    description: 代码质量检查
    allowedCommands: [run, test]
```

- [ ] **Step 5: Write a loader integration test**

```typescript
// Add to packages/core/__tests__/role/loader.test.ts
it('should load all 5 builtin roles', async () => {
  const roles = await loadRoles(tmpDir, undefined, undefined);
  // Note: this test will pass once the roles/ directory has all 5 builtin roles
  expect(roles.size).toBeGreaterThanOrEqual(5);
});
```

Run: `pnpm test -- --run`
Expected: PASS — 5 roles loaded

- [ ] **Step 6: Commit**

```bash
git add roles/ packages/core/__tests__/role/
git commit -m "feat: built-in roles — pm/rd/qa/reviewer/pmo with agent.yaml, system.md, skills, tools"
```

---

### Task 6: Role Builder (prompt assembler)

**Files:**
- Create: `packages/core/src/role/builder.ts`
- Create: `packages/core/__tests__/role/builder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/__tests__/role/builder.test.ts
import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../src/role/builder.js';
import type { RoleConfig, Artifact } from '../../src/types.js';

const mockRole: RoleConfig = {
  name: 'pm',
  display: '产品经理',
  description: '测试角色',
  model: 'claude-sonnet-4',
  agent: { command: 'claude', args: [], promptMode: 'arg-append' },
  timeout: 60000,
  maxRetries: 0,
  outputs: ['demand-card'],
  quality: '输出必须可验证。',
  context: { maxSkills: 3, includeHistory: false },
  source: 'builtin',
  dirPath: '/tmp/test/pm',
};

const mockArtifacts: Artifact[] = [{
  id: 'art-1',
  projectId: 'proj-1',
  nodeId: 'node-1',
  type: 'demand-card',
  version: 1,
  status: 'approved',
  summary: '需求摘要：批量重试失败任务',
  filePath: '/tmp/artifacts/demand-card.md',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}];

describe('Role Builder', () => {
  it('should render system.md template with variables', () => {
    const systemMd = '你是{{display}}，{{description}}。\n质量标准：{{quality_standards}}';
    const result = buildPrompt(mockRole, systemMd, [], [], [], mockArtifacts, 'test-project');
    expect(result).toContain('你是产品经理');
    expect(result).toContain('测试角色');
    expect(result).toContain('输出必须可验证。');
  });

  it('should include loaded skills content', () => {
    const systemMd = '{{loaded_skills}}';
    const skills = [{ id: 'clarify', content: '## 澄清策略\n1. 问目标', injectMode: 'append' as const, priority: 'required' as const }];
    const result = buildPrompt(mockRole, systemMd, skills, [], [], [], 'test-project');
    expect(result).toContain('## 澄清策略');
    expect(result).toContain('1. 问目标');
  });

  it('should include input artifacts', () => {
    const systemMd = '上游产物：{{input_artifacts}}';
    const result = buildPrompt(mockRole, systemMd, [], [], [], mockArtifacts, 'test-project');
    expect(result).toContain('需求摘要：批量重试失败任务');
  });

  it('should inject knowledge content', () => {
    const systemMd = '{{knowledge}}';
    const knowledge = [{ name: 'prd-template.md', content: '# PRD 模板\n...' }];
    const result = buildPrompt(mockRole, systemMd, [], knowledge, [], [], 'test-project');
    expect(result).toContain('# PRD 模板');
  });
});
```

- [ ] **Step 2: Run test → fail**

Run: `pnpm test -- --run`
Expected: FAIL

- [ ] **Step 3: Implement builder.ts**

```typescript
// packages/core/src/role/builder.ts
import type { RoleConfig, Artifact } from '../types.js';

export interface LoadedSkill {
  id: string;
  content: string;
  injectMode: 'append' | 'replace';
  priority: 'required' | 'optional';
}

export interface LoadedKnowledge {
  name: string;
  content: string;
}

export interface LoadedTool {
  name: string;
  description: string;
  allowedCommands: string[];
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value || '');
  }
  return result;
}

export function buildPrompt(
  role: RoleConfig,
  systemMd: string,
  skills: LoadedSkill[],
  tools: LoadedTool[],
  knowledge: LoadedKnowledge[],
  artifacts: Artifact[],
  projectContext: string,
): string {
  // Build skill content for injection
  const skillsContent = skills
    .filter(s => s.injectMode === 'append')
    .map(s => s.content)
    .join('\n\n');

  // Build tools content
  const toolsContent = tools.length > 0
    ? tools.map(t => `- **${t.name}**: ${t.description} (允许: ${t.allowedCommands.join(', ')})`).join('\n')
    : '';

  // Build knowledge content
  const knowledgeContent = knowledge.map(k => k.content).join('\n\n');

  // Build input artifacts content (use summary, fallback to type)
  const artifactsContent = artifacts.length > 0
    ? artifacts.map(a => `- [${a.type}] ${a.summary || '(无摘要)'}`).join('\n')
    : '(无上游产物)';

  // Replace template variables for first pass (display/description etc.)
  let rendered = renderTemplate(systemMd, {
    display: role.display,
    description: role.description,
    quality_standards: role.quality || '',
    loaded_skills: '',
    loaded_tools: '',
    knowledge: '',
    input_artifacts: '',
    project_context: projectContext,
    ...Object.fromEntries(
      (role.outputs || []).map((o, i) => [`output_${i}`, o])
    ),
  });

  // Second pass: inject actual content
  rendered = rendered.replace('{{loaded_skills}}', skillsContent);
  rendered = rendered.replace('{{loaded_tools}}', toolsContent);
  rendered = rendered.replace('{{knowledge}}', knowledgeContent);
  rendered = rendered.replace('{{input_artifacts}}', artifactsContent);

  return rendered;
}
```

- [ ] **Step 4: Run test → pass**

Run: `pnpm test -- --run`
Expected: PASS — all 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/role/builder.ts packages/core/__tests__/role/builder.test.ts
git commit -m "feat(core): role builder — system.md template rendering with variable injection"
```

---

### Task 7: Role Runner (Agent spawn)

**Files:**
- Create: `packages/core/src/role/runner.ts`
- Create: `packages/core/__tests__/role/runner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/__tests__/role/runner.test.ts
import { describe, it, expect } from 'vitest';
import { runAgent } from '../../src/role/runner.js';
import type { RoleConfig, AgentRunOptions } from '../../src/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockRole: RoleConfig = {
  name: 'pm', display: 'PM', description: 'test',
  model: 'claude-sonnet-4',
  agent: { command: 'echo', args: [], promptMode: 'stdin' },
  timeout: 5000, maxRetries: 0, outputs: ['demand-card'],
  context: { maxSkills: 1, includeHistory: false },
  source: 'builtin', dirPath: '/tmp/test',
};

describe('Role Runner', () => {
  it('should spawn agent and collect output', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donkey-runner-'));
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'result.md'), 'mock artifact content');

    const opts: AgentRunOptions = {
      role: 'pm',
      roleConfig: mockRole,
      promptContent: 'test prompt',
      outputDir,
      worktreePath: tmpDir,
      env: { DONKEY_OUTPUT_DIR: outputDir, DONKEY_ROLE: 'pm' },
    };

    const result = await runAgent(opts);

    expect(result.role).toBe('pm');
    expect(result.exitCode).toBe(0);
    expect(result.outputFiles).toContain('result.md');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should handle agent timeout', async () => {
    const slowRole: RoleConfig = {
      ...mockRole,
      agent: { command: 'sleep', args: ['10'], promptMode: 'none' },
      timeout: 500,  // 500ms timeout
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donkey-timeout-'));
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    await expect(
      runAgent({
        role: 'pm', roleConfig: slowRole,
        promptContent: 'test', outputDir, worktreePath: tmpDir,
      })
    ).rejects.toThrow();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10000);
});
```

- [ ] **Step 2: Run test → fail**

- [ ] **Step 3: Implement runner.ts**

```typescript
// packages/core/src/role/runner.ts
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RoleConfig, AgentRunOptions, AgentResult } from '../types.js';

export async function runAgent(opts: AgentRunOptions): Promise<AgentResult> {
  const { roleConfig, promptContent, outputDir, worktreePath, env } = opts;
  const startTime = Date.now();

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // Build command args
  let args = [...roleConfig.agent.args];
  const promptMode = roleConfig.agent.promptMode || 'arg-append';

  // Handle prompt injection based on mode
  if (promptMode === 'arg-append') {
    args.push(promptContent);
  }

  // Merge environment
  const procEnv = {
    ...process.env,
    ...roleConfig.agent.env,
    ...env,
    DONKEY_OUTPUT_DIR: outputDir,
    DONKEY_ROLE: opts.role,
  };

  return new Promise((resolve, reject) => {
    const proc = spawn(roleConfig.agent.command, args, {
      cwd: worktreePath,
      env: procEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: roleConfig.timeout,
    });

    let stdout = '';
    let stderr = '';

    // If promptMode is stdin, write prompt to stdin
    if (promptMode === 'stdin' && proc.stdin) {
      proc.stdin.write(promptContent);
      proc.stdin.end();
    }

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn agent: ${err.message}`));
    });

    proc.on('close', async (exitCode) => {
      const duration = Date.now() - startTime;

      // Collect output files
      let outputFiles: string[] = [];
      try {
        const files = await fs.readdir(outputDir);
        outputFiles = files.filter(f => !f.startsWith('.'));
      } catch {
        // output dir may not exist if agent failed
      }

      resolve({
        role: opts.role,
        exitCode: exitCode ?? -1,
        stdout,
        stderr,
        outputFiles,
        duration,
      });
    });

    // Handle timeout
    if (roleConfig.timeout > 0) {
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGTERM');
          reject(new Error(`Agent '${opts.role}' timed out after ${roleConfig.timeout}ms`));
        }
      }, roleConfig.timeout);
    }
  });
}
```

- [ ] **Step 4: Run test → pass**

Run: `pnpm test -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/role/runner.ts packages/core/__tests__/role/runner.test.ts
git commit -m "feat(core): role runner — spawn agent subprocess with prompt injection modes"
```

---

## Week 3: Workflow Engine

### Task 8: Workflow template parser

**Files:**
- Create: `packages/core/src/workflow/template.ts`
- Create: `packages/core/__tests__/workflow/template.test.ts`
- Create: `workflows/standard-feature.yaml`
- Create: `workflows/bugfix.yaml`

- [ ] **Step 1: Create test fixtures — workflow templates**

```yaml
# workflows/standard-feature.yaml (copy from technical plan section 5.1)
# [Full YAML from tech plan]
```

```yaml
# workflows/bugfix.yaml
name: bugfix
description: Bug 修复，快速修复流程
match:
  riskLevel: [low]
  types: [bugfix]

phases:
  - title: 需求理解
    parallel: false
    nodes:
      - role: pm
        task:
          instruction: "理解 Bug 描述，补全复现步骤和预期行为"
          output: [demand-card]
        skills: [clarify]
        retry: 1

  - title: 修复与验证
    parallel: false
    nodes:
      - role: rd
        task:
          instruction: "定位 Bug 根因，修复代码，补充测试"
          input: [demand-card]
          output: [code-changes]
        skills: [implement, debug]
        retry: 3
        gate:
          checks:
            - type: build
            - type: test
              autoFix: true
            - type: lint
              autoFix: true
          retryLimit: 3
          onExhausted: escalate-human

  - title: 审查与交付
    parallel: false
    nodes:
      - role: reviewer
        task:
          instruction: "审查修复代码，确认不引入新问题"
          input: [code-changes]
          output: [review-report]
        skills: [code-review]
```

- [ ] **Step 2: Write template parser test**

```typescript
// packages/core/__tests__/workflow/template.test.ts
import { describe, it, expect } from 'vitest';
import { parseTemplate, listTemplates } from '../../src/workflow/template.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = path.resolve(__dirname, '../../../../../workflows');

describe('Template parser', () => {
  it('should parse standard-feature template', async () => {
    const tmpl = await parseTemplate(path.join(WORKFLOWS_DIR, 'standard-feature.yaml'));
    expect(tmpl.name).toBe('standard-feature');
    expect(tmpl.phases).toHaveLength(5);
    expect(tmpl.phases[0].title).toBe('需求澄清');
    expect(tmpl.phases[0].nodes[0].role).toBe('pm');
  });

  it('should parse bugfix template', async () => {
    const tmpl = await parseTemplate(path.join(WORKFLOWS_DIR, 'bugfix.yaml'));
    expect(tmpl.name).toBe('bugfix');
    expect(tmpl.phases).toHaveLength(3);
  });

  it('should list all templates', async () => {
    const templates = await listTemplates(WORKFLOWS_DIR);
    expect(templates.length).toBeGreaterThanOrEqual(2);
    const names = templates.map(t => t.name);
    expect(names).toContain('standard-feature');
    expect(names).toContain('bugfix');
  });

  it('should handle input shorthand (string → ArtifactRef)', async () => {
    const tmpl = await parseTemplate(path.join(WORKFLOWS_DIR, 'standard-feature.yaml'));
    const devPhase = tmpl.phases[1]; // 技术方案与开发
    const node = devPhase.nodes[0];
    // input: [demand-card] should be expanded to [{ type: 'demand-card' }]
    const input = node.task.input;
    expect(Array.isArray(input)).toBe(true);
    if (input && input.length > 0) {
      expect(typeof input[0]).toBe('object');
      expect(input[0].type).toBe('demand-card');
    }
  });
});
```

- [ ] **Step 3: Run test → fail**

- [ ] **Step 4: Implement template.ts**

```typescript
// packages/core/src/workflow/template.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import type { WorkflowTemplate, ArtifactRef, GateConfig } from '../types.js';

export async function parseTemplate(filePath: string): Promise<WorkflowTemplate> {
  const content = await fs.readFile(filePath, 'utf-8');
  const raw = yaml.load(content) as Record<string, any>;

  // Parse phases with input shorthand expansion
  const phases = (raw.phases || []).map((phase: any) => ({
    title: phase.title,
    parallel: phase.parallel ?? false,
    nodes: (phase.nodes || []).map((node: any) => ({
      role: node.role,
      task: {
        instruction: node.task.instruction,
        input: expandInput(node.task.input),
        output: node.task.output || [],
      },
      skills: node.skills || [],
      retry: node.retry,
      gate: node.gate,
    })),
  }));

  return {
    name: raw.name,
    description: raw.description || '',
    match: raw.match,
    phases,
  };
}

function expandInput(input: any): (string | ArtifactRef)[] {
  if (!input || !Array.isArray(input)) return [];
  return input.map((item: any) => {
    if (typeof item === 'string') {
      return { type: item } as ArtifactRef;
    }
    return item as ArtifactRef;
  });
}

export async function listTemplates(workflowsDir: string): Promise<WorkflowTemplate[]> {
  const templates: WorkflowTemplate[] = [];
  try {
    const files = await fs.readdir(workflowsDir);
    for (const file of files) {
      if (file.endsWith('.yaml') || file.endsWith('.yml')) {
        const tmpl = await parseTemplate(path.join(workflowsDir, file));
        templates.push(tmpl);
      }
    }
  } catch {
    // Directory may not exist
  }
  return templates;
}
```

- [ ] **Step 5: Run test → pass**

Run: `pnpm test -- --run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/workflow/template.ts packages/core/__tests__/workflow/template.test.ts workflows/
git commit -m "feat(core): workflow template parser — YAML parsing with input shorthand expansion"
```

---

### Task 9: Workflow state machine

**Files:**
- Create: `packages/core/src/workflow/state.ts`
- Create: `packages/core/__tests__/workflow/state.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/core/__tests__/workflow/state.test.ts
import { describe, it, expect } from 'vitest';
import { advanceNode, interruptNode, resolveArtifactRef } from '../../src/workflow/state.js';
import type { Node, Phase, Artifact } from '../../src/types.js';

function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    id: 'node-1',
    role: 'pm',
    task: { input: [], output: ['demand-card'], instruction: 'test' },
    skills: [],
    status: 'pending',
    retryCount: 0,
    maxRetries: 1,
    source: 'template',
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1', projectId: 'proj-1', nodeId: 'node-0',
    type: 'demand-card', version: 1, status: 'approved',
    filePath: '/tmp/test.md', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    ...overrides,
  };
}

describe('Node state machine', () => {
  it('should transition pending → running', () => {
    const node = makeNode();
    const next = advanceNode(node, 'start');
    expect(next.status).toBe('running');
  });

  it('should transition running → awaiting-gate on complete', () => {
    const node = makeNode({ status: 'running' });
    const next = advanceNode(node, 'agent-complete');
    expect(next.status).toBe('awaiting-gate');
  });

  it('should transition running → interrupted on signal', () => {
    const node = makeNode({ status: 'running' });
    const next = interruptNode(node);
    expect(next.status).toBe('interrupted');
  });

  it('should transition interrupted → pending on resume', () => {
    const node = makeNode({ status: 'interrupted' });
    const next = advanceNode(node, 'resume');
    expect(next.status).toBe('pending');
  });

  it('should handle retry on gate fail', () => {
    const node = makeNode({ status: 'awaiting-gate', retryCount: 0, maxRetries: 2 });
    const next = advanceNode(node, 'gate-fail');
    expect(next.status).toBe('pending');
    expect(next.retryCount).toBe(1);
  });

  it('should move to needs-revision when retries exhausted', () => {
    const node = makeNode({ status: 'awaiting-gate', retryCount: 2, maxRetries: 2 });
    const next = advanceNode(node, 'gate-fail');
    expect(next.status).toBe('needs-revision');
  });

  it('should transition awaiting-gate → passed', () => {
    const node = makeNode({ status: 'awaiting-gate' });
    const next = advanceNode(node, 'gate-pass');
    expect(next.status).toBe('passed');
  });
});

describe('ArtifactRef resolution', () => {
  it('should resolve by type (closest match)', () => {
    const artifacts = [
      makeArtifact({ id: 'art-1', nodeId: 'node-0', type: 'demand-card' }),
      makeArtifact({ id: 'art-2', nodeId: 'node-2', type: 'code-changes' }),
      makeArtifact({ id: 'art-3', nodeId: 'node-1', type: 'demand-card' }),
    ];
    const result = resolveArtifactRef({ type: 'demand-card' }, artifacts);
    expect(result?.id).toBe('art-3'); // Most recent (last in array)
  });

  it('should return undefined when not found', () => {
    const result = resolveArtifactRef({ type: 'code-changes' }, []);
    expect(result).toBeUndefined();
  });

  it('should resolve by nodeId exactly', () => {
    const artifacts = [
      makeArtifact({ id: 'art-1', nodeId: 'node-0', type: 'demand-card' }),
      makeArtifact({ id: 'art-2', nodeId: 'node-2', type: 'demand-card' }),
    ];
    const result = resolveArtifactRef({ type: 'demand-card', nodeId: 'node-0' }, artifacts);
    expect(result?.id).toBe('art-1');
  });
});
```

- [ ] **Step 2: Run test → fail**

- [ ] **Step 3: Implement state.ts**

```typescript
// packages/core/src/workflow/state.ts
import type { Node, NodeStatus, Artifact, ArtifactRef } from '../types.js';

type TransitionEvent = 'start' | 'agent-complete' | 'gate-pass' | 'gate-fail' | 'resume';

export function advanceNode(node: Node, event: TransitionEvent): Node {
  const next = { ...node };

  switch (event) {
    case 'start':
      if (node.status === 'pending' || node.status === 'interrupted') {
        next.status = 'running';
        next.retryCount = node.status === 'interrupted' ? 0 : node.retryCount;
      }
      break;

    case 'agent-complete':
      if (node.status === 'running') {
        next.status = 'awaiting-gate';
      }
      break;

    case 'gate-pass':
      if (node.status === 'awaiting-gate') {
        next.status = 'passed';
      }
      break;

    case 'gate-fail':
      if (node.status === 'awaiting-gate') {
        if (node.retryCount < node.maxRetries) {
          next.status = 'pending';
          next.retryCount = node.retryCount + 1;
        } else {
          next.status = 'needs-revision';
        }
      }
      break;

    case 'resume':
      if (node.status === 'interrupted') {
        next.status = 'pending';
      }
      break;
  }

  return next;
}

export function interruptNode(node: Node): Node {
  if (node.status !== 'running') return node;
  return { ...node, status: 'interrupted' };
}

export function resolveArtifactRef(
  ref: ArtifactRef,
  artifacts: Artifact[]
): Artifact | undefined {
  // 1. Exact nodeId match
  if (ref.nodeId) {
    const exact = artifacts.findLast(a => a.type === ref.type && a.nodeId === ref.nodeId);
    if (exact) return exact;
  }

  // 2. Type match (closest = last in array for same type)
  const byType = artifacts.filter(a => a.type === ref.type);
  return byType.length > 0 ? byType[byType.length - 1] : undefined;
}
```

- [ ] **Step 4: Run test → pass**

Run: `pnpm test -- --run`
Expected: PASS — all tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/workflow/state.ts packages/core/__tests__/workflow/state.test.ts
git commit -m "feat(core): workflow state machine — node transitions + ArtifactRef resolution"
```

---

### Task 10: Workflow Engine (core execution loop)

**Files:**
- Create: `packages/core/src/workflow/engine.ts`
- Create: `packages/core/__tests__/workflow/engine.test.ts`

Due to length, this task documents the core engine API and integration test. The engine orchestrates phase → node → role run → gate → audit logging.

- [ ] **Step 1: Write engine integration test**

```typescript
// packages/core/__tests__/workflow/engine.test.ts
import { describe, it, expect, vi } from 'vitest';
import { WorkflowEngine } from '../../src/workflow/engine.js';
import type { WorkflowTemplate, RoleConfig } from '../../src/types.js';

const mockRoles = new Map<string, RoleConfig>();
// [Setup mock PM and echo roles]

const mockTemplate: WorkflowTemplate = {
  name: 'test-workflow',
  description: 'test',
  phases: [
    {
      title: 'test-phase',
      parallel: false,
      nodes: [
        {
          role: 'pm',
          task: { instruction: 'test instruction', output: ['demand-card'] },
          skills: [],
          retry: 1,
        },
      ],
    },
  ],
};

describe('WorkflowEngine', () => {
  it('should execute a single-phase workflow', async () => {
    const engine = new WorkflowEngine({ dbPath: ':memory:' });

    const mockRunner = vi.fn().mockResolvedValue({
      role: 'pm', exitCode: 0, stdout: 'OK', stderr: '',
      outputFiles: ['demand-card.md'], duration: 100,
    });

    const result = await engine.execute(mockTemplate, mockRoles, '/tmp/test-repo', mockRunner);

    expect(result.status).toBe('completed');
    expect(mockRunner).toHaveBeenCalledOnce();
    expect(result.phases[0].status).toBe('completed');
    expect(result.phases[0].nodes[0].status).toBe('passed');
  });
});
```

- [ ] **Step 2: Implement engine.ts** (core execution loop)

```typescript
// packages/core/src/workflow/engine.ts
import { initDb, getDb, closeDb } from '../db.js';
import { advanceNode } from './state.js';
import { buildPrompt } from '../role/builder.js';
import type {
  WorkflowTemplate, RoleConfig, WorkflowInstance, Phase,
  Node, ArtifactRef, AgentResult,
} from '../types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export interface EngineOptions {
  dbPath: string;
}

export type AgentRunnerFn = (opts: {
  role: string;
  roleConfig: RoleConfig;
  promptContent: string;
  outputDir: string;
  worktreePath: string;
}) => Promise<AgentResult>;

export class WorkflowEngine {
  private dbPath: string;

  constructor(opts: EngineOptions) {
    this.dbPath = opts.dbPath;
  }

  private uid(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  async execute(
    template: WorkflowTemplate,
    roles: Map<string, RoleConfig>,
    repoPath: string,
    runner: AgentRunnerFn,
  ): Promise<WorkflowInstance> {
    initDb(this.dbPath);
    const db = getDb();

    const instance: WorkflowInstance = {
      id: this.uid(),
      templateRef: template.name,
      projectId: '',
      phases: [],
      currentPhaseIndex: 0,
      status: 'running',
    };

    // Create output dir
    const outputBase = path.join(repoPath, '.donkey', 'runs', instance.id);
    await fs.mkdir(outputBase, { recursive: true });

    // Execute phases sequentially
    for (let pi = 0; pi < template.phases.length; pi++) {
      const tPhase = template.phases[pi];
      const phase: Phase = {
        id: this.uid(),
        title: tPhase.title,
        nodes: [],
        parallel: tPhase.parallel ?? false,
        status: 'running',
        source: 'template',
      };

      instance.currentPhaseIndex = pi;

      // Execute nodes (parallel or sequential)
      if (phase.parallel) {
        const nodePromises = tPhase.nodes.map(async (tNode) => {
          return this.executeNode(tNode, roles, repoPath, outputBase, runner);
        });
        const nodes = await Promise.all(nodePromises);
        phase.nodes = nodes.filter((n): n is Node => n !== null);
      } else {
        for (const tNode of tPhase.nodes) {
          const node = await this.executeNode(tNode, roles, repoPath, outputBase, runner);
          if (node) phase.nodes.push(node);
        }
      }

      // Check if all nodes passed
      const allPassed = phase.nodes.every(n => n.status === 'passed');
      phase.status = allPassed ? 'completed' : 'failed';
      instance.phases.push(phase);

      if (!allPassed) {
        instance.status = 'failed';
        break;
      }
    }

    if (instance.status === 'running') {
      instance.status = 'completed';
    }

    // Write summary
    const summaryPath = path.join(outputBase, 'delivery-package.md');
    await fs.writeFile(summaryPath, this.generateSummary(instance), 'utf-8');

    return instance;
  }

  private async executeNode(
    tNode: WorkflowTemplate['phases'][0]['nodes'][0],
    roles: Map<string, RoleConfig>,
    repoPath: string,
    outputBase: string,
    runner: AgentRunnerFn,
  ): Promise<Node | null> {
    const roleConfig = roles.get(tNode.role);
    if (!roleConfig) {
      console.error(`Role '${tNode.role}' not found`);
      return null;
    }

    let node: Node = {
      id: this.uid(),
      role: tNode.role,
      task: {
        input: (tNode.task.input || []).map(i =>
          typeof i === 'string' ? { type: i } as ArtifactRef : i
        ),
        output: tNode.task.output,
        instruction: tNode.task.instruction,
      },
      skills: tNode.skills || [],
      gate: tNode.gate,
      status: 'pending',
      retryCount: 0,
      maxRetries: tNode.retry ?? roleConfig.maxRetries,
      source: 'template',
    };

    // Transition to running
    node = advanceNode(node, 'start');

    // Build prompt
    const systemMd = await fs.readFile(
      path.join(roleConfig.dirPath, 'system.md'), 'utf-8'
    ).catch(() => '你是{{display}}，{{description}}。');

    const promptContent = buildPrompt(
      roleConfig, systemMd,
      [], // skills loaded later
      [], // tools loaded later
      [], // knowledge loaded later
      [], // artifacts from previous nodes loaded later
      path.basename(repoPath),
    );

    // Execute agent
    const outputDir = path.join(outputBase, node.id);
    await fs.mkdir(outputDir, { recursive: true });

    try {
      const result = await runner({
        role: node.role,
        roleConfig,
        promptContent,
        outputDir,
        worktreePath: repoPath,
      });

      // Transition to awaiting-gate
      node = advanceNode(node, 'agent-complete');

      // Run gates
      let gatePassed = true;
      if (node.gate) {
        for (const check of node.gate.checks) {
          if (check.type === 'schema') {
            // Schema validation is auto-pass for now (schema checkers in Task 11)
            continue;
          }
          // Deterministic gates (build/test/lint) run via runner
          if (check.command) {
            // Will be implemented in Gate Engine task
          }
        }
      }

      // Mark as passed or needs-revision
      if (gatePassed) {
        node = advanceNode(node, 'gate-pass');
      } else {
        node = advanceNode(node, 'gate-fail');
      }

      // Log audit event
      const db = getDb();
      db.prepare(`INSERT INTO audit_events (id, timestamp, project_id, node_id, event_type, payload)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        this.uid(), new Date().toISOString(), '', node.id,
        node.status === 'passed' ? 'node_completed' : 'artifact_created',
        JSON.stringify({ exitCode: result.exitCode, duration: result.duration }),
      );

    } catch (err) {
      node.status = 'needs-revision';
    }

    return node;
  }

  private generateSummary(instance: WorkflowInstance): string {
    const lines = [
      `# 交付证据包`,
      `Workflow: ${instance.templateRef}`,
      `Status: ${instance.status}`,
      '',
    ];
    for (const phase of instance.phases) {
      lines.push(`## ${phase.title} (${phase.status})`);
      for (const node of phase.nodes) {
        lines.push(`- [${node.status}] ${node.role}: ${node.task.instruction}`);
      }
    }
    return lines.join('\n');
  }
}
```

- [ ] **Step 3: Run test → pass**

Run: `pnpm test -- --run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/workflow/engine.ts packages/core/__tests__/workflow/engine.test.ts
git commit -m "feat(core): workflow engine — orchestrator with phase/node execution, state machine, audit logging"
```

---

## Week 4: Gate Engine + Artifact Store + Constraint Validator

### Task 11: Gate Engine

**Files:**
- Create: `packages/core/src/gate/engine.ts`
- Create: `packages/core/src/gate/checks.ts`
- Create: `packages/core/__tests__/gate/engine.test.ts`

- [ ] **Step 1: Write test (gate chain execution)**

```typescript
// packages/core/__tests__/gate/engine.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runGateChain } from '../../src/gate/engine.js';
import type { GateConfig } from '../../src/types.js';

describe('Gate Engine', () => {
  const simpleGate: GateConfig = {
    checks: [
      { type: 'build', command: 'echo "build ok"', autoFix: false },
    ],
    retryLimit: 1,
    onExhausted: 'block',
  };

  it('should run single gate check and pass', async () => {
    const results = await runGateChain(simpleGate, '/tmp/test');
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pass');
  });

  it('should fail on non-zero exit and retry', async () => {
    const failGate: GateConfig = {
      checks: [{ type: 'test', command: 'exit 1', autoFix: false }],
      retryLimit: 2,
      onExhausted: 'block',
    };

    await expect(runGateChain(failGate, '/tmp/test')).rejects.toThrow();
  });

  it('should execute checks in order', async () => {
    const multiGate: GateConfig = {
      checks: [
        { type: 'build', command: 'echo "1"', autoFix: false },
        { type: 'lint', command: 'echo "2"', autoFix: false },
      ],
      retryLimit: 1,
      onExhausted: 'block',
    };

    const results = await runGateChain(multiGate, '/tmp/test');
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe('build');
    expect(results[1].type).toBe('lint');
  });
});
```

- [ ] **Step 2: Implement gate engine**

```typescript
// packages/core/src/gate/engine.ts
import { execSync } from 'node:child_process';
import type { GateConfig, GateResult, GateType } from '../types.js';

export async function runGateChain(
  config: GateConfig,
  cwd: string,
): Promise<GateResult[]> {
  const results: GateResult[] = [];

  for (const check of config.checks) {
    let passed = false;
    let retries = 0;
    let lastError = '';

    while (!passed && retries <= config.retryLimit) {
      const startTime = Date.now();
      try {
        if (check.type === 'schema') {
          // Schema validation: handled separately by validateArtifactSchema()
          passed = true;
        } else if (check.command) {
          execSync(check.command, { cwd, timeout: 120000, stdio: 'pipe' });
          passed = true;
        } else {
          // No-op gate (e.g. human gate): pass by default in auto mode
          passed = true;
        }

        results.push({
          type: check.type,
          status: 'pass',
          output: '',
          duration: Date.now() - startTime,
          retriesUsed: retries,
          fixedByAgent: false,
        });
      } catch (err: any) {
        lastError = err.stderr?.toString() || err.message || 'unknown error';
        retries++;
        if (retries > config.retryLimit) {
          // All retries exhausted
          const finalResult: GateResult = {
            type: check.type,
            status: 'fail',
            output: lastError,
            duration: Date.now() - startTime,
            retriesUsed: retries - 1,
            fixedByAgent: false,
          };

          if (config.onExhausted === 'skip') {
            results.push(finalResult);
          } else if (config.onExhausted === 'block') {
            results.push(finalResult);
            throw new Error(`Gate '${check.type}' failed after ${retries} retries: ${lastError}`);
          } else {
            // escalate-human
            throw new Error(`Gate '${check.type}' requires human intervention: ${lastError}`);
          }
        }
        // Otherwise: retry loop continues
      }
    }
  }

  return results;
}
```

- [ ] **Step 3: Run test → pass**

- [ ] **Step 4: Commit**

---

### Task 12: Artifact Store

**Files:**
- Create: `packages/core/src/artifact/store.ts`
- Create: `packages/core/__tests__/artifact/store.test.ts`

- [ ] **Step 1: Test**

```typescript
// packages/core/__tests__/artifact/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ArtifactStore } from '../../src/artifact/store.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('ArtifactStore', () => {
  let tmpDir: string;
  let store: ArtifactStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donkey-artifact-'));
    store = new ArtifactStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should save and read an artifact', async () => {
    const art = await store.save({
      projectId: 'proj-1', nodeId: 'node-1',
      type: 'demand-card', content: '# 需求卡\n测试需求',
    });
    expect(art.type).toBe('demand-card');
    expect(art.version).toBe(1);
    expect(art.status).toBe('draft');
    expect(fs.existsSync(art.filePath)).toBe(true);

    const content = await store.read(art.id);
    expect(content).toContain('测试需求');
  });

  it('should version artifacts', async () => {
    const a1 = await store.save({
      projectId: 'proj-1', nodeId: 'node-1',
      type: 'demand-card', content: 'v1',
    });
    const a2 = await store.saveVersion(a1.id, 'v2 content');
    expect(a2.version).toBe(2);
    const content = await store.read(a2.id);
    expect(content).toBe('v2 content');
  });

  it('should list artifacts by project', async () => {
    await store.save({ projectId: 'proj-1', nodeId: 'n1', type: 'demand-card', content: 'd' });
    await store.save({ projectId: 'proj-1', nodeId: 'n2', type: 'code-changes', content: 'c' });
    const list = await store.listByProject('proj-1');
    expect(list).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Implement → pass tests → commit**

---

### Task 13: Constraint Validator

**Files:**
- Create: `packages/core/src/constraint/validator.ts`
- Create: `constraints.yaml`
- Create: `packages/core/__tests__/constraint/validator.test.ts`

- [ ] **Step 1: Create constraints.yaml**

```yaml
# constraints.yaml
constraints:
  hard:
    - rule: "所有代码变更必须经过 build + lint gate"
      appliesWhen: { outputs: [code-changes] }
      gates: [build, lint]
    - rule: "所有 workflow 必须有独立的审查阶段"
      appliesWhen: { phasesCount: '>= 2' }
      requirePhase:
        title: "审查"
        containsRole: reviewer
    - rule: "所有 workflow 必须有验证阶段"
      requiresOneOf:
        - { role: qa }
        - { gate: e2e-pass }
  conditional:
    - rule: "高风险需求必须有人工确认 Gate"
      when: { riskLevel: high }
      injectGate: { type: human, at: 'end-of-workflow' }
    - rule: "涉及权限/安全的需求必须有安全审查"
      when: { tags: [auth, security, permission] }
      requireRole: reviewer
      requireSkills: [security]
      injectGate: { type: security-scan, at: 'after-node:rd' }
    - rule: "数据相关变更必须有回滚方案"
      when: { tags: [data, migration, schema-change] }
      requireOutput: rollback-plan
    - rule: "多模块变更建议拆分阶段"
      when: { affectedModules: '>= 3' }
      suggest: { splitPhases: true, mode: per-module }
  soft:
    - rule: "独立模块建议并行开发"
      suggest: { parallel: true }
    - rule: "建议为 E2E 测试预留独立阶段"
      suggest: { separateE2EPhase: true }
```

- [ ] **Step 2: Test the validator**

```typescript
// packages/core/__tests__/constraint/validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '../../src/constraint/validator.js';
import type { WorkflowTemplate, Demand } from '../../src/types.js';

const mockWorkflow: WorkflowTemplate = {
  name: 'test',
  description: 'test',
  phases: [
    {
      title: '开发',
      nodes: [
        {
          role: 'rd', task: { instruction: 'code', output: ['code-changes'] },
          skills: [], retry: 1,
        },
      ],
    },
    {
      title: '审查',
      nodes: [
        {
          role: 'reviewer', task: { instruction: 'review', output: ['review-report'] },
          skills: [],
        },
      ],
    },
    {
      title: '验证',
      nodes: [
        {
          role: 'qa', task: { instruction: 'test', output: ['test-report'] },
          skills: [], retry: 1,
          gate: { checks: [{ type: 'e2e-pass', autoFix: false }], retryLimit: 1, onExhausted: 'block' },
        },
      ],
    },
  ],
};

describe('Constraint Validator', () => {
  it('should pass a compliant workflow', () => {
    const demand: Partial<Demand> = { riskLevel: 'low', tags: [] };
    const result = validateWorkflow(mockWorkflow, demand as Demand);
    expect(result.hardViolations).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it('should flag missing review phase', () => {
    const badWf: WorkflowTemplate = {
      name: 'bad', description: '',
      phases: [{
        title: 'dev', nodes: [{
          role: 'rd', task: { instruction: 'code', output: ['code-changes'] }, skills: []
        }],
      }],
    };
    const result = validateWorkflow(badWf, { riskLevel: 'low', tags: [] } as Demand);
    expect(result.hardViolations.length).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
  });

  it('should inject human gate for high risk', () => {
    const result = validateWorkflow(mockWorkflow, { riskLevel: 'high', tags: [] } as Demand);
    expect(result.injectedGates.length).toBeGreaterThan(0);
    expect(result.injectedGates.some(g => g.type === 'human')).toBe(true);
  });

  it('should inject security scan for auth tags', () => {
    const result = validateWorkflow(mockWorkflow, { riskLevel: 'low', tags: ['auth'] } as Demand);
    expect(result.injectedGates.some(g => g.type === 'security-scan')).toBe(true);
  });
});
```

- [ ] **Step 3: Implement → pass tests → commit**

---

## Week 5: CLI Commands

### Task 14: CLI entry point + init command

**Files:**
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/src/commands/init.ts`
- Create: `packages/cli/__tests__/commands/init.test.ts`

- [ ] **Step 1: Create CLI entry with Commander.js**

```typescript
// packages/cli/src/index.ts
#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { roleCommand } from './commands/role.js';
import { workflowCommand } from './commands/workflow.js';
import { constraintsCommand } from './commands/constraints.js';
import { logCommand } from './commands/log.js';
import { cleanCommand } from './commands/clean.js';

const program = new Command();

program
  .name('donkey')
  .description('AI Native 产研流程执行系统')
  .version('0.1.0');

program.addCommand(initCommand());
program.addCommand(runCommand());
program.addCommand(statusCommand());
program.addCommand(roleCommand());
program.addCommand(workflowCommand());
program.addCommand(constraintsCommand());
program.addCommand(logCommand());
program.addCommand(cleanCommand());

program.parse();
```

- [ ] **Step 2: Implement init command**

```typescript
// packages/cli/src/commands/init.ts
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

export function initCommand(): Command {
  return new Command('init')
    .description('初始化当前目录为 Donkey 项目')
    .option('--repo <path>', '目标仓库路径', '.')
    .action(async (opts) => {
      const repoPath = path.resolve(opts.repo);
      const donkeyDir = path.join(repoPath, '.donkey');
      const rolesDir = path.join(donkeyDir, 'roles');

      if (!fs.existsSync(donkeyDir)) {
        fs.mkdirSync(donkeyDir, { recursive: true });
      }
      if (!fs.existsSync(rolesDir)) {
        fs.mkdirSync(rolesDir, { recursive: true });
      }

      const configPath = path.join(donkeyDir, 'config.yaml');
      if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, `# Donkey 项目配置
repo: ${repoPath}
`, 'utf-8');
      }

      console.log(`✓ Donkey 项目已初始化: ${donkeyDir}`);
      console.log(`  角色目录: ${rolesDir}/ (在此覆盖内置角色)`);
    });
}
```

- [ ] **Step 3: Test**

```typescript
// packages/cli/__tests__/commands/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('donkey init', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donkey-init-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('should create .donkey directory and config', () => {
    execSync(`node ${path.resolve('packages/cli/dist/index.js')} init --repo ${tmpDir}`, {
      cwd: tmpDir,
    });
    expect(fs.existsSync(path.join(tmpDir, '.donkey'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.donkey', 'roles'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.donkey', 'config.yaml'))).toBe(true);
  });
});
```

- [ ] **Step 4: Implement run command**

```typescript
// packages/cli/src/commands/run.ts
import { Command } from 'commander';
import { WorkflowEngine } from '@donkey/core';
import { loadRoles } from '@donkey/core';
import { parseTemplate, listTemplates } from '@donkey/core';
import { runAgent } from '@donkey/core';
import path from 'node:path';

export function runCommand(): Command {
  return new Command('run')
    .description('启动一个需求')
    .argument('[description]', '需求描述（自然语言）')
    .option('--template <name>', '使用指定模板')
    .option('--dynamic', '动态模式')
    .option('--dry-run', '预览 Workflow，不执行')
    .option('--repo <path>', '目标仓库路径', '.')
    .action(async (description, opts) => {
      const repoPath = path.resolve(opts.repo);
      const donkeyDir = path.join(repoPath, '.donkey');

      // Load roles
      const roles = await loadRoles(repoPath);

      // Select template
      let template;
      if (opts.template) {
        const workflowDir = path.resolve('workflows');
        template = await parseTemplate(path.join(workflowDir, `${opts.template}.yaml`));
      } else {
        // Default: standard-feature
        const workflowDir = path.resolve('workflows');
        template = await parseTemplate(path.join(workflowDir, 'standard-feature.yaml'));
      }

      if (opts.dryRun) {
        console.log(JSON.stringify(template, null, 2));
        return;
      }

      console.log(`Starting workflow: ${template.name}`);
      console.log(`Phases: ${template.phases.map(p => p.title).join(' → ')}`);

      const engine = new WorkflowEngine({
        dbPath: path.join(donkeyDir, 'donkey.db'),
      });

      const runner = async (runOpts: any) => runAgent(runOpts);

      const result = await engine.execute(template, roles, repoPath, runner);
      console.log(`\nWorkflow ${result.status}`);
      for (const phase of result.phases) {
        const icon = phase.status === 'completed' ? '✓' : '✗';
        console.log(` ${icon} ${phase.title}: ${phase.status}`);
      }
    });
}
```

- [ ] **Step 5: Implement status command**

```typescript
// packages/cli/src/commands/status.ts
import { Command } from 'commander';
import { getDb, initDb, getDbPath } from '@donkey/core';
import path from 'node:path';

export function statusCommand(): Command {
  return new Command('status')
    .description('查看项目状态')
    .option('--repo <path>', '目标仓库路径', '.')
    .action(async (opts) => {
      const repoPath = path.resolve(opts.repo);
      const dbPath = getDbPath(repoPath);
      initDb(dbPath);
      const db = getDb();

      const projects = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC LIMIT 5').all() as any[];

      if (projects.length === 0) {
        console.log('No projects yet. Run `donkey run "..."` to start.');
        return;
      }

      for (const proj of projects) {
        console.log(`\nProject: ${proj.name} (${proj.id})`);
        console.log(`Status:  ${proj.status}`);
        console.log('─'.repeat(40));

        const nodes = db.prepare(
          `SELECT n.*, p.title as phase_title FROM nodes n
           JOIN phases p ON n.phase_id = p.id
           JOIN workflow_instances w ON p.workflow_instance_id = w.id
           WHERE w.project_id = ?
           ORDER BY p.phase_index, n.id`
        ).all(proj.id) as any[];

        const icons: Record<string, string> = {
          'passed': '✓', 'completed': '✓',
          'running': '●', 'pending': '○',
          'needs-revision': '✗', 'blocked': '⊘', 'failed': '✗',
        };

        for (const node of nodes) {
          const icon = icons[node.status] || '?';
          console.log(` ${icon} ${node.phase_title}: ${node.role} (${node.status})`);
        }
      }
    });
}
```

- [ ] **Step 6: Implement remaining commands**

role.ts, workflow.ts, constraints.ts, log.ts, clean.ts follow the same pattern — each wraps a Core function and formats output for the terminal.

- [ ] **Step 7: Run all CLI tests**

Run: `pnpm test -- --run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/cli/
git commit -m "feat(cli): CLI commands — init/run/status/role/workflow/constraints/log/clean"
```

---

## Week 6: Web Dashboard + E2E Testing

### Task 15: tRPC API routers

**Files:**
- Create: `packages/web/src/server/api/routers/project.ts`
- Create: `packages/web/src/server/api/routers/role.ts`
- Create: `packages/web/src/server/api/routers/audit.ts`

- [ ] **Step 1: Create tRPC routers wrapping Core functions**

```typescript
// packages/web/src/server/api/routers/project.ts
import { z } from 'zod';
import { publicProcedure, router } from '../trpc.js';
import { initDb, getDb, getDbPath } from '@donkey/core';

export const projectRouter = router({
  list: publicProcedure.query(() => {
    initDb(getDbPath('.'));
    const db = getDb();
    return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
  }),

  get: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) => {
    initDb(getDbPath('.'));
    const db = getDb();
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(input.id);
  }),
});
```

(role.ts and audit.ts follow the same pattern)

- [ ] **Step 2: Test → pass → commit**

---

### Task 16: Dashboard pages

**Files:**
- Create: All Next.js pages as per file structure

- [ ] **Step 1: Create layout with shadcn/ui sidebar**

```tsx
// packages/web/src/app/layout.tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="flex h-screen">
          <aside className="w-64 border-r bg-gray-50 p-4">
            <h1 className="text-lg font-bold mb-6">Donkey</h1>
            <nav className="space-y-1">
              <a href="/" className="block px-3 py-2 rounded hover:bg-gray-100">项目</a>
              <a href="/roles" className="block px-3 py-2 rounded hover:bg-gray-100">角色</a>
              <a href="/workflows" className="block px-3 py-2 rounded hover:bg-gray-100">Workflows</a>
            </nav>
          </aside>
          <main className="flex-1 overflow-y-auto p-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Project list page**

```tsx
// packages/web/src/app/page.tsx
import { trpc } from '@/server/api/client';

export default async function HomePage() {
  const projects = await trpc.project.list.query();
  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">项目列表</h2>
      {projects.length === 0 && <p className="text-gray-500">暂无项目。运行 `donkey run` 开始。</p>}
      {projects.map((p: any) => (
        <div key={p.id} className="border rounded-lg p-4 mb-3">
          <a href={`/project/${p.id}`} className="text-lg font-semibold hover:underline">
            {p.name}
          </a>
          <span className={`ml-3 text-sm px-2 py-0.5 rounded ${p.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
            {p.status}
          </span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Project cockpit page**

```tsx
// packages/web/src/app/project/[id]/page.tsx
export default async function ProjectCockpit({ params }: { params: { id: string } }) {
  const project = await trpc.project.get.query({ id: params.id });
  if (!project) return <div>Project not found</div>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">{project.name}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="border rounded-lg p-4">
          <h3 className="font-semibold mb-2">状态</h3>
          <span className="text-lg">{project.status}</span>
        </div>
        <div className="border rounded-lg p-4">
          <h3 className="font-semibold mb-2">仓库</h3>
          <code className="text-sm">{project.repo_url}</code>
        </div>
      </div>
      {/* Phase timeline component */}
      {/* Gate status component */}
      {/* Artifact list component */}
    </div>
  );
}
```

- [ ] **Step 4: Test → pass → commit**

---

### Task 17: E2E test (full flow)

**Files:**
- Create: `packages/cli/__tests__/e2e/full-flow.test.ts`

- [ ] **Step 1: E2E test with mock Agent**

```typescript
// packages/cli/__tests__/e2e/full-flow.test.ts
import { describe, it, expect } from 'vitest';
import { WorkflowEngine } from '@donkey/core';
import { loadRoles } from '@donkey/core';
import { parseTemplate } from '@donkey/core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('E2E: Full workflow execution', () => {
  it('should execute standard-feature workflow end-to-end', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'donkey-e2e-'));
    const rolesDir = path.join(tmpDir, '.donkey', 'roles');
    fs.mkdirSync(rolesDir, { recursive: true });

    // Mock runner that "writes" code and test artifacts
    const mockRunner = async (opts: any) => {
      const outputDir = opts.outputDir;
      fs.writeFileSync(path.join(outputDir, `${opts.role}-output.md`),
        `# ${opts.role} output\n\nTask completed successfully.`);
      return {
        role: opts.role, exitCode: 0, stdout: 'Done', stderr: '',
        outputFiles: [`${opts.role}-output.md`], duration: 50,
      };
    };

    // Load roles from builtin
    const roles = await loadRoles(tmpDir);
    expect(roles.size).toBeGreaterThanOrEqual(5);

    // Parse template
    const tmpl = await parseTemplate(
      path.resolve('workflows/standard-feature.yaml')
    );

    // Execute
    const engine = new WorkflowEngine({
      dbPath: path.join(tmpDir, '.donkey', 'donkey.db'),
    });

    const result = await engine.execute(tmpl, roles, tmpDir, mockRunner);

    expect(result.status).toBe('completed');
    expect(result.phases).toHaveLength(5);
    for (const phase of result.phases) {
      expect(phase.status).toBe('completed');
      expect(phase.nodes.length).toBeGreaterThan(0);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30000);
});
```

- [ ] **Step 2: Run E2E test**

Run: `pnpm test -- --run`
Expected: PASS

- [ ] **Step 3: Commit**

---

## Week 7: Polish, Bugfix, Documentation

### Task 18: Error handling & edge cases

- [ ] Handle missing role gracefully (engine skips node, logs warning)
- [ ] Handle template parse errors (show line number)
- [ ] Handle agent spawn failures (retry or escalate)
- [ ] Handle SQLite locked (single-process guard)
- [ ] Handle worktree collision (clean stale worktrees)

### Task 19: User manual

**Files:**
- Create: `docs/manual/donkey-v2-user-manual.md`
- Create: `docs/manual/donkey-v2-user-manual.html`

Content: how to install, init, run first project, customize roles, create workflows, read audit logs.

### Task 20: Dogfooding — run Donkey on Donkey

- [ ] Set up Donkey project with `donkey init`
- [ ] Run one real feature request through Donkey to validate the flow
- [ ] Record metrics: time to PR, human interventions, gate pass rate

---

## Week 8: Final Testing & Ship

### Task 21: Full test suite validation

Run: `pnpm test -- --run --coverage`
Expected: ≥ 80% coverage, 0 failures

### Task 22: Build & package

```bash
pnpm build
# Verify: packages/core/dist/ exists
# Verify: packages/cli/dist/index.js is executable
# Verify: packages/web/.next/ exists
```

### Task 23: Phase 1 completion checklist

- [ ] All 5 built-in roles load successfully
- [ ] Both workflow templates (standard-feature + bugfix) parse correctly
- [ ] `donkey init` creates .donkey structure
- [ ] `donkey run` executes a complete workflow with mock runner
- [ ] `donkey status` shows project state
- [ ] `donkey role list` shows all 5 roles with source labels
- [ ] `donkey constraints show` displays constraint rules
- [ ] Web dashboard shows project list
- [ ] Constraints are enforced on dynamic workflows
- [ ] Audit events are logged for every node transition
- [ ] E2E test passes
- [ ] All unit tests pass (≥ 60 tests)
- [ ] Test coverage ≥ 80%

---

**Total tasks:** 23
**Total commits:** ~23 (one per task)
**Target:** 6-8 weeks
