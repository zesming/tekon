import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createApiCaller,
  dispatchApiCall,
  type ApiCaller,
} from './api/root.js';
import { ApiError } from './api/errors.js';
import { resolveProjectRoot } from './project-context.js';

export interface CreateWebServerOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  port?: number;
  host?: string;
  vite?: boolean;
}

export interface RunningWebServer {
  readonly url: string;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export async function createWebServer(
  options: CreateWebServerOptions,
): Promise<RunningWebServer> {
  const projectRoot = resolveProjectRoot(options);
  const api = await createApiCaller({ projectRoot });
  const vite = options.vite ? await createViteMiddleware() : null;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/api/rpc')) {
      await handleRpc({ api, request, response });
      return;
    }

    if (vite) {
      vite.middlewares(request, response, () => {
        response.statusCode = 404;
        response.end('Not found');
      });
      return;
    }

    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(renderFallbackHtml());
  });

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3000;
  let url = `http://${host}:${port}`;

  return {
    get url() {
      return url;
    },

    async listen() {
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          if (address && typeof address === 'object') {
            url = `http://${host}:${address.port}`;
          }
          resolveListen();
        });
      });
    },

    async close() {
      await api.close();
      await vite?.close();
      await closeServer(server);
    },
  };
}

async function handleRpc(input: {
  api: ApiCaller;
  request: IncomingMessage;
  response: ServerResponse;
}): Promise<void> {
  if (input.request.method !== 'POST') {
    writeJson(input.response, 405, {
      error: { code: 'BAD_REQUEST', message: 'Only POST is supported' },
    });
    return;
  }

  try {
    const body = (await readJson(input.request)) as {
      path?: unknown;
      input?: unknown;
    };
    if (typeof body.path !== 'string') {
      throw new ApiError('BAD_REQUEST', 'RPC path is required');
    }
    const result = await dispatchApiCall(input.api, body.path, body.input);
    writeJson(input.response, 200, { result });
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'BAD_REQUEST';
    const status =
      code === 'UNAUTHORIZED' ? 401 : code === 'NOT_FOUND' ? 404 : 400;
    writeJson(input.response, status, {
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length === 0 ? {} : JSON.parse(raw);
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

async function createViteMiddleware() {
  const { createServer: createViteServer } = await import('vite');
  return createViteServer({
    root: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    server: { hmr: false, middlewareMode: true },
    appType: 'spa',
    logLevel: 'error',
  });
}

function renderFallbackHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8" /><title>Tekon Web</title></head>',
    '<body><main><h1>Tekon Web</h1></main></body>',
    '</html>',
  ].join('');
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  server.closeIdleConnections?.();
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolveClose();
    });
    server.closeAllConnections?.();
  });
}
