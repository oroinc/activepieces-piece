import { PieceAuth, Property } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import { oroCommerceApiCall } from './client';

export const orocommerceAuth = PieceAuth.CustomAuth({
  props: {
    serverUrl: Property.ShortText({
      displayName: 'Server URL',
      required: true,
    }),
    clientId: Property.ShortText({
      displayName: 'Client ID',
      required: true,
    }),
    clientSecret: PieceAuth.SecretText({
      displayName: 'Client Secret',
      required: true,
    }),
  },
  validate: async ({ auth }) => {
    try {
      await oroCommerceApiCall({
        method: HttpMethod.GET,
        resourceUri: '/admin/api/regions/US-CA',
        auth,
      });
      return { valid: true };
    } catch {
      return {
        valid: false,
        error: 'Check Server URL, Client ID and Client Secret',
      };
    }
  },
  required: true,
});
