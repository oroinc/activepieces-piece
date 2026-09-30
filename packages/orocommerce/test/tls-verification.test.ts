import { execFileSync, spawnSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppConnectionType } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { oroApiCall } from '../src/lib/common';

const PACKAGE_ROOT = join(__dirname, '..');
const BUNDLE = join(PACKAGE_ROOT, 'dist', 'src', 'index.js');

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
