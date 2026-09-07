import type { TekonDatabase } from '@tekon/core';

/** Session API fixtures must reference a real Run in the fixture project. */
export function createScopedFixtureRun(db: TekonDatabase, id: string): string {
  const result = db.prepare(`
    insert into workflow_instances (id, project_id, demand_id, status, created_at, updated_at)
    select ?, project_id, demand_id, 'running', created_at, updated_at
    from workflow_instances where id = 'run_1'
  `).run(id);
  if (result.changes !== 1) throw new Error('fixture run_1 must exist');
  return id;
}
