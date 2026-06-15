import type { ProcedureName, RpcProcedureMap } from '../../shared/rpc-contract.js';

// ---------------------------------------------------------------------------
// Error class for API errors
// ---------------------------------------------------------------------------

export class ApiClientError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Session token management
// ---------------------------------------------------------------------------

let rpcSessionToken: string | null = null;

/**
 * Set the session token used for authenticated RPC calls.
 * Called by AuthProvider when the user enters/changes the token.
 */
export function setRpcSessionToken(token: string | null): void {
  rpcSessionToken = token;
}

// ---------------------------------------------------------------------------
// Server response shapes
// ---------------------------------------------------------------------------

interface RpcSuccessResponse<T> {
  result: T;
}

interface RpcErrorResponse {
  error: { code: string; message: string };
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiClientError(
      'PARSE_ERROR',
      `Failed to parse JSON response: ${text.slice(0, 200)}`,
    );
  }
}

export const rpc = {
  async call<P extends ProcedureName>(
    procedure: P,
    ...args: RpcProcedureMap[P]['input'] extends undefined
      ? []
      : [input: RpcProcedureMap[P]['input']]
  ): Promise<RpcProcedureMap[P]['output']> {
    const input = args[0];

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (rpcSessionToken) {
      headers['x-session-token'] = rpcSessionToken;
    }

    const response = await fetch('/api/rpc', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: procedure, input }),
    });

    if (!response.ok) {
      const body = await parseJsonResponse<RpcErrorResponse>(response);
      const err = body.error ?? { code: 'UNKNOWN', message: 'Unknown error' };
      throw new ApiClientError(err.code, err.message);
    }

    const body = await parseJsonResponse<RpcSuccessResponse<RpcProcedureMap[P]['output']>>(response);
    return body.result;
  },
};
