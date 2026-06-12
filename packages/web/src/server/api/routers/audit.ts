import type { ServerContext } from '../context.js';
import { assertRunInScope, listNodes } from '../queries.js';
import { mapAuditEvent, matchesAuditFilters } from '../mappers.js';

export function createAuditRouter(context: ServerContext) {
  return {
    async list(auditInput: {
      runId: string;
      nodeId?: string;
      gateId?: string;
      role?: string;
    }) {
      assertRunInScope(context.db, context.projectContext, auditInput.runId);
      const events = await context.repositories.listAuditEvents(
        auditInput.runId,
      );
      const nodeById = new Map(
        listNodes(context.db, auditInput.runId).map((node) => [node.id, node]),
      );
      return {
        verification: await context.audit.verify(auditInput.runId),
        events: events
          .map((event) => mapAuditEvent(event, nodeById))
          .filter((event) => matchesAuditFilters(event, auditInput)),
      };
    },
  };
}
