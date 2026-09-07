import type { Page, Route } from '@playwright/test';
import type { RpcProcedureMap } from '../../src/shared/rpc-contract.js';

type SessionList = RpcProcedureMap['session.list']['output'];
interface WorkspaceReads {
  connections: Array<{ frames: number; ended: boolean }>;
}
interface ListPublications {
  statuses: string[];
  staleError: boolean;
}
declare global {
  interface Window {
    __r24WorkspaceReads?: WorkspaceReads;
    __r24ListPublications?: ListPublications;
  }
}

export const STALE_LIST_ERROR = 'R24 迟到的列表查询失败';

/** 观察生产代码读到的真实 SSE 字节；原 fetch、reader 与读取结果全部透传。 */
export async function observeWorkspaceReads(page: Page) {
  await page.addInitScript(() => {
    const probe: WorkspaceReads = { connections: [] };
    window.__r24WorkspaceReads = probe;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const response = await nativeFetch(...args);
      const resource = args[0];
      const url = typeof resource === 'string'
        ? resource
        : resource instanceof URL ? resource.href : resource.url;
      if (
        !/\/api\/workspaces\/[^/]+\/summary\/events$/u.test(new URL(url, location.href).pathname) ||
        !response.ok ||
        !response.body ||
        !response.headers.get('content-type')?.includes('text/event-stream')
      ) return response;

      const connection = { frames: 0, ended: false };
      probe.connections.push(connection);
      const getReader = response.body.getReader.bind(response.body);
      response.body.getReader = (() => {
        const reader = getReader();
        const read = reader.read.bind(reader);
        const decoder = new TextDecoder();
        let pending = '';
        reader.read = async () => {
          try {
            const result = await read();
            if (result.done) {
              connection.ended = true;
            } else {
              pending += decoder.decode(result.value, { stream: true });
              let boundary: number;
              while ((boundary = pending.indexOf('\n\n')) !== -1) {
                const frame = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                if (/^data:/mu.test(frame)) connection.frames++;
              }
            }
            return result;
          } catch (error) {
            connection.ended = true;
            throw error;
          }
        };
        return reader;
      }) as typeof response.body.getReader;
      return response;
    };
  });
}

export function workspaceReads(page: Page): Promise<WorkspaceReads> {
  return page.evaluate(() => {
    const probe = window.__r24WorkspaceReads;
    if (!probe) throw new Error('尚未安装 R24 Workspace 读取观察器');
    return probe;
  });
}

/** 等待读取 continuation 与 React commit，不依赖任意固定毫秒延迟。 */
export async function settleBrowser(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/** 记录短暂 DOM 发布，避免只检查最终画面而漏掉迟到响应闪现。 */
export async function observeListPublications(page: Page, sessionId: string) {
  await page.evaluate(({ id, error }) => {
    const probe: ListPublications = { statuses: [], staleError: false };
    window.__r24ListPublications = probe;
    const observer = new MutationObserver(() => {
      const link = [...document.querySelectorAll('a.session-list-link')].find(
        (candidate) => candidate.getAttribute('href') === `/sessions/${id}`,
      );
      const status = link?.querySelector('.badge[title]')?.getAttribute('title');
      if (status) probe.statuses.push(status);
      if (document.body.textContent?.includes(error)) probe.staleError = true;
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['title'],
    });
  }, { id: sessionId, error: STALE_LIST_ERROR });
}

export function listPublications(page: Page): Promise<ListPublications> {
  return page.evaluate(() => {
    const probe = window.__r24ListPublications;
    if (!probe) throw new Error('尚未安装 R24 列表发布观察器');
    return probe;
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  // 清理阶段可能释放尚未被测试 await 的门；异常仍由原 Promise 和 route 暴露。
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * 先向生产 RPC 取得真实 SQLite 快照，再扣住发送。唯一故障注入是指定请求的 500；
 * 成功数据从不修改，后续查询也始终访问真实服务。
 */
export async function holdSessionListResponses(page: Page) {
  function makeHold(outcome: 'success' | '500') {
    const captured = deferred<SessionList>();
    const released = deferred<void>();
    const completed = deferred<void>();
    return { outcome, captured, released, completed };
  }
  const pending: ReturnType<typeof makeHold>[] = [];
  const holds: ReturnType<typeof makeHold>[] = [];
  const stats = { requests: 0, active: 0, maxActive: 0 };
  const handler = async (route: Route) => {
    if (route.request().postDataJSON().path !== 'session.list') return route.continue();
    const hold = pending.shift();
    stats.requests++;
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    let released = false;
    try {
      const response = await route.fetch();
      if (hold) {
        const body = (await response.json()) as { result: SessionList };
        hold.captured.resolve(body.result);
        await hold.released.promise;
      }
      // 发布操作前归还计数；浏览器收到字节后即可开始下一请求。
      stats.active--;
      released = true;
      if (hold?.outcome === '500') {
        await route.fulfill({
          status: 500,
          json: { error: { code: 'INTERNAL_ERROR', message: STALE_LIST_ERROR } },
        });
      } else {
        await route.fulfill({ response });
      }
      hold?.completed.resolve();
    } catch (error) {
      hold?.captured.reject(error);
      hold?.completed.reject(error);
      throw error;
    } finally {
      if (!released) stats.active--;
    }
  };
  await page.route('**/api/rpc', handler);
  return {
    stats,
    holdNext(outcome: 'success' | '500' = 'success') {
      const hold = makeHold(outcome);
      pending.push(hold);
      holds.push(hold);
      return {
        captured: hold.captured.promise,
        completed: hold.completed.promise,
        release: () => hold.released.resolve(),
      };
    },
    async close() {
      for (const hold of holds) hold.released.resolve();
      await page.unrouteAll({ behavior: 'wait' });
    },
  };
}
