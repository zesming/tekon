import { createSseParser, type StreamConnState } from './session-stream.js';

export interface WorkspaceSummaryEvent {
  workspaceId: string;
  /** Present on low-latency process-local frames; absent on signature catch-up. */
  sessionId?: string;
  /** Present on low-latency process-local frames; absent on signature catch-up. */
  type?: string;
  timestamp?: string;
}

const FATAL_STREAM_STATUSES = new Set([400, 401, 403, 404]);

export interface OpenWorkspaceSummaryStreamOptions {
  workspaceId: string;
  token: string | null;
  /** Called with the parsed summary event for each incoming data frame. */
  onEvent(event: WorkspaceSummaryEvent): void;
  onStateChange?(state: StreamConnState): void;
  /** Overridable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Base backoff in ms (default 500); grows exponentially, capped. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Open a resilient SSE stream to GET /api/workspaces/:workspaceId/summary/events.
 * Dispatches `workspace/summary` notifications when session states update.
 */
export function openWorkspaceSummaryStream(
  options: OpenWorkspaceSummaryStreamOptions,
): { close(): void } {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseBackoff = options.baseBackoffMs ?? 500;
  const maxBackoff = options.maxBackoffMs ?? 10_000;
  let closed = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function markClosed(): void {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    controller?.abort();
    options.onStateChange?.('closed');
  }

  async function connect(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    options.onStateChange?.(attempt === 0 ? 'connecting' : 'reconnecting');
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (options.token) {
      headers['x-session-token'] = options.token;
    }
    const url = `/api/workspaces/${encodeURIComponent(
      options.workspaceId,
    )}/summary/events`;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        if (FATAL_STREAM_STATUSES.has(response.status)) {
          markClosed();
          return;
        }
        throw new Error(`workspace stream failed: ${response.status}`);
      }
      attempt = 0;
      options.onStateChange?.('live');
      const parser = createSseParser();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(
          decoder.decode(value, { stream: true }),
        )) {
          if (frame.data === undefined) continue;
          try {
            const event = JSON.parse(frame.data) as WorkspaceSummaryEvent;
            if (event.workspaceId === options.workspaceId) {
              options.onEvent(event);
            }
          } catch {
            // Ignore unparseable frames.
          }
        }
      }
    } catch {
      // Transient failure -> fall through to reconnect unless closed.
    }
    if (closed) return;
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    options.onStateChange?.('reconnecting');
    const delay = Math.min(maxBackoff, baseBackoff * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(() => {
      void connect();
    }, delay);
  }

  void connect();

  return {
    close(): void {
      markClosed();
    },
  };
}
