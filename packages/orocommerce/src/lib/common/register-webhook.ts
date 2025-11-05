import {
  createTrigger,
  Trigger,
  TriggerStrategy,
} from '@activepieces/pieces-framework';
import { orocommerceAuth } from './auth';
import { oroCommerceApiCall } from './client';
import { HttpMethod } from '@activepieces/pieces-common';

export const createOroCommerceWebhookTrigger = ({
  name,
  description,
  displayName,
  topic,
  event,
  sampleData
}: {
  name: string;
  description: string;
  displayName: string;
  topic: string;
  event: string;
  sampleData: Record<string, unknown>;
}): Trigger =>
  createTrigger({
    auth: orocommerceAuth,
    name,
    description,
    displayName,
    props: {},
    sampleData: sampleData,
    type: TriggerStrategy.WEBHOOK,

    async onEnable(context) {
      const response = await oroCommerceApiCall({
        method: HttpMethod.POST,
        resourceUri: '/admin/api/remotenotifications',
        auth: context.auth,
        body: {
          data: {
            type: 'remotenotifications',
            attributes: {
              channel: topic,
              event: event,
              enabled: true,
              notificationUrl: context.webhookUrl
            }
          }
        }
      });

      await context.store?.put(`orocommerce_webhook_id`, response.body.data.id);
      console.log('webhook created', response.body.data.id);
    },

    async onDisable(context) {
      const webhookId = await context.store.get<string>(`orocommerce_webhook_id`);
      await oroCommerceApiCall({
        method: HttpMethod.DELETE,
        resourceUri: '/admin/api/remotenotifications/' + webhookId,
        auth: context.auth
      });
      await context.store?.put(`orocommerce_webhook_id`, null);
    },
    async run(context) {
      console.debug('trigger running', context);
      return [context.payload.body];
    },
  });
