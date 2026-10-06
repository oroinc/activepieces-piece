import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppConnectionType } from '@activepieces/pieces-framework';
import { HttpMethod, httpClient } from '@activepieces/pieces-common';
import { getAccessToken, oroAuth } from '../src/lib/common';
import type { OroAuth } from '../src/lib/common/types';
import { dispatcherForConnection, requestOptionsWithTlsVerification } from '../src/lib/common/tls';
import { createCustomerAction } from '../src/lib/actions/create-customer';
import { customApiCallAction } from '../src/lib/actions/api-call';
import { oroWebhookTopicTrigger } from '../src/lib/triggers/webhook-topic-trigger';

const BUNDLE = join(__dirname, '..', 'dist', 'src', 'index.js');
const CERTIFICATE_ERROR = /DEPTH_ZERO_SELF_SIGNED_CERT|self[- ]signed certificate/i;
const TOPIC = 'oro.customer.created';

let certDir = '';
let certFile = '';
let keyFile = '';

/** One self-signed certificate for localhost, so nothing in the trust store can vouch for it. */
function issueSelfSignedCertificate(): void {
  certFile = join(certDir, 'server.pem');
  keyFile = join(certDir, 'server.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', keyFile, '-out', certFile, '-subj', '/CN=localhost'], { stdio: 'pipe' });
}

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'oro-tls-option-'));
  issueSelfSignedCertificate();
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

/** A connection value as Activepieces hands it over; 'absent' is one saved before the option existed. */
function connection({
  port,
  verify,
  secret,
}: {
  port: number;
  verify: boolean | undefined | 'absent';
  secret: string;
}): OroAuth {
  const props = {
    serverUrl: `https://localhost:${port}`,
    adminPrefix: 'admin',
    clientId: 'client-id',
    clientSecret: secret,
    isInternalInfrastructure: false,
  };
  return {
    type: AppConnectionType.CUSTOM_AUTH,
    props: verify === 'absent' ? props : { ...props, verifyTlsCertificate: verify },
  } as OroAuth;
}

/** fetch says only "fetch failed"; the certificate error is on the cause. */
function describeFailure(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return [String((error as Error).message ?? error), cause?.code, cause?.message].join(' ');
}

describe('Verify TLS certificate on the connection', () => {
  const originalEnv = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  let server: ReturnType<typeof createServer>;
  let port = 0;
  let received: string[] = [];
  let cases = 0;

  beforeAll(async () => {
    server = createServer(
      { cert: readFileSync(certFile), key: readFileSync(keyFile) },
      (req: IncomingMessage, res: ServerResponse) => {
        req.resume();
        req.on('end', () => {
          received.push(`${req.method} ${req.url}`);
          const json = (status: number, body?: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(body === undefined ? '' : JSON.stringify(body));
          };
          if (req.url === '/oauth2-token') {
            return json(200, { access_token: 'token', expires_in: 3600 });
          }
          if (req.method === 'POST' && req.url === '/admin/api/webhooks') {
            return json(201, { data: { type: 'webhooks', id: 'webhook-1' } });
          }
          if (req.method === 'POST' && req.url === '/admin/api/customers') {
            return json(201, { data: { type: 'customers', id: '7' } });
          }
          if (req.method === 'DELETE') {
            return json(204);
          }
          return json(200, { data: [] });
        });
      }
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    // The sources under test still carry upstream's assignment, so the variable is put back.
    if (originalEnv === undefined) {
      delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    } else {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = originalEnv;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    received = [];
  });

  /** A distinct secret per case gives each its own entry in the shared token cache. */
  const connectionFor = (verify: boolean | undefined | 'absent') =>
    connection({ port, verify, secret: `case-${++cases}` });

  const createStore = (entry?: unknown) => {
    const values = new Map<string, unknown>(entry === undefined ? [] : [['webhookInfo', entry]]);
    return {
      put: async (name: string, value: unknown) => { values.set(name, value); return value; },
      get: async (name: string) => values.get(name) ?? null,
      delete: async (name: string) => { values.delete(name); },
    };
  };

  const customApiCall = (auth: OroAuth) =>
    (customApiCallAction.run as (input: unknown) => Promise<unknown>)({
      auth,
      propsValue: {
        url: { url: `https://localhost:${port}/admin/api/regions` },
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
    });

  /** Every way the piece reaches the server, each with the request it should make when allowed to. */
  const paths: Array<[string, (auth: OroAuth) => Promise<unknown>, string]> = [
    ['the token fetch', (auth) => getAccessToken({ auth }), 'POST /oauth2-token'],
    [
      'an action (Create Customer)',
      (auth) =>
        (createCustomerAction.run as (input: unknown) => Promise<unknown>)({
          auth,
          propsValue: { name: 'ACME' },
        }),
      'POST /admin/api/customers',
    ],
    ['the Custom API Call', customApiCall, 'GET /admin/api/regions'],
    [
      'webhook registration (onEnable)',
      (auth) =>
        (oroWebhookTopicTrigger.onEnable as (input: unknown) => Promise<unknown>)({
          auth,
          propsValue: { topic: TOPIC, signDeliveries: false },
          webhookUrl: 'https://activepieces.invalid/webhook',
          store: createStore(),
        }),
      'POST /admin/api/webhooks',
    ],
    [
      'webhook removal (onDisable)',
      (auth) =>
        (oroWebhookTopicTrigger.onDisable as (input: unknown) => Promise<unknown>)({
          auth,
          propsValue: { topic: TOPIC, signDeliveries: false },
          store: createStore({ webhookId: 'webhook-1', topic: TOPIC }),
        }),
      'DELETE /admin/api/webhooks/webhook-1',
    ],
    [
      'the connection check (validate)',
      async (auth) => {
        const result = await (oroAuth.validate as (input: unknown) => Promise<{ valid: boolean; error?: string }>)({
          auth: auth.props,
        });
        if (!result.valid) {
          throw new Error(result.error);
        }
      },
      'GET /admin/api/regions/US-CA',
    ],
  ];

  describe.each(paths)('%s', (_name, call, expectedRequest) => {
    it.each([
      ['on', true],
      ['unset', undefined],
      ['missing, as on a connection saved before the option existed', 'absent'],
    ] as const)('refuses the self-signed certificate when the option is %s', async (_label, verify) => {
      const failure = await call(connectionFor(verify)).then(
        () => 'succeeded',
        (error: unknown) => describeFailure(error)
      );

      expect(failure).toMatch(CERTIFICATE_ERROR);
      expect(received).toEqual([]);
    });

    it('reaches the server when the option is off', async () => {
      await call(connectionFor(false));

      expect(received).toContain(expectedRequest);
    });
  });

  it('keeps verifying for a connection that has it on, after one with it off used the same server', async () => {
    await getAccessToken({ auth: connectionFor(false) });

    const failure = await getAccessToken({ auth: connectionFor(true) }).then(
      () => 'succeeded',
      (error: unknown) => describeFailure(error)
    );

    expect(failure).toMatch(CERTIFICATE_ERROR);
  });

  it('keeps two Custom API Calls running side by side on their own connection', async () => {
    const [off, on] = await Promise.allSettled([
      customApiCall(connectionFor(false)),
      customApiCall(connectionFor(true)),
    ]);

    expect(off.status).toBe('fulfilled');
    expect(on.status).toBe('rejected');
    expect(describeFailure((on as PromiseRejectedResult).reason)).toMatch(CERTIFICATE_ERROR);
  });

  it('keeps verifying on the shared client when a request names no connection', async () => {
    await getAccessToken({ auth: connectionFor(false) });

    const failure = await httpClient
      .sendRequest({ method: HttpMethod.GET, url: `https://localhost:${port}/` })
      .then(() => 'succeeded', (error: unknown) => describeFailure(error));

    expect(failure).toMatch(CERTIFICATE_ERROR);
  });
});

describe('the dispatcher a connection gets', () => {
  const verifying = requestOptionsWithTlsVerification().dispatcher;
  const props = { serverUrl: 'https://oro.invalid', adminPrefix: 'admin', clientId: 'id', clientSecret: 'secret', isInternalInfrastructure: false };
  const auth = (extra: Record<string, unknown>) =>
    ({ type: AppConnectionType.CUSTOM_AUTH, props: { ...props, ...extra } }) as OroAuth;

  it('verifies unless the option is explicitly false', () => {
    expect(dispatcherForConnection({ auth: auth({}) })).toBe(verifying);
    expect(dispatcherForConnection({ auth: auth({ verifyTlsCertificate: undefined }) })).toBe(verifying);
    expect(dispatcherForConnection({ auth: auth({ verifyTlsCertificate: null }) })).toBe(verifying);
    expect(dispatcherForConnection({ auth: auth({ verifyTlsCertificate: true }) })).toBe(verifying);
    expect(dispatcherForConnection({ auth: undefined })).toBe(verifying);

    expect(dispatcherForConnection({ auth: auth({ verifyTlsCertificate: false }) })).not.toBe(verifying);
  });

  it('is one cached instance per choice, not a new agent per request', () => {
    const off = auth({ verifyTlsCertificate: false });

    expect(dispatcherForConnection({ auth: off })).toBe(dispatcherForConnection({ auth: off }));
  });
});

/**
 * Whether the option stays inside the piece can only be seen in the artifact, in a process of its
 * own: the sources under test still carry upstream's NODE_TLS_REJECT_UNAUTHORIZED assignment, which
 * scripts/bundle.mjs strips, so in this process the variable says nothing about the piece.
 */
describe('the built artifact, with the option off', () => {
  const describeIfBuilt = existsSync(BUNDLE) ? describe : describe.skip;

  describeIfBuilt('leaves the rest of the process verifying', () => {
    function runInChildProcess({ rejectUnauthorized }: { rejectUnauthorized: string | undefined }) {
      const script = `
        import { createServer, request } from 'node:https';
        import { readFileSync } from 'node:fs';
        const server = createServer(
          { cert: readFileSync(${JSON.stringify(certFile)}), key: readFileSync(${JSON.stringify(keyFile)}) },
          (req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(req.url === '/oauth2-token'
              ? JSON.stringify({ access_token: 'token', expires_in: 3600 })
              : JSON.stringify({ data: [] }));
          });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const url = 'https://localhost:' + server.address().port;
        const viaFetch = () => fetch(url + '/').then(() => 'ok', (error) => error.cause?.code ?? String(error));
        const viaHttps = () => new Promise((resolve) => {
          request(url + '/', (res) => { res.resume(); resolve('ok'); })
            .on('error', (error) => resolve(error.code ?? String(error)))
            .end();
        });
        const globalDispatcher = () => globalThis[Symbol.for('undici.globalDispatcher.1')];
        const auth = (extra) => ({
          serverUrl: url, adminPrefix: 'admin', clientId: 'client-id', isInternalInfrastructure: false, ...extra,
        });

        const envBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null;
        // Made first, as in a worker that has already used fetch, so Node has its own global dispatcher.
        const fetchBefore = await viaFetch();
        const dispatcherBefore = globalDispatcher();

        const { orocommerce } = await import(${JSON.stringify(BUNDLE)});
        const off = await orocommerce.auth.validate({ auth: auth({ clientSecret: 'off', verifyTlsCertificate: false }) });

        const result = {
          off,
          envBefore,
          envAfter: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null,
          sameGlobalDispatcher: globalDispatcher() === dispatcherBefore,
          fetchBefore,
          fetchAfter: await viaFetch(),
          httpsAfter: await viaHttps(),
          savedWithoutOption: await orocommerce.auth.validate({ auth: auth({ clientSecret: 'absent' }) }),
        };
        console.log('RESULT ' + JSON.stringify(result));
        server.close();
      `;

      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env['NODE_TLS_REJECT_UNAUTHORIZED'];
      delete env['NODE_EXTRA_CA_CERTS'];
      if (rejectUnauthorized !== undefined) env['NODE_TLS_REJECT_UNAUTHORIZED'] = rejectUnauthorized;

      const { stdout, stderr, status } = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        { encoding: 'utf8', env, timeout: 60_000 }
      );
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
      if (!line) {
        throw new Error(`child produced no result (exit ${status}):\n${stdout}\n${stderr}`);
      }
      return JSON.parse(line.slice('RESULT '.length));
    }

    it.each([
      ['unset', undefined],
      ['set to 1', '1'],
    ])('with NODE_TLS_REJECT_UNAUTHORIZED %s', (_label, rejectUnauthorized) => {
      const result = runInChildProcess({ rejectUnauthorized });

      expect(result.off).toMatchObject({ valid: true });
      expect(result.envAfter).toBe(result.envBefore);
      expect(result.envAfter).toBe(rejectUnauthorized ?? null);
      expect(result.sameGlobalDispatcher).toBe(true);
      expect(result.fetchBefore).toMatch(CERTIFICATE_ERROR);
      expect(result.fetchAfter).toMatch(CERTIFICATE_ERROR);
      expect(result.httpsAfter).toMatch(CERTIFICATE_ERROR);
      expect(result.savedWithoutOption.valid).toBe(false);
      expect(result.savedWithoutOption.error).toMatch(CERTIFICATE_ERROR);
    });
  });
});
