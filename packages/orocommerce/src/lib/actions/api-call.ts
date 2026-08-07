import { createCustomApiCallAction } from '@activepieces/pieces-common';
import {
  getAccessToken,
  getConnectionHeaders,
  getInternalInfrastructureHeaders,
  getOroAdminApiBaseUrl,
  oroAuth,
  toHeaderRecord,
} from '../common';

export const customApiCallAction = createCustomApiCallAction({
  auth: oroAuth,
  name: 'custom_api_call',
  displayName: 'Custom API Call',
  description: 'Make a direct authenticated call to the OroCommerce JSON:API.',
  baseUrl: (auth) => auth ? getOroAdminApiBaseUrl({ auth }) : '',
  authMapping: async (auth, propsValue: Record<string, unknown>) => ({
    ...getConnectionHeaders({ auth }),
    ...getInternalInfrastructureHeaders({ auth }),
    ...toHeaderRecord({ value: propsValue['headers'] }),
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
