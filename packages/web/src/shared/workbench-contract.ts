import { z } from 'zod';

const agentStatusSchema = z.enum([
  'ready',
  'unauthenticated',
  'not_installed',
  'unsupported',
]);

export const discoveredAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  iconKey: z.string(),
  status: agentStatusSchema,
  executable: z.boolean().optional(),
  authKind: z.string().optional(),
  version: z.string().optional(),
  loginHint: z.string().optional(),
  installHint: z.string().optional(),
  unsupportedHint: z.string().optional(),
  models: z.array(z.string()),
  efforts: z.array(z.string()),
  modelEfforts: z.record(z.string(), z.array(z.string())).optional(),
  source: z.enum(['built-in', 'user-config']),
});

export const agentDiscoverySnapshotSchema = z.object({
  probedAt: z.string(),
  agents: z.array(discoveredAgentSchema),
});

export const workbenchPreferencesSchema = z.object({
  defaultOrchestrator: z.string(),
  compactThreshold: z.enum(['75', '85', 'manual']),
  autoArchiveLogs: z.boolean(),
  theme: z.enum(['light', 'dark']),
  contentWidth: z.enum(['normal', 'wide', 'full']),
  railMode: z.enum(['top', 'right']),
});

export const prefsGetOutputSchema = z.object({
  workspace: z.object({ name: z.string(), path: z.string() }),
  prefs: workbenchPreferencesSchema,
});

export const prefsUpdateInputSchema = workbenchPreferencesSchema.partial();

export const roleRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  builtIn: z.boolean(),
  overridden: z.boolean(),
  category: z.enum(['general', 'delivery']),
  driver: z.string(),
  model: z.string(),
  effort: z.string(),
  isolated: z.boolean(),
  systemPrompt: z.string(),
});

export const linearWorkflowNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  workspace: z.enum(['worktree', 'in-place', 'none']).optional(),
  docKey: z.string().optional(),
  expectedDoc: z.string().optional(),
  overrideModel: z.string().optional(),
  overrideEffort: z.string().optional(),
  overridePrompt: z.string().optional(),
  contextMode: z.enum(['auto', 'full', 'isolated', 'reuse']).optional(),
  confirmAfter: z.boolean().optional(),
});

export const linearWorkflowRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  builtIn: z.boolean(),
  overridden: z.boolean(),
  category: z.enum(['general', 'delivery']),
  nodes: z.array(linearWorkflowNodeSchema),
});

export const taskListItemSchema = z.object({
  runId: z.string(),
  sessionId: z.string().nullable(),
  executor: z.enum(['workbench', 'legacy']),
  canControl: z.boolean(),
  title: z.string(),
  mode: z.enum(['static', 'dynamic']),
  templateName: z.string(),
  status: z.string(),
  pauseReason: z.string().nullable(),
  blueprintStatus: z.string().nullable(),
  uiCategory: z.enum(['running', 'attention', 'done']),
  progressLabel: z.string(),
  completedNodes: z.number(),
  totalNodes: z.number(),
  updatedAt: z.string(),
  createdAt: z.string(),
});

export const solidifiedDocSchema = z.object({
  id: z.string(),
  source: z.enum(['artifact', 'attachment']),
  runId: z.string(),
  nodeId: z.string().nullable(),
  docKey: z.string(),
  title: z.string(),
  version: z.number(),
  summary: z.string(),
  pinned: z.boolean(),
  archived: z.boolean(),
  sizeBytes: z.number(),
  createdAt: z.string(),
  versions: z.array(z.number()),
});

export const contextGeneralEntrySchema = z.object({
  id: z.string(),
  kind: z.enum([
    'goal',
    'handoff',
    'constraint',
    'rework_feedback',
    'compaction_summary',
    'followup',
  ]),
  nodeId: z.string().nullable(),
  content: z.string(),
  status: z.enum(['active', 'queued_next', 'compacted']),
  createdAt: z.string(),
});

export const contextArchiveEntrySchema = z.object({
  id: z.string(),
  nodeId: z.string().nullable(),
  kind: z.enum(['private_trace', 'doc_snapshot', 'compacted_history']),
  title: z.string(),
  summary: z.string(),
  filePath: z.string(),
  byteSize: z.number(),
  mounted: z.boolean(),
  createdAt: z.string(),
  content: z.string().optional(),
});

export const followUpTurnSchema = z.object({
  id: z.string(),
  runId: z.string(),
  roleId: z.string(),
  driver: z.string(),
  model: z.string().nullable(),
  userText: z.string(),
  assistantText: z.string(),
  createdAt: z.string(),
});

export const dynamicBlueprintNodeRpcSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  roleId: z.string().min(1),
  docKey: z.string().optional(),
  expectedDoc: z.string().optional(),
  reason: z.string().optional(),
  confirmAfter: z.boolean().optional(),
  overrideModel: z.string().optional(),
  overrideEffort: z.string().optional(),
  contextMode: z.enum(['auto', 'full', 'isolated', 'reuse']).optional(),
});

export const taskNodeViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  status: z.string(),
  order: z.number(),
  driver: z.string(),
  model: z.string(),
  effort: z.string(),
  contextMode: z.enum(['auto', 'full', 'isolated', 'reuse']),
  docKey: z.string().nullable(),
  expectedDoc: z.string().nullable(),
  confirmAfter: z.boolean(),
  attemptGeneration: z.number(),
  reworkCount: z.number(),
  durationMs: z.number().nullable(),
  tokenInput: z.number().nullable(),
  tokenCached: z.number().nullable(),
  tokenOutput: z.number().nullable(),
  cacheReusePercent: z.number().nullable(),
  handoffBrief: z.string().nullable(),
  traceSummary: z.string().nullable(),
  traceLines: z.array(z.string()),
  errorMessage: z.string().nullable(),
  reuseAnchorOrder: z.number().nullable(),
  reuseMode: z.enum(['new', 'isolated', 'reuse', 'reset']),
});

export const taskDetailViewSchema = z.object({
  runId: z.string(),
  sessionId: z.string().nullable(),
  executor: z.enum(['workbench', 'legacy']),
  canControl: z.boolean(),
  title: z.string(),
  prompt: z.string(),
  mode: z.enum(['static', 'dynamic']),
  templateId: z.string().nullable(),
  templateName: z.string(),
  status: z.string(),
  pauseReason: z.string().nullable(),
  blueprintStatus: z.string().nullable(),
  blueprint: z
    .object({
      summary: z.string().optional(),
      nodes: z.array(dynamicBlueprintNodeRpcSchema.extend({ id: z.string() })),
      error: z.string().optional(),
    })
    .nullable(),
  currentNodeId: z.string().nullable(),
  lastRoleId: z.string().nullable(),
  nodes: z.array(taskNodeViewSchema),
  documents: z.array(solidifiedDocSchema),
  queuedConstraints: z.array(contextGeneralEntrySchema),
  followUps: z.array(followUpTurnSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const nodeContextPackageSchema = z.object({
  runId: z.string(),
  nodeId: z.string(),
  nodeName: z.string(),
  roleId: z.string(),
  driver: z.string(),
  model: z.string(),
  effort: z.string(),
  contextMode: z.enum(['auto', 'full', 'isolated', 'reuse']),
  session: z.object({
    mode: z.enum(['new', 'isolated', 'reuse', 'reset']),
    anchorNodeId: z.string().optional(),
    anchorNodeOrder: z.number().optional(),
    providerThreadId: z.string().optional(),
    cacheReusePercent: z.number().optional(),
    windowPercent: z.number(),
    windowTokens: z.number(),
    windowLimit: z.number(),
  }),
  generalEntries: z.array(contextGeneralEntrySchema),
  queuedConstraints: z.array(contextGeneralEntrySchema),
  documents: z.array(
    z.object({
      id: z.string(),
      docKey: z.string(),
      title: z.string(),
      version: z.number(),
      sourceNodeId: z.string().nullable(),
      pinned: z.boolean(),
      summary: z.string(),
      delivery: z.enum(['full', 'index']),
      content: z.string().optional(),
    }),
  ),
  isolatedArchives: z.array(contextArchiveEntrySchema),
  mountedArchives: z.array(contextArchiveEntrySchema),
});

export const workbenchProcedureSpecs = {
  // ── Agents & Local Discovery (auth: 'session') ──
  'agent.list': {
    auth: 'session' as const,
    input: z.undefined().optional(),
    output: agentDiscoverySnapshotSchema,
  },
  'agent.refresh': {
    auth: 'session' as const,
    input: z.undefined().optional(),
    output: agentDiscoverySnapshotSchema,
  },

  // ── Preferences & Workspace Info ──
  'prefs.get': {
    auth: 'session' as const,
    input: z.undefined().optional(),
    output: prefsGetOutputSchema,
  },
  'prefs.update': {
    auth: 'session' as const,
    input: prefsUpdateInputSchema,
    output: prefsGetOutputSchema,
  },

  // ── Roles CRUD & Override Cleanup ──
  'role.listDetailed': {
    auth: 'session' as const,
    input: z.object({ includeDelivery: z.boolean().optional() }).optional(),
    output: z.object({ roles: z.array(roleRecordSchema) }),
  },
  'role.save': {
    auth: 'session' as const,
    input: z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      description: z.string().optional(),
      driver: z.string().optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
      isolated: z.boolean().optional(),
      systemPrompt: z.string().min(1),
    }),
    output: z.object({
      role: roleRecordSchema,
      cleanedWorkflows: z.array(z.string()),
    }),
  },
  'role.duplicate': {
    auth: 'session' as const,
    input: z.object({
      sourceId: z.string().min(1),
      newId: z.string().optional(),
      newName: z.string().optional(),
    }),
    output: z.object({ role: roleRecordSchema }),
  },
  'role.delete': {
    auth: 'session' as const,
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ deleted: z.literal(true) }),
  },
  'role.resetBuiltIn': {
    auth: 'session' as const,
    input: z.object({ id: z.string().min(1) }),
    output: z.object({
      role: roleRecordSchema,
      cleanedWorkflows: z.array(z.string()),
    }),
  },

  // ── Workflows CRUD ──
  'workflow.listDetailed': {
    auth: 'session' as const,
    input: z.object({ includeDelivery: z.boolean().optional() }).optional(),
    output: z.object({ workflows: z.array(linearWorkflowRecordSchema) }),
  },
  'workflow.get': {
    auth: 'session' as const,
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ workflow: linearWorkflowRecordSchema }),
  },
  'workflow.save': {
    auth: 'session' as const,
    input: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      nodes: z.array(linearWorkflowNodeSchema).min(1),
    }),
    output: z.object({ workflow: linearWorkflowRecordSchema }),
  },
  'workflow.duplicate': {
    auth: 'session' as const,
    input: z.object({
      sourceId: z.string().min(1),
      newId: z.string().optional(),
      newName: z.string().optional(),
    }),
    output: z.object({ workflow: linearWorkflowRecordSchema }),
  },
  'workflow.delete': {
    auth: 'session' as const,
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ deleted: z.literal(true) }),
  },
  'workflow.resetBuiltIn': {
    auth: 'session' as const,
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ workflow: linearWorkflowRecordSchema }),
  },

  // ── Tasks & Orchestration ──
  'task.list': {
    auth: 'session' as const,
    input: z
      .object({
        filter: z.enum(['all', 'running', 'attention', 'done']).optional(),
        q: z.string().optional(),
      })
      .optional(),
    output: z.object({
      workspace: z.object({ name: z.string(), path: z.string() }),
      tasks: z.array(taskListItemSchema),
    }),
  },
  'task.get': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ task: taskDetailViewSchema }),
  },
  'task.create': {
    auth: 'session' as const,
    input: z.object({
      mode: z.enum(['static', 'dynamic']),
      templateId: z.string().optional(),
      prompt: z.string().min(1),
      attachments: z
        .array(z.object({ name: z.string().min(1), content: z.string() }))
        .optional(),
    }),
    output: z.object({
      runId: z.string(),
      sessionId: z.string(),
      task: taskDetailViewSchema,
    }),
  },
  'task.pause': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ task: taskDetailViewSchema }),
  },
  'task.resume': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ task: taskDetailViewSchema }),
  },
  'task.cancel': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ task: taskDetailViewSchema }),
  },
  'task.appendConstraint': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1), text: z.string().min(1) }),
    output: z.object({ task: taskDetailViewSchema }),
  },
  'task.approveCheckpoint': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ task: taskDetailViewSchema }),
  },
  'task.reworkFromNode': {
    auth: 'session' as const,
    input: z.object({
      runId: z.string().min(1),
      targetNodeId: z.string().min(1),
      note: z.string().min(1),
    }),
    output: z.object({ task: taskDetailViewSchema }),
  },
  'task.retryNode': {
    auth: 'session' as const,
    input: z.object({
      runId: z.string().min(1),
      nodeId: z.string().min(1),
      override: z
        .object({
          driver: z.string().optional(),
          model: z.string().optional(),
          effort: z.string().optional(),
        })
        .optional(),
    }),
    output: z.object({ task: taskDetailViewSchema }),
  },
  'task.followUp': {
    auth: 'session' as const,
    input: z.object({
      runId: z.string().min(1),
      roleId: z.string().optional(),
      prompt: z.string().min(1),
    }),
    output: z.object({ task: taskDetailViewSchema }),
  },
  'task.updateBlueprint': {
    auth: 'session' as const,
    input: z.object({
      runId: z.string().min(1),
      nodes: z.array(dynamicBlueprintNodeRpcSchema).min(1),
    }),
    output: z.object({ task: taskDetailViewSchema }),
  },
  'task.replanBlueprint': {
    auth: 'session' as const,
    input: z.object({
      runId: z.string().min(1),
      instruction: z.string().optional(),
    }),
    output: z.object({ task: taskDetailViewSchema }),
  },
  'task.confirmBlueprint': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ task: taskDetailViewSchema }),
  },
  'task.saveAsTemplate': {
    auth: 'session' as const,
    input: z.object({
      runId: z.string().min(1),
      id: z.string().optional(),
      name: z.string().min(1),
      description: z.string().optional(),
    }),
    output: z.object({ id: z.string(), name: z.string() }),
  },

  // ── Solidified Documents ──
  'doc.list': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ documents: z.array(solidifiedDocSchema) }),
  },
  'doc.get': {
    auth: 'session' as const,
    input: z.object({
      runId: z.string().min(1),
      docId: z.string().min(1),
      version: z.number().int().positive().optional(),
    }),
    output: z.object({
      document: solidifiedDocSchema,
      content: z.string(),
    }),
  },
  'doc.diff': {
    auth: 'session' as const,
    input: z.object({
      runId: z.string().min(1),
      docKey: z.string().min(1),
      fromVersion: z.number().int().positive(),
      toVersion: z.number().int().positive(),
    }),
    output: z.object({
      fromVersion: z.number(),
      toVersion: z.number(),
      addedCount: z.number(),
      removedCount: z.number(),
      lines: z.array(
        z.object({
          type: z.enum(['context', 'added', 'removed']),
          text: z.string(),
        }),
      ),
    }),
  },
  'doc.togglePin': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1), docId: z.string().min(1) }),
    output: z.object({ document: solidifiedDocSchema }),
  },
  'doc.promoteFromHandoff': {
    auth: 'session' as const,
    input: z.object({
      runId: z.string().min(1),
      nodeId: z.string().min(1),
      title: z.string().optional(),
    }),
    output: z.object({ document: solidifiedDocSchema }),
  },
  'doc.export': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1), docId: z.string().min(1) }),
    output: z.object({ filename: z.string(), content: z.string() }),
  },

  // ── Context Inspector, Compaction & Reversible Archive ──
  'context.inspectNode': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1), nodeId: z.string().min(1) }),
    output: z.object({ context: nodeContextPackageSchema }),
  },
  'context.setNodeReuseMode': {
    auth: 'session' as const,
    input: z.object({
      runId: z.string().min(1),
      roleId: z.string().min(1),
      reuseMode: z.enum(['reuse', 'reset']),
    }),
    output: z.object({ updated: z.literal(true) }),
  },
  'context.compact': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({
      compactedCount: z.number(),
      archive: contextArchiveEntrySchema,
      windowPercent: z.number(),
    }),
  },
  'context.listArchives': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ archives: z.array(contextArchiveEntrySchema) }),
  },
  'context.getArchive': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1), archiveId: z.string().min(1) }),
    output: z.object({
      archive: contextArchiveEntrySchema,
      content: z.string(),
    }),
  },
  'context.toggleArchiveMount': {
    auth: 'session' as const,
    input: z.object({ runId: z.string().min(1), archiveId: z.string().min(1) }),
    output: z.object({ archive: contextArchiveEntrySchema }),
  },
} as const;
