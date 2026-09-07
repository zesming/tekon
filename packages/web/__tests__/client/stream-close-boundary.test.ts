import { describe, expect, it, vi } from 'vitest';
import { openSessionStream } from '../../src/client/lib/session-stream.js';
import { openWorkspaceSummaryStream } from '../../src/client/lib/workspace-summary-stream.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const frame = 'data: {"workspaceId":"workspace-close","seq":1,"type":"approval/requested"}\n\n';

for (const kind of ['session', 'workspace'] as const) {
  describe(`${kind} stream close ownership`, () => {
    for (const phase of ['headers', 'body'] as const) {
      it(`does not publish delayed ${phase} after close`, async () => {
        let releaseResponse!: (response: Response) => void;
        let writer!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
        const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
        const pending = new Promise<Response>((resolve) => { releaseResponse = resolve; });
        const fetchImpl = vi.fn(() => phase === 'headers' ? pending : Promise.resolve(response));
        const onEvent = vi.fn();
        const onStateChange = vi.fn();
        const options = { token: 'closing-token', fetchImpl, onEvent, onStateChange };
        const handle = kind === 'session'
          ? openSessionStream({ ...options, sessionId: 'session-close' })
          : openWorkspaceSummaryStream({ ...options, workspaceId: 'workspace-close' });
        await flush();
        handle.close();
        onStateChange.mockClear();
        writer.enqueue(new TextEncoder().encode(frame));
        writer.close();
        releaseResponse(response);
        await flush();
        expect(onEvent).not.toHaveBeenCalled();
        expect(onStateChange).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      });
    }
  });
}
