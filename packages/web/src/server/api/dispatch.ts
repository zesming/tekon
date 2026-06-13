import { ZodError } from 'zod';

import { procedureSpecs, type ProcedureName } from '../../shared/rpc-contract.js';
import type { ApiCaller } from './context.js';
import { ApiError } from './errors.js';

export async function dispatchApiCall(
  caller: ApiCaller,
  path: string,
  rawInput: unknown,
): Promise<unknown> {
  // 1. Exact path check against procedureSpecs (own-property only)
  if (!Object.prototype.hasOwnProperty.call(procedureSpecs, path)) {
    throw new ApiError('NOT_FOUND', `Unknown API procedure: ${path}`);
  }

  const spec = procedureSpecs[path as ProcedureName];

  // 2. Input validation via schema contract
  const parseResult = spec.input.safeParse(rawInput);
  if (!parseResult.success) {
    throw new ApiError(
      'BAD_REQUEST',
      `Invalid input for ${path}: ${parseResult.error.message}`,
    );
  }

  // 3. Route to handler
  const [namespace, procedure] = path.split('.');
  const router = caller[namespace as keyof ApiCaller] as
    | Record<string, (input?: unknown) => Promise<unknown>>
    | undefined;
  const handler = router?.[procedure ?? ''];
  if (!handler) {
    throw new ApiError('NOT_FOUND', `Handler not found: ${path}`);
  }

  const result = await handler(parseResult.data);

  // 4. Output validation — parse strips extra fields, enforcing the schema
  //    boundary. In production this is equally strict: a mismatch throws,
  //    which is the desired contract enforcement behaviour.
  try {
    return spec.output.parse(result);
  } catch (err) {
    if (err instanceof ZodError) {
      // This is a SERVER contract error, not a client input error
      throw new ApiError(
        'INTERNAL_ERROR',
        `Output schema mismatch for ${path}: ${err.message}`,
      );
    }
    throw err;
  }
}
