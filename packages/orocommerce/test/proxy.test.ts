import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Node's switch and the proxy variables are read once, when the piece's agents are built at module
 * load, so every case runs the built artifact in a child process started with its own environment.
 * The servers stay in this process and log what reaches them; the child only makes the requests.
 */
const BUNDLE = join(__dirname, '..', 'dist', 'src', 'index.js');
const CERTIFICATE_ERROR = /DEPTH_ZERO_SELF_SIGNED_CERT|self[- ]signed certificate/i;
const PROXY_VARIABLES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'];
const SWITCH_ON = { NODE_USE_ENV_PROXY: '1' };

type Seen = { request: string; remotePort: number | undefined; proxyAuthorization?: string };
type Tunnel = { authority: string; proxyAuthorization?: string; upstreamPort: number };
type Outcome = { path: string; ok: boolean; error?: string };

let certDir = '';
let certFile = '';
let keyFile = '';

/** Answers like Oro would for the requests the piece makes, and logs which socket each came in on. */
function oroLike(seen: Seen[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      seen.push({
        request: `${req.method} ${req.url}`,
        remotePort: req.socket.remotePort,
        proxyAuthorization: req.headers['proxy-authorization'],
      });
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
      return json(200, { data: [] });
    });
  };
}

/** Every way the piece reaches Oro, each with its own client secret so each fetches its own token. */
function childScript({
  serverUrl,
  verify,
  internal = false,
}: {
  serverUrl: string;
  verify: boolean;
  internal?: boolean;
}): string {
  return `
    const { orocommerce } = await import(${JSON.stringify(BUNDLE)});
    const props = (secret) => ({
      serverUrl: ${JSON.stringify(serverUrl)}, adminPrefix: 'admin', clientId: 'client-id', clientSecret: secret,
      isInternalInfrastructure: ${internal}, verifyTlsCertificate: ${verify},
    });
    const auth = (secret) => ({ type: 'CUSTOM_AUTH', props: props(secret) });
    const store = () => {
      const values = new Map();
      return {
        put: async (key, value) => { values.set(key, value); return value; },
        get: async (key) => values.get(key) ?? null,
        delete: async (key) => { values.delete(key); },
      };
    };
    const paths = {
      validate: async () => {
        const result = await orocommerce.auth.validate({ auth: props('validate') });
        if (!result.valid) throw new Error(result.error);
      },
      action: () => orocommerce.getAction('create_customer').run({ auth: auth('action'), propsValue: { name: 'ACME' } }),
      customApiCall: () => orocommerce.getAction('custom_api_call').run({
        auth: auth('custom'),
        propsValue: {
          url: { url: ${JSON.stringify(serverUrl)} + '/admin/api/regions' }, method: 'GET', headers: {}, queryParams: {},
          body_type: 'none', body: undefined, failsafe: false, timeout: 0, response_is_binary: false, followRedirects: false,
        },
        files: { write: async () => '' },
      }),
      onEnable: () => orocommerce.getTrigger('oro-webhook-event').onEnable({
        auth: auth('trigger'),
        propsValue: { topic: 'oro.customer.created', signDeliveries: false },
        webhookUrl: 'https://activepieces.invalid/webhook',
        store: store(),
      }),
    };
    const outcomes = [];
    for (const [path, run] of Object.entries(paths)) {
      try {
        await run();
        outcomes.push({ path, ok: true });
      } catch (error) {
        outcomes.push({ path, ok: false, error: [error.message, error.cause?.code].join(' ') });
      }
    }
    console.log('RESULT ' + JSON.stringify(outcomes));
  `;
}

/** Spawned, not spawnSync: the servers answering the child live in this process's event loop. */
function runChild({ script, env }: { script: string; env: Record<string, string> }): Promise<Outcome[]> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [...PROXY_VARIABLES, 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY',
    'NODE_OPTIONS', 'ORO_SERVER_URL', 'ORO_SERVER_VERIFY_TLS']) {
    delete childEnv[name];
  }
  Object.assign(childEnv, env);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 50_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
      if (!line) {
        reject(new Error(`child produced no result (exit ${code}):\n${stdout}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(line.slice('RESULT '.length)));
    });
  });
}

const EXPECTED_REQUESTS = [
  'POST /oauth2-token',
  'GET /admin/api/regions/US-CA',
  'POST /oauth2-token',
  'POST /admin/api/customers',
  'POST /oauth2-token',
  'GET /admin/api/regions',
  'POST /oauth2-token',
  'POST /admin/api/webhooks',
];

const describeIfBuilt = existsSync(BUNDLE) ? describe : describe.skip;

/**
 * A CONNECT proxy. It logs each tunnel with the local port of its own socket to the target, which is
 * the remote port the target sees, so a request can be traced to the tunnel it came through.
 */
function connectProxy(tunnels: Tunnel[]) {
  const proxy = createHttpServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxy.on('connect', (req: IncomingMessage, client, head: Buffer) => {
    const [host, port] = (req.url ?? '').split(':');
    const upstream = connect(Number(port), host === 'localhost' ? '127.0.0.1' : host, () => {
      tunnels.push({
        authority: req.url ?? '',
        proxyAuthorization: req.headers['proxy-authorization'],
        upstreamPort: upstream.localPort ?? 0,
      });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return proxy;
}

describeIfBuilt('the built artifact behind a proxy', () => {
  const httpsSeen: Seen[] = [];
  const httpSeen: Seen[] = [];
  const tunnels: Tunnel[] = [];
  const otherTunnels: Tunnel[] = [];
  let httpsServer: ReturnType<typeof createHttpsServer>;
  let httpServer: ReturnType<typeof createHttpServer>;
  let proxy: ReturnType<typeof createHttpServer>;
  let otherProxy: ReturnType<typeof createHttpServer>;
  let httpsPort = 0;
  let httpPort = 0;
  let proxyUrl = '';
  let otherProxyUrl = '';

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'oro-proxy-'));
    certFile = join(certDir, 'server.pem');
    keyFile = join(certDir, 'server.key');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', keyFile, '-out', certFile, '-subj', '/CN=localhost'], { stdio: 'pipe' });

    httpsServer = createHttpsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, oroLike(httpsSeen));
    httpServer = createHttpServer(oroLike(httpSeen));
    proxy = connectProxy(tunnels);
    // Set in the other letter case, to show which of the two is used.
    otherProxy = connectProxy(otherTunnels);

    const listen = (server: { listen: (port: number, host: string, done: () => void) => unknown; address: () => unknown }) =>
      new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
      });
    httpsPort = await listen(httpsServer);
    httpPort = await listen(httpServer);
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
    otherProxyUrl = `http://127.0.0.1:${await listen(otherProxy)}`;
  });

  afterAll(async () => {
    const close = (server: { close: (done: () => void) => unknown }) =>
      new Promise<void>((resolve) => { server.close(() => resolve()); });
    await Promise.all([close(httpsServer), close(httpServer), close(proxy), close(otherProxy)]);
    rmSync(certDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    httpsSeen.length = 0;
    httpSeen.length = 0;
    tunnels.length = 0;
    otherTunnels.length = 0;
  });

  const viaProxy = (seen: Seen) => tunnels.some((tunnel) => tunnel.upstreamPort === seen.remotePort);
  const httpsUrl = () => `https://localhost:${httpsPort}`;
  const httpUrl = () => `http://127.0.0.1:${httpPort}`;

  it.each([
    ['without Node\'s switch', {}],
    ['with NODE_USE_ENV_PROXY=1', SWITCH_ON],
  ])('connects directly when no proxy variable is set, %s', async (_label, env) => {
    const outcomes = await runChild({
      script: childScript({ serverUrl: httpUrl(), verify: true }),
      env,
    });

    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
    expect(httpSeen.map((seen) => seen.request)).toEqual(EXPECTED_REQUESTS);
    expect(httpSeen.some(viaProxy)).toBe(false);
    expect(tunnels).toEqual([]);
  }, 60_000);

  describe('uses the proxy only when Node\'s own switch is on', () => {
    // Node leaves fetch direct in each of these; so does the piece.
    it.each([
      ['no switch', {}],
      ['NODE_USE_ENV_PROXY=true', { NODE_USE_ENV_PROXY: 'true' }],
      ['NODE_USE_ENV_PROXY=0', { NODE_USE_ENV_PROXY: '0' }],
      ['NODE_USE_ENV_PROXY=1 turned off by --no-use-env-proxy', { ...SWITCH_ON, NODE_OPTIONS: '--no-use-env-proxy' }],
    ])('connects directly with the proxy variables set and %s', async (_label, env) => {
      const outcomes = await runChild({
        script: childScript({ serverUrl: httpUrl(), verify: true }),
        env: { http_proxy: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ...env },
      });

      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
      expect(httpSeen.map((seen) => seen.request)).toEqual(EXPECTED_REQUESTS);
      expect(httpSeen.some(viaProxy)).toBe(false);
      expect(tunnels).toEqual([]);
    }, 60_000);

    it.each([
      ['NODE_USE_ENV_PROXY=1', SWITCH_ON],
      ['--use-env-proxy in NODE_OPTIONS', { NODE_OPTIONS: '--max-old-space-size=512 --use-env-proxy' }],
    ])('goes through the proxy with %s', async (_label, env) => {
      const outcomes = await runChild({
        script: childScript({ serverUrl: httpUrl(), verify: true }),
        env: { http_proxy: proxyUrl, ...env },
      });

      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
      expect(httpSeen.map((seen) => seen.request)).toEqual(EXPECTED_REQUESTS);
      expect(httpSeen.every(viaProxy)).toBe(true);
    }, 60_000);
  });

  it.each(['HTTPS_PROXY', 'https_proxy'])(
    'sends every request to an https server through %s',
    async (variable) => {
      const outcomes = await runChild({
        script: childScript({ serverUrl: httpsUrl(), verify: false }),
        env: { [variable]: proxyUrl, ...SWITCH_ON },
      });

      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
      expect(httpsSeen.map((seen) => seen.request)).toEqual(EXPECTED_REQUESTS);
      expect(httpsSeen.every(viaProxy)).toBe(true);
      expect(tunnels.map((tunnel) => tunnel.authority)).toContain(`localhost:${httpsPort}`);
    },
    60_000
  );

  it('sends every request to a plain http server through http_proxy', async () => {
    const outcomes = await runChild({
      script: childScript({ serverUrl: httpUrl(), verify: true }),
      env: { http_proxy: proxyUrl, ...SWITCH_ON },
    });

    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
    expect(httpSeen.map((seen) => seen.request)).toEqual(EXPECTED_REQUESTS);
    expect(httpSeen.every(viaProxy)).toBe(true);
  }, 60_000);

  // The same choices Node's fetch makes for the other pieces.
  describe('reads the variables the way Node\'s fetch does', () => {
    it.each([
      ['https_proxy', 'HTTPS_PROXY', httpsUrl, httpsSeen],
      ['http_proxy', 'HTTP_PROXY', httpUrl, httpSeen],
    ] as const)('prefers %s over %s', async (lower, upper, url, seen) => {
      const outcomes = await runChild({
        script: childScript({ serverUrl: url(), verify: false }),
        env: { [lower]: proxyUrl, [upper]: otherProxyUrl, ...SWITCH_ON },
      });

      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
      expect(seen).toHaveLength(EXPECTED_REQUESTS.length);
      expect(seen.every(viaProxy)).toBe(true);
      expect(otherTunnels).toEqual([]);
    }, 60_000);

    it('connects directly when http_proxy is set but empty, whatever HTTP_PROXY says', async () => {
      const outcomes = await runChild({
        script: childScript({ serverUrl: httpUrl(), verify: true }),
        env: { http_proxy: '', HTTP_PROXY: otherProxyUrl, ...SWITCH_ON },
      });

      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
      expect(httpSeen.map((seen) => seen.request)).toEqual(EXPECTED_REQUESTS);
      expect(otherTunnels).toEqual([]);
      expect(tunnels).toEqual([]);
    }, 60_000);

    it('sends https through http_proxy when no https proxy is set', async () => {
      const outcomes = await runChild({
        script: childScript({ serverUrl: httpsUrl(), verify: false }),
        env: { HTTP_PROXY: proxyUrl, ...SWITCH_ON },
      });

      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
      expect(httpsSeen).toHaveLength(EXPECTED_REQUESTS.length);
      expect(httpsSeen.every(viaProxy)).toBe(true);
    }, 60_000);
  });

  describe('keeps the connection\'s certificate choice through the proxy', () => {
    it('refuses a self-signed server when verification is on', async () => {
      const outcomes = await runChild({
        script: childScript({ serverUrl: httpsUrl(), verify: true }),
        env: { https_proxy: proxyUrl, ...SWITCH_ON },
      });

      expect(outcomes).toHaveLength(4);
      for (const outcome of outcomes) {
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toMatch(CERTIFICATE_ERROR);
      }
      expect(tunnels.length).toBeGreaterThan(0);
      expect(httpsSeen).toEqual([]);
    }, 60_000);

    // The tunnel ignores `connect`; without `requestTls` this request would follow the variable.
    it('refuses it even with NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment', async () => {
      const outcomes = await runChild({
        script: childScript({ serverUrl: httpsUrl(), verify: true }),
        env: { https_proxy: proxyUrl, NODE_TLS_REJECT_UNAUTHORIZED: '0', ...SWITCH_ON },
      });

      for (const outcome of outcomes) {
        expect(outcome.error).toMatch(CERTIFICATE_ERROR);
      }
      expect(httpsSeen).toEqual([]);
    }, 60_000);

    it('reaches it when verification is on and its certificate is trusted through NODE_EXTRA_CA_CERTS', async () => {
      const outcomes = await runChild({
        script: childScript({ serverUrl: httpsUrl(), verify: true }),
        env: { https_proxy: proxyUrl, NODE_EXTRA_CA_CERTS: certFile, ...SWITCH_ON },
      });

      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
      expect(httpsSeen.every(viaProxy)).toBe(true);
      expect(httpsSeen).toHaveLength(EXPECTED_REQUESTS.length);
    }, 60_000);

    // The case that breaks if the agent sets only `connect`: the tunnel would verify anyway.
    it('reaches it when verification is off', async () => {
      const outcomes = await runChild({
        script: childScript({ serverUrl: httpsUrl(), verify: false }),
        env: { https_proxy: proxyUrl, ...SWITCH_ON },
      });

      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
      expect(httpsSeen.every(viaProxy)).toBe(true);
      expect(httpsSeen).toHaveLength(EXPECTED_REQUESTS.length);
    }, 60_000);

    it('reaches it when ORO_SERVER_VERIFY_TLS=false turns verification off for Internal infrastructure', async () => {
      const outcomes = await runChild({
        script: childScript({ serverUrl: httpsUrl(), verify: true, internal: true }),
        env: { https_proxy: proxyUrl, ORO_SERVER_VERIFY_TLS: 'false', ...SWITCH_ON },
      });

      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
      expect(httpsSeen.map((seen) => seen.request)).toEqual(EXPECTED_REQUESTS);
      expect(httpsSeen.every(viaProxy)).toBe(true);
    }, 60_000);
  });

  it.each([
    ['NO_PROXY=127.0.0.1', { NO_PROXY: '127.0.0.1' }, 'http'],
    ['NO_PROXY=localhost', { NO_PROXY: 'localhost' }, 'https'],
    ['no_proxy=localhost', { no_proxy: 'localhost' }, 'https'],
  ] as const)('connects directly to a host listed in %s', async (_label, noProxy, scheme) => {
    const seen = scheme === 'http' ? httpSeen : httpsSeen;
    const outcomes = await runChild({
      script: childScript({ serverUrl: scheme === 'http' ? httpUrl() : httpsUrl(), verify: false }),
      env: { http_proxy: proxyUrl, https_proxy: proxyUrl, ...noProxy, ...SWITCH_ON },
    });

    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
    expect(seen.map((entry) => entry.request)).toEqual(EXPECTED_REQUESTS);
    expect(seen.some(viaProxy)).toBe(false);
    expect(tunnels).toEqual([]);
  }, 60_000);

  it('sends the credentials in the proxy URL to the proxy only', async () => {
    const outcomes = await runChild({
      script: childScript({ serverUrl: httpUrl(), verify: true }),
      env: { http_proxy: proxyUrl.replace('http://', 'http://u:p@'), ...SWITCH_ON },
    });

    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
    expect(httpSeen.every(viaProxy)).toBe(true);
    expect(tunnels.length).toBeGreaterThan(0);
    for (const tunnel of tunnels) {
      expect(tunnel.proxyAuthorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    }
    expect(httpSeen).toHaveLength(EXPECTED_REQUESTS.length);
    for (const seen of httpSeen) {
      expect(seen.proxyAuthorization).toBeUndefined();
    }
  }, 60_000);
});
