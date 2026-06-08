import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createArtifactStore } from '../artifact/store.js';
import type { AuditLogger } from '../audit/logger.js';
import type { DonkeyRepositories } from '../db/repositories.js';
import { loadRepoProfile, type RepoProfile } from '../repo/profile.js';
import type { Artifact } from '../types/domain.js';
import {
  createDeliveryEvidencePackage,
  type DeliveryEvidencePackage,
} from './evidence.js';

export interface PullRequestPreparation {
  runId: string;
  title: string;
  branch: string;
  baseBranch: string;
  packagePath: string;
  prBodyPath: string;
  artifact: Artifact;
  evidence: DeliveryEvidencePackage;
  requiresHumanApproval: true;
}

export async function createPullRequestPreparation(input: {
  repoPath: string;
  repositories: DonkeyRepositories;
  audit: AuditLogger;
  runId: string;
  profile?: RepoProfile;
}): Promise<PullRequestPreparation> {
  const profile = input.profile ?? loadRepoProfile(input.repoPath);
  const evidence = await createDeliveryEvidencePackage({
    repositories: input.repositories,
    audit: input.audit,
    runId: input.runId,
    repoPath: input.repoPath,
    riskGates: ['human', 'security-scan'],
  });
  const nodes = await input.repositories.listNodes(input.runId);
  const deliveryNode = nodes.at(-1);
  if (!deliveryNode) {
    throw new Error(`run has no nodes: ${input.runId}`);
  }

  const title = `${profile.pr.titlePrefix}${evidence.demand.title}`.trim();
  const branch = `donkey-delivery/${input.runId}`;
  const baseBranch = profile.pr.baseBranch;
  const body = formatPrBody({ evidence, branch, baseBranch });
  const packageContent = formatPreparationPackage({
    evidence,
    title,
    branch,
    baseBranch,
    profile,
    body,
  });

  const store = createArtifactStore({
    repoPath: input.repoPath,
    repositories: input.repositories,
  });
  const artifact = await store.writeArtifact({
    runId: input.runId,
    nodeId: deliveryNode.id,
    type: 'delivery-package',
    content: packageContent,
    summary: `PR preparation for ${evidence.demand.title}`,
  });

  const packagePath = join(
    input.repoPath,
    '.donkey',
    'runs',
    input.runId,
    'delivery',
    'pr-package.md',
  );
  const prBodyPath = join(
    input.repoPath,
    '.donkey',
    'runs',
    input.runId,
    'delivery',
    'pr-body.md',
  );
  mkdirSync(dirname(packagePath), { recursive: true });
  writeFileSync(packagePath, packageContent, 'utf8');
  writeFileSync(prBodyPath, body, 'utf8');

  await input.audit.append({
    runId: input.runId,
    type: 'delivery.pr-prepared',
    payload: {
      branch,
      baseBranch,
      packagePath: artifact.path,
      prBodyPath,
      requiresHumanApproval: true,
    },
  });

  return {
    runId: input.runId,
    title,
    branch,
    baseBranch,
    packagePath,
    prBodyPath,
    artifact,
    evidence,
    requiresHumanApproval: true,
  };
}

function formatPrBody(input: {
  evidence: DeliveryEvidencePackage;
  branch: string;
  baseBranch: string;
}): string {
  const passedGates = input.evidence.gates.filter(
    (gate) => gate.status === 'passed',
  ).length;
  const failedGates = input.evidence.gates.filter(
    (gate) => gate.status === 'failed' || gate.status === 'blocked',
  ).length;
  return [
    `# ${input.evidence.demand.title}`,
    '',
    '## Summary',
    input.evidence.demand.body,
    '',
    '## Validation',
    `- workflow: ${input.evidence.workflowStatus}`,
    `- gates: ${passedGates} passed, ${failedGates} failed_or_blocked`,
    `- audit: ${input.evidence.audit.valid ? 'valid' : 'invalid'}`,
    `- artifacts: ${input.evidence.artifacts.length}`,
    `- rollback plan: ${input.evidence.rollbackPlanPresent ? 'present' : 'missing'}`,
    ...formatAcceptanceEvidence(input.evidence),
    ...formatSecurityEvidence(input.evidence),
    '',
    '## Delivery',
    `- branch: ${input.branch}`,
    `- base: ${input.baseBranch}`,
    '- remote push and PR creation require human approval.',
  ].join('\n');
}

function formatPreparationPackage(input: {
  evidence: DeliveryEvidencePackage;
  title: string;
  branch: string;
  baseBranch: string;
  profile: RepoProfile;
  body: string;
}): string {
  return [
    `# PR Preparation: ${input.title}`,
    '',
    '## Decision Surface',
    `- runId: ${input.evidence.runId}`,
    `- workflowStatus: ${input.evidence.workflowStatus}`,
    `- branch: ${input.branch}`,
    `- baseBranch: ${input.baseBranch}`,
    `- requiresHumanApproval: true`,
    '',
    '## Repo Profile Commands',
    ...Object.entries(input.profile.commands).map(([name, command]) =>
      `- ${name}: ${command.tool} ${command.args.join(' ')}`.trim(),
    ),
    '',
    '## Evidence',
    `- artifacts: ${input.evidence.artifacts.length}`,
    `- gates: ${input.evidence.gates.length}`,
    `- audit: ${input.evidence.audit.valid ? 'valid' : 'invalid'}`,
    `- rollbackPlanPresent: ${input.evidence.rollbackPlanPresent}`,
    '',
    '## Acceptance Evidence',
    ...formatAcceptanceEvidence(input.evidence),
    '',
    '## Security',
    ...formatSecurityEvidence(input.evidence),
    '',
    '## PR Body',
    input.body,
  ].join('\n');
}

function formatAcceptanceEvidence(evidence: DeliveryEvidencePackage): string[] {
  if (evidence.acceptanceEvidence.length === 0) {
    return ['- acceptanceEvidence: none'];
  }
  return evidence.acceptanceEvidence.map((item) =>
    [
      `- ${item.criterionId}: ${item.status}`,
      `  - description: ${item.description}`,
      `  - evidence: ${item.evidence.join('; ') || 'missing'}`,
      `  - artifacts: ${item.artifactIds.join(',') || 'none'}`,
      `  - gates: ${item.gateResultIds.join(',') || 'none'}`,
    ].join('\n'),
  );
}

function formatSecurityEvidence(evidence: DeliveryEvidencePackage): string[] {
  if (evidence.securityScans.length === 0) {
    return ['- securityScans: none'];
  }
  return evidence.securityScans.map((scan) =>
    [
      `- ${scan.gateResultId}: ${scan.status}`,
      `  - output: ${scan.outputPath ?? 'none'}`,
      `  - failure: ${scan.failureClassification ?? 'none'}`,
    ].join('\n'),
  );
}
