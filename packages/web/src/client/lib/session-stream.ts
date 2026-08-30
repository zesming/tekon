import type { PresentedEvent } from '@tekon/core';

/**
 * Phase 3 3a: SSE client for the session event stream.
 *
 * We use fetch + ReadableStream rather than the native EventSource because
 * EventSource cannot set the `x-session-token` request header (W3C spec), and
 * putting the token in the URL would leak it into access logs / history — a
 * secret-leak regression (design D1). The trade-off is that we hand-roll frame
 * parsing and reconnection, both of which are pure and unit-tested below.
 */

/** A presented session event as it arrives over the wire (server strips seq-less internal fields). */
export type StreamEvent = PresentedEvent;

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
}

/**
 * Incremental SSE frame parser. `push` accepts an arbitrary chunk (which may
 * split a frame mid-line or between CR and LF) and returns whatever complete
 * frames are now available, buffering the rest. Comment/heartbeat lines
 * (starting ":") are ignored. The event-stream grammar accepts LF, CRLF, and
 * bare CR line endings, including when a CRLF pair crosses chunk boundaries.
 */
export function createSseParser(): { push(chunk: string): SseFrame[] } {
  let buffer = '';
  // A trailing CR is already a legal line terminator. If the next network
  // chunk starts in LF, that LF is merely the second half of the same CRLF
  // pair and must not create an extra blank line.
  let skipLeadingLf = false;

  return {
    push(chunk: string): SseFrame[] {
      if (skipLeadingLf && chunk.length > 0) {
        if (chunk.startsWith('\n')) {
          chunk = chunk.slice(1);
        }
        skipLeadingLf = false;
      }

      let normalized = '';
      for (let index = 0; index < chunk.length; index += 1) {
        const char = chunk[index];
        if (char !== '\r') {
          normalized += char;
          continue;
        }

        normalized += '\n';
        if (index + 1 < chunk.length && chunk[index + 1] === '\n') {
          // CRLF wholly inside this chunk is one line ending.
          index += 1;
        } else if (index === chunk.length - 1) {
          // The CR may be followed by LF in the next chunk. We have already
          // consumed it as the line ending, so ignore only that leading LF.
          skipLeadingLf = true;
        }
      }

      buffer += normalized;
      const frames: SseFrame[] = [];
      let sep: number;
      // Frames are separated by a blank line ("\n\n") after normalization.
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const frame = parseFrameLines(rawFrame);
        if (frame) {
          frames.push(frame);
        }
      }
      return frames;
    },
  };
}

function parseFrameLines(raw: string): SseFrame | null {
  const frame: SseFrame = {};
  let hasField = false;
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) {
      // Blank line inside a block or comment/heartbeat — skip.
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // SSE spec: a single leading space after the colon is stripped.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'id') {
      frame.id = value;
      hasField = true;
    } else if (field === 'event') {
      frame.event = value;
      hasField = true;
    } else if (field === 'data') {
      frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
      hasField = true;
    }
  }
  return hasField ? frame : null;
}

function hasStrictlyIncreasingSeq(events: readonly StreamEvent[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.seq <= events[index - 1]!.seq) {
      return false;
    }
  }
  return true;
}

/**
 * Merge freshly-arrived events into an accumulated list: dedupe by seq (a
 * reconnect replays an overlapping tail), keep the first occurrence of any
 * seq, and return sorted ascending by seq. The normal SSE path is an ordered,
 * non-overlapping append; keep that path linear and allocation-light instead
 * of rebuilding a Map and sorting the complete history for every frame. Replay
 * overlap, duplicates, or out-of-order input still use the defensive reducer.
 */
export function mergeEventsBySeq(
  existing: readonly StreamEvent[],
  incoming: readonly StreamEvent[],
): StreamEvent[] {
  const existingOrdered = hasStrictlyIncreasingSeq(existing);
  const incomingOrdered = hasStrictlyIncreasingSeq(incoming);
  const followsExisting =
    existing.length === 0 ||
    incoming.length === 0 ||
    incoming[0]!.seq > existing[existing.length - 1]!.seq;

  if (existingOrdered && incomingOrdered && followsExisting) {
    return [...existing, ...incoming];
  }

  const bySeq = new Map<number, StreamEvent>();
  for (const event of existing) {
    if (!bySeq.has(event.seq)) {
      bySeq.set(event.seq, event);
    }
  }
  for (const event of incoming) {
    if (!bySeq.has(event.seq)) {
      bySeq.set(event.seq, event);
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The Last-Event-ID to resume from: the max seq seen, or 0 for a full replay. */
export function lastEventId(events: readonly StreamEvent[]): number {
  let max = 0;
  for (const event of events) {
    if (event.seq > max) {
      max = event.seq;
    }
  }
  return max;
}

export type StreamConnState = 'connecting' | 'live' | 'reconnecting' | 'closed';

/**
 * HTTP statuses that will never recover on retry: an origin/Sec-Fetch guard
 * rejection (400), a bad/missing session token (401/403), or an unknown session
 * (404). Every 400 on this route comes from the request guard (there is no
 * transient 400), so treating it as fatal cannot wrongly kill a retryable
 * stream. Reconnecting on any of these just hammers the server with the same
 * doomed request, so we go straight to 'closed' instead.
 */
const FATAL_STREAM_STATUSES = new Set([400, 401, 403, 404]);

export interface OpenSessionStreamOptions {
  sessionId: string;
  token: string | null;
  /** Called with the parsed event for each incoming data frame. */
  onEvent(event: StreamEvent): void;
  onStateChange(state: StreamConnState): void;
  /**
   * Called when the server signals that replay was truncated (reconnect budget
   * or slow-client backpressure cap exceeded). The stream has switched to the
   * recent tail; the UI should show a non-blocking notice. Optional.
   */
  onTruncated?: (cursor: number | null) => void;
  /** Resume point for the first connection (default 0 = full replay). */
  sinceSeq?: number;
  /** Overridable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Base backoff in ms (default 500); grows exponentially, capped. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

function asStreamEvent(value: unknown): StreamEvent | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { seq?: unknown }).seq !== 'number' ||
    !Number.isFinite((value as { seq: number }).seq) ||
    typeof (value as { type?: unknown }).type !== 'string'
  ) {
    return null;
  }
  return value as StreamEvent;
}

/**
 * Open a resilient SSE stream to GET /api/sessions/:id/events. Returns a
 * `close()` that aborts the fetch and stops reconnection. On disconnect it
 * reconnects with exponential backoff, resuming from the max seq seen via the
 * `Last-Event-ID` header (server stitches 0..k ∪ k..end with no loss/dup).
 */
export function openSessionStream(options: OpenSessionStreamOptions): {
  close(): void;
} {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseBackoff = options.baseBackoffMs ?? 500;
  const maxBackoff = options.maxBackoffMs ?? 10_000;
  let closed = false;
  let attempt = 0;
  let maxSeq = options.sinceSeq ?? 0;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function markClosed(): void {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    controller?.abort();
    options.onStateChange('closed');
  }

  async function connect(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    options.onStateChange(attempt === 0 ? 'connecting' : 'reconnecting');
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (options.token) {
      headers['x-session-token'] = options.token;
    }
    if (maxSeq > 0) {
      headers['Last-Event-ID'] = String(maxSeq);
    }
    const url = `/api/sessions/${encodeURIComponent(options.sessionId)}/events`;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        // A fatal client error (bad token, unknown session) will never recover
        // on retry — stop rather than hammer the server. Anything else (5xx,
        // network drop) is transient → fall through to backoff reconnect.
        if (FATAL_STREAM_STATUSES.has(response.status)) {
          markClosed();
          return;
        }
        throw new Error(`stream failed: ${response.status}`);
      }
      attempt = 0;
      options.onStateChange('live');
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
            const parsed = JSON.parse(frame.data) as unknown;
            if (frame.event === 'replay-truncated') {
              const cursor =
                typeof parsed === 'object' &&
                parsed !== null &&
                typeof (parsed as { cursor?: unknown }).cursor === 'number'
                  ? (parsed as { cursor: number }).cursor
                  : null;
              if (cursor !== null && Number.isFinite(cursor)) {
                maxSeq = Math.max(maxSeq, cursor);
              }
              options.onTruncated?.(
                cursor !== null && Number.isFinite(cursor) ? cursor : null,
              );
              continue;
            }

            const event = asStreamEvent(parsed);
            if (!event) continue;
            if (event.seq > maxSeq) {
              maxSeq = event.seq;
            }
            options.onEvent(event);
          } catch {
            // Ignore an unparseable frame rather than tearing down the stream.
          }
        }
      }
    } catch {
      // fall through to reconnect (unless closed)
    }
    if (closed) return;
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    options.onStateChange('reconnecting');
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
