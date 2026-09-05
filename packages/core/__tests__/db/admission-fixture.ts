import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { PreparedAdmissionData } from '../../src/db/admission-store.js';

export function admissionData(repoPath: string, suffix = 'one'): PreparedAdmissionData {
  return {
    requestId: 'request_shared_123', envelopeVersion: 1, envelopeHash: 'same-intent',
    runId: `run_${suffix}`, projectId: 'project_shared', projectName: 'Admission test', repoPath,
    dataDir: '.tekon', demandId: `demand_${suffix}`, demandTitle: 'Atomic admission',
    demandBody: 'Persist exactly one complete run.', workflowKind: 'workflow',
    allowDirtyBase: false, planSnapshot: '{"digestVersion":2}', planDigest: 'plan-digest',
    providerSnapshot: { provider: 'codex', configSummary: { timeoutMs: 1000 } },
    phases: [{ id: `phase_${suffix}`, name: 'Delivery', order: 0, nodes: [{
      id: `node_${suffix}`, role: 'rd', order: 0, inputs: [], outputs: [], gates: [], dependencies: [],
    }] }],
    admissionAudits: [{ type: 'run.policy-checked', payload: { approved: true } }],
    sessionData: { sessionId: `session_${suffix}`, workspaceRoot: repoPath, profile: 'human-web',
      jobId: `job_${suffix}`, jobKind: 'workflow-run' },
  };
}

/** Real, independent Node processes; release only after both SQLite connections are open. */
export async function parallelDatabaseProcesses(filename: string, scripts: string[]): Promise<any[]> {
  const moduleRoot = new URL('../../src/', import.meta.url).href;
  const loader = fileURLToPath(new URL('../../../../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const children = scripts.map((script) => {
    const source = `
      import { openTekonDatabase } from ${JSON.stringify(`${moduleRoot}db/connection.ts`)};
      import { createRepositories } from ${JSON.stringify(`${moduleRoot}db/repositories.ts`)};
      import { createWriteQueue } from ${JSON.stringify(`${moduleRoot}db/write-queue.ts`)};
      import { createAuditLogger } from ${JSON.stringify(`${moduleRoot}audit/logger.ts`)};
      const db = openTekonDatabase({ filename: ${JSON.stringify(filename)} });
      const writeQueue = createWriteQueue();
      const repositories = createRepositories(db, writeQueue);
      process.send({ ready: true });
      await new Promise(resolve => process.once('message', resolve));
      ${script}
      db.close();
      process.disconnect();
    `;
    const child = spawn(process.execPath, ['--import', loader, '--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += chunk; });
    let result: unknown;
    const ready = new Promise<void>((resolve, reject) => {
      child.on('message', (message: any) => {
        if (message.ready) resolve();
        else result = message.result;
      });
      child.once('error', reject);
      child.once('exit', (code) => { if (code !== 0) reject(new Error(stderr)); });
    });
    const done = new Promise<unknown>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(result) : reject(new Error(stderr)));
    });
    // Child failures before the ready barrier must not leave an unhandled rejection.
    void done.catch(() => {});
    return { child, ready, done };
  });
  const deadline = setTimeout(() => children.forEach(({ child }) => child.kill()), 15_000);
  try {
    await Promise.all(children.map(({ ready }) => ready));
    children.forEach(({ child }) => child.send({ start: true }));
    return await Promise.all(children.map(({ done }) => done));
  } finally {
    clearTimeout(deadline);
    children.forEach(({ child }) => { if (child.exitCode === null) child.kill(); });
  }
}
