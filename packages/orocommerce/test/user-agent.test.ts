import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppConnectionType } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { DEFAULT_USER_AGENT, getAccessToken, mergeHeaders, oroAuth } from '../src/lib/common';
import type { OroAuth } from '../src/lib/common/types';
import { createCustomerAction } from '../src/lib/actions/create-customer';
import { customApiCallAction } from '../src/lib/actions/api-call';
import { oroWebhookTopicTrigger } from '../src/lib/triggers/webhook-topic-trigger';

type Seen = { request: string; userAgent?: string; userAgentHeaders: number; xTest?: string };

let port = 0;
let server: ReturnType<typeof createServer>;
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({
        request: `${req.method} ${req.url}`,
        userAgent: req.headers['user-agent'],
        // Counted on the raw list: req.headers would join two of them into one value.
        userAgentHeaders: req.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'user-agent').length,
        xTest: req.headers['x-test'] as string | undefined,
      });
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
      if (req.url === '/oauth2-token') {
        res.end(JSON.stringify({ access_token: 'token', expires_in: 3600 }));
      } else if (req.url === '/admin/api/webhooks') {
        res.end(JSON.stringify({ data: { type: 'webhooks', id: 'webhook-1' } }));
      } else {
        res.end(JSON.stringify({ data: req.method === 'POST' ? { type: 'customers', id: '7' } : [] }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const savedEnv = { userAgent: process.env['ORO_SERVER_USER_AGENT'], url: process.env['ORO_SERVER_URL'] };

beforeEach(() => {
  seen.length = 0;
  delete process.env['ORO_SERVER_USER_AGENT'];
  delete process.env['ORO_SERVER_URL'];
});

afterEach(() => {
  for (const [name, value] of [['ORO_SERVER_USER_AGENT', savedEnv.userAgent], ['ORO_SERVER_URL', savedEnv.url]] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

let cases = 0;

/** A distinct client secret per call gives each its own token request. */
function connection({ headers, internal = false }: { headers?: string; internal?: boolean } = {}): OroAuth {
  return {
    type: AppConnectionType.CUSTOM_AUTH,
    props: {
      serverUrl: `http://127.0.0.1:${port}`,
      adminPrefix: 'admin',
      clientId: 'client-id',
      clientSecret: `case-${++cases}`,
      headers,
      isInternalInfrastructure: internal,
    },
  } as OroAuth;
}

const tokenRequest = (auth: OroAuth) => getAccessToken({ auth });

const action = (auth: OroAuth, stepHeaders?: Record<string, string>) =>
  (createCustomerAction.run as (input: unknown) => Promise<unknown>)({
    auth,
    propsValue: { name: 'ACME', additionalHeaders: stepHeaders },
  });

const customApiCall = (auth: OroAuth, stepHeaders: Record<string, string> = {}) =>
  (customApiCallAction.run as (input: unknown) => Promise<unknown>)({
    auth,
    propsValue: {
      url: { url: `http://127.0.0.1:${port}/admin/api/regions` },
      method: HttpMethod.GET,
      headers: stepHeaders,
      queryParams: {},
      body_type: 'none',
      body: undefined,
      failsafe: false,
      timeout: 0,
      response_is_binary: false,
      followRedirects: false,
    },
    files: { write: async () => '' },
  });

const validate = async (auth: OroAuth) => {
  const result = await (oroAuth.validate as (input: unknown) => Promise<{ valid: boolean; error?: string }>)({
    auth: auth.props,
  });
  expect(result).toEqual({ valid: true });
};

const register = (auth: OroAuth) =>
  (oroWebhookTopicTrigger.onEnable as (input: unknown) => Promise<unknown>)({
    auth,
    propsValue: { topic: 'oro.customer.created', signDeliveries: false },
    webhookUrl: 'https://activepieces.invalid/webhook',
    store: { put: async () => undefined, get: async () => null, delete: async () => undefined },
  });

const paths: Array<[string, (auth: OroAuth) => Promise<unknown>, string[]]> = [
  ['the token request', tokenRequest, ['POST /oauth2-token']],
  ['an action (Create Customer)', (auth) => action(auth), ['POST /oauth2-token', 'POST /admin/api/customers']],
  ['the Custom API Call', (auth) => customApiCall(auth), ['POST /oauth2-token', 'GET /admin/api/regions']],
  ['the connection check (validate)', validate, ['POST /oauth2-token', 'GET /admin/api/regions/US-CA']],
  ['webhook registration (onEnable)', register, ['POST /oauth2-token', 'POST /admin/api/webhooks']],
];

/** What reached the server, one User-Agent header per request and its value. */
function userAgents(): Array<[string, string | undefined]> {
  for (const entry of seen) {
    expect(entry.userAgentHeaders, entry.request).toBe(1);
  }
  return seen.map((entry) => [entry.request, entry.userAgent]);
}

describe('the default User-Agent', () => {
  it('names the package and the version in package.json', () => {
    const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };

    expect(DEFAULT_USER_AGENT).toBe(`oroinc-piece-orocommerce/${version}`);
  });

  it.each(paths)('is sent by %s', async (_name, call, requests) => {
    await call(connection());

    expect(userAgents()).toEqual(requests.map((request) => [request, DEFAULT_USER_AGENT]));
  });
});

describe('a User-Agent in the connection Default HTTP Headers', () => {
  it.each(paths)('replaces the default on %s', async (_name, call, requests) => {
    await call(connection({ headers: '{"User-Agent":"connection-ua/1"}' }));

    expect(userAgents()).toEqual(requests.map((request) => [request, 'connection-ua/1']));
  });

  it('is sent once when it is spelled in lower case', async () => {
    await action(connection({ headers: '{"user-agent":"connection-ua/1"}' }));
    await customApiCall(connection({ headers: '{"user-agent":"connection-ua/1"}' }));

    expect(userAgents()).toEqual([
      ['POST /oauth2-token', 'connection-ua/1'],
      ['POST /admin/api/customers', 'connection-ua/1'],
      ['POST /oauth2-token', 'connection-ua/1'],
      ['GET /admin/api/regions', 'connection-ua/1'],
    ]);
  });

  it('reaches the token request alone of the connection headers', async () => {
    await action(connection({ headers: '{"User-Agent":"connection-ua/1","X-Test":"kept"}' }));

    expect(seen.map((entry) => [entry.request, entry.xTest])).toEqual([
      ['POST /oauth2-token', undefined],
      ['POST /admin/api/customers', 'kept'],
    ]);
  });
});

describe('ORO_SERVER_USER_AGENT', () => {
  it.each(paths)('replaces the connection one on %s with Internal infrastructure on', async (_name, call, requests) => {
    process.env['ORO_SERVER_USER_AGENT'] = 'env-ua/1';

    // Lower case on purpose: with the default in another case, a plain spread would let it win.
    await call(connection({ internal: true, headers: '{"user-agent":"connection-ua/1"}' }));

    expect(userAgents()).toEqual(requests.map((request) => [request, 'env-ua/1']));
  });

  it('is ignored with Internal infrastructure off', async () => {
    process.env['ORO_SERVER_USER_AGENT'] = 'env-ua/1';

    await action(connection());

    expect(userAgents()).toEqual([
      ['POST /oauth2-token', DEFAULT_USER_AGENT],
      ['POST /admin/api/customers', DEFAULT_USER_AGENT],
    ]);
  });
});

describe('a step header', () => {
  it('wins on the API call of an action, and does not reach the token request', async () => {
    process.env['ORO_SERVER_USER_AGENT'] = 'env-ua/1';

    await action(connection({ internal: true }), { 'user-agent': 'step-ua/1' });

    expect(userAgents()).toEqual([
      ['POST /oauth2-token', 'env-ua/1'],
      ['POST /admin/api/customers', 'step-ua/1'],
    ]);
  });

  it('wins on the Custom API Call whatever its case', async () => {
    await customApiCall(connection({ headers: '{"User-Agent":"connection-ua/1"}' }), { 'user-agent': 'step-ua/1' });
    await customApiCall(connection({ headers: '{"user-agent":"connection-ua/1"}' }), { 'User-Agent': 'step-ua/2' });

    expect(userAgents()).toEqual([
      ['POST /oauth2-token', 'connection-ua/1'],
      ['GET /admin/api/regions', 'step-ua/1'],
      ['POST /oauth2-token', 'connection-ua/1'],
      ['GET /admin/api/regions', 'step-ua/2'],
    ]);
  });
});

describe('mergeHeaders', () => {
  it('lets the later set win whatever the case, in the later set\'s spelling', () => {
    expect(
      mergeHeaders(
        { 'User-Agent': 'default', Accept: 'a' },
        { 'user-agent': 'connection' },
        undefined,
        { 'USER-AGENT': 'step', 'X-Test': 'x' },
      )
    ).toEqual({ 'USER-AGENT': 'step', Accept: 'a', 'X-Test': 'x' });
  });
});
