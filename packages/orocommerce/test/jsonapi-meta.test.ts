import { describe, expect, it } from 'vitest';
import { createMockActionContext } from '@activepieces/pieces-framework';
import { serialize, type FlatResource } from '../src/lib/common/jsonapi';
import { serializeJsonApiAction } from '../src/lib/actions/serialize-jsonapi';

function runSerializeAction(attributes: FlatResource) {
  return serializeJsonApiAction.run(
    createMockActionContext<typeof serializeJsonApiAction.props>({
      propsValue: { attributes, relationships: {}, included: [] },
    })
  );
}

describe('_meta decides what Oro does with an embedded record', () => {
  it('sends it as the meta of the included record', () => {
    const result = serialize({
      type: 'orders',
      data: {
        identifier: 'ORD-1',
        customer: {
          _type: 'customers',
          id: '77',
          name: 'Acme GmbH',
          _meta: { update: true },
        },
      },
    });

    expect(result.included).toStrictEqual([
      {
        type: 'customers',
        id: '77',
        attributes: { name: 'Acme GmbH' },
        meta: { update: true },
      },
    ]);
  });

  it('keeps _meta out of the attributes', () => {
    const result = serialize({
      type: 'orders',
      data: {
        customer: { _type: 'customers', id: '77', name: 'Acme GmbH', _meta: { upsert: true } },
      },
    });

    expect(result.included?.[0].attributes).toStrictEqual({ name: 'Acme GmbH' });
  });

  it('creates the record when no _meta is given, as before', () => {
    const result = serialize({
      type: 'orders',
      data: { customer: { _type: 'customers', id: '77', name: 'Acme GmbH' } },
    });

    expect(result.included?.[0]).not.toHaveProperty('meta');
  });

  it('carries _meta on the primary record too', () => {
    const result = serialize({
      type: 'customers',
      id: '5',
      data: { name: 'Acme GmbH', _meta: { upsert: true } },
    });

    expect(result.data).toStrictEqual({
      type: 'customers',
      id: '5',
      attributes: { name: 'Acme GmbH' },
      meta: { upsert: true },
    });
  });

  it('does not embed a record that carries nothing but _meta', () => {
    const result = serialize({
      type: 'orders',
      data: { customer: { _type: 'customers', id: '77', _meta: { update: true } } },
    });

    expect(result.included).toBeUndefined();
    expect(result.data['relationships']).toStrictEqual({
      customer: { data: { type: 'customers', id: '77' } },
    });
  });

  it('ignores a _meta that carries no instruction', () => {
    const result = serialize({
      type: 'orders',
      data: { customer: { _type: 'customers', id: '77', name: 'Acme', _meta: {} } },
    });

    expect(result.included?.[0]).not.toHaveProperty('meta');
  });

  it.each([
    ['a string', 'update'],
    ['an array', ['update']],
    ['null', null],
  ])('ignores a _meta that is %s, and never sends it as an attribute', (_label, value) => {
    const result = serialize({
      type: 'orders',
      data: { customer: { _type: 'customers', id: '77', name: 'Acme', _meta: value } },
    });

    expect(result.included?.[0]).not.toHaveProperty('meta');
    expect(result.included?.[0].attributes).toStrictEqual({ name: 'Acme' });
  });

  it('reaches the same result through the Serialize JSON:API Request action', async () => {
    const result = (await runSerializeAction({
      _type: 'orders',
      identifier: 'ORD-1',
      customer: { _type: 'customers', id: '77', name: 'Acme GmbH', _meta: { update: true } },
    })) as { included?: { meta?: unknown }[] };

    expect(result.included?.[0].meta).toStrictEqual({ update: true });
  });
});
