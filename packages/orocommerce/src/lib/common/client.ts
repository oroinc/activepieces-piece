import { createHash } from 'node:crypto';

import {
  httpClient,
  HttpMethod,
  HttpMessageBody,
  HttpResponse,
  HttpError,
  AuthenticationType,
} from '@activepieces/pieces-common';
import { tryCatch } from '@activepieces/pieces-framework';

import {
  type OroAuth,
  type OroAuthResponseType,
  type OroApiCallParams,
  type OroJsonApiItem,
  type OroJsonApiCollection,
  type FetchCollectionParams,
} from './types';
import { jsonApiBodyUtils } from './jsonapi';
// Importing it also installs its patch on the shared client, which covers every caller of it.
import { dispatcherForConnection, isInternalInfrastructure } from './tls';
import { version } from '../../../package.json';

/**
 * What every request says it comes from, unless the connection or the environment names something
 * else. Without it fetch sends "node", which tells an access log or a firewall rule nothing. The
 * bundler inlines the version from package.json, so it is always the version being shipped.
 */
export const DEFAULT_USER_AGENT = `oroinc-piece-orocommerce/${version}`;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const inFlightTokenRequests = new Map<string, Promise<string>>();

// Hashing the secret too keeps two connections that share a server URL and client id from swapping tokens.
function buildCacheKey({ auth }: { auth: OroAuth }): string {
  return createHash('sha256')
    .update([getOroServerUrl(auth), auth.props.clientId, auth.props.clientSecret].join('\0'))
    .digest('hex');
}

export function formatError({ error }: { error: unknown }): string {
  if (error instanceof HttpError) {
    const status = error.response.status;
    const body = error.response.body;
    const detail = typeof body === 'object' && body !== null
      ? JSON.stringify(body)
      : String(body ?? '');
    return `OroCommerce API Error (${status}): ${detail}`;
  }
  if (error instanceof Error) {
    return `OroCommerce API Error: ${error.message}${describeCause({ error })}`;
  }
  return `OroCommerce API Error: ${String(error)}`;
}

/**
 * fetch reports every transport failure as "fetch failed" and puts what actually happened on the
 * cause. A rejected certificate is the case that matters most here: without this, the whole message
 * is "fetch failed", which says nothing about what to fix.
 */
function describeCause({ error }: { error: Error }): string {
  const cause = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) {
    return '';
  }
  const code = (cause as { code?: unknown }).code;
  const detail = typeof code === 'string' && code !== '' ? `${code}: ${cause.message}` : cause.message;
  return detail ? ` (${detail})` : '';
}

function getOroServerUrl(auth: OroAuth): string {
  const envUrl = isInternalInfrastructure({ auth })
    ? process.env['ORO_SERVER_URL']?.trim()
    : undefined;
  const url = envUrl || auth.props.serverUrl;

  return url.replace(/\/*$/, '');
}

export function getInternalInfrastructureHeaders({ auth }: { auth: OroAuth }): Record<string, string> {
  if (!isInternalInfrastructure({ auth })) {
    return {};
  }
  const userAgent = process.env['ORO_SERVER_USER_AGENT']?.trim();
  if (!userAgent) {
    return {};
  }

  return { 'User-Agent': userAgent };
}

/**
 * The headers every request of the connection starts from, lowest first: the default User-Agent,
 * the connection's Default HTTP Headers, then the internal infrastructure User-Agent. A step's own
 * headers go on top of these.
 */
export function getBaseHeaders({ auth }: { auth: OroAuth }): Record<string, string> {
  return mergeHeaders(
    { 'User-Agent': DEFAULT_USER_AGENT },
    getConnectionHeaders({ auth }),
    getInternalInfrastructureHeaders({ auth }),
  );
}

/**
 * Only the User-Agent of the base headers, for the token request. It goes out with the same
 * User-Agent as the API calls, but none of the connection's other headers.
 */
function getUserAgentHeader({ auth }: { auth: OroAuth }): Record<string, string> {
  return Object.fromEntries(
    Object.entries(getBaseHeaders({ auth })).filter(([key]) => key.toLowerCase() === 'user-agent'),
  );
}

/**
 * Lay header sets over each other, lowest first, as object spread does, but with names matched
 * whatever their case. Spread keeps "user-agent" and "User-Agent" as two keys, and the shared client
 * then keeps whichever comes last in key order, which is not always the set that should win. A
 * name keeps the spelling of the set that set it last.
 */
export function mergeHeaders(...sets: Array<Record<string, string> | undefined>): Record<string, string> {
  const merged = new Map<string, [string, string]>();
  for (const set of sets) {
    for (const [key, value] of Object.entries(set ?? {})) {
      merged.set(key.toLowerCase(), [key, value]);
    }
  }
  return Object.fromEntries(merged.values());
}

export function getOroAdminApiBaseUrl({ auth }: { auth: OroAuth }): string {
  const serverUrl = getOroServerUrl(auth);
  const adminPrefix = auth.props.adminPrefix.replace(/^\/+|\/+$/g, '');
  return `${serverUrl}/${adminPrefix}/api`;
}

export async function getAccessToken({ auth }: { auth: OroAuth }): Promise<string> {
  const cacheKey = buildCacheKey({ auth });
  const cached = tokenCache.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const inFlight = inFlightTokenRequests.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const request = requestAccessToken({ auth, cacheKey }).finally(() => {
    inFlightTokenRequests.delete(cacheKey);
  });
  inFlightTokenRequests.set(cacheKey, request);

  return request;
}

/**
 * Parse the connection's Default HTTP Headers, or say why it cannot be done.
 *
 * This used to swallow the failure and return {}, so a typo in the JSON meant the headers were
 * quietly dropped and every call went out without them - with nothing to show for it until someone
 * compared a request against what they had configured.
 */
export function parseHeaderJson({ raw }: { raw: string }): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'Default HTTP Headers is not valid JSON, expected an object such as {"X-Include": "totalCount"}.'
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      'Default HTTP Headers must be a JSON object such as {"X-Include": "totalCount"}.'
    );
  }
  return toHeaderRecord({ value: parsed });
}

export function getConnectionHeaders({ auth }: { auth: OroAuth }): Record<string, string> {
  const raw = auth.props.headers;
  if (!raw || raw.trim() === '') {
    return {};
  }
  return parseHeaderJson({ raw });
}

export function toHeaderRecord({ value }: { value: unknown }): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return withoutAuthorization({
    headers: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)])),
  });
}

/**
 * The bearer token is the connection's to send. An Authorization header coming from the connection
 * defaults or from a step used to reach the request after the token was applied and replace it, so
 * the call went out as whoever the step said - while the field described it as always managed by the
 * connection. Dropping the key here makes that description true.
 */
function withoutAuthorization({
  headers,
}: {
  headers: Record<string, string>;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'authorization')
  );
}

export async function oroApiCall({
  method,
  resourceUri,
  auth,
  queryParams,
  body,
  headers: extraHeaders,
  throwOriginalError = false
}: OroApiCallParams): Promise<HttpResponse<HttpMessageBody>> {
  const sendRequest = async ({ token }: { token: string }): Promise<HttpResponse<HttpMessageBody>> =>
    await httpClient.sendRequest({
      method,
      url: `${getOroAdminApiBaseUrl({ auth })}/${resourceUri.replace(/^\/+/, '')}`,
      headers: {
        'Content-Type': 'application/vnd.api+json',
        // Stripped once more over the merged set: the shared client applies `authentication` first
        // and then spreads these over it, so an Authorization key surviving here would win.
        ...withoutAuthorization({
          headers: mergeHeaders(getBaseHeaders({ auth }), extraHeaders),
        }),
      },
      authentication: {
        type: AuthenticationType.BEARER_TOKEN,
        token,
      },
      queryParams,
      body: sanitizeJsonApiBody({ body }),
    }, { dispatcher: dispatcherForConnection({ auth }) });

  try {
    const token = await getAccessToken({ auth });
    const { data, error } = await tryCatch(() => sendRequest({ token }));
    if (!error) {
      return data;
    }
    if (!(error instanceof HttpError) || error.response.status !== 401) {
      throw error;
    }
    invalidateAccessToken({ auth, token });

    return await sendRequest({ token: await getAccessToken({ auth }) });
  } catch (error: unknown) {
    if (throwOriginalError) {
      throw error;
    } else {
      throw new Error(formatError({ error }));
    }
  }
}

export async function fetchCollection({
  auth,
  resourceUri,
  queryParams,
}: FetchCollectionParams): Promise<OroJsonApiItem[]> {
  const response = await oroApiCall({
    method: HttpMethod.GET,
    resourceUri,
    auth,
    queryParams: { 'page[size]': '50', ...queryParams },
  });

  const body = response.body as OroJsonApiCollection | undefined;
  return body?.data ?? [];
}

function sanitizeJsonApiBody({ body }: { body: unknown }): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  const record = body as Record<string, unknown>;
  const { included, ...withoutIncluded } = record;
  const sanitized =
    Array.isArray(included) && included.length === 0 ? withoutIncluded : record;
  if (
    !('data' in sanitized) ||
    typeof sanitized['data'] !== 'object' ||
    sanitized['data'] === null
  ) {
    return sanitized;
  }
  return {
    ...sanitized,
    data: jsonApiBodyUtils.omitEmptyObjects(sanitized['data'] as Record<string, unknown>),
  };
}

async function requestAccessToken({
  auth,
  cacheKey,
}: {
  auth: OroAuth;
  cacheKey: string;
}): Promise<string> {
  const response = await httpClient.sendRequest<OroAuthResponseType>({
    method: HttpMethod.POST,
    url: `${getOroServerUrl(auth)}/oauth2-token`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...getUserAgentHeader({ auth }),
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: auth.props.clientId,
      client_secret: auth.props.clientSecret,
    }).toString(),
  }, { dispatcher: dispatcherForConnection({ auth }) });

  const token = response.body.access_token;
  tokenCache.set(cacheKey, {
    token,
    expiresAt: Date.now() + response.body.expires_in * 1000 - 30_000,
  });

  return token;
}

export function invalidateAccessToken({ auth, token }: { auth: OroAuth; token: string }): void {
  const cacheKey = buildCacheKey({ auth });
  if (tokenCache.get(cacheKey)?.token === token) {
    tokenCache.delete(cacheKey);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
