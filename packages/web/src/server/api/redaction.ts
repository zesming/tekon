const SENSITIVE_KEYS_LOWER = new Set([
  'apikey', 'api_key', 'api-key', 'token', 'secret', 'password', 'passwd', 'pwd',
  'authorization', 'cookie', 'session', 'accesstoken', 'access_token', 'access-token',
  'refreshtoken', 'refresh_token', 'refresh-token', 'privatekey', 'private_key', 'private-key',
  'x-api-key', 'x_api_key', 'x-api-token',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS_LOWER.has(key.toLowerCase());
}

/**
 * Applies all secret-pattern redactions to an arbitrary string value.
 * Used by redactObject to redact ALL string values (not just sensitive-keyed ones).
 */
export function redactString(text: string): string {
  let result = text;
  // 1. Auth schemes FIRST: Bearer, Basic, ApiKey, Token, Digest + their credentials
  //    This handles "Authorization: Bearer xxx" and standalone "Bearer xxx"
  result = result.replace(/((?:Bearer|Basic|ApiKey|Token|Digest)\s+)\S+/gi, '$1[REDACTED]');
  // 2. Key=value and key: value (authorization excluded — step 1 already handled it)
  result = result.replace(
    /((?:token|password|passwd|pwd|secret|apiKey|api[_-]key|access[_-]token|refresh[_-]token|cookie|session|private[_-]key|auth|credentials?)\s*[:=]\s*)\S+/gi,
    '$1[REDACTED]'
  );
  // 3. Env-var style keys: *_KEY, *_TOKEN, *_SECRET (UPPERCASE)
  result = result.replace(
    /([A-Z_]{2,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS?)(?:\s*[:=]\s*))\S+/g,
    '$1[REDACTED]'
  );
  // 4. Lowercase env-var style: *_key, *_token, *_secret
  result = result.replace(
    /([a-z][a-z_]*(?:_key|_token|_secret|_password|_passwd|_credentials?)(?:\s*[:=]\s*))\S+/g,
    '$1[REDACTED]'
  );
  // 5. Raw OpenAI-style keys: sk-..., key-...
  result = result.replace(/\b(?:sk|key)[-_][A-Za-z0-9]{16,}\b/g, '[REDACTED]');
  // 6. Command-line args: --token value, --api-key value
  result = result.replace(
    /(--(?:token|password|secret|api-key|api_key|access-token|auth|authorization)\s+)\S+/gi,
    '$1[REDACTED]'
  );
  // 7. JSON-style: "token":"value"
  result = result.replace(
    /("(?:token|password|passwd|pwd|secret|apiKey|api_key|api-key|access_token|access-token|refresh_token|refresh-token|authorization|cookie|session|private_key|private-key|auth|credentials?)"\s*:\s*)"[^"]*"/gi,
    '$1"[REDACTED]"'
  );
  return result;
}

/**
 * Recursively redacts all values in an object tree:
 * - Sensitive keys (case-insensitive) are fully replaced with '[REDACTED]'
 * - All other string values have secret-pattern redaction applied
 * - Non-string primitives (number, boolean) pass through unchanged
 */
export function redactObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactString(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return obj;
  if (Array.isArray(obj)) return obj.map(redactObject);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = redactObject(value);
      }
    }
    return result;
  }
  return obj;
}

/**
 * Truncates text to maxLength, then applies all secret-pattern redactions.
 * Use for large content fields where both size-limiting and redaction are needed.
 */
export function redactTextPreview(text: string, maxLength = 1600): string {
  const redacted = redactString(text);
  return redacted.slice(0, maxLength);
}
