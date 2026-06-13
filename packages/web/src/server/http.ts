import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createApiCaller,
  dispatchApiCall,
  type ApiCaller,
} from './api/root.js';
import { ApiError } from './api/errors.js';
import { procedureSpecs, type ProcedureName } from '../shared/rpc-contract.js';
import { resolveProjectRoot } from './project-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CreateWebServerOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  port?: number;
  host?: string;
  vite?: boolean;
  /** Override the static asset directory (defaults to ../../dist relative to this module). */
  distDir?: string;
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
  const api = await createApiCaller({ projectRoot, env: options.env });
  const vite = options.vite ? await createViteMiddleware() : null;
  const distDir = options.distDir ?? resolve(__dirname, '../../dist');
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);

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

    if (request.url?.startsWith('/assets/') && !vite) {
      let urlPath: string;
      try {
        urlPath = decodeURIComponent(request.url.slice(1));
      } catch {
        response.statusCode = 400;
        response.end('Bad request: malformed URL encoding');
        return;
      }

      // Reject path traversal attempts before normalization resolves them
      if (urlPath.includes('..')) {
        response.statusCode = 400;
        response.end('Bad request');
        return;
      }

      const normalizedPath = normalize(urlPath);

      // Reject absolute paths
      if (normalizedPath.startsWith('/')) {
        response.statusCode = 400;
        response.end('Bad request');
        return;
      }

      const assetPath = resolve(distDir, normalizedPath);

      // Verify resolved path is within distDir
      if (!assetPath.startsWith(distDir + '/') && assetPath !== distDir) {
        response.statusCode = 400;
        response.end('Bad request');
        return;
      }

      // Reject symlinks and verify real path stays within distDir
      let realDistDir: string;
      try {
        realDistDir = realpathSync(distDir);
      } catch {
        response.statusCode = 404;
        response.end('Not found');
        return;
      }

      try {
        const stat = lstatSync(assetPath);
        if (stat.isSymbolicLink()) {
          response.statusCode = 400;
          response.end('Bad request');
          return;
        }
        const realPath = realpathSync(assetPath);
        if (!realPath.startsWith(realDistDir + '/')) {
          response.statusCode = 400;
          response.end('Bad request');
          return;
        }
      } catch {
        // File doesn't exist — fall through to serveProductionHtml
      }

      if (existsSync(assetPath)) {
        const ext = assetPath.split('.').pop();
        const contentTypes: Record<string, string> = {
          js: 'application/javascript',
          css: 'text/css',
          html: 'text/html',
          svg: 'image/svg+xml',
        };
        response.setHeader(
          'content-type',
          contentTypes[ext || ''] || 'application/octet-stream',
        );
        response.setHeader(
          'cache-control',
          'public, max-age=31536000, immutable',
        );
        response.end(readFileSync(assetPath));
        return;
      }
    }

    if (!serveProductionHtml(response, distDir)) {
      response.statusCode = 404;
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('Not found — build the frontend first (pnpm build)');
    }
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

    // Origin + Sec-Fetch-Site check for mutation (token-auth) procedures
    const spec = procedureSpecs[body.path as ProcedureName];
    if (spec && spec.auth === 'token') {
      assertRequestAllowed(input.request);
    }

    const result = await dispatchApiCall(input.api, body.path, body.input);
    writeJson(input.response, 200, { result });
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'BAD_REQUEST';
    const status =
      code === 'UNAUTHORIZED'
        ? 401
        : code === 'NOT_FOUND'
          ? 404
          : code === 'INTERNAL_ERROR'
            ? 500
            : 400;
    writeJson(input.response, status, {
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += buf.length;
    if (totalSize > MAX_BODY_SIZE) {
      throw new ApiError('BAD_REQUEST', 'Request body too large');
    }
    chunks.push(buf);
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

function serveProductionHtml(response: ServerResponse, distDir: string): boolean {
  const indexPath = resolve(distDir, 'index.html');
  if (!existsSync(indexPath)) {
    return false;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(readFileSync(indexPath, 'utf8'));
  return true;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  // CSP: allow self for scripts/styles, inline styles for Vite dev
  const csp =
    process.env.NODE_ENV === 'production'
      ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
      : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'";
  response.setHeader('Content-Security-Policy', csp);
}

function assertOriginAllowed(request: IncomingMessage): void {
  const origin = request.headers.origin;
  if (!origin) {
    // Missing Origin is allowed (local CLI / test requests)
    return;
  }
  const host = request.headers.host;
  if (host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host === host) {
        return;
      }
    } catch {
      // Malformed origin — fall through to reject
    }
  }
  throw new ApiError('BAD_REQUEST', 'Origin not allowed');
}

function assertRequestAllowed(request: IncomingMessage): void {
  // Existing origin check
  assertOriginAllowed(request);

  // Sec-Fetch-Site check
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    throw new ApiError('BAD_REQUEST', 'Cross-site requests are not allowed');
  }
  // Allow: same-origin, same-site, none (CLI/test requests)
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
