import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { AppConnectionType, createMockActionContext } from '@activepieces/pieces-framework';
import { HttpError, HttpMethod } from '@activepieces/pieces-common';
import { customApiCallAction } from '../src/lib/actions/api-call';
import { createCustomerAction } from '../src/lib/actions/create-customer';
import { oroApiCall } from '../src/lib/common';
import { oroAuth } from '../src/lib/common/auth';
import { failureLine, withFailureLog } from '../src/lib/common/request-log';

const CLIENT_ID = 'client-id-request-log';
const CUSTOMER_NAME = 'Customer name from the request body';
const QUERY_VALUE = 'filter-value-from-the-query';
const URL_QUERY_VALUE = 'filter-value-in-the-url';

/** Everything a failure line must never hold, whatever failed. */
function leaks({ line, secret }: { line: string; secret: string }): string[] {
  return [
    secret,
    CLIENT_ID,
    'client_secret',
    'client_id',
    'grant_type',
    CUSTOMER_NAME,
    QUERY_VALUE,
    URL_QUERY_VALUE,
    '?',
    'Bearer',
    'TOKEN-',
  ].filter((needle) => line.includes(needle));
}

let port = 0;
let server: ReturnType<typeof createServer>;
let tokenStatus = 200;
let issuedTokens = 0;
/** The token the server currently honours. Rotating it stands in for Oro ending a session early. */
let acceptedToken = '';
let received: string[] = [];

let certDir = '';
let httpsPort = 0;
let httpsServer: ReturnType<typeof createHttpsServer>;

/** A port nothing listens on: bound once, then released. */
let closedPort = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    received.push(`${req.method} ${req.url}`);
    if (req.url === '/oauth2-token') {
      if (tokenStatus !== 200) {
        res.writeHead(tokenStatus, { 'content-type': 'text/html' });
        return res.end('<html><body>No token today</body></html>');
      }
      issuedTokens += 1;
      acceptedToken = `TOKEN-${issuedTokens}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: acceptedToken, expires_in: 3600 }));
    }
    if (req.url?.startsWith('/admin/api/slow')) {
      return; // Never answers, so the request runs into its timeout.
    }
    const presented = String(req.headers['authorization'] ?? '').replace('Bearer ', '');
    if (presented !== acceptedToken) {
      res.writeHead(401, { 'content-type': 'application/vnd.api+json' });
      return res.end(JSON.stringify({ errors: [{ title: 'token expired' }] }));
    }
    if (req.url === '/admin/api/customers') {
      res.writeHead(500, { 'content-type': 'application/vnd.api+json' });
      return res.end(JSON.stringify({ errors: [{ status: '500', title: 'Internal error' }] }));
    }
    if (req.url?.startsWith('/admin/api/regions')) {
      res.writeHead(404, { 'content-type': 'application/vnd.api+json' });
      return res.end(JSON.stringify({ errors: [{ status: '404', title: 'Not found' }] }));
    }
    res.writeHead(200, { 'content-type': 'application/vnd.api+json' });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;

  certDir = mkdtempSync(join(tmpdir(), 'oro-request-log-'));
  const cert = join(certDir, 'server.pem');
  const key = join(certDir, 'server.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', key, '-out', cert, '-subj', '/CN=localhost'], { stdio: 'pipe' });
  httpsServer = createHttpsServer(
    { cert: readFileSync(cert), key: readFileSync(key) },
    (_req, res) => {
      res.writeHead(200);
      res.end('{}');
    }
  );
  await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
  httpsPort = (httpsServer.address() as { port: number }).port;

  const released = createServer();
  await new Promise<void>((resolve) => released.listen(0, '127.0.0.1', resolve));
  closedPort = (released.address() as { port: number }).port;
  await new Promise<void>((resolve) => released.close(() => resolve()));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
  rmSync(certDir, { recursive: true, force: true });
});

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  tokenStatus = 200;
  received = [];
  // Silences the print upstream's client still has in the sources; the artifact has it removed.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

/** The lines this piece wrote, as the engine forwards them: its arguments joined by a space. */
function loggedLines(): string[] {
  return consoleError.mock.calls
    .filter(([first]) => typeof first === 'string' && first.startsWith('[OroCommerce]'))
    .map((args) => {
      expect(args).toHaveLength(1);
      return args.join(' ');
    });
}

function connectionProps({ secret, serverUrl }: { secret: string; serverUrl?: string }) {
  return {
    serverUrl: serverUrl ?? `http://127.0.0.1:${port}`,
    adminPrefix: 'admin',
    clientId: CLIENT_ID,
    clientSecret: secret,
    isInternalInfrastructure: false,
  };
}

/** A distinct secret per case gives each its own entry in the shared token cache. */
function connection({ secret, serverUrl }: { secret: string; serverUrl?: string }) {
  return {
    type: AppConnectionType.CUSTOM_AUTH,
    props: connectionProps({ secret, serverUrl }),
  } as Parameters<typeof oroApiCall>[0]['auth'];
}

function runCustomApiCall({
  secret,
  path,
  failsafe = false,
  timeout = 0,
}: {
  secret: string;
  path: string;
  failsafe?: boolean;
  timeout?: number;
}) {
  return (customApiCallAction.run as (input: unknown) => Promise<unknown>)({
    auth: connection({ secret }),
    propsValue: {
      url: { url: `http://127.0.0.1:${port}${path}` },
      method: HttpMethod.GET,
      headers: {},
      queryParams: { 'filter[name]': QUERY_VALUE },
      body_type: 'none',
      body: undefined,
      failsafe,
      timeout,
      response_is_binary: false,
      followRedirects: false,
    },
    files: { write: async () => '' },
  });
}

function runCreateCustomer({ secret, serverUrl }: { secret: string; serverUrl?: string }) {
  return (createCustomerAction.run as (input: unknown) => Promise<unknown>)({
    ...createMockActionContext<typeof createCustomerAction.props>({
      propsValue: { name: CUSTOMER_NAME },
    }),
    auth: connection({ secret, serverUrl }),
  });
}

async function errorOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error: unknown) {
    return error as Error;
  }
  throw new Error('expected the step to fail');
}

describe('a failed request is logged as one line, without bodies or credentials', () => {
  it.each([503, 401])('a token request answered with %i', async (status) => {
    const secret = `token-${status}-secret`;
    tokenStatus = status;

    const error = await errorOf(runCreateCustomer({ secret }));

    expect(loggedLines()).toEqual([
      `[OroCommerce] POST http://127.0.0.1:${port}/oauth2-token failed: ${status}`,
    ]);
    expect(leaks({ line: loggedLines()[0], secret })).toEqual([]);
    // The step error is the one the piece already gave.
    expect(error.message).toBe(
      `OroCommerce API Error (${status}): <html><body>No token today</body></html>`
    );
  });

  it('a failing action (Create Customer answered with 500)', async () => {
    const secret = 'create-customer-500-secret';

    const error = await errorOf(runCreateCustomer({ secret }));

    expect(received).toEqual(['POST /oauth2-token', 'POST /admin/api/customers']);
    expect(loggedLines()).toEqual([
      `[OroCommerce] POST http://127.0.0.1:${port}/admin/api/customers failed: 500`,
    ]);
    expect(leaks({ line: loggedLines()[0], secret })).toEqual([]);
    expect(error.message).toBe(
      'OroCommerce API Error (500): {"errors":[{"status":"500","title":"Internal error"}]}'
    );
  });

  it.each([false, true])(
    'the Custom API Call answered with 404 (Return Error as Output: %s)',
    async (failsafe) => {
      const secret = `cac-404-${failsafe}-secret`;

      const run = runCustomApiCall({
        secret,
        path: `/admin/api/regions?filter[code]=${URL_QUERY_VALUE}`,
        failsafe,
      });
      if (failsafe) {
        expect(await run).toMatchObject({ response: { status: 404 } });
      } else {
        expect((await errorOf(run)).message).toMatch(/^OroCommerce API Error \(404\)/);
      }

      // The query string was really sent, both halves of it, and none of it is in the line.
      expect(received[1]).toContain(URL_QUERY_VALUE);
      expect(received[1]).toContain(QUERY_VALUE);
      expect(loggedLines()).toEqual([
        `[OroCommerce] GET http://127.0.0.1:${port}/admin/api/regions failed: 404`,
      ]);
      expect(leaks({ line: loggedLines()[0], secret })).toEqual([]);
    }
  );

  it('a certificate that cannot be verified', async () => {
    const secret = 'self-signed-secret';

    const result = await oroAuth.validate({
      auth: connectionProps({ secret, serverUrl: `https://127.0.0.1:${httpsPort}` }),
    });

    expect(result.valid).toBe(false);
    expect(loggedLines()).toEqual([
      `[OroCommerce] POST https://127.0.0.1:${httpsPort}/oauth2-token ` +
        'failed: DEPTH_ZERO_SELF_SIGNED_CERT',
    ]);
    expect(leaks({ line: loggedLines()[0], secret })).toEqual([]);
  });

  it('a refused connection', async () => {
    const secret = 'refused-secret';

    const error = await errorOf(
      runCreateCustomer({ secret, serverUrl: `http://127.0.0.1:${closedPort}` })
    );

    expect(error.message).toMatch(/ECONNREFUSED/);
    expect(loggedLines()).toEqual([
      `[OroCommerce] POST http://127.0.0.1:${closedPort}/oauth2-token failed: ECONNREFUSED`,
    ]);
    expect(leaks({ line: loggedLines()[0], secret })).toEqual([]);
  });

  it('a request that runs into its timeout', async () => {
    const secret = 'timeout-secret';

    await errorOf(runCustomApiCall({ secret, path: '/admin/api/slow', timeout: 1 }));

    expect(loggedLines()).toEqual([
      `[OroCommerce] GET http://127.0.0.1:${port}/admin/api/slow failed: AbortError`,
    ]);
  });
});

describe('a request that succeeds is not logged', () => {
  it('a token request and a call', async () => {
    const result = (await runCustomApiCall({
      secret: 'success-secret',
      path: '/admin/api/countries',
    })) as { status: number };

    expect(result.status).toBe(200);
    expect(received).toHaveLength(2);
    expect(loggedLines()).toEqual([]);
  });

  it('only the stale-token 401 is logged, not the retry that succeeds', async () => {
    const secret = 'stale-token-secret';
    await runCustomApiCall({ secret, path: '/admin/api/countries' });
    acceptedToken = 'ROTATED-SERVER-SIDE';
    consoleError.mockClear();

    const result = (await runCustomApiCall({ secret, path: '/admin/api/countries' })) as {
      status: number;
    };

    expect(result.status).toBe(200);
    expect(loggedLines()).toEqual([
      `[OroCommerce] GET http://127.0.0.1:${port}/admin/api/countries failed: 401`,
    ]);
  });
});

describe('withFailureLog', () => {
  it('passes the original error through, the same object', async () => {
    const error = new HttpError({ body: 'request body' }, { status: 500, responseBody: 'down' });

    const request = { method: 'GET', url: 'https://oro.example/admin/api/x' };

    await expect(withFailureLog({ request, sent: Promise.reject(error) })).rejects.toBe(error);
    expect(loggedLines()).toEqual([
      '[OroCommerce] GET https://oro.example/admin/api/x failed: 500',
    ]);
  });

  it('passes the response through and logs nothing', async () => {
    const response = { status: 200 };

    await expect(withFailureLog({ request: {}, sent: Promise.resolve(response) })).resolves.toBe(
      response
    );
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('failureLine', () => {
  const request = { method: 'POST', url: 'https://oro.example/admin/api/customers' };

  it('keeps the user, the password, the query and the fragment out of the address', () => {
    expect(
      failureLine({
        request: {
          method: 'GET',
          url: 'https://user:pa55@oro.example:8443/admin/api/x?filter[id]=1#top',
        },
        error: new HttpError(undefined, { status: 404, responseBody: undefined }),
      })
    ).toBe('[OroCommerce] GET https://oro.example:8443/admin/api/x failed: 404');
  });

  it('says so when the address cannot be parsed', () => {
    const error = { code: 'ERR_INVALID_URL' };

    expect(failureLine({ request: { method: 'GET', url: 'not a url' }, error })).toBe(
      '[OroCommerce] GET <invalid url> failed: ERR_INVALID_URL'
    );
  });

  it('takes the code from the cause when the error has none (an unknown host)', () => {
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND oro.invalid'), { code: 'ENOTFOUND' }),
    });

    expect(failureLine({ request, error })).toBe(
      '[OroCommerce] POST https://oro.example/admin/api/customers failed: ENOTFOUND'
    );
  });

  it('falls back to the name, never the message', () => {
    const aborted = new DOMException('This operation was aborted', 'AbortError');

    expect(failureLine({ request, error: aborted })).toMatch(/ failed: AbortError$/);
    expect(failureLine({ request, error: new Error('secret in a message') })).toMatch(
      / failed: Error$/
    );
    expect(failureLine({ request, error: 'secret in a string' })).toMatch(
      / failed: unknown error$/
    );
    expect(failureLine({ request: undefined, error: undefined })).toBe(
      '[OroCommerce] <no method> <invalid url> failed: unknown error'
    );
  });
});
