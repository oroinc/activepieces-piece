import { createCustomApiCallAction, HttpError } from '@activepieces/pieces-common';
import { tryCatch } from '@activepieces/pieces-framework';
import {
  formatError,
  getAccessToken,
  getBaseHeaders,
  getOroAdminApiBaseUrl,
  invalidateAccessToken,
  mergeHeaders,
  oroAuth,
  toHeaderRecord,
} from '../common';
import { withConnection } from '../common/tls';
import type { OroAuth } from '../common/types';

const upstreamAction = createCustomApiCallAction({
  auth: oroAuth,
  name: 'custom_api_call',
  displayName: 'Custom API Call',
  description: 'Make a direct authenticated call to the OroCommerce JSON:API.',
  baseUrl: (auth) => (auth ? getOroAdminApiBaseUrl({ auth }) : ''),
  // Upstream spreads the step's headers first and these over them, so each name here keeps the
  // spelling the step gave it, or a step header in another case than the connection's would lose.
  authMapping: async (auth, propsValue: Record<string, unknown>) => ({
    ...mergeHeaders(getBaseHeaders({ auth }), toHeaderRecord({ value: propsValue['headers'] })),
    Authorization: `Bearer ${await getAccessToken({ auth })}`,
  }),
  props: {
    headers: {
      defaultValue: {
        'Accept': 'application/vnd.api+json',
        'X-Include': 'noHateoas;totalCount',
      },
    },
  },
});

type RunContext = Parameters<typeof upstreamAction.run>[0];

// Captured before the replacement below, or the wrapper would call itself.
const upstreamRun = upstreamAction.run.bind(upstreamAction);

/**
 * Give the shared HTTP action the same stale-token recovery every other action gets.
 *
 * The token is cached and reused until it is due to expire. Oro can end it sooner - the OAuth
 * application is regenerated, the server is reset - and then the cached copy is simply wrong.
 * oroApiCall answers a 401 by dropping the cached token and trying once more with a fresh one. This
 * action went straight through to the shared client, so the 401 reached the flow and, worse, the
 * dead token stayed in the cache: every later run failed the same way until it expired on its own.
 *
 * The action itself is upstream's, props and all, and it is left that way - its props are its public
 * surface and the metadata snapshot pins them. Only run is wrapped.
 */
async function runWithStaleTokenRetry(context: RunContext): Promise<unknown> {
  const auth = context.auth as OroAuth;
  // Read from the cache, so the retry can tell the token that just failed from one a parallel step
  // has already replaced. No request is made unless the cache is empty.
  const usedToken = await getAccessToken({ auth });
  // Upstream's run sends its request with no options, so the connection's TLS setting reaches the
  // shared client through this scope rather than as an argument.
  const run = () => withConnection({ auth }, () => upstreamRun(context));

  const first = await tryCatch(run);

  if (!first.error) {
    // With "Return Error as Output" on, a 401 comes back as output instead of being thrown.
    if (!isUnauthorizedOutput(first.data)) {
      return first.data;
    }
    invalidateAccessToken({ auth, token: usedToken });
    return await run();
  }

  if (!(first.error instanceof HttpError) || first.error.response.status !== 401) {
    throw first.error;
  }

  invalidateAccessToken({ auth, token: usedToken });

  return await run();
}

/**
 * Report every failure the way oroApiCall does: the status and the response body, nothing else.
 *
 * Upstream's HttpError writes the request body into its message, and the message is what the run
 * shows as the step's error. Two paths used to throw past formatError - the token fetched before
 * the first call, and the second run after a 401 returned as output - and on a failed token request
 * that body is the client id and secret. Formatting here, where every error leaves, covers both and
 * any path added later.
 */
async function runWithFormattedErrors(context: RunContext): Promise<unknown> {
  const { data, error } = await tryCatch(() => runWithStaleTokenRetry(context));
  if (error) {
    throw new Error(formatError({ error }));
  }
  return data;
}

function isUnauthorizedOutput(value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const response = (value as { response?: unknown }).response;
  if (response === null || typeof response !== 'object') {
    return false;
  }
  return (response as { status?: unknown }).status === 401;
}

// `run` and `test` are declared readonly for callers of the framework; replacing them here is
// deliberate, and keeps every other field - name, displayName, description, props - exactly as
// upstream built them. `test` is what the builder runs when a step is tested, and createAction
// defaults it to the same function as `run`, so it needs the same treatment or testing a step would
// still fail on a stale token.
const mutable = upstreamAction as unknown as {
  run: (context: RunContext) => Promise<unknown>;
  test: (context: RunContext) => Promise<unknown>;
};
mutable.run = runWithFormattedErrors;
mutable.test = runWithFormattedErrors;

export const customApiCallAction = upstreamAction;
