import { describe, expect, it } from 'vitest';

import { redactObject, redactString, redactTextPreview } from '../../src/server/api/redaction.js';

describe('redactTextPreview', () => {
  it('redacts token=value patterns without leaking the original value', () => {
    const input = 'token=abc123';
    const output = redactTextPreview(input);
    expect(output).toBe('token=[REDACTED]');
    expect(output).not.toContain('abc123');
  });

  it('redacts password: value patterns', () => {
    const input = 'password: hunter2';
    const output = redactTextPreview(input);
    expect(output).toBe('password: [REDACTED]');
    expect(output).not.toContain('hunter2');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig';
    const output = redactTextPreview(input);
    expect(output).toBe('Authorization: Bearer [REDACTED]');
    expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload.sig');
  });

  it('redacts --token value in command lines while preserving surrounding args', () => {
    const input = 'command --token mysecret --verbose';
    const output = redactTextPreview(input);
    expect(output).toBe('command --token [REDACTED] --verbose');
    expect(output).not.toContain('mysecret');
    expect(output).toContain('--verbose');
  });

  it('redacts multiple secrets in the same text', () => {
    const input = 'secret=mysecret and also apiKey=key123';
    const output = redactTextPreview(input);
    expect(output).toBe('secret=[REDACTED] and also apiKey=[REDACTED]');
    expect(output).not.toContain('mysecret');
    expect(output).not.toContain('key123');
  });

  it('leaves normal text without secrets unchanged', () => {
    const input = 'Hello, this is a normal message with no secrets.';
    const output = redactTextPreview(input);
    expect(output).toBe(input);
  });

  it('does not leak any original secret values in the output', () => {
    const secrets = ['superSecretToken', 'p@ssw0rd!', 'apiKeyValue99'];
    const input = `token=${secrets[0]} password=${secrets[1]} apiKey=${secrets[2]}`;
    const output = redactTextPreview(input);
    for (const secret of secrets) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[REDACTED]');
  });

  it('truncates to maxLength before redacting', () => {
    const input = 'token=short';
    const output = redactTextPreview(input, 5);
    expect(output.length).toBeLessThanOrEqual(30); // truncated then redacted
    expect(output).not.toContain('short');
  });

  it('handles case-insensitive key matching', () => {
    const input = 'TOKEN=abc123';
    const output = redactTextPreview(input);
    expect(output).toBe('TOKEN=[REDACTED]');
    expect(output).not.toContain('abc123');
  });

  it('redacts --password and --api-key CLI flags', () => {
    const input = 'deploy --password s3cret --api-key ak123 --region us-east';
    const output = redactTextPreview(input);
    expect(output).not.toContain('s3cret');
    expect(output).not.toContain('ak123');
    expect(output).toContain('--password [REDACTED]');
    expect(output).toContain('--api-key [REDACTED]');
    expect(output).toContain('--region us-east');
  });
});

describe('redactString', () => {
  it('redacts token=value patterns', () => {
    expect(redactString('token=abc123')).toBe('token=[REDACTED]');
  });

  it('redacts password: value patterns', () => {
    expect(redactString('password: hunter2')).toBe('password: [REDACTED]');
  });

  it('redacts Bearer tokens', () => {
    expect(redactString('Bearer eyJhbG...')).toBe('Bearer [REDACTED]');
  });

  it('redacts --token CLI flags', () => {
    const output = redactString('deploy --token mysecret');
    expect(output).toBe('deploy --token [REDACTED]');
    expect(output).not.toContain('mysecret');
  });

  it('redacts --password and --secret CLI flags', () => {
    const output = redactString('run --password pw1 --secret s1');
    expect(output).not.toContain('pw1');
    expect(output).not.toContain('s1');
  });

  it('leaves normal text unchanged', () => {
    expect(redactString('Hello world')).toBe('Hello world');
  });

  it('handles multiple secrets in one string', () => {
    const output = redactString('token=a password=b secret=c');
    expect(output).not.toContain('token=a');
    expect(output).not.toContain('password=b');
    expect(output).not.toContain('secret=c');
    expect(output).toContain('[REDACTED]');
  });

  it('is case-insensitive on key names', () => {
    expect(redactString('TOKEN=abc')).toBe('TOKEN=[REDACTED]');
    expect(redactString('Password: x')).toBe('Password: [REDACTED]');
    expect(redactString('SECRET=top')).toBe('SECRET=[REDACTED]');
  });
});

describe('redactObject', () => {
  it('replaces sensitive key values with [REDACTED] (exact lowercase)', () => {
    const output = redactObject({ token: 'abc123', name: 'test' }) as Record<string, unknown>;
    expect(output.token).toBe('[REDACTED]');
    expect(output.name).toBe('test');
  });

  it('case-insensitive key matching: Token, TOKEN, API_KEY', () => {
    const output = redactObject({ Token: 'a', TOKEN: 'b', API_KEY: 'c', Api_Key: 'd' }) as Record<string, unknown>;
    expect(output.Token).toBe('[REDACTED]');
    expect(output.TOKEN).toBe('[REDACTED]');
    expect(output.API_KEY).toBe('[REDACTED]');
    expect(output.Api_Key).toBe('[REDACTED]');
  });

  it('redacts artifact.summary containing token=abc123', () => {
    const input = {
      id: 'artifact-1',
      summary: 'Build used token=abc123 for authentication',
      type: 'report',
    };
    const output = redactObject(input) as Record<string, unknown>;
    expect(output.summary).not.toContain('abc123');
    expect(output.summary).toContain('token=[REDACTED]');
  });

  it('redacts HumanDecision.note containing password: hunter2', () => {
    const input = {
      id: 'decision-1',
      note: 'User configured password: hunter2 for the service account',
      status: 'pending',
    };
    const output = redactObject(input) as Record<string, unknown>;
    expect(output.note).not.toContain('hunter2');
    expect(output.note).toContain('password: [REDACTED]');
  });

  it('redacts audit payload containing Authorization: Bearer xyz', () => {
    const input = {
      payload: {
        headers: 'Authorization: Bearer xyz.secret.token',
        action: 'deploy',
      },
    };
    const output = redactObject(input) as { payload: Record<string, unknown> };
    expect(output.payload.headers).not.toContain('xyz.secret.token');
    expect(output.payload.headers).toContain('Bearer [REDACTED]');
    expect(output.payload.action).toBe('deploy');
  });

  it('redacts nextCommands containing --token mysecret', () => {
    const input = {
      nextCommands: ['deploy --token mysecret --verbose', 'status check'],
    };
    const output = redactObject(input) as { nextCommands: string[] };
    expect(output.nextCommands[0]).not.toContain('mysecret');
    expect(output.nextCommands[0]).toContain('--token [REDACTED]');
    expect(output.nextCommands[0]).toContain('--verbose');
    expect(output.nextCommands[1]).toBe('status check');
  });

  it('recursively redacts deeply nested objects', () => {
    const input = {
      level1: {
        level2: {
          message: 'secret=topsecret in this text',
          apiKey: 'should-be-fully-redacted',
          level3: {
            deepNote: 'password=p@ss running here',
          },
        },
      },
    };
    const output = redactObject(input) as Record<string, unknown>;
    const l1 = output.level1 as Record<string, unknown>;
    const l2 = l1.level2 as Record<string, unknown>;
    const l3 = l2.level3 as Record<string, unknown>;
    expect(l2.message).toContain('secret=[REDACTED]');
    expect(l2.message).not.toContain('topsecret');
    expect(l2.apiKey).toBe('[REDACTED]');
    expect(l3.deepNote).toContain('password=[REDACTED]');
    expect(l3.deepNote).not.toContain('p@ss');
  });

  it('handles null, undefined, numbers, booleans', () => {
    expect(redactObject(null)).toBeNull();
    expect(redactObject(undefined)).toBeUndefined();
    expect(redactObject(42)).toBe(42);
    expect(redactObject(true)).toBe(true);
    expect(redactObject(false)).toBe(false);
  });

  it('handles arrays recursively', () => {
    const input = [
      { token: 'secret-val', label: 'ok' },
      { text: 'password: x' },
    ];
    const output = redactObject(input) as Array<Record<string, unknown>>;
    expect(output[0].token).toBe('[REDACTED]');
    expect(output[0].label).toBe('ok');
    expect(output[1].text).not.toContain('x');
    expect(output[1].text).toContain('password: [REDACTED]');
  });

  it('handles empty objects and arrays', () => {
    expect(redactObject({})).toEqual({});
    expect(redactObject([])).toEqual([]);
  });

  it('redacts strings at the top level', () => {
    expect(redactObject('token=leaked')).toBe('token=[REDACTED]');
    expect(redactObject('safe message')).toBe('safe message');
  });

  it('redacts mixed nested types: objects containing arrays containing strings', () => {
    const input = {
      items: [
        'normal string',
        'has token=secret123 embedded',
        { nested: 'Bearer abc.def.ghi' },
      ],
    };
    const output = redactObject(input) as { items: Array<unknown> };
    expect(output.items[0]).toBe('normal string');
    expect(output.items[1]).not.toContain('secret123');
    expect((output.items[1] as string)).toContain('token=[REDACTED]');
    expect((output.items[2] as Record<string, unknown>).nested).not.toContain('abc.def.ghi');
  });

  it('is idempotent: applying twice produces the same result', () => {
    const input = { token: 'abc', note: 'password: x', nested: { apiKey: 'key' } };
    const once = redactObject(input);
    const twice = redactObject(once);
    expect(twice).toEqual(once);
  });

  it('redacts all sensitive key variants: accessToken, access_token, refreshToken, etc.', () => {
    const input = {
      accessToken: 'at',
      access_token: 'at2',
      refreshToken: 'rt',
      refresh_token: 'rt2',
      privateKey: 'pk',
      private_key: 'pk2',
      passwd: 'pw',
      pwd: 'pw2',
      session: 's',
      cookie: 'c',
      secret: 's2',
    };
    const output = redactObject(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      expect(output[key]).toBe('[REDACTED]');
    }
  });
});

describe('redactString – integration (codex review gaps)', () => {
  it('redacts JSON-formatted secrets: {"token":"abc123"}', () => {
    const input = '{"token":"abc123"}';
    const output = redactString(input);
    expect(output).not.toContain('abc123');
    expect(output).toContain('"token":"[REDACTED]"');
  });

  it('redacts JSON-formatted secrets with spaces: {"token": "abc123"}', () => {
    const input = '{"token": "abc123"}';
    const output = redactString(input);
    expect(output).not.toContain('abc123');
    expect(output).toContain('"token": "[REDACTED]"');
  });

  it('redacts Authorization: Basic credentials', () => {
    const input = 'Authorization: Basic dXNlcjpwYXNz';
    const output = redactString(input);
    expect(output).not.toContain('dXNlcjpwYXNz');
    expect(output).toContain('Basic [REDACTED]');
  });

  it('redacts hyphenated key=value: api-key=sk-abc123', () => {
    const input = 'api-key=sk-abc123';
    const output = redactString(input);
    expect(output).not.toContain('sk-abc123');
    expect(output).toContain('api-key=[REDACTED]');
  });

  it('redacts other hyphenated key=value patterns: access-token, refresh-token, private-key', () => {
    const output1 = redactString('access-token=at-secret');
    expect(output1).not.toContain('at-secret');
    expect(output1).toContain('access-token=[REDACTED]');

    const output2 = redactString('refresh-token=rt-secret');
    expect(output2).not.toContain('rt-secret');
    expect(output2).toContain('refresh-token=[REDACTED]');

    const output3 = redactString('private-key=pk-secret');
    expect(output3).not.toContain('pk-secret');
    expect(output3).toContain('private-key=[REDACTED]');
  });

  it('redacts --api-key and --auth CLI flags', () => {
    const output1 = redactString('deploy --api-key mykey123');
    expect(output1).not.toContain('mykey123');
    expect(output1).toContain('--api-key [REDACTED]');

    const output2 = redactString('run --auth bearer-token-value');
    expect(output2).not.toContain('bearer-token-value');
    expect(output2).toContain('--auth [REDACTED]');
  });

  it('redacts multiple JSON secrets in one string', () => {
    const input = '{"token":"tok123","password":"pass456","api-key":"ak789"}';
    const output = redactString(input);
    expect(output).not.toContain('tok123');
    expect(output).not.toContain('pass456');
    expect(output).not.toContain('ak789');
  });
});

describe('redactObject – integration (codex review gaps)', () => {
  it('recursively redacts a nested object containing secrets in string values', () => {
    const input = {
      config: {
        auth: {
          header: 'Authorization: Basic dXNlcjpwYXNz',
          note: 'using api-key=sk-live-abc',
        },
        raw: '{"token":"embedded-secret"}',
      },
      label: 'safe-value',
    };
    const output = redactObject(input) as Record<string, unknown>;
    const config = output.config as Record<string, unknown>;
    const auth = config.auth as Record<string, unknown>;
    expect(auth.header).not.toContain('dXNlcjpwYXNz');
    expect(auth.header).toContain('Basic [REDACTED]');
    expect(auth.note).not.toContain('sk-live-abc');
    expect(auth.note).toContain('api-key=[REDACTED]');
    expect(config.raw).not.toContain('embedded-secret');
    expect(output.label).toBe('safe-value');
  });

  it('redacts a mock artifact.summary containing JSON secrets and Basic auth', () => {
    const input = {
      id: 'artifact-42',
      summary: 'Authenticated with {"token":"abc123"} and Authorization: Basic dXNlcjpwYXNz',
      type: 'build',
    };
    const output = redactObject(input) as Record<string, unknown>;
    expect(output.summary).not.toContain('abc123');
    expect(output.summary).not.toContain('dXNlcjpwYXNz');
    expect(output.summary).toContain('"token":"[REDACTED]"');
    expect(output.summary).toContain('Basic [REDACTED]');
  });

  it('redacts a mock audit payload with nested secrets including hyphenated keys', () => {
    const input = {
      auditId: 'audit-99',
      payload: {
        headers: {
          authorization: 'Basic YWRtaW46c2VjcmV0',
          'x-api-key': 'api-key=sk-prod-xyz',
        },
        body: '{"password":"p@ssw0rd","access-token":"at-leaked"}',
        metadata: { note: 'deployed with --auth secret-flag' },
      },
    };
    const output = redactObject(input) as Record<string, unknown>;
    const payload = output.payload as Record<string, unknown>;
    const headers = payload.headers as Record<string, unknown>;
    // authorization key is sensitive → fully redacted
    expect(headers.authorization).toBe('[REDACTED]');
    // x-api-key is a sensitive key, so its value is fully replaced with [REDACTED]
    expect(headers['x-api-key']).toBe('[REDACTED]');
    expect(headers['x-api-key']).not.toContain('sk-prod-xyz');
    // body is a string containing JSON secrets
    expect(payload.body).not.toContain('p@ssw0rd');
    expect(payload.body).not.toContain('at-leaked');
    // metadata note contains CLI flag
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.note).not.toContain('secret-flag');
    expect(metadata.note).toContain('--auth [REDACTED]');
  });
});
