import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppConnectionType, createMockActionContext } from '@activepieces/pieces-framework';
import { HttpError, HttpMethod } from '@activepieces/pieces-common';
import { customApiCallAction } from '../src/lib/actions/api-call';
import { createCustomerAction } from '../src/lib/actions/create-customer';
import { oroApiCall } from '../src/lib/common';
import { oroAuth } from '../src/lib/common/auth';

const BUNDLE = join(__dirname, '..', 'dist', 'src', 'index.js');

const CLIENT_ID = 'client-id-7f3a';

/**
 * Everything the token request body holds besides the grant type: the client id, the secret and the
 * field names around them. None of it belongs in an error or a log line.
 */
function leaks({ text, secret }: { text: string; secret: string }): string[] {
  return [secret, CLIENT_ID, 'client_secret', 'client_id', 'grant_type'].filter((needle) =>
    text.includes(needle)
  );
}

/** Message, stack and every own property, the way console.error would print the error. */
function everythingIn(error: unknown): string {
  return inspect(error, { depth: null });
}

const MAINTENANCE_PAGE = '<html><body>Down for maintenance</body></html>';

const TOKEN_FAILURES = [
  { name: 'maintenance (503 HTML)', status: 503, answer: 'maintenance' },
  { name: 'refused (401)', status: 401, answer: 'refused' },
] as const;

type TokenAnswer = 'token' | (typeof TOKEN_FAILURES)[number]['answer'];

let port = 0;
let server: ReturnType<typeof createServer>;

let tokenAnswer: TokenAnswer = 'token';
/** The token the server currently honours. Rotating it stands in for Oro ending a session early. */
let acceptedToken = '';
let issuedTokens = 0;
let log: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    if (req.url === '/oauth2-token') {
      if (tokenAnswer === 'maintenance') {
        log.push('token -> 503');
        res.writeHead(503, { 'content-type': 'text/html' });
        return res.end(MAINTENANCE_PAGE);
      }
      if (tokenAnswer === 'refused') {
        log.push('token -> 401');
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({ error: 'invalid_client', message: 'Client authentication failed' })
        );
      }
      issuedTokens += 1;
      acceptedToken = `TOKEN-${issuedTokens}`;
      log.push(`issued ${acceptedToken}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: acceptedToken, expires_in: 3600 }));
    }

    const presented = String(req.headers['authorization'] ?? '').replace('Bearer ', '');
    const status = presented !== acceptedToken ? 401 : req.method === 'POST' ? 201 : 200;
    log.push(`${req.method} with ${presented} -> ${status}`);
    res.writeHead(status, { 'content-type': 'application/vnd.api+json' });
    res.end(
      JSON.stringify(
        status === 401
          ? { errors: [{ title: 'token expired' }] }
          : { data: status === 201 ? { type: 'customers', id: '7' } : [] }
      )
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  tokenAnswer = 'token';
  log = [];
});

function connectionProps({ secret }: { secret: string }) {
  return {
    serverUrl: `http://127.0.0.1:${port}`,
    adminPrefix: 'admin',
    clientId: CLIENT_ID,
    clientSecret: secret,
    isInternalInfrastructure: false,
  };
}

/** A distinct secret per case gives each its own entry in the shared token cache. */
function connection({ secret }: { secret: string }) {
  return {
    type: AppConnectionType.CUSTOM_AUTH,
    props: connectionProps({ secret }),
  } as Parameters<typeof oroApiCall>[0]['auth'];
}

function runCustomApiCall({ secret, failsafe = false }: { secret: string; failsafe?: boolean }) {
  return (customApiCallAction.run as (input: unknown) => Promise<unknown>)({
    auth: connection({ secret }),
    propsValue: {
      url: { url: `http://127.0.0.1:${port}/admin/api/regions` },
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
  });
}

function runCreateCustomer({ secret }: { secret: string }) {
  return (createCustomerAction.run as (input: unknown) => Promise<unknown>)({
    ...createMockActionContext<typeof createCustomerAction.props>({ propsValue: { name: 'Acme' } }),
    auth: connection({ secret }),
  });
}

async function errorOf(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the step to fail');
}

/** A run that succeeds caches its token, so the next one starts from a cached token. */
async function cacheToken({ secret }: { secret: string }): Promise<void> {
  await runCustomApiCall({ secret });
  log = [];
}

describe.each(TOKEN_FAILURES)(
  'a token request that fails with $name keeps the client credentials out of the error',
  ({ status, answer }) => {
    const expected = new RegExp(`^OroCommerce API Error \\(${status}\\)`);

    it('Custom API Call', async () => {
      const secret = `cac-${answer}-secret`;
      tokenAnswer = answer;

      const error = await errorOf(runCustomApiCall({ secret }));

      expect((error as Error).message).toMatch(expected);
      expect(leaks({ text: everythingIn(error), secret })).toEqual([]);
    });

    it('Custom API Call with Return Error as Output on', async () => {
      const secret = `cac-failsafe-${answer}-secret`;
      tokenAnswer = answer;

      // The token is fetched before upstream's failsafe catch, so this still fails the step.
      const error = await errorOf(runCustomApiCall({ secret, failsafe: true }));

      expect((error as Error).message).toMatch(expected);
      expect(leaks({ text: everythingIn(error), secret })).toEqual([]);
    });

    it('Custom API Call refreshing a token after a 401 returned as output', async () => {
      const secret = `cac-failsafe-refresh-${answer}-secret`;
      await cacheToken({ secret });
      acceptedToken = 'ROTATED-SERVER-SIDE';
      tokenAnswer = answer;

      const error = await errorOf(runCustomApiCall({ secret, failsafe: true }));

      expect(log).toEqual([`GET with TOKEN-${issuedTokens} -> 401`, `token -> ${status}`]);
      expect((error as Error).message).toMatch(expected);
      expect(leaks({ text: everythingIn(error), secret })).toEqual([]);
    });

    it('Custom API Call refreshing a token after a thrown 401', async () => {
      const secret = `cac-refresh-${answer}-secret`;
      await cacheToken({ secret });
      acceptedToken = 'ROTATED-SERVER-SIDE';
      tokenAnswer = answer;

      const error = await errorOf(runCustomApiCall({ secret }));

      expect((error as Error).message).toMatch(expected);
      expect(leaks({ text: everythingIn(error), secret })).toEqual([]);
    });

    it('Create Customer', async () => {
      const secret = `create-customer-${answer}-secret`;
      tokenAnswer = answer;

      const error = await errorOf(runCreateCustomer({ secret }));

      expect((error as Error).message).toMatch(expected);
      expect(leaks({ text: everythingIn(error), secret })).toEqual([]);
    });

    it('the connection check', async () => {
      const secret = `validate-${answer}-secret`;
      tokenAnswer = answer;

      const result = await oroAuth.validate({ auth: connectionProps({ secret }) });

      expect(result.valid).toBe(false);
      const error = (result as { error: string }).error;
      expect(error).toMatch(expected);
      expect(leaks({ text: error, secret })).toEqual([]);
    });

    it('a caller that asks for the original error still gets an HttpError with the status', async () => {
      const secret = `original-${answer}-secret`;
      tokenAnswer = answer;

      const error = await errorOf(
        oroApiCall({
          method: HttpMethod.GET,
          resourceUri: 'regions',
          auth: connection({ secret }),
          throwOriginalError: true,
        })
      );

      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).response.status).toBe(status);
      expect(leaks({ text: everythingIn(error), secret })).toEqual([]);
    });
  }
);

describe('a 401 on the call itself still refreshes the token once and retries', () => {
  it('Custom API Call', async () => {
    const secret = 'retry-cac-secret';
    await cacheToken({ secret });
    acceptedToken = 'ROTATED-SERVER-SIDE';
    const stale = `TOKEN-${issuedTokens}`;

    const result = (await runCustomApiCall({ secret })) as { status: number };

    expect(result.status).toBe(200);
    expect(log).toEqual([
      `GET with ${stale} -> 401`,
      `issued TOKEN-${issuedTokens}`,
      `GET with TOKEN-${issuedTokens} -> 200`,
    ]);
  });

  it('Create Customer', async () => {
    const secret = 'retry-create-customer-secret';
    await runCreateCustomer({ secret });
    acceptedToken = 'ROTATED-SERVER-SIDE';
    log = [];
    const stale = `TOKEN-${issuedTokens}`;

    const result = await runCreateCustomer({ secret });

    expect(result).toEqual({ data: { type: 'customers', id: '7' } });
    expect(log).toEqual([
      `POST with ${stale} -> 401`,
      `issued TOKEN-${issuedTokens}`,
      `POST with TOKEN-${issuedTokens} -> 201`,
    ]);
  });
});

/**
 * Upstream's shared client logs every failed request, request body included, to the engine's
 * stderr. scripts/bundle.mjs takes that line out of the artifact, and only the artifact shows it:
 * the sources under test still carry it, so the check runs the built piece in a process of its own
 * and reads what that process wrote.
 */
describe('the built artifact', () => {
  const describeIfBuilt = existsSync(BUNDLE) ? describe : describe.skip;

  describeIfBuilt('writes no request to stderr', () => {
    const SECRET = 'S3CRET-in-the-child';
    const CUSTOMER_NAME = 'Customer name from the request body';

    it('when the token request or the call itself fails', () => {
      const script = `
        import { createServer } from 'node:http';
        let tokenAnswer = 'maintenance';
        const server = createServer((req, res) => {
          req.resume();
          if (req.url === '/oauth2-token') {
            if (tokenAnswer === 'maintenance') {
              res.writeHead(503, { 'content-type': 'text/html' });
              return res.end(${JSON.stringify(MAINTENANCE_PAGE)});
            }
            if (tokenAnswer === 'refused') {
              res.writeHead(401, { 'content-type': 'application/json' });
              return res.end(JSON.stringify({ error: 'invalid_client' }));
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ access_token: 'token', expires_in: 3600 }));
          }
          res.writeHead(422, { 'content-type': 'application/vnd.api+json' });
          res.end(JSON.stringify({ errors: [{ status: '422', detail: 'This value is not valid.' }] }));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const props = {
          serverUrl: 'http://127.0.0.1:' + server.address().port,
          adminPrefix: 'admin',
          clientId: ${JSON.stringify(CLIENT_ID)},
          clientSecret: ${JSON.stringify(SECRET)},
          isInternalInfrastructure: false,
        };
        const auth = { type: 'CUSTOM_AUTH', props };
        const failure = (run) => run.then(() => 'no error', (error) => String(error?.message ?? error));

        const { orocommerce } = await import(${JSON.stringify(BUNDLE)});
        const customApiCall = (failsafe) => orocommerce.getAction('custom_api_call').run({
          auth,
          propsValue: {
            url: { url: props.serverUrl + '/admin/api/regions' },
            method: 'GET', headers: {}, queryParams: {}, body_type: 'none', body: undefined,
            failsafe, timeout: 0, response_is_binary: false, followRedirects: false,
          },
          files: { write: async () => '' },
        });
        const createCustomer = () => orocommerce.getAction('create_customer').run({
          auth,
          propsValue: { name: ${JSON.stringify(CUSTOMER_NAME)} },
        });

        const messages = [];
        for (const answer of ['maintenance', 'refused']) {
          tokenAnswer = answer;
          messages.push((await orocommerce.auth.validate({ auth: props })).error);
          messages.push(await failure(customApiCall(false)));
          messages.push(await failure(customApiCall(true)));
          messages.push(await failure(createCustomer()));
        }
        // Now with a token, so the call itself is what fails, with the customer in its body.
        tokenAnswer = 'token';
        messages.push(await failure(createCustomer()));

        console.log('RESULT ' + JSON.stringify({ messages }));
        server.close();
      `;

      const { stdout, stderr, status } = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        { encoding: 'utf8', timeout: 60_000 }
      );
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
      if (!line) {
        throw new Error(`child produced no result (exit ${status}):\n${stdout}\n${stderr}`);
      }
      const { messages } = JSON.parse(line.slice('RESULT '.length)) as { messages: string[] };

      // Each case failed, and for the reason the server gave.
      expect(messages.map((message) => message.match(/^OroCommerce API Error \((\d+)\)/)?.[1])).toEqual(
        ['503', '503', '503', '503', '401', '401', '401', '401', '422']
      );
      expect(leaks({ text: stdout, secret: SECRET })).toEqual([]);
      expect(leaks({ text: stderr, secret: SECRET })).toEqual([]);
      expect(stderr).not.toContain(CUSTOMER_NAME);
      expect(stderr).not.toContain('Request failed');
    });
  });
});
