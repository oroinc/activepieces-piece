import { createPiece } from '@activepieces/pieces-framework';
import { orocommerceAuth } from './lib/common/auth';
import { newOrder } from './lib/triggers/new-order';

export const orocommerce = createPiece({
  displayName: 'OroCommerce',
  auth: orocommerceAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: 'https://oroinc.com/wp-content/themes/oroinc/images/redesign/ORO.svg',
  authors: [],
  actions: [],
  triggers: [
    newOrder
  ]
});
