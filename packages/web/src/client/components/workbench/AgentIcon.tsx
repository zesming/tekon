import type { ReactNode } from 'react';

export type AgentIconKind =
  | 'chatgpt'
  | 'antigravity'
  | 'codex'
  | 'claude'
  | 'generic';

export function resolveAgentIconKind(agentId?: string | null): AgentIconKind {
  const id = String(agentId ?? '').toLowerCase();
  if (id.includes('chatgpt') || id.includes('openai')) return 'chatgpt';
  if (
    id.includes('antigravity') ||
    id.includes('gemini') ||
    id.includes('dsh')
  ) {
    return 'antigravity';
  }
  if (id.includes('codex')) return 'codex';
  if (id.includes('claude')) return 'claude';
  return 'generic';
}

export function AgentIcon({
  agentId,
  size = 'md',
}: {
  agentId?: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const kind = resolveAgentIconKind(agentId);
  const px = size === 'sm' ? 10 : size === 'lg' ? 15 : 11;
  const sizeCls =
    size === 'sm' ? 'wb-ag-icon-sm' : size === 'lg' ? 'wb-ag-icon-lg' : '';

  let svg: ReactNode;
  if (kind === 'chatgpt') {
    svg = (
      <svg width={px} height={px} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round">
        <path d="M8 2.2l2.6 1.5v3L8 8.2 5.4 6.7v-3L8 2.2z" />
        <path d="M13 5.1l-2.6 1.5v3L13 11.1" />
        <path d="M3 5.1l2.6 1.5v3L3 11.1" />
        <path d="M8 13.8l-2.6-1.5v-3L8 7.8l2.6 1.5v3L8 13.8z" />
      </svg>
    );
  } else if (kind === 'antigravity') {
    svg = (
      <svg width={px} height={px} viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1.5c.4 3.4 2.1 5.1 5.5 5.5-3.4.4-5.1 2.1-5.5 5.5-.4-3.4-2.1-5.1-5.5-5.5 3.4-.4 5.1-2.1 5.5-5.5z" />
        <circle cx="12.6" cy="3.4" r="1.2" />
      </svg>
    );
  } else if (kind === 'codex') {
    svg = (
      <svg width={px} height={px} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 5.2L6.8 8l-3.3 2.8M8.4 11h4.1" />
      </svg>
    );
  } else if (kind === 'claude') {
    svg = (
      <svg width={px} height={px} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
        <path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" />
      </svg>
    );
  } else {
    svg = (
      <svg width={px} height={px} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
        <polygon points="8,2 13.5,5.2 13.5,10.8 8,14 2.5,10.8 2.5,5.2" />
        <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  return (
    <span
      className={`wb-ag-icon ${sizeCls} wb-ag-${kind}`}
      data-agent-icon={kind}
      title={`Agent: ${agentId || 'unknown'}`}
      aria-hidden="true"
    >
      {svg}
    </span>
  );
}

export const ROLE_COLORS: Record<string, string> = {
  explorer: 'var(--r-explorer)',
  designer: 'var(--r-designer)',
  reviewer: 'var(--r-reviewer)',
  coder: 'var(--r-coder)',
  orchestrator: 'var(--r-orchestrator)',
};

export function roleColor(roleId: string): string {
  return ROLE_COLORS[roleId] ?? 'var(--accent)';
}

export const WbIcons = {
  menu: <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /></svg>,
  plus: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v10M3 8h10" /></svg>,
  search: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>,
  folder: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0 }}><path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" /></svg>,
  settings: <svg width="14" height="14" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="9" cy="9" r="2.7" /><path d="M9 1.8v2M9 14.2v2M1.8 9h2M14.2 9h2M3.9 3.9l1.4 1.4M12.7 12.7l1.4 1.4M3.9 14.1l1.4-1.4M12.7 5.3l1.4-1.4" /></svg>,
  sun: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" /></svg>,
  moon: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13.2 9.8A5.4 5.4 0 016.2 2.8a5.6 5.6 0 107 7z" /></svg>,
  width: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 3v10M14 3v10M5 8h6M6.8 6L4.8 8l2 2M9.2 6l2 2-2 2" /></svg>,
  pause: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="4" y="3" width="2.8" height="10" rx="0.8" /><rect x="9.2" y="3" width="2.8" height="10" rx="0.8" /></svg>,
  play: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4.5 3.2l8 4.8-8 4.8z" /></svg>,
  stop: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 4l8 8M12 4l-8 8" /></svg>,
  doc: <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3.5 2h6l3 3v9h-9z" /><path d="M9.5 2v3h3M5.8 8.5h4.4M5.8 11h3" /></svg>,
  ctx: <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="4" cy="4" r="2" /><circle cx="12" cy="4" r="2" /><circle cx="8" cy="12" r="2" /><path d="M5.7 5.2L7.2 10M10.3 5.2L8.8 10" /></svg>,
  reuse: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13 8a5 5 0 11-1.3-3.4" /><path d="M13 2.5v2.8h-2.8" /></svg>,
  chevDown: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 6l4 4 4-4" /></svg>,
  chevUp: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 10l4-4 4 4" /></svg>,
  send: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M8 12.5V3.5M4 7.5L8 3.5l4 4" /></svg>,
  pin: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M9.5 2.5l4 4-2.5 2.5.5 3-3-3-3.5 3.5L6.5 9l-3-3 3 .5z" /></svg>,
  diff: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4.5 5h7M9.5 3l2 2-2 2M11.5 11h-7M6.5 9l-2 2 2 2" /></svg>,
  export: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8 2.5v7.5M5 7.5L8 10.5l3-3M3 13h10" /></svg>,
  compact: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 5h10M5 8h6M3 11h10" /></svg>,
  eye: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" /><circle cx="8" cy="8" r="1.7" /></svg>,
  check: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3.5 8.5l3 3 6-6.5" /></svg>,
  back: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M10 3.5L5.5 8 10 12.5" /></svg>,
  clip: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M11.5 5.5l-5 5a1.8 1.8 0 01-2.5-2.5l5.5-5.5a2.8 2.8 0 014 4l-5.5 5.5a3.8 3.8 0 01-5.4-5.4l5-5" /></svg>,
  up: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 12V4M4.5 7.5L8 4l3.5 3.5" /></svg>,
  down: <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 4v8M4.5 8.5L8 12l3.5-3.5" /></svg>,
  trash: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></svg>,
  copy: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" /><path d="M10.5 5.5V4A1.5 1.5 0 009 2.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5" /></svg>,
  sliders: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /><circle cx="6" cy="4.5" r="1.4" fill="var(--surface)" /><circle cx="10.5" cy="8" r="1.4" fill="var(--surface)" /><circle cx="7" cy="11.5" r="1.4" fill="var(--surface)" /></svg>,
  railSlim: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M10 2.5v11" /></svg>,
  railTop: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M2 6.5h12" /></svg>,
};
