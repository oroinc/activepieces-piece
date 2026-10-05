import { HttpError } from '@activepieces/pieces-common';

/**
 * One line in the worker's log for every request of this piece that fails.
 *
 * Upstream's shared client prints the whole HttpError when a request fails, and that error carries
 * the request body: on a failed token request the client id and secret, on any other call the record
 * being sent. scripts/bundle.mjs takes that print out of the artifact. On its own that left the
 * worker's log with nothing at all, and step errors are only stored with the run, never logged, so
 * support had no trace to start from. This line puts the trace back with only what is safe to keep:
 * the method, the address without its query string, and the status or the error code. Filter values
 * in the query string can be customer data, and no body, header, token or credential is read here.
 *
 * Transport failures are logged too - a refused certificate, an unknown host, a refused connection,
 * a timeout - which upstream's print never covered, as it only ran for an HTTP status.
 *
 * It goes out through console.error, which the engine replaces with a function that forwards each
 * call to the worker's stderr (packages/server/engine/src/lib/worker-socket.ts in Activepieces).
 */
export function withFailureLog<T>({
  request,
  sent,
}: {
  request: unknown;
  sent: Promise<T>;
}): Promise<T> {
  return sent.catch((error: unknown) => {
    console.error(failureLine({ request, error }));
    throw error;
  });
}

export function failureLine({ request, error }: { request: unknown; error: unknown }): string {
  const { method, url } = (request ?? {}) as { method?: unknown; url?: unknown };
  const verb = typeof method === 'string' && method !== '' ? method : '<no method>';
  return `[OroCommerce] ${verb} ${addressOf({ url })} failed: ${reasonOf({ error })}`;
}

/** Origin and path only: the query string, the fragment and any user:password@ stay out. */
function addressOf({ url }: { url: unknown }): string {
  try {
    const { origin, pathname } = new URL(String(url));
    return `${origin}${pathname}`;
  } catch {
    return '<invalid url>';
  }
}

/**
 * The status for an HTTP error. For anything else, the code fetch's error or its cause carries -
 * ECONNREFUSED, ENOTFOUND, DEPTH_ZERO_SELF_SIGNED_CERT - and failing that the error's name, which is
 * AbortError for a timeout. Never the message: an HttpError's message holds the request body.
 */
function reasonOf({ error }: { error: unknown }): string {
  if (error instanceof HttpError) {
    return String(error.response.status);
  }
  const { code, cause, name } = (error ?? {}) as { code?: unknown; cause?: unknown; name?: unknown };
  const causeCode = ((cause ?? {}) as { code?: unknown }).code;
  return [code, causeCode, name].find(isNonEmptyString) ?? 'unknown error';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}
