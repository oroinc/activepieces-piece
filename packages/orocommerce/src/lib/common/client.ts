import {
  httpClient,
  HttpMethod,
  HttpRequest,
  HttpMessageBody,
  QueryParams, HttpResponse
} from '@activepieces/pieces-common';

export type OroCommerceAuthProps = {
  serverUrl: string;
  clientId: string;
  clientSecret: string;
};

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(auth: OroCommerceAuthProps): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const response = await httpClient.sendRequest<{
    token_type: string;
    access_token: string;
    expires_in: number;
  }>({
    method: HttpMethod.POST,
    url: auth.serverUrl + '/oauth2-token',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: {
      grant_type: 'client_credentials',
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
    },
  });

  cachedToken = response.body.access_token;
  tokenExpiresAt = Date.now() + response.body.expires_in * 1000 - 30 * 1000;

  return cachedToken!;
}

export type OroCommerceApiCallParams = {
  method: HttpMethod;
  resourceUri: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: any;
  auth: OroCommerceAuthProps;
};

export async function oroCommerceApiCall<ResponseBody extends HttpMessageBody = any>({
  method,
  resourceUri,
  query,
  body,
  auth,
}: OroCommerceApiCallParams): Promise<HttpResponse<ResponseBody>> {
  const token = await getAccessToken(auth);

  const queryParams: QueryParams = {};
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) {
        queryParams[key] = String(value);
      }
    }
  }

  const request: HttpRequest = {
    method,
    url: `${auth.serverUrl}${resourceUri}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/vnd.api+json',
    },
    queryParams,
    body,
  };

  try {
    return await httpClient.sendRequest(request);
  } catch (error: any) {
    const statusCode = error.response?.status;
    const errorMessage = error.response?.data?.message || error.message || 'Unknown error';

    throw new Error(`OroCommerce API Error (${statusCode || 'Unknown'}): ${errorMessage}`);
  }
}
