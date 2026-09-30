import { Agent } from 'undici';

import { httpClient } from '@activepieces/pieces-common';
import type { SendRequestOptions } from '@activepieces/pieces-common';

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
 * dependency. It has to stay on the major Node bundles (7.x for Node 24): a dispatcher built by a
 * different major is rejected with UND_ERR_INVALID_ARG, because the handler interface it implements
 * is not the one Node's own copy of undici calls.
 *
 * The patch below is what reaches upstream's shared HTTP action. createCustomApiCallAction builds
 * its request internally and calls sendRequest with no options, so there is no argument to pass a
 * dispatcher through - and reimplementing that action to get one would change the props that make up
 * its public surface. Wrapping the client the action already calls leaves the action untouched and
 * covers every other caller in one place.
 */
const verifyingAgent = new Agent({ connect: { rejectUnauthorized: true } });

export function requestOptionsWithTlsVerification(
  options?: SendRequestOptions
): SendRequestOptions {
  return { ...options, dispatcher: options?.dispatcher ?? verifyingAgent };
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
