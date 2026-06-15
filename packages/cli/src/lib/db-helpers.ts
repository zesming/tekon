import {
  createRepositories,
  type TekonDatabase,
  type TekonRepositories,
} from '@tekon/core';

export function selectLatestRunId(
  db: TekonDatabase,
): string | null {
  const row = db
    .prepare(
      `select id
       from workflow_instances
       order by datetime(updated_at) desc, datetime(created_at) desc, id desc
       limit 1`,
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

export function selectLatestPendingHumanDecision(
  db: TekonDatabase,
): { runId: string; decisionId: string } | null {
  const row = db
    .prepare(
      `select run_id as runId, id as decisionId
       from human_decisions
       where status = 'pending'
       order by datetime(created_at) desc, id desc
       limit 1`,
    )
    .get() as { runId: string; decisionId: string } | undefined;
  return row ?? null;
}

export function countPendingHumanDecisionsForRun(
  db: TekonDatabase,
  runId: string,
): number {
  const row = db
    .prepare(
      `select count(*) as count
       from human_decisions
       where run_id = ? and status = 'pending'`,
    )
    .get(runId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function assertUnambiguousPendingDecisionForRun(
  db: TekonDatabase,
  runId: string,
): void {
  const pendingCount = countPendingHumanDecisionsForRun(db, runId);
  if (pendingCount > 1) {
    throw new Error(
      `运行 ${runId} 存在多个待审批的人工决策，请使用 --decision-id <decisionId> 参数指定`,
    );
  }
}

export async function resolveHumanDecisionContext(input: {
  db: TekonDatabase;
  repositories: TekonRepositories;
  explicitRunId?: string;
  explicitDecisionId?: string;
  requireDecision?: boolean;
}): Promise<{ runId: string; decisionId?: string }> {
  if (input.explicitDecisionId) {
    const decision = await input.repositories.getHumanDecision(
      input.explicitDecisionId,
    );
    if (!decision) {
      throw new Error(`未找到人工决策: ${input.explicitDecisionId}`);
    }
    if (input.explicitRunId && decision.runId !== input.explicitRunId) {
      throw new Error(
        `决策 ${decision.id} 属于运行 ${decision.runId}，而非 ${input.explicitRunId}`,
      );
    }
    return { runId: decision.runId, decisionId: decision.id };
  }

  if (input.explicitRunId) {
    assertUnambiguousPendingDecisionForRun(
      input.db,
      input.explicitRunId,
    );
    const pendingDecision = (
      await input.repositories.listHumanDecisions(input.explicitRunId)
    )
      .filter((decision) => decision.status === 'pending')
      .at(-1);
    if (!pendingDecision && input.requireDecision) {
      throw new Error(
        `运行 ${input.explicitRunId} 没有待审批的人工决策`,
      );
    }
    return {
      runId: input.explicitRunId,
      decisionId: pendingDecision?.id,
    };
  }

  const latestPendingDecision = selectLatestPendingHumanDecision(
    input.db,
  );
  if (latestPendingDecision) {
    assertUnambiguousPendingDecisionForRun(
      input.db,
      latestPendingDecision.runId,
    );
    return {
      runId: latestPendingDecision.runId,
      decisionId: latestPendingDecision.decisionId,
    };
  }

  if (input.requireDecision) {
    throw new Error(
      '无法推断待审批的人工决策，请使用 --run-id 和 --decision-id 参数指定',
    );
  }

  const runId = selectLatestRunId(input.db);
  if (!runId) {
    throw new Error('无法推断运行 ID，请使用 --run-id <runId> 指定');
  }
  return { runId };
}
