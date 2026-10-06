import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * One Activepieces can hold a connection to an internal Oro and one to an external Oro at the same
 * time. The environment is set the way a deployment sets it for the internal one, and both kinds of
 * connection then run side by side in one process of the built artifact: ORO_SERVER_URL,
 * ORO_SERVER_USER_AGENT and ORO_SERVER_VERIFY_TLS must change the internal connection only, and
 * NO_PROXY must take the internal host off the proxy while the external connection still goes
 * through it.
 *
 * Both host names are this machine. The internal Oro is reached as 127.0.0.1, which NO_PROXY lists,
 * and the external ones as localhost, which it does not, so the proxy carries them.
 */
const BUNDLE = join(__dirname, '..', 'dist', 'src', 'index.js');
const CERTIFICATE_ERROR = /DEPTH_ZERO_SELF_SIGNED_CERT|self[- ]signed certificate/i;
const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
const DEFAULT_USER_AGENT = `oroinc-piece-orocommerce/${version}`;
const INTERNAL_USER_AGENT = 'internal-integration/2.0';
/**
 * Node 20 has no switch: its fetch connects directly whatever the proxy variables say, and so does
 * the piece. There the external connection is expected to connect directly too.
 */
const NODE_HAS_ENV_PROXY = process.allowedNodeEnvironmentFlags.has('--use-env-proxy');

type ServerName = 'internal' | 'external' | 'selfSigned';
type Seen = { server: ServerName; request: string; client: string; userAgent?: string; remotePort?: number };
type Tunnel = { authority: string; upstreamPort: number };
type Outcome = { connection: string; path: string; ok: boolean; error?: string };

/**
 * Answers like Oro would, and records which connection each request belongs to: the token request
 * names its client id, and the token it hands out names it again on every API call.
 */
function oroLike(server: ServerName, seen: Seen[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const bearer = /^Bearer token-for-(.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const client = req.url === '/oauth2-token' ? new URLSearchParams(body).get('client_id') : bearer;
      seen.push({
        server,
        request: `${req.method} ${req.url}`,
        client: client ?? '(none)',
        userAgent: req.headers['user-agent'],
        remotePort: req.socket.remotePort,
      });
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/oauth2-token') {
        return json(200, { access_token: `token-for-${client}`, expires_in: 3600 });
      }
      if (req.method === 'POST' && req.url === '/admin/api/customers') {
        return json(201, { data: { type: 'customers', id: '7' } });
      }
      return json(200, { data: [] });
    });
  };
}

/** Logs each tunnel with the local port of its socket to the target, the remote port the target sees. */
function connectProxy(tunnels: Tunnel[]) {
  const proxy = createHttpServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxy.on('connect', (req: IncomingMessage, client, head: Buffer) => {
    const [host, port] = (req.url ?? '').split(':');
    const upstream = connect(Number(port), host === 'localhost' ? '127.0.0.1' : host, () => {
      tunnels.push({ authority: req.url ?? '', upstreamPort: upstream.localPort ?? 0 });
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

/**
 * Three connections, each taking the token, an action and the Custom API Call, all nine started at
 * once. The internal one names the external Oro as its Server URL, as a connection copied from an
 * external one would; ORO_SERVER_URL has to send it elsewhere. Each path has its own client secret,
 * so each fetches its own token.
 */
function childScript({ externalUrl, selfSignedUrl }: { externalUrl: string; selfSignedUrl: string }): string {
  return `
    const { orocommerce } = await import(${JSON.stringify(BUNDLE)});
    const connections = {
      internal: { serverUrl: ${JSON.stringify(externalUrl)}, clientId: 'internal', isInternalInfrastructure: true },
      external: { serverUrl: ${JSON.stringify(externalUrl)}, clientId: 'external', isInternalInfrastructure: false },
      selfSigned: { serverUrl: ${JSON.stringify(selfSignedUrl)}, clientId: 'self-signed', isInternalInfrastructure: false },
    };
    const props = (connection, secret) => ({
      ...connections[connection], adminPrefix: 'admin', clientSecret: secret, verifyTlsCertificate: true,
    });
    const auth = (connection, secret) => ({ type: 'CUSTOM_AUTH', props: props(connection, secret) });
    const paths = {
      token: async (connection) => {
        const result = await orocommerce.auth.validate({ auth: props(connection, 'validate') });
        if (!result.valid) throw new Error(result.error);
      },
      action: (connection) => orocommerce.getAction('create_customer').run({
        auth: auth(connection, 'action'), propsValue: { name: 'ACME' },
      }),
      customApiCall: (connection) => orocommerce.getAction('custom_api_call').run({
        auth: auth(connection, 'custom'),
        propsValue: {
          url: { url: 'regions' }, method: 'GET', headers: {}, queryParams: {},
          body_type: 'none', body: undefined, failsafe: false, timeout: 0, response_is_binary: false, followRedirects: false,
        },
        files: { write: async () => '' },
      }),
    };
    const runs = Object.keys(connections).flatMap((connection) =>
      Object.entries(paths).map(([path, run]) => ({ connection, path, run })));
    const outcomes = await Promise.all(runs.map(async ({ connection, path, run }) => {
      try {
        await run(connection);
        return { connection, path, ok: true };
      } catch (error) {
        return { connection, path, ok: false, error: [error.message, error.cause?.code].join(' ') };
      }
    }));
    console.log('RESULT ' + JSON.stringify(outcomes));
  `;
}

/** Spawned, not spawnSync: the servers answering the child live in this process's event loop. */
function runChild({ script, env }: { script: string; env: Record<string, string> }): Promise<Outcome[]> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'NODE_OPTIONS',
    'ORO_SERVER_URL', 'ORO_SERVER_USER_AGENT', 'ORO_SERVER_VERIFY_TLS']) {
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

const PATH_REQUESTS = [
  'GET /admin/api/regions',
  'GET /admin/api/regions/US-CA',
  'POST /admin/api/customers',
  'POST /oauth2-token',
  'POST /oauth2-token',
  'POST /oauth2-token',
];

const describeIfBuilt = existsSync(BUNDLE) ? describe : describe.skip;

describeIfBuilt('an internal and an external connection in one process', () => {
  const seen: Seen[] = [];
  const tunnels: Tunnel[] = [];
  const servers: Array<{ close: (done: () => void) => unknown }> = [];
  let certDir = '';
  let internalAuthority = '';
  let externalAuthority = '';
  let selfSignedAuthority = '';
  let outcomes: Outcome[] = [];

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'oro-two-connections-'));
    // Three self-signed certificates. Only the external Oro's is trusted, through NODE_EXTRA_CA_CERTS.
    const certificate = (name: string) => {
      const cert = join(certDir, `${name}.pem`);
      const key = join(certDir, `${name}.key`);
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
        '-keyout', key, '-out', cert, '-subj', '/CN=localhost'], { stdio: 'pipe' });
      return { cert: readFileSync(cert), key: readFileSync(key), file: cert };
    };
    const internalCertificate = certificate('internal');
    const externalCertificate = certificate('external');
    const selfSignedCertificate = certificate('self-signed');

    const listen = (server: { listen: (port: number, host: string, done: () => void) => unknown; address: () => unknown; close: (done: () => void) => unknown }) =>
      new Promise<number>((resolve) => {
        servers.push(server);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
      });
    const internalPort = await listen(createHttpsServer(internalCertificate, oroLike('internal', seen)));
    const externalPort = await listen(createHttpsServer(externalCertificate, oroLike('external', seen)));
    const selfSignedPort = await listen(createHttpsServer(selfSignedCertificate, oroLike('selfSigned', seen)));
    const proxyUrl = `http://127.0.0.1:${await listen(connectProxy(tunnels))}`;
    internalAuthority = `127.0.0.1:${internalPort}`;
    externalAuthority = `localhost:${externalPort}`;
    selfSignedAuthority = `localhost:${selfSignedPort}`;

    outcomes = await runChild({
      script: childScript({ externalUrl: `https://${externalAuthority}`, selfSignedUrl: `https://${selfSignedAuthority}` }),
      env: {
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        NO_PROXY: '127.0.0.1',
        NODE_EXTRA_CA_CERTS: externalCertificate.file,
        ORO_SERVER_URL: `https://${internalAuthority}`,
        ORO_SERVER_USER_AGENT: INTERNAL_USER_AGENT,
        ORO_SERVER_VERIFY_TLS: 'false',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); })));
    rmSync(certDir, { recursive: true, force: true });
  });

  const viaProxy = (entry: Seen) => tunnels.some((tunnel) => tunnel.upstreamPort === entry.remotePort);
  const requestsOf = (client: string) => seen.filter((entry) => entry.client === client);
  const outcomesOf = (connection: string) => outcomes.filter((outcome) => outcome.connection === connection);

  it('sends the internal connection to ORO_SERVER_URL, directly, with ORO_SERVER_USER_AGENT and no certificate check', () => {
    expect(outcomesOf('internal')).toEqual([
      { connection: 'internal', path: 'token', ok: true },
      { connection: 'internal', path: 'action', ok: true },
      { connection: 'internal', path: 'customApiCall', ok: true },
    ]);
    const requests = requestsOf('internal');
    expect(requests.map((entry) => entry.request).sort()).toEqual(PATH_REQUESTS);
    for (const entry of requests) {
      expect(entry.server).toBe('internal');
      expect(entry.userAgent).toBe(INTERNAL_USER_AGENT);
      expect(viaProxy(entry)).toBe(false);
    }
    expect(tunnels.map((tunnel) => tunnel.authority)).not.toContain(internalAuthority);
  });

  it(`sends the external connection to its own Server URL ${NODE_HAS_ENV_PROXY ? 'through the proxy' : 'directly, as this Node has no env proxy'}, with the default User-Agent`, () => {
    expect(outcomesOf('external').filter((outcome) => !outcome.ok)).toEqual([]);
    const requests = requestsOf('external');
    expect(requests.map((entry) => entry.request).sort()).toEqual(PATH_REQUESTS);
    for (const entry of requests) {
      expect(entry.server).toBe('external');
      expect(entry.userAgent).toBe(DEFAULT_USER_AGENT);
      expect(viaProxy(entry)).toBe(NODE_HAS_ENV_PROXY);
    }
    expect(tunnels.some((tunnel) => tunnel.authority === externalAuthority)).toBe(NODE_HAS_ENV_PROXY);
  });

  it('keeps verifying on the external connection: a self-signed external server is refused', () => {
    const refused = outcomesOf('selfSigned');
    expect(refused).toHaveLength(3);
    for (const outcome of refused) {
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(CERTIFICATE_ERROR);
    }
    expect(seen.filter((entry) => entry.server === 'selfSigned')).toEqual([]);
    expect(tunnels.some((tunnel) => tunnel.authority === selfSignedAuthority)).toBe(NODE_HAS_ENV_PROXY);
  });

  it('sends no request of one connection to the other\'s server, and only external hosts through the proxy', () => {
    expect(seen.filter((entry) => entry.server === 'external' && entry.client !== 'external')).toEqual([]);
    expect(seen.filter((entry) => entry.server === 'internal' && entry.client !== 'internal')).toEqual([]);
    expect(tunnels.every((tunnel) => [externalAuthority, selfSignedAuthority].includes(tunnel.authority))).toBe(true);
  });
});
