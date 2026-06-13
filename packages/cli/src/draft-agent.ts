import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DraftShape } from '@tekon/core';

export interface AgentClarificationConfig {
  agentCommand: string;
  /** The repo path for resolving project-local roles */
  repoPath: string;
}

/**
 * Check whether the agent supports AI-driven clarification.
 * Currently only claude-code is supported (codex uses different CLI flags).
 */
export function isAgentAvailable(config: AgentClarificationConfig): boolean {
  try {
    execFileSync(config.agentCommand, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Call the PM agent to generate context-specific clarifying questions
 * based on the draft content. Falls back to empty array on any error.
 */
export function generateAgentQuestions(
  draft: DraftShape,
  config: AgentClarificationConfig,
): string[] {
  try {
    const prompt = buildQuestionsPrompt(draft, config.repoPath);
    const output = execFileSync(
      config.agentCommand,
      ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions'],
      {
        input: prompt,
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );

    const parsed = parseAgentJson(output);
    if (parsed?.questions && Array.isArray(parsed.questions)) {
      return parsed.questions
        .filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 0)
        .slice(0, 6);
    }
  } catch {
    // Agent unavailable or timed out — caller should fall back to static questions
  }
  return [];
}

/**
 * Call the PM agent to refine the draft shape with the user's answers.
 * Returns a partial DraftShape that will be merged with the original.
 * Falls back to null on any error (caller should use static updateDraftWithAnswers).
 */
export function refineDraftWithAgent(
  draft: DraftShape,
  answers: Array<{ question: string; answer: string }>,
  config: AgentClarificationConfig,
): Partial<DraftShape> | null {
  try {
    const prompt = buildRefinementPrompt(draft, answers, config.repoPath);
    const output = execFileSync(
      config.agentCommand,
      ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions'],
      {
        input: prompt,
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );

    const parsed = parseAgentJson(output);
    if (parsed) {
      return extractDraftShapePatch(parsed);
    }
  } catch {
    // Agent unavailable — caller should fall back
  }
  return null;
}

// ── Prompt builders ──────────────────────────────────────────

function buildQuestionsPrompt(draft: DraftShape, repoPath: string): string {
  const rolePrompt = loadPmRolePrompt(repoPath);
  const draftJson = JSON.stringify(
    {
      title: draft.title,
      category: draft.category,
      riskLevel: draft.risk.level,
      riskTags: draft.risk.tags,
      recommendedTemplate: draft.recommendedTemplate,
      acceptanceCriteria: draft.acceptanceCriteria.map((ac) => ({
        id: ac.id,
        description: ac.description,
      })),
      nonGoals: draft.nonGoals,
      assumptions: draft.assumptions,
      openQuestions: draft.openQuestions,
      rawText: draft.rawText,
    },
    null,
    2,
  );

  return `${rolePrompt}

## Task

You are reviewing a Tekon demand draft to generate clarifying questions for the user.
The user will answer these questions interactively in the terminal.

Given the draft below, generate 3-5 specific, context-aware clarifying questions that:
1. Address gaps or ambiguities unique to THIS draft (not generic templates)
2. Help clarify scope, user value, acceptance criteria, or risks
3. Are concise (one sentence each) and easy to answer in a terminal

Return ONLY a JSON object with a "questions" array:

{
  "questions": ["question 1", "question 2", ...]
}

Do NOT include any text outside the JSON.

## Draft

${draftJson}`;
}

function buildRefinementPrompt(
  draft: DraftShape,
  answers: Array<{ question: string; answer: string }>,
  repoPath: string,
): string {
  const rolePrompt = loadPmRolePrompt(repoPath);
  const draftJson = JSON.stringify(
    {
      title: draft.title,
      category: draft.category,
      riskLevel: draft.risk.level,
      riskTags: draft.risk.tags,
      recommendedTemplate: draft.recommendedTemplate,
      acceptanceCriteria: draft.acceptanceCriteria.map((ac) => ({
        id: ac.id,
        description: ac.description,
      })),
      nonGoals: draft.nonGoals,
      assumptions: draft.assumptions,
      openQuestions: draft.openQuestions,
      rawText: draft.rawText,
    },
    null,
    2,
  );
  const qaText = answers
    .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');

  return `${rolePrompt}

## Task

You are refining a Tekon demand draft based on the user's answers to clarifying questions.

Given the original draft and the Q&A below, produce an updated version of the draft.
Focus on:
- Incorporating user answers into the title, scope, and acceptance criteria
- Resolving open questions that were answered
- Updating risk assessment based on new information
- Adding specific acceptance criteria that reflect the clarified requirements
- Keeping the existing structure (category, template, etc.) unless answers clearly suggest a change

Return ONLY a JSON object with the fields you are updating (leave unchanged fields out):

{
  "title": "updated title if changed",
  "riskLevel": "low|medium|high",
  "riskTags": ["tag1"],
  "acceptanceCriteria": [
    { "id": "AC-1", "description": "specific criterion" }
  ],
  "nonGoals": ["specific non-goal"],
  "assumptions": ["specific assumption"],
  "openQuestions": ["remaining question"]
}

Do NOT include any text outside the JSON.

## Original Draft

${draftJson}

## User Answers

${qaText}`;
}

// ── Helpers ──────────────────────────────────────────────────

function loadPmRolePrompt(repoPath: string): string {
  // Try project-local role first, then built-in
  const candidates = [
    join(repoPath, '.tekon', 'roles', 'pm', 'system.md'),
    join(repoPath, 'roles', 'pm', 'system.md'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf8').trim();
    }
  }

  // Fallback inline prompt
  return `# Role: Product Manager

You are Tekon PM. Convert demand into clear scope, assumptions, open questions,
risks, and acceptance criteria. Keep high-risk work gated for human control.

## Principles

- Separate facts, assumptions, and recommendations.
- Produce acceptance criteria that downstream RD and QA can verify.
- Flag scope creep, unclear boundaries, and missing user context.
- For interactive clarification, ask specific questions based on the draft content.`;
}

/**
 * Parse agent output that may be wrapped in Claude's JSON result envelope
 * or be raw JSON.
 */
function parseAgentJson(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();

  // Try raw JSON first
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Continue
  }

  // Try Claude's JSON result format: {"type":"result","result":"..."}
  try {
    const envelope = JSON.parse(trimmed) as { result?: string };
    if (typeof envelope.result === 'string') {
      // The result field may itself be JSON
      const inner = envelope.result.trim();
      // Find the first '{' ... last '}' in the result text
      const jsonStart = inner.indexOf('{');
      const jsonEnd = inner.lastIndexOf('}');
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        return JSON.parse(inner.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
      }
    }
  } catch {
    // Continue
  }

  return null;
}

function extractDraftShapePatch(
  parsed: Record<string, unknown>,
): Partial<DraftShape> {
  const patch: Record<string, unknown> = {};

  if (typeof parsed.title === 'string' && parsed.title.trim()) {
    patch.title = parsed.title.trim();
  }

  if (
    typeof parsed.riskLevel === 'string' &&
    ['low', 'medium', 'high'].includes(parsed.riskLevel)
  ) {
    patch.risk = {
      level: parsed.riskLevel as 'low' | 'medium' | 'high',
      tags: Array.isArray(parsed.riskTags)
        ? parsed.riskTags.filter((t: unknown): t is string => typeof t === 'string')
        : [],
    } as DraftShape['risk'];
  }

  if (Array.isArray(parsed.acceptanceCriteria)) {
    patch.acceptanceCriteria = parsed.acceptanceCriteria
      .filter(
        (ac: unknown): ac is { id: string; description: string } =>
          typeof ac === 'object' &&
          ac !== null &&
          typeof (ac as Record<string, unknown>).description === 'string',
      )
      .map((ac: { id?: string; description: string }, i: number) => ({
        id: ac.id ?? `AC-${i + 1}`,
        description: ac.description,
      }));
  }

  if (Array.isArray(parsed.nonGoals)) {
    patch.nonGoals = parsed.nonGoals.filter(
      (ng: unknown): ng is string => typeof ng === 'string',
    );
  }

  if (Array.isArray(parsed.assumptions)) {
    patch.assumptions = parsed.assumptions.filter(
      (a: unknown): a is string => typeof a === 'string',
    );
  }

  if (Array.isArray(parsed.openQuestions)) {
    patch.openQuestions = parsed.openQuestions.filter(
      (oq: unknown): oq is string => typeof oq === 'string',
    );
  }

  return patch as Partial<DraftShape>;
}
