import { AsyncLocalStorage } from 'node:async_hooks';

import { Agent, type Dispatcher } from 'undici';

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
 */
const verifyingAgent = new Agent({ connect: { rejectUnauthorized: true } });

/**
 * For a connection whose "Verify TLS certificate" is off: a private or self-signed server the user
 * trusts. It is handed to that connection's requests one by one, like the verifying agent, so nothing
 * else changes: no environment variable, no global dispatcher, and every other connection and piece
 * in the worker keeps verifying.
 */
const nonVerifyingAgent = new Agent({ connect: { rejectUnauthorized: false } });

/**
 * The one place that decides how a request reaches the connection's server. Anything later added to
 * that, such as a proxy, belongs here, so every request path picks it up at once.
 *
 * Only an explicit false turns verification off. A connection saved before the option existed has no
 * value for it at all, and it keeps verifying, as does a request made with no connection.
 */
export function dispatcherForConnection({ auth }: { auth: OroAuth | undefined }): Dispatcher {
  return auth?.props.verifyTlsCertificate === false ? nonVerifyingAgent : verifyingAgent;
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
