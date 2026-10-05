import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppConnectionType } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { getAccessToken, oroAuth } from '../src/lib/common';
import type { OroAuth } from '../src/lib/common/types';
import { dispatcherForConnection, requestOptionsWithTlsVerification } from '../src/lib/common/tls';
import { createCustomerAction } from '../src/lib/actions/create-customer';
import { customApiCallAction } from '../src/lib/actions/api-call';

const CERTIFICATE_ERROR = /DEPTH_ZERO_SELF_SIGNED_CERT|self[- ]signed certificate/i;
// ORO_SERVER_URL is read for the same connections, so it is cleared too: it would send them elsewhere.
const VARIABLES = ['ORO_SERVER_VERIFY_TLS', 'ORO_SERVER_URL', 'NODE_TLS_REJECT_UNAUTHORIZED'] as const;
const savedEnv = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));

let certDir = '';
let certFile = '';
let keyFile = '';

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'oro-verify-tls-env-'));
  certFile = join(certDir, 'server.pem');
  keyFile = join(certDir, 'server.key');
  // One self-signed certificate for localhost, so nothing in the trust store can vouch for it.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', keyFile, '-out', certFile, '-subj', '/CN=localhost'], { stdio: 'pipe' });
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env['ORO_SERVER_VERIFY_TLS'];
  delete process.env['ORO_SERVER_URL'];
});

// The sources under test still carry upstream's NODE_TLS_REJECT_UNAUTHORIZED assignment, so that
// one is put back as well.
afterEach(() => {
  for (const name of VARIABLES) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
});

/** fetch says only "fetch failed"; the certificate error is on the cause. */
function describeFailure(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return [String((error as Error).message ?? error), cause?.code, cause?.message].join(' ');
}

const outcomeOf = (sent: Promise<unknown>) =>
  sent.then(() => 'succeeded', (error: unknown) => describeFailure(error));

describe('ORO_SERVER_VERIFY_TLS', () => {
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
          const json = (status: number, body: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
          };
          if (req.url === '/oauth2-token') {
            return json(200, { access_token: 'token', expires_in: 3600 });
          }
          if (req.method === 'POST' && req.url === '/admin/api/customers') {
            return json(201, { data: { type: 'customers', id: '7' } });
          }
          return json(200, { data: [] });
        });
      }
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    received = [];
  });

  /** A distinct secret per case gives each its own entry in the shared token cache. */
  const connection = ({ internal, verify }: { internal: boolean; verify: boolean }): OroAuth =>
    ({
      type: AppConnectionType.CUSTOM_AUTH,
      props: {
        serverUrl: `https://localhost:${port}`,
        adminPrefix: 'admin',
        clientId: 'client-id',
        clientSecret: `case-${++cases}`,
        isInternalInfrastructure: internal,
        verifyTlsCertificate: verify,
      },
    }) as OroAuth;

  const action = (auth: OroAuth) =>
    (createCustomerAction.run as (input: unknown) => Promise<unknown>)({
      auth,
      propsValue: { name: 'ACME' },
    });

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

  const validate = async (auth: OroAuth) => {
    const result = await (oroAuth.validate as (input: unknown) => Promise<{ valid: boolean; error?: string }>)({
      auth: auth.props,
    });
    if (!result.valid) {
      throw new Error(result.error);
    }
  };

  /** Every way the piece reaches the server, each with the request it should make when allowed to. */
  const paths: Array<[string, (auth: OroAuth) => Promise<unknown>, string]> = [
    ['the token request', (auth) => getAccessToken({ auth }), 'POST /oauth2-token'],
    ['an action (Create Customer)', action, 'POST /admin/api/customers'],
    ['the connection check (validate)', validate, 'GET /admin/api/regions/US-CA'],
    ['the Custom API Call', customApiCall, 'GET /admin/api/regions'],
  ];

  describe.each(paths)('%s, on an Internal infrastructure connection', (_name, call, expectedRequest) => {
    it('reaches the self-signed server with false, although the option is on', async () => {
      process.env['ORO_SERVER_VERIFY_TLS'] = 'false';

      await call(connection({ internal: true, verify: true }));

      expect(received).toContain(expectedRequest);
    });

    it('refuses the self-signed certificate with true, although the option is off', async () => {
      process.env['ORO_SERVER_VERIFY_TLS'] = 'true';

      const outcome = await outcomeOf(call(connection({ internal: true, verify: false })));

      expect(outcome).toMatch(CERTIFICATE_ERROR);
      expect(received).toEqual([]);
    });
  });

  describe('on a connection that is not Internal infrastructure', () => {
    it('is ignored: false does not turn verification off', async () => {
      process.env['ORO_SERVER_VERIFY_TLS'] = 'false';

      const outcome = await outcomeOf(action(connection({ internal: false, verify: true })));

      expect(outcome).toMatch(CERTIFICATE_ERROR);
      expect(received).toEqual([]);
    });

    it('is ignored: true does not turn verification on', async () => {
      process.env['ORO_SERVER_VERIFY_TLS'] = 'true';

      await action(connection({ internal: false, verify: false }));

      expect(received).toContain('POST /admin/api/customers');
    });
  });

  describe.each([
    ['unset', undefined],
    ['empty', ''],
  ] as const)('%s, on an Internal infrastructure connection', (_label, value) => {
    beforeEach(() => {
      if (value !== undefined) {
        process.env['ORO_SERVER_VERIFY_TLS'] = value;
      }
    });

    it('leaves it to the option: on refuses the self-signed certificate', async () => {
      const outcome = await outcomeOf(action(connection({ internal: true, verify: true })));

      expect(outcome).toMatch(CERTIFICATE_ERROR);
      expect(received).toEqual([]);
    });

    it('leaves it to the option: off reaches the server', async () => {
      await action(connection({ internal: true, verify: false }));

      expect(received).toContain('POST /admin/api/customers');
    });
  });

  it.each(['FALSE', ' off '])('reads %j as false', async (value) => {
    process.env['ORO_SERVER_VERIFY_TLS'] = value;

    await action(connection({ internal: true, verify: true }));

    expect(received).toContain('POST /admin/api/customers');
  });

  // The report is once per process, and this module keeps that state for the whole file, so this is
  // the only case here with a value it does not understand.
  it('verifies on a value it does not understand, and says so once', async () => {
    process.env['ORO_SERVER_VERIFY_TLS'] = 'maybe';
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const first = await outcomeOf(action(connection({ internal: true, verify: false })));
      const second = await outcomeOf(action(connection({ internal: true, verify: false })));

      expect(first).toMatch(CERTIFICATE_ERROR);
      expect(second).toMatch(CERTIFICATE_ERROR);
      expect(received).toEqual([]);
      const reports = error.mock.calls.filter(([line]) => String(line).includes('ORO_SERVER_VERIFY_TLS'));
      expect(reports).toEqual([
        ['[OroCommerce] ORO_SERVER_VERIFY_TLS="maybe" not understood, verifying certificates'],
      ]);
    } finally {
      error.mockRestore();
    }
  });

  // The same connection both times, its token cached by the first call, so the second request is
  // the step's own: for the Custom API Call that is the one reaching the client with no options.
  it.each([
    ['an action (Create Customer)', action, 'POST /admin/api/customers'],
    ['the Custom API Call', customApiCall, 'GET /admin/api/regions'],
  ] as const)('is read on every request, for %s', async (_name, call, expectedRequest) => {
    const auth = connection({ internal: true, verify: false });

    process.env['ORO_SERVER_VERIFY_TLS'] = 'false';
    await call(auth);
    expect(received).toEqual(['POST /oauth2-token', expectedRequest]);

    process.env['ORO_SERVER_VERIFY_TLS'] = 'true';
    const outcome = await outcomeOf(call(auth));

    expect(outcome).toMatch(CERTIFICATE_ERROR);
    expect(received).toEqual(['POST /oauth2-token', expectedRequest]);
  });
});

describe('the dispatcher an Internal infrastructure connection gets', () => {
  const verifying = requestOptionsWithTlsVerification().dispatcher;
  const auth = ({ internal = true, verify }: { internal?: boolean; verify: boolean }) =>
    ({
      type: AppConnectionType.CUSTOM_AUTH,
      props: {
        serverUrl: 'https://oro.invalid',
        adminPrefix: 'admin',
        clientId: 'id',
        clientSecret: 'secret',
        isInternalInfrastructure: internal,
        verifyTlsCertificate: verify,
      },
    }) as OroAuth;
  const dispatcherWith = (value: string, connection: OroAuth | undefined) => {
    process.env['ORO_SERVER_VERIFY_TLS'] = value;
    return dispatcherForConnection({ auth: connection });
  };

  it.each(['false', '0', 'no', 'off', 'FALSE', 'No', ' off ', '\toff\n'])('turns verification off for %j', (value) => {
    expect(dispatcherWith(value, auth({ verify: true }))).not.toBe(verifying);
    expect(dispatcherWith(value, auth({ verify: true }))).toBe(dispatcherWith(value, auth({ verify: false })));
  });

  it.each(['true', '1', 'yes', 'on', 'TRUE', 'Yes', ' on '])('turns verification on for %j', (value) => {
    expect(dispatcherWith(value, auth({ verify: false }))).toBe(verifying);
  });

  it.each(['', '  '])('leaves it to the option for %j', (value) => {
    expect(dispatcherWith(value, auth({ verify: true }))).toBe(verifying);
    expect(dispatcherWith(value, auth({ verify: false }))).not.toBe(verifying);
  });

  it('is ignored when the connection is not Internal infrastructure, or there is none', () => {
    expect(dispatcherWith('false', auth({ internal: false, verify: true }))).toBe(verifying);
    expect(dispatcherWith('true', auth({ internal: false, verify: false }))).not.toBe(verifying);
    expect(dispatcherWith('false', undefined)).toBe(verifying);
  });
});
