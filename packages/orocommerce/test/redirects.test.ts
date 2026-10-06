import { createServer, type IncomingMessage } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppConnectionType, createMockActionContext } from '@activepieces/pieces-framework';
import { HttpError, HttpMethod } from '@activepieces/pieces-common';
import { customApiCallAction } from '../src/lib/actions/api-call';
import { createCustomerAction } from '../src/lib/actions/create-customer';
import { attrLabel, fetchCollection, loadDropdownOptions, oroApiCall } from '../src/lib/common';
import { oroAuth } from '../src/lib/common/auth';

type Received = { method: string; url: string; authorization?: string; body: string };

let oro: ReturnType<typeof createServer>;
let elsewhere: ReturnType<typeof createServer>;
let oroPort = 0;
let elsewherePort = 0;
const atOro: Received[] = [];
const atElsewhere: Received[] = [];

/**
 * What Oro answers instead of the real response, for the token request or for the API. A request
 * to /admin/api/moved is never redirected: it is where a same-host redirect points.
 */
let redirect: { on: 'token' | 'api'; status: number; location?: string } | undefined;

async function record(req: IncomingMessage, into: Received[]): Promise<void> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
  }
  into.push({
    method: req.method ?? '',
    url: req.url ?? '',
    authorization: req.headers['authorization'],
    body,
  });
}

beforeAll(async () => {
  oro = createServer(async (req, res) => {
    await record(req, atOro);
    const isToken = req.url === '/oauth2-token';
    if (redirect && redirect.on === (isToken ? 'token' : 'api') && req.url !== '/admin/api/moved') {
      res.writeHead(redirect.status, redirect.location === undefined ? {} : { location: redirect.location });
      return res.end();
    }
    if (isToken) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'TOKEN', expires_in: 3600 }));
    }
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/vnd.api+json' });
    res.end(
      JSON.stringify(
        req.method === 'POST'
          ? { data: { type: 'customers', id: '7', attributes: { name: 'Acme' } } }
          : { data: [{ type: 'countries', id: 'US', attributes: { name: 'United States' } }] }
      )
    );
  });

  // Answers whatever reaches it as if it were Oro, which is what makes a followed redirect look
  // like a success.
  elsewhere = createServer(async (req, res) => {
    await record(req, atElsewhere);
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        req.url === '/oauth2-token'
          ? { access_token: 'ELSEWHERE-TOKEN', expires_in: 3600 }
          : { data: [{ type: 'countries', id: 'XX', attributes: { name: 'From elsewhere' } }] }
      )
    );
  });

  await new Promise<void>((resolve) => oro.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
  oroPort = (oro.address() as { port: number }).port;
  elsewherePort = (elsewhere.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => oro.close(() => resolve()));
  await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
});

beforeEach(() => {
  redirect = undefined;
  atOro.length = 0;
  atElsewhere.length = 0;
});

function elsewhereUrl(path: string): string {
  return `http://127.0.0.1:${elsewherePort}${path}`;
}

function connectionProps({ secret }: { secret: string }) {
  return {
    serverUrl: `http://127.0.0.1:${oroPort}`,
    adminPrefix: 'admin',
    clientId: 'client-id',
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

function runCreateCustomer({ secret }: { secret: string }) {
  return (createCustomerAction.run as (input: unknown) => Promise<unknown>)({
    ...createMockActionContext<typeof createCustomerAction.props>({ propsValue: { name: 'Acme' } }),
    auth: connection({ secret }),
  });
}

function redirectError({ status, location }: { status: number; location?: string }): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const target = location === undefined ? '' : ` to ${escape(location)}`;
  return new RegExp(
    `^OroCommerce API Error: The server answered with a redirect \\(${status}\\)${target}\\. ` +
      "Redirects are not followed, so set the connection's Server URL to the final address\\.$"
  );
}

describe('a redirect to another host fails instead of being followed', () => {
  it('a dropdown request (GET)', async () => {
    const location = elsewhereUrl('/admin/api/countries');
    redirect = { on: 'api', status: 302, location };
    const auth = connection({ secret: 'redirect-get' });

    await expect(fetchCollection({ auth, resourceUri: '/countries' })).rejects.toThrow(
      redirectError({ status: 302, location })
    );
    // The dropdown shows its usual failure, not the other host's records.
    expect(
      await loadDropdownOptions({ auth, resourceUri: '/countries', labelFn: attrLabel('name') })
    ).toMatchObject({ disabled: true, options: [] });
    expect(atElsewhere).toEqual([]);
  });

  it('a create action (POST)', async () => {
    const location = elsewhereUrl('/admin/api/customers');
    redirect = { on: 'api', status: 302, location };

    await expect(runCreateCustomer({ secret: 'redirect-post' })).rejects.toThrow(
      redirectError({ status: 302, location })
    );
    expect(atOro.filter((entry) => entry.url === '/admin/api/customers')).toHaveLength(1);
    expect(atElsewhere).toEqual([]);
  });

  it('a 307 on a create action, which fetch would resend with its body', async () => {
    const location = elsewhereUrl('/admin/api/customers');
    redirect = { on: 'api', status: 307, location };

    await expect(runCreateCustomer({ secret: 'redirect-307' })).rejects.toThrow(
      redirectError({ status: 307, location })
    );
    expect(atElsewhere).toEqual([]);
  });

  it('the token request', async () => {
    const location = elsewhereUrl('/oauth2-token');
    redirect = { on: 'token', status: 302, location };

    await expect(runCreateCustomer({ secret: 'redirect-token' })).rejects.toThrow(
      redirectError({ status: 302, location })
    );
    expect(atOro.filter((entry) => entry.url.startsWith('/admin/api'))).toEqual([]);
    expect(atElsewhere).toEqual([]);
  });

  it('the token request, seen from the connection check', async () => {
    const location = elsewhereUrl('/oauth2-token');
    redirect = { on: 'token', status: 302, location };

    const result = await oroAuth.validate({ auth: connectionProps({ secret: 'redirect-validate' }) });

    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toMatch(redirectError({ status: 302, location }));
    expect(atElsewhere).toEqual([]);
  });

  it('the token request, seen from Custom API Call', async () => {
    const location = elsewhereUrl('/oauth2-token');
    redirect = { on: 'token', status: 302, location };

    await expect(
      (customApiCallAction.run as (input: unknown) => Promise<unknown>)({
        auth: connection({ secret: 'redirect-cac-token' }),
        propsValue: {
          url: { url: `http://127.0.0.1:${oroPort}/admin/api/countries` },
          method: HttpMethod.GET,
          headers: {},
          queryParams: {},
          body_type: 'none',
          body: undefined,
          failsafe: false,
          timeout: 0,
          response_is_binary: false,
          followRedirects: false,
        },
        files: { write: async () => '' },
      })
    ).rejects.toThrow(redirectError({ status: 302, location }));
    expect(atElsewhere).toEqual([]);
  });
});

describe('a redirect on the same host fails too: redirects are never followed', () => {
  it.each([301, 302])('%i on a GET', async (status) => {
    redirect = { on: 'api', status, location: '/admin/api/moved' };

    await expect(
      fetchCollection({ auth: connection({ secret: `same-host-${status}` }), resourceUri: '/countries' })
    ).rejects.toThrow(redirectError({ status, location: '/admin/api/moved' }));
    expect(atOro.filter((entry) => entry.url === '/admin/api/moved')).toEqual([]);
  });

  it('a redirect without a Location still fails, and says no more than the status', async () => {
    redirect = { on: 'api', status: 302 };

    await expect(
      fetchCollection({ auth: connection({ secret: 'no-location' }), resourceUri: '/countries' })
    ).rejects.toThrow(redirectError({ status: 302 }));
  });

  it('a caller that asks for the original error gets an Error, not an HttpError', async () => {
    redirect = { on: 'api', status: 302, location: elsewhereUrl('/admin/api/webhooks/1') };

    const error = await oroApiCall({
      method: HttpMethod.DELETE,
      resourceUri: 'webhooks/1',
      auth: connection({ secret: 'redirect-original' }),
      throwOriginalError: true,
    }).then(
      () => undefined,
      (failure: unknown) => failure
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpError);
    expect((error as Error).message).toMatch(/^The server answered with a redirect \(302\) to /);
  });
});

describe('a normal answer is unchanged', () => {
  it('200 on a GET', async () => {
    const items = await fetchCollection({ auth: connection({ secret: 'plain-get' }), resourceUri: '/countries' });

    expect(items).toEqual([{ type: 'countries', id: 'US', attributes: { name: 'United States' } }]);
  });

  it('201 on a create action', async () => {
    const result = await runCreateCustomer({ secret: 'plain-post' });

    expect(result).toEqual({ data: { type: 'customers', id: '7', attributes: { name: 'Acme' } } });
  });
});

describe("Custom API Call's own request keeps upstream's redirect handling", () => {
  it('returns a 3xx as its output when Follow redirects is off', async () => {
    redirect = { on: 'api', status: 302, location: elsewhereUrl('/admin/api/countries') };

    const result = (await (customApiCallAction.run as (input: unknown) => Promise<unknown>)({
      auth: connection({ secret: 'cac-own-redirect' }),
      propsValue: {
        url: { url: `http://127.0.0.1:${oroPort}/admin/api/countries` },
        method: HttpMethod.GET,
        headers: {},
        queryParams: {},
        body_type: 'none',
        body: undefined,
        failsafe: false,
        timeout: 0,
        response_is_binary: false,
        followRedirects: false,
      },
      files: { write: async () => '' },
    })) as { status: number };

    expect(result.status).toBe(302);
    expect(atElsewhere).toEqual([]);
  });
});
