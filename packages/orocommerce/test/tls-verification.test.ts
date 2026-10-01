import { execFileSync, spawnSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Agent } from 'undici';

import { AppConnectionType } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { oroApiCall } from '../src/lib/common';
import { requestOptionsWithTlsVerification } from '../src/lib/common/tls';

const PACKAGE_ROOT = join(__dirname, '..');
const BUNDLE = join(PACKAGE_ROOT, 'dist', 'src', 'index.js');
const UNDICI_VERSION = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, '..', '..', 'node_modules', 'undici', 'package.json'), 'utf8')
).version as string;

let certDir = '';

/** A local CA, and a localhost certificate signed by it, so both trust outcomes can be exercised. */
function issueCertificates(): { ca: string; cert: string; key: string } {
  const ca = join(certDir, 'ca.pem');
  const caKey = join(certDir, 'ca.key');
  const cert = join(certDir, 'server.pem');
  const key = join(certDir, 'server.key');
  const csr = join(certDir, 'server.csr');
  const ext = join(certDir, 'server.ext');

  writeFileSync(ext, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  const run = (args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });

  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', caKey, '-out', ca, '-subj', '/CN=Oro piece test CA']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr,
    '-subj', '/CN=localhost']);
  run(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial',
    '-days', '2', '-extfile', ext, '-out', cert]);

  return { ca, cert, key };
}

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'oro-tls-'));
});

afterAll(() => {
  rmSync(certDir, { recursive: true, force: true });
});

describe('certificate verification survives a worker that turned it off', () => {
  const originalEnv = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  let httpsPort = 0;
  let httpPort = 0;
  let httpsServer: ReturnType<typeof createHttpsServer>;
  let httpServer: ReturnType<typeof createHttpServer>;

  beforeAll(async () => {
    const { cert, key } = issueCertificates();
    const respond = (url: string | undefined, res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        url === '/oauth2-token'
          ? JSON.stringify({ access_token: 'token', expires_in: 3600 })
          : JSON.stringify({ data: [] })
      );
    };

    httpsServer = createHttpsServer(
      { cert: readFileSync(cert), key: readFileSync(key) },
      (req, res) => respond(req.url, res)
    );
    httpServer = createHttpServer((req, res) => respond(req.url, res));

    await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    httpsPort = (httpsServer.address() as { port: number }).port;
    httpPort = (httpServer.address() as { port: number }).port;

    // What another piece sharing this worker does to the whole process.
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  });

  afterAll(async () => {
    if (originalEnv === undefined) {
      delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    } else {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = originalEnv;
    }
    await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const authFor = (url: string, secret: string) =>
    ({
      type: AppConnectionType.CUSTOM_AUTH,
      props: {
        serverUrl: url,
        adminPrefix: 'admin',
        clientId: 'client-id',
        clientSecret: secret,
        isInternalInfrastructure: false,
      },
    }) as Parameters<typeof oroApiCall>[0]['auth'];

  it('refuses a certificate it cannot verify, and says why', async () => {
    await expect(
      oroApiCall({
        method: HttpMethod.GET,
        resourceUri: 'regions/US-CA',
        auth: authFor(`https://localhost:${httpsPort}`, 'untrusted'),
      })
    ).rejects.toThrow(/CERT|SELF_SIGNED|certificate/i);
  });

  it('leaves plain HTTP alone', async () => {
    const response = await oroApiCall({
      method: HttpMethod.GET,
      resourceUri: 'regions/US-CA',
      auth: authFor(`http://127.0.0.1:${httpPort}`, 'plain-http'),
    });

    expect(response.status).toBe(200);
  });
});

/**
 * The piece hands Node's own `fetch` a dispatcher built by the `undici` in its bundle, and the two
 * are separate copies of the library. They agree today, but they are versioned apart: undici 8
 * reworked the handler interface, and a dispatcher built by it is refused by every Node released so
 * far with `UND_ERR_INVALID_ARG`. That would take certificate verification down at runtime, on the
 * first request a flow makes, with nothing failing at build time to warn anyone.
 *
 * So the pairing is exercised here rather than assumed. Versions are deliberately not compared: the
 * piece is on undici 7 while Node 20 and 22 bundle undici 6, and that combination is fine. Only the
 * real request can say.
 */
describe('the dispatcher is one this Node accepts', () => {
  const versions = () =>
    `piece undici ${UNDICI_VERSION}, Node ${process.version} bundling undici ${process.versions.undici}`;

  it('is honoured by the global fetch, rather than refused or ignored', async () => {
    const { cert, key, ca } = issueCertificates();
    const server = createHttpsServer({ cert: readFileSync(cert), key: readFileSync(key) },
      (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };

    try {
      // Trusted through the dispatcher rather than the environment, so no restart is needed.
      const trusting = new Agent({ connect: { rejectUnauthorized: true, ca: readFileSync(ca) } });
      const response = await fetch(`https://localhost:${port}/`, {
        dispatcher: trusting,
      } as RequestInit);

      expect(response.status, `a valid chain should be accepted (${versions()})`).toBe(200);
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      throw new Error(
        code === 'UND_ERR_INVALID_ARG'
          ? `Node refused the dispatcher this piece builds, so certificate verification would be off at runtime (${versions()}). Align the undici dependency with a major this Node accepts.`
          : `the request failed with ${code ?? String(error)} (${versions()})`
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('is what the piece actually sends, and it carries rejectUnauthorized', () => {
    const dispatcher = requestOptionsWithTlsVerification().dispatcher;

    expect(dispatcher, `no dispatcher is attached to outgoing requests (${versions()})`).toBeDefined();
    expect(typeof (dispatcher as { dispatch?: unknown }).dispatch).toBe('function');
  });
});

/**
 * The bundle-time half of the fix, which only exists in the artifact: scripts/bundle.mjs cuts
 * upstream's NODE_TLS_REJECT_UNAUTHORIZED assignment out of what gets published. Running the built
 * piece in its own process is the only way to see that, because the sources under test still carry
 * the assignment.
 */
describe('the built artifact', () => {
  const describeIfBuilt = existsSync(BUNDLE) ? describe : describe.skip;

  it('is present, or these checks cannot run', () => {
    expect(existsSync(BUNDLE), `${BUNDLE} is missing. Run "npm run bundle" first.`).toBe(true);
  });

  describeIfBuilt('runs a real request', () => {
    /** Drive the packed piece in a child process, so NODE_EXTRA_CA_CERTS can be set at startup. */
    function validateInChildProcess({
      trustCa,
      rejectUnauthorized,
    }: {
      trustCa: string | undefined;
      rejectUnauthorized: string | undefined;
    }): { valid: boolean; error?: string; envAfter: string | null } {
      const { ca, cert, key } = issueCertificates();
      const script = `
        import { createServer } from 'node:https';
        import { readFileSync } from 'node:fs';
        const server = createServer(
          { cert: readFileSync(${JSON.stringify(cert)}), key: readFileSync(${JSON.stringify(key)}) },
          (req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(req.url === '/oauth2-token'
              ? JSON.stringify({ access_token: 'token', expires_in: 3600 })
              : JSON.stringify({ data: [] }));
          });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const { orocommerce } = await import(${JSON.stringify(BUNDLE)});
        const result = await orocommerce.auth.validate({
          auth: {
            serverUrl: 'https://localhost:' + port,
            adminPrefix: 'admin',
            clientId: 'client-id',
            clientSecret: 'secret',
            isInternalInfrastructure: false,
          },
        });
        console.log('RESULT ' + JSON.stringify({
          ...result,
          envAfter: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null,
        }));
        server.close();
      `;

      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env['NODE_TLS_REJECT_UNAUTHORIZED'];
      delete env['NODE_EXTRA_CA_CERTS'];
      if (trustCa !== undefined) env['NODE_EXTRA_CA_CERTS'] = trustCa === 'ca' ? ca : trustCa;
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

    it('rejects an untrusted certificate even when the process says not to verify', () => {
      const result = validateInChildProcess({ trustCa: undefined, rejectUnauthorized: '0' });

      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/CERT|SELF_SIGNED|certificate/i);
    });

    it('accepts a certificate signed by a trusted authority', () => {
      const result = validateInChildProcess({ trustCa: 'ca', rejectUnauthorized: '0' });

      expect(result).toMatchObject({ valid: true });
    });

    it('never sets NODE_TLS_REJECT_UNAUTHORIZED itself', () => {
      const result = validateInChildProcess({ trustCa: 'ca', rejectUnauthorized: undefined });

      expect(result).toMatchObject({ valid: true });
      expect(result.envAfter).toBeNull();
    });
  });
});
