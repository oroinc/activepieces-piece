import { AsyncLocalStorage } from 'node:async_hooks';

import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici';

import { httpClient } from '@activepieces/pieces-common';
import type { SendRequestOptions } from '@activepieces/pieces-common';

import type { OroAuth } from './types';

/**
 * Keep certificate verification on for every request this piece makes.
 *
 * Two things work against that, and each needs its own answer.
 *
 * The first is upstream's own HTTP client, which sets NODE_TLS_REJECT_UNAUTHORIZED to '0' at the top
 * of every sendRequest. scripts/bundle.mjs strips that assignment out of the artifact, so our copy
 * of the client no longer disables verification.
 *
 * The second is that the variable is process-wide. Pieces share a worker, so any other piece that
 * still carries the assignment turns verification off for everything running beside it, including
 * us. Stripping our copy cannot fix that. What does fix it is an explicit rejectUnauthorized on the
 * request itself: passed to the TLS socket directly, it is read instead of the environment variable,
 * whatever the variable happens to say at that moment.
 *
 * Node's fetch takes that as an undici Dispatcher under `dispatcher`, which is why undici is a
 * dependency. The version needs care, though not version matching: undici 6 and 7 are both accepted
 * by Node 20, 22 and 24, whichever of the two those Node versions bundle themselves. undici 8 is
 * not. It reworked the handler interface, so a dispatcher built by it is refused with
 * UND_ERR_INVALID_ARG by every Node released so far, and the piece would lose certificate
 * verification on the first request a flow makes. test/tls-verification.test.ts sends a real request
 * through the global fetch to keep that from reaching a release.
 *
 * The patch below is what reaches upstream's shared HTTP action. createCustomApiCallAction builds
 * its request internally and calls sendRequest with no options, so there is no argument to pass a
 * dispatcher through - and reimplementing that action to get one would change the props that make up
 * its public surface. Wrapping the client the action already calls leaves the action untouched and
 * covers every other caller in one place.
 *
 * The proxy is one switch for the whole service, not a setting of this piece: with Node's
 * NODE_USE_ENV_PROXY=1, every fetch in the engine follows http_proxy, https_proxy and no_proxy. This
 * piece follows the same switch only because it must pass its own dispatcher to keep certificate
 * verification, and that replaces the one Node installs for the proxy. So the agents go through the
 * proxy exactly when Node's fetch does, and they read the variables the way it does: undici's
 * defaults match Node's in the names and their letter case (lower case first, https falling back to
 * http_proxy) and, from Node 24.14.1, in how no_proxy matches, so no httpProxy, httpsProxy or
 * noProxy is passed. Like Node, the switch and the proxy URLs are read once, when this module loads,
 * so they have to be in the engine's environment when it starts. Activepieces passes a variable from
 * the worker to the engine only if AP_SANDBOX_PROPAGATED_ENV_VARS lists it.
 *
 * The TLS options go in twice. `connect` is used when the agent connects to the server directly.
 * Through a CONNECT proxy, undici replaces `connect` with its own tunnel and starts TLS with the
 * server from `requestTls` instead, so without it a proxied request would ignore the connection's
 * choice and fall back to whatever NODE_TLS_REJECT_UNAUTHORIZED says. The proxy's own TLS
 * (`proxyTls`) is left at its defaults, so an https proxy with a private CA is not covered.
 */
function agentFor(tls: { rejectUnauthorized: boolean }): Dispatcher {
  return useEnvProxy ? new EnvHttpProxyAgent({ connect: tls, requestTls: tls }) : new Agent({ connect: tls });
}

/**
 * Node's own decision: NODE_USE_ENV_PROXY set to exactly 1, or --use-env-proxy in NODE_OPTIONS or on
 * the command line, in any of the spellings Node accepts. Of --use-env-proxy and --no-use-env-proxy
 * the last one wins, and the command line comes after NODE_OPTIONS. A Node without the option
 * ignores all of them, and so does this.
 */
function nodeUsesEnvProxy(): boolean {
  if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
    return false;
  }
  let enabled = process.env['NODE_USE_ENV_PROXY'] === '1';
  const nodeOptions = (process.env['NODE_OPTIONS'] ?? '').split(/\s+/).map((option) => option.replace(/^"(.*)"$/, '$1'));
  for (const option of [...nodeOptions, ...process.execArgv]) {
    const name = option.replace(/=.*$/, '').replace(/_/g, '-');
    if (name === '--use-env-proxy') {
      enabled = true;
    } else if (name === '--no-use-env-proxy') {
      enabled = false;
    }
  }
  return enabled;
}

const useEnvProxy = nodeUsesEnvProxy();

const verifyingAgent = agentFor({ rejectUnauthorized: true });

/**
 * For a connection whose "Verify TLS certificate" is off, or that ORO_SERVER_VERIFY_TLS turns off: a
 * private or self-signed server the user trusts. It is handed to that connection's requests one by
 * one, like the verifying agent, so nothing else changes: no environment variable is set, no global
 * dispatcher, and every other connection and piece in the worker keeps verifying.
 */
const nonVerifyingAgent = agentFor({ rejectUnauthorized: false });

/**
 * The one place that decides how a request reaches the connection's server, directly or through
 * the proxy, so every request path picks up the same choice at once.
 *
 * For a connection marked Internal infrastructure, ORO_SERVER_VERIFY_TLS decides when it is set.
 * Otherwise only an explicit false turns verification off. A connection saved before the option
 * existed has no value for it at all, and it keeps verifying, as does a request made with no
 * connection.
 */
export function dispatcherForConnection({ auth }: { auth: OroAuth | undefined }): Dispatcher {
  const fromEnvironment = auth && isInternalInfrastructure({ auth }) ? verifyTlsFromEnvironment() : undefined;
  const verify = fromEnvironment ?? auth?.props.verifyTlsCertificate !== false;
  return verify ? verifyingAgent : nonVerifyingAgent;
}

// Here rather than in client.ts, which imports this module, so that the two do not import each other.
export function isInternalInfrastructure({ auth }: { auth: OroAuth }): boolean {
  return auth.props.isInternalInfrastructure;
}

const VERIFY_TLS_ON = new Set(['true', '1', 'yes', 'on']);
const VERIFY_TLS_OFF = new Set(['false', '0', 'no', 'off']);
let reportedUnknownVerifyTls = false;

/**
 * ORO_SERVER_VERIFY_TLS for a connection marked Internal infrastructure: true or false, or undefined
 * when it is unset or empty and the connection's own option decides.
 *
 * A deployment sets one variable instead of editing each connection: the connections it creates for
 * itself are marked Internal infrastructure and keep "Verify TLS certificate" at its default. It works
 * like ORO_SERVER_URL and ORO_SERVER_USER_AGENT in client.ts: only for those connections, and read on
 * every request rather than at load, so it also covers connections that already exist. Like them, it
 * reaches the engine only if AP_SANDBOX_PROPAGATED_ENV_VARS lists it.
 *
 * A value it does not understand verifies, so a typo cannot turn verification off. It is reported
 * once per process, not on every request.
 */
function verifyTlsFromEnvironment(): boolean | undefined {
  const raw = process.env['ORO_SERVER_VERIFY_TLS'] ?? '';
  const value = raw.trim().toLowerCase();
  if (value === '') {
    return undefined;
  }
  if (VERIFY_TLS_OFF.has(value)) {
    return false;
  }
  if (!VERIFY_TLS_ON.has(value) && !reportedUnknownVerifyTls) {
    reportedUnknownVerifyTls = true;
    console.error(`[OroCommerce] ORO_SERVER_VERIFY_TLS="${raw}" not understood, verifying certificates`);
  }
  return true;
}

/**
 * The connection of a call into upstream code that sends its request with no options, which is how
 * the Custom API Call reaches the client: there is no argument to carry the connection, so it travels
 * with the async context instead. The store is this module's own and only the patch below reads it.
 */
const connectionScope = new AsyncLocalStorage<OroAuth>();

export function withConnection<T>({ auth }: { auth: OroAuth }, fn: () => T): T {
  return connectionScope.run(auth, fn);
}

export function requestOptionsWithTlsVerification(
  options?: SendRequestOptions
): SendRequestOptions {
  return {
    ...options,
    dispatcher: options?.dispatcher ?? dispatcherForConnection({ auth: connectionScope.getStore() }),
  };
}

let patched = false;

export function enforceTlsVerification(): void {
  if (patched) {
    return;
  }
  patched = true;

  const client = httpClient as {
    sendRequest: (request: unknown, options?: SendRequestOptions) => Promise<unknown>;
  };
  const original = client.sendRequest.bind(client);

  client.sendRequest = (request: unknown, options?: SendRequestOptions) =>
    original(request, requestOptionsWithTlsVerification(options));
}

enforceTlsVerification();
