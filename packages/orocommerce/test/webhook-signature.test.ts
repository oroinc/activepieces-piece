import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpMethod } from '@activepieces/pieces-common';
import { oroApiCall } from '../src/lib/common';
import { oroWebhookTopicTrigger } from '../src/lib/triggers/webhook-topic-trigger';

vi.mock('../src/lib/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/common')>();
  return { ...actual, oroApiCall: vi.fn() };
});

type EnableContext = Parameters<typeof oroWebhookTopicTrigger.onEnable>[0];
type RunContext = Parameters<typeof oroWebhookTopicTrigger.run>[0];

const TOPIC = 'oro.customer.created';
const SECRET = 'a'.repeat(64);
const RAW_BODY = '{"event":"oro.customer.created","id":42}';
const BODY = { event: 'oro.customer.created', id: 42 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sign({ rawBody, secret }: { rawBody: string; secret: string }): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

function createStore(entry?: unknown) {
  const values = new Map<string, unknown>();
  if (entry !== undefined) {
    values.set('webhookInfo', entry);
  }

  return {
    values,
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
      return value;
    }),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

function createRunContext({
  store,
  headers,
  rawBody,
}: {
  store: ReturnType<typeof createStore>;
  headers?: Record<string, string>;
  rawBody?: unknown;
}): RunContext {
  return {
    store,
    payload: {
      body: BODY,
      rawBody,
      headers,
      queryParams: {},
    },
    propsValue: { topic: TOPIC, signDeliveries: true },
    flows: { current: { id: 'flow-1', version: { id: 'flow-version-1' } } },
    step: { name: 'trigger' },
  } as unknown as RunContext;
}

function createEnableContext({
  store,
  signDeliveries,
}: {
  store: ReturnType<typeof createStore>;
  signDeliveries?: boolean;
}): EnableContext {
  return {
    store,
    auth: {
      type: 'CUSTOM_AUTH',
      props: {
        serverUrl: 'https://store.example.com',
        adminPrefix: 'admin',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        isInternalInfrastructure: false,
      },
    },
    propsValue: { topic: TOPIC, signDeliveries },
    webhookUrl: 'https://activepieces.example.com/webhooks/flow-1',
  } as unknown as EnableContext;
}

function createdAttributes(): Record<string, unknown> {
  const body = vi.mocked(oroApiCall).mock.calls[0][0].body;
  const data = isRecord(body) ? body['data'] : undefined;
  const attributes = isRecord(data) ? data['attributes'] : undefined;
  if (!isRecord(attributes)) {
    throw new Error('the webhook create call carried no attributes object');
  }
  return attributes;
}

function storedInfo(store: ReturnType<typeof createStore>): Record<string, unknown> {
  const value = store.values.get('webhookInfo');
  if (!isRecord(value)) {
    throw new Error('nothing was stored under webhookInfo');
  }
  return value;
}

describe('the webhook trigger verifies signed deliveries', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a delivery whose signature covers the raw body', async () => {
    const store = createStore({ webhookId: 'wh-1', topic: TOPIC, secret: SECRET });

    const result = await oroWebhookTopicTrigger.run(
      createRunContext({
        store,
        headers: { 'webhook-signature': sign({ rawBody: RAW_BODY, secret: SECRET }) },
        rawBody: RAW_BODY,
      })
    );

    expect(result).toStrictEqual([BODY]);
  });

  it('accepts a delivery whose raw body arrived as a buffer', async () => {
    const store = createStore({ webhookId: 'wh-1', topic: TOPIC, secret: SECRET });

    const result = await oroWebhookTopicTrigger.run(
      createRunContext({
        store,
        headers: { 'webhook-signature': sign({ rawBody: RAW_BODY, secret: SECRET }) },
        rawBody: Buffer.from(RAW_BODY, 'utf8'),
      })
    );

    expect(result).toStrictEqual([BODY]);
  });

  it('drops a delivery that carries no signature header', async () => {
    const store = createStore({ webhookId: 'wh-1', topic: TOPIC, secret: SECRET });

    const result = await oroWebhookTopicTrigger.run(
      createRunContext({ store, headers: {}, rawBody: RAW_BODY })
    );

    expect(result).toStrictEqual([]);
  });

  it('drops a delivery signed with the wrong key', async () => {
    const store = createStore({ webhookId: 'wh-1', topic: TOPIC, secret: SECRET });

    const result = await oroWebhookTopicTrigger.run(
      createRunContext({
        store,
        headers: {
          'webhook-signature': sign({ rawBody: RAW_BODY, secret: 'b'.repeat(64) }),
        },
        rawBody: RAW_BODY,
      })
    );

    expect(result).toStrictEqual([]);
  });

  it('drops a delivery whose signature header is too short to compare', async () => {
    const store = createStore({ webhookId: 'wh-1', topic: TOPIC, secret: SECRET });

    const result = await oroWebhookTopicTrigger.run(
      createRunContext({
        store,
        headers: { 'webhook-signature': 'not-a-signature' },
        rawBody: RAW_BODY,
      })
    );

    expect(result).toStrictEqual([]);
  });

  it('drops a delivery that arrived with no headers at all', async () => {
    const store = createStore({ webhookId: 'wh-1', topic: TOPIC, secret: SECRET });

    const result = await oroWebhookTopicTrigger.run(
      createRunContext({ store, rawBody: RAW_BODY })
    );

    expect(result).toStrictEqual([]);
  });

  it('drops a delivery whose raw body was not captured', async () => {
    const store = createStore({ webhookId: 'wh-1', topic: TOPIC, secret: SECRET });

    const result = await oroWebhookTopicTrigger.run(
      createRunContext({
        store,
        headers: { 'webhook-signature': sign({ rawBody: RAW_BODY, secret: SECRET }) },
      })
    );

    expect(result).toStrictEqual([]);
  });

  it('still discards cleanly on an engine that predates flows/step in the context', async () => {
    const store = createStore({ webhookId: 'wh-1', topic: TOPIC, secret: SECRET });
    const legacyEngineContext = {
      store,
      payload: {
        body: BODY,
        rawBody: RAW_BODY,
        headers: {},
        queryParams: {},
      },
      propsValue: { topic: TOPIC, signDeliveries: true },
    } as unknown as RunContext;

    const result = await oroWebhookTopicTrigger.run(legacyEngineContext);

    expect(result).toStrictEqual([]);
  });

  it('verifies the bytes Oro sent, not a re-serialized body', async () => {
    const store = createStore({ webhookId: 'wh-1', topic: TOPIC, secret: SECRET });
    const reordered = JSON.stringify({ id: 42, event: 'oro.customer.created' });

    expect(reordered).not.toBe(RAW_BODY);
    expect(reordered.length).toBe(RAW_BODY.length);

    const result = await oroWebhookTopicTrigger.run(
      createRunContext({
        store,
        headers: { 'webhook-signature': sign({ rawBody: reordered, secret: SECRET }) },
        rawBody: RAW_BODY,
      })
    );

    expect(result).toStrictEqual([]);
  });

  it('keeps a flow enabled before signing existed running unverified', async () => {
    const store = createStore({ webhookId: 'wh-legacy', topic: TOPIC });

    const result = await oroWebhookTopicTrigger.run(
      createRunContext({ store, headers: {}, rawBody: RAW_BODY })
    );

    expect(result).toStrictEqual([BODY]);
  });

  it('does not start verifying just because a signature header showed up', async () => {
    const store = createStore({ webhookId: 'wh-legacy', topic: TOPIC });

    const result = await oroWebhookTopicTrigger.run(
      createRunContext({
        store,
        headers: { 'webhook-signature': 'f'.repeat(64) },
        rawBody: RAW_BODY,
      })
    );

    expect(result).toStrictEqual([BODY]);
  });
});

describe('enabling the webhook trigger provisions the signing secret', () => {
  beforeEach(() => {
    vi.mocked(oroApiCall).mockReset();
    vi.mocked(oroApiCall).mockResolvedValue({
      status: 201,
      headers: {},
      body: { data: { id: 'wh-created' } },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a fresh secret to Oro and keeps the only copy in the store', async () => {
    const store = createStore();

    await oroWebhookTopicTrigger.onEnable(createEnableContext({ store, signDeliveries: true }));

    const secret = createdAttributes()['secret'];
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(storedInfo(store)).toStrictEqual({
      webhookId: 'wh-created',
      topic: TOPIC,
      secret,
    });
  });

  it('signs by default when the flow never set the checkbox', async () => {
    const store = createStore();

    await oroWebhookTopicTrigger.onEnable(createEnableContext({ store }));

    expect(createdAttributes()['secret']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sends no secret at all when signing is turned off', async () => {
    const store = createStore();

    await oroWebhookTopicTrigger.onEnable(createEnableContext({ store, signDeliveries: false }));

    expect(createdAttributes()).not.toHaveProperty('secret');
    expect(storedInfo(store)).toStrictEqual({ webhookId: 'wh-created', topic: TOPIC });
  });

  it('removes the webhook it just created when the secret cannot be stored', async () => {
    const store = createStore();
    const storeFailure = new Error('store unavailable');
    store.put.mockRejectedValueOnce(storeFailure);

    await expect(
      oroWebhookTopicTrigger.onEnable(createEnableContext({ store, signDeliveries: true }))
    ).rejects.toBe(storeFailure);

    expect(vi.mocked(oroApiCall)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(oroApiCall).mock.calls[1][0]).toMatchObject({
      method: HttpMethod.DELETE,
      resourceUri: 'webhooks/wh-created',
    });
  });

  it('drops a leftover registration before creating a replacement', async () => {
    const store = createStore({ webhookId: 'wh-stale', topic: TOPIC, secret: SECRET });

    await oroWebhookTopicTrigger.onEnable(createEnableContext({ store, signDeliveries: true }));

    expect(vi.mocked(oroApiCall).mock.calls[0][0]).toMatchObject({
      method: HttpMethod.DELETE,
      resourceUri: 'webhooks/wh-stale',
    });
    expect(vi.mocked(oroApiCall).mock.calls[1][0]).toMatchObject({
      method: HttpMethod.POST,
      resourceUri: 'webhooks',
    });
    expect(storedInfo(store)['webhookId']).toBe('wh-created');
  });
});
