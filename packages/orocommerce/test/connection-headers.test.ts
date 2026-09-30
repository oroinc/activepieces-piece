import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppConnectionType } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { getConnectionHeaders, oroApiCall, parseHeaderJson, toHeaderRecord } from '../src/lib/common';
import { oroAuth } from '../src/lib/common/auth';

type Seen = { url: string; authorization?: string; xTest?: string };

let port = 0;
let server: ReturnType<typeof createServer>;
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      authorization: req.headers['authorization'],
      xTest: req.headers['x-test'] as string | undefined,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      req.url === '/oauth2-token'
        ? JSON.stringify({ access_token: 'CONNECTION-TOKEN', expires_in: 3600 })
        : JSON.stringify({ data: [] })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  seen.length = 0;
});

/** A distinct client secret per case keeps the token cache from carrying state between tests. */
function connection({ headers, secret }: { headers?: string; secret: string }) {
  return {
    type: AppConnectionType.CUSTOM_AUTH,
    props: {
      serverUrl: `http://127.0.0.1:${port}`,
      adminPrefix: 'admin',
      clientId: 'client-id',
      clientSecret: secret,
      headers,
      isInternalInfrastructure: false,
    },
  } as Parameters<typeof oroApiCall>[0]['auth'];
}

function apiCallHeaders(): Seen {
  const call = seen.find((entry) => entry.url.includes('regions'));
  if (!call) {
    throw new Error('the API call never reached the server');
  }
  return call;
}

describe('the connection keeps ownership of the Authorization header', () => {
  it('ignores an Authorization set in the connection defaults', async () => {
    await oroApiCall({
      method: HttpMethod.GET,
      resourceUri: 'regions/US-CA',
      auth: connection({
        secret: 'default-headers',
        headers: '{"Authorization":"Bearer SOMETHING-ELSE","X-Test":"kept"}',
      }),
    });

    expect(apiCallHeaders().authorization).toBe('Bearer CONNECTION-TOKEN');
    expect(apiCallHeaders().xTest).toBe('kept');
  });

  it('ignores it whatever the casing', async () => {
    await oroApiCall({
      method: HttpMethod.GET,
      resourceUri: 'regions/US-CA',
      auth: connection({
        secret: 'lower-case',
        headers: '{"authorization":"Bearer SOMETHING-ELSE"}',
      }),
    });

    expect(apiCallHeaders().authorization).toBe('Bearer CONNECTION-TOKEN');
  });

  it('ignores an Authorization set on the step', async () => {
    await oroApiCall({
      method: HttpMethod.GET,
      resourceUri: 'regions/US-CA',
      auth: connection({ secret: 'step-headers' }),
      headers: toHeaderRecord({ value: { Authorization: 'Bearer STEP', 'X-Test': 'kept' } }),
    });

    expect(apiCallHeaders().authorization).toBe('Bearer CONNECTION-TOKEN');
    expect(apiCallHeaders().xTest).toBe('kept');
  });

  it('ignores it even when a caller hands it straight to the client', async () => {
    await oroApiCall({
      method: HttpMethod.GET,
      resourceUri: 'regions/US-CA',
      auth: connection({ secret: 'raw-headers' }),
      headers: { AuThOrIzAtIoN: 'Bearer RAW' },
    });

    expect(apiCallHeaders().authorization).toBe('Bearer CONNECTION-TOKEN');
  });
});

describe('malformed Default HTTP Headers are reported, not dropped', () => {
  it('names the problem when the JSON does not parse', () => {
    expect(() => parseHeaderJson({ raw: '{not json at all' })).toThrow(/not valid JSON/);
  });

  it('names the problem when the JSON is not an object', () => {
    expect(() => parseHeaderJson({ raw: '["a","b"]' })).toThrow(/must be a JSON object/);
  });

  it('fails the call rather than sending it without the configured headers', async () => {
    await expect(
      oroApiCall({
        method: HttpMethod.GET,
        resourceUri: 'regions/US-CA',
        auth: connection({ secret: 'broken-json', headers: '{not json at all' }),
      })
    ).rejects.toThrow(/not valid JSON/);
  });

  it('treats an empty field as no headers', () => {
    expect(getConnectionHeaders({ auth: connection({ secret: 'empty', headers: '   ' }) })).toEqual({});
    expect(getConnectionHeaders({ auth: connection({ secret: 'absent' }) })).toEqual({});
  });
});

describe('validate() checks the header field before saving the connection', () => {
  const credentials = (headers?: string) => ({
    serverUrl: `http://127.0.0.1:${port}`,
    adminPrefix: 'admin',
    clientId: 'client-id',
    clientSecret: `validate-${headers ?? 'none'}`,
    headers,
    isInternalInfrastructure: false,
  });

  it('rejects header JSON that does not parse', async () => {
    const result = await oroAuth.validate({ auth: credentials('{not json at all') });

    expect(result).toEqual({ valid: false, error: expect.stringMatching(/not valid JSON/) });
  });

  it('rejects header JSON that is not an object', async () => {
    const result = await oroAuth.validate({ auth: credentials('["a","b"]') });

    expect(result).toEqual({ valid: false, error: expect.stringMatching(/must be a JSON object/) });
  });

  it('accepts a well-formed header object', async () => {
    const result = await oroAuth.validate({ auth: credentials('{"X-Test":"1"}') });

    expect(result).toEqual({ valid: true });
  });
});
