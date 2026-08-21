import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  presentEvent,
  type SessionEvent,
  type SessionEventBus,
  type SessionEventStore,
} from '@tekon/core';

/**
 * SSE 端点处理器(阶段 1 S8,设计 §3.1)。
 *
 * 契约:`GET /api/sessions/:sessionId/events?sinceSeq=<n>`,鉴权(token/origin)
 * 由 http.ts 的 SSE 分支在调用本函数前完成(不建立流即可返回 JSON 错误)。本函数
 * 负责:session 存在性(404)→ 解析 sinceSeq → 写流式响应头 → **先订阅后回放(M6)**
 * → flush 交界缓冲(SHOULD3)→ 转纯 live → 心跳 + 断连清理。
 *
 * M6 零丢失(顺序不可换):先 `bus.subscribe`(flushing 期间 live 事件入内存缓冲)
 * → `listEventsSince` 回放并记 maxReplayedSeq → drain 缓冲(seq > maxReplayedSeq
 * 且未回放过的,按 seq 升序去重)→ 翻转 flushing=false → 转纯 live。subscribe 与
 * listEventsSince 之间仅一个 await 窗口,该窗口内 publish 的事件必入缓冲,回放/订阅
 * 交界零丢失、零重复。
 */
export async function handleSessionEventsSse(input: {
  request: IncomingMessage;
  response: ServerResponse;
  sessionId: string;
  sessions: SessionEventStore;
  bus: SessionEventBus;
  /** 心跳间隔;默认 15s(设计 §3.1 步骤 8)。仅测试注入短间隔。 */
  heartbeatMs?: number;
}): Promise<void> {
  const { request, response, sessionId, sessions, bus } = input;

  // 1. session 存在性(404,流建立前)。
  const session = await sessions.getSession(sessionId);
  if (!session) {
    response.statusCode = 404;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(
      JSON.stringify({
        error: { code: 'NOT_FOUND', message: `Session not found: ${sessionId}` },
      }),
    );
    return;
  }

  // 2. 解析 sinceSeq:query 优先,否则 Last-Event-ID,否则 0(全量回放)。
  const url = new URL(request.url ?? '', 'http://localhost');
  const sinceParam = url.searchParams.get('sinceSeq');
  const lastEventId = request.headers['last-event-id'];
  let sinceSeq = 0;
  if (sinceParam != null && /^\d+$/.test(sinceParam)) {
    sinceSeq = Number(sinceParam);
  } else if (typeof lastEventId === 'string' && /^\d+$/.test(lastEventId)) {
    sinceSeq = Number(lastEventId);
  }

  // 3. 流式响应头。
  response.statusCode = 200;
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('connection', 'keep-alive');
  response.setHeader('x-accel-buffering', 'no');
  response.flushHeaders?.();

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  // 每帧:`id: <seq>\nevent: <type>\ndata: <presentEvent(event)>\n\n`。
  // internal 事件 presentEvent 返回 null → 不下发(C5)。JSON.stringify 保证
  // data 单行(内部换行被转义),不破坏帧边界。
  const writeFrame = (event: SessionEvent): void => {
    if (closed || response.writableEnded) {
      return;
    }
    const presented = presentEvent(event);
    if (!presented) {
      return;
    }
    // Defense-in-depth (B5): the event line is `event: <type>`. type is always
    // a fixed literal from our producers today, but strip CR/LF so a future
    // caller can never inject frame boundaries via a crafted type. data is JSON
    // (newlines escaped) so it is already single-line.
    const safeType = presented.type.replace(/[\r\n]/g, ' ');
    response.write(
      `id: ${presented.seq}\n` +
        `event: ${safeType}\n` +
        `data: ${JSON.stringify(presented)}\n\n`,
    );
  };

  // 4. 先订阅:flushing 期间 live 事件进缓冲,回放后再 drain。
  let flushing = true;
  const buffered: SessionEvent[] = [];
  const unsubscribe = bus.subscribe(sessionId, (event) => {
    if (flushing) {
      buffered.push(event);
    } else {
      writeFrame(event);
    }
  });

  // 7(上移):断连清理。**必须在回放 await 之前注册**——否则客户端在
  // listEventsSince 期间断连时无 listener,unsubscribe 永不触发、bus 永久持有
  // 闭包、heartbeat 空写(R6 泄漏,B2)。heartbeat 用可空引用,cleanup 判空,
  // 避免在 heartbeat 创建前触发 cleanup 撞 TDZ。
  const cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    unsubscribe();
    if (!response.writableEnded) {
      response.end();
    }
  };
  request.on('close', cleanup);

  try {
    // 5. 后回放:listEventsSince 逐条写帧,记 maxReplayedSeq;seq 去重集。
    const replayed = await sessions.listEventsSince(sessionId, sinceSeq);
    const seenSeqs = new Set<number>();
    let maxReplayedSeq = sinceSeq;
    for (const event of replayed) {
      seenSeqs.add(event.seq);
      if (event.seq > maxReplayedSeq) {
        maxReplayedSeq = event.seq;
      }
      writeFrame(event);
    }

    // 6. flush 交界缓冲(SHOULD3):drain 到空再翻转 flushing。subscribe→此处仅
    // listEventsSince 一个 await,缓冲在此后是同步 drain(无 await → 不会再增长),
    // 但循环仍保证"drain 到空"语义。seq > maxReplayedSeq 且未回放过的才发。
    const drainBuffer = (): void => {
      for (;;) {
        const batch = buffered.splice(0).sort((a, b) => a.seq - b.seq);
        if (batch.length === 0) {
          break;
        }
        for (const event of batch) {
          if (event.seq > maxReplayedSeq && !seenSeqs.has(event.seq)) {
            seenSeqs.add(event.seq);
            writeFrame(event);
          }
        }
      }
    };
    drainBuffer();
    flushing = false;
    // 翻转后再查一次防漏(翻转与最后一次 splice 之间无 await,纯防御)。
    drainBuffer();
  } catch {
    // 回放失败(如 db 锁/关闭):清理并结束流。**不 rethrow**——http.ts 的
    // createServer 回调是 async,rejection 无人接管会成 unhandled rejection 崩掉
    // 整个 server(B1)。响应头已发,无法再回 JSON 错误,只能静默结束流。
    cleanup();
    return;
  }

  // 回放期间客户端可能已断连:此时 cleanup 已跑过,直接返回不再起心跳。
  if (closed || response.writableEnded) {
    cleanup();
    return;
  }

  // 8. 15s 心跳注释帧,interval unref(不阻止进程退出)。
  const heartbeatMs = input.heartbeatMs ?? 15_000;
  heartbeat = setInterval(() => {
    if (closed || response.writableEnded) {
      return;
    }
    response.write(': ping\n\n');
  }, heartbeatMs);
  if (typeof heartbeat.unref === 'function') {
    heartbeat.unref();
  }
}
