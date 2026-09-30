import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppConnectionType } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { customApiCallAction } from '../src/lib/actions/api-call';

let port = 0;
let server: ReturnType<typeof createServer>;

/** The token the server currently honours. Rotating it stands in for Oro ending a session early. */
let acceptedToken = '';
let issuedTokens = 0;
let log: string[] = [];
/** When set, even a freshly issued token is refused, so the retry fails too. */
let refuseEveryToken = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/oauth2-token') {
      issuedTokens += 1;
      acceptedToken = `TOKEN-${issuedTokens}`;
      log.push(`issued ${acceptedToken}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: acceptedToken, expires_in: 3600 }));
    }

    const presented = String(req.headers['authorization'] ?? '').replace('Bearer ', '');
    const status =
      refuseEveryToken || presented !== acceptedToken
        ? 401
        : (req.url ?? '').includes('/nope')
          ? 404
          : 200;
    log.push(`call with ${presented} -> ${status}`);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        status === 200 ? { data: [] } : { errors: [{ title: status === 401 ? 'token expired' : 'not found' }] }
      )
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  log = [];
  refuseEveryToken = false;
});

/** A distinct secret per case gives each its own entry in the shared token cache. */
function runAction({
  secret,
  failsafe = false,
  path = '/regions',
}: {
  secret: string;
  failsafe?: boolean;
  path?: string;
}) {
  const context = {
    auth: {
      type: AppConnectionType.CUSTOM_AUTH,
      props: {
        serverUrl: `http://127.0.0.1:${port}`,
        adminPrefix: 'admin',
        clientId: 'client-id',
        clientSecret: secret,
        isInternalInfrastructure: false,
      },
    },
    propsValue: {
      url: { url: `http://127.0.0.1:${port}/admin/api${path}` },
      method: HttpMethod.GET,
      headers: {},
      queryParams: {},
      body_type: 'none',
      body: undefined,
      failsafe,
      timeout: 0,
      response_is_binary: false,
      followRedirects: false,
    },
    files: { write: async () => '' },
  };

  return (customApiCallAction.run as (input: unknown) => Promise<unknown>)(context);
}

function issuedDuringRun(): number {
  return log.filter((entry) => entry.startsWith('issued')).length;
}

describe('Custom API Call recovers from a token Oro ended early', () => {
  it('re-authenticates once and succeeds', async () => {
    await runAction({ secret: 'recovers' });
    // Oro ends the session behind our back; the cached token is now worthless.
    acceptedToken = 'ROTATED-SERVER-SIDE';
    log = [];

    const result = (await runAction({ secret: 'recovers' })) as { status: number };

    expect(result.status).toBe(200);
    expect(issuedDuringRun()).toBe(1);
    expect(log).toEqual([
      'call with TOKEN-1 -> 401',
      'issued TOKEN-2',
      'call with TOKEN-2 -> 200',
    ]);
  });

  it('does not re-authenticate when the first call is fine', async () => {
    await runAction({ secret: 'happy-path' });
    log = [];

    await runAction({ secret: 'happy-path' });

    expect(issuedDuringRun()).toBe(0);
    expect(log).toHaveLength(1);
  });

  it('recovers too when the step returns errors as output', async () => {
    await runAction({ secret: 'failsafe', failsafe: true });
    acceptedToken = 'ROTATED-SERVER-SIDE';
    log = [];

    const result = (await runAction({ secret: 'failsafe', failsafe: true })) as { status: number };

    expect(result.status).toBe(200);
    expect(issuedDuringRun()).toBe(1);
  });

  it('gives up after one retry and reports the failure in the piece format', async () => {
    await runAction({ secret: 'always-401' });
    // Nothing the piece can present will be accepted, so the retry fails as well.
    refuseEveryToken = true;
    log = [];

    await expect(runAction({ secret: 'always-401' })).rejects.toThrow(
      /^OroCommerce API Error \(401\)/
    );
    expect(issuedDuringRun()).toBe(1);
  });

  it('passes a non-401 failure straight through, in the piece format', async () => {
    await expect(runAction({ secret: 'not-found', path: '/nope' })).rejects.toThrow(
      /^OroCommerce API Error \(404\)/
    );
    // A 404 is the server's answer, not a token problem, so nothing is re-requested.
    expect(issuedDuringRun()).toBe(1);
    expect(log.filter((entry) => entry.includes('-> 404'))).toHaveLength(1);
  });

  it('wraps run and test alike, so testing a step recovers as well', () => {
    expect(customApiCallAction.test).toBe(customApiCallAction.run);
  });
});
