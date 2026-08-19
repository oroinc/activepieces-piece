import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  createTrigger,
  Property,
  TriggerStrategy,
} from '@activepieces/pieces-framework';
import { oroAuth, oroApiCall, formatError } from '../common';
import { OroAuth, OroJsonApiCollection, OroJsonApiItem } from '../common/types';
import { HttpError, HttpMethod } from '@activepieces/pieces-common';

export const oroWebhookTopicTrigger = createTrigger({
  auth: oroAuth,
  name: 'oro-webhook-event',
  displayName: 'Oro Webhook Event',
  description: 'Trigger when a selected webhook event is raised',
  props: {
    topic: Property.Dropdown({
      auth: oroAuth,
      displayName: 'Topic',
      description: 'Only topics accessible by your connection are shown',
      required: true,
      refreshers: ['auth'],
      options: async ({ auth }) => {
        if (!auth) {
          return { disabled: true, placeholder: 'Connect your account first', options: [] };
        }

        const response = await oroApiCall({
          method: HttpMethod.GET,
          resourceUri: 'webhooktopics',
          auth: auth as OroAuth,
        });
        const body = response.body as OroJsonApiCollection;

        return {
          options: (body.data ?? []).map((item: OroJsonApiItem) => ({
            label: String(
              item.attributes['label']
                ? item.attributes['label'] + ' (' + item.id + ')'
                : item.id
            ),
            value: item.id,
          })),
        };
      },
    }),
    signDeliveries: Property.Checkbox({
      displayName: 'Sign webhook deliveries',
      description:
        'Register the webhook with a shared secret and discard deliveries whose "Webhook-Signature" header does not match the body. ' +
        'Requires OroCommerce 6.1 or newer: older versions reject the secret and the registration fails. ' +
        'Turn this off only for those versions, and be aware that anyone who learns the webhook URL can then start this flow.',
      required: false,
      defaultValue: true,
    }),
  },
  type: TriggerStrategy.WEBHOOK,
  sampleData: {},

  async onEnable(context) {
    const staleInfo = await context.store.get<WebhookInformation>('webhookInfo');
    if (staleInfo !== null && staleInfo !== undefined) {
      await discardWebhook({ auth: context.auth, webhookId: staleInfo.webhookId });
    }

    const secret =
      context.propsValue.signDeliveries === false
        ? undefined
        : randomBytes(32).toString('hex');

    const response = await oroApiCall({
      method: HttpMethod.POST,
      resourceUri: 'webhooks',
      auth: context.auth,
      body: {
        data: {
          type: 'webhooks',
          attributes: {
            enabled: true,
            notificationUrl: context.webhookUrl,
            ...(secret === undefined ? {} : { secret }),
          },
          relationships: {
            topic: {
              data: {
                type: 'webhooktopics',
                id: context.propsValue.topic,
              },
            },
            format: {
              data: {
                type: 'webhookformats',
                id: 'default',
              },
            },
          },
        },
      },
    });

    const webhookId = (response.body as { data?: { id?: string } })?.data?.id;
    if (!webhookId) {
      throw new Error('OroCommerce webhook registration failed: no webhook ID returned. Check your connection and permissions.');
    }

    try {
      await context.store.put<WebhookInformation>('webhookInfo', {
        webhookId,
        topic: context.propsValue.topic,
        ...(secret === undefined ? {} : { secret }),
      });
    } catch (error: unknown) {
      await discardWebhook({ auth: context.auth, webhookId });
      throw error;
    }
  },

  async onDisable(context) {
    const webhookInfo = await context.store.get<WebhookInformation>('webhookInfo');

    if (webhookInfo !== null && webhookInfo !== undefined) {
      await deleteWebhook({ auth: context.auth, webhookId: webhookInfo.webhookId });

      await context.store.delete('webhookInfo');
    }
  },

  async run(context) {
    const webhookInfo = await context.store.get<WebhookInformation>('webhookInfo');
    const secret = webhookInfo?.secret;

    if (secret === undefined || secret === null) {
      return [context.payload.body];
    }

    const rejection = findSignatureRejection({
      headers: context.payload.headers,
      rawBody: context.payload.rawBody,
      secret,
    });

    if (rejection !== undefined) {
      console.warn(
        `OroCommerce webhook delivery discarded (flow ${context.flows.current.id}, step "${context.step.name}"): ${rejection}.`
      );
      return [];
    }

    return [context.payload.body];
  },
});

async function deleteWebhook({
  auth,
  webhookId,
}: {
  auth: OroAuth;
  webhookId: string;
}): Promise<void> {
  try {
    await oroApiCall({
      method: HttpMethod.DELETE,
      resourceUri: `webhooks/${webhookId}`,
      auth,
      throwOriginalError: true,
    });
  } catch (error: unknown) {
    const alreadyGone =
      error instanceof HttpError &&
      [401, 403, 404].includes(error.response.status);

    if (!alreadyGone) {
      throw new Error(formatError({ error }));
    }
  }
}

async function discardWebhook({
  auth,
  webhookId,
}: {
  auth: OroAuth;
  webhookId: string;
}): Promise<void> {
  try {
    await deleteWebhook({ auth, webhookId });
  } catch {
    return;
  }
}

function findSignatureRejection({
  headers,
  rawBody,
  secret,
}: {
  headers: Record<string, string> | undefined;
  rawBody: unknown;
  secret: string;
}): string | undefined {
  const signature = headers?.['webhook-signature'];
  if (!signature) {
    return 'the Webhook-Signature header is missing';
  }

  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) {
    return 'the raw request body was not captured, so the signature cannot be checked';
  }

  const expected = Buffer.from(
    createHmac('sha256', secret).update(rawBody).digest('hex')
  );
  const received = Buffer.from(signature);

  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return 'the Webhook-Signature header does not match the delivered body';
  }

  return undefined;
}

interface WebhookInformation {
  webhookId: string;
  topic: string;
  secret?: string;
}
