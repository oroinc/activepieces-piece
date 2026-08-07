import { describe, expect, it } from 'vitest';
import { createMockActionContext } from '@activepieces/pieces-framework';
import {
  deserialize,
  serialize,
  type FlatResource,
  type JsonApiResourceDocument,
} from '../src/lib/common/jsonapi';
import { serializeJsonApiAction } from '../src/lib/actions/serialize-jsonapi';

function throughFlowJson(flat: FlatResource): FlatResource {
  return JSON.parse(JSON.stringify(flat));
}

function runSerializeAction({
  resourceType,
  attributes,
}: {
  resourceType?: string;
  attributes: FlatResource;
}) {
  return serializeJsonApiAction.run(
    createMockActionContext<typeof serializeJsonApiAction.props>({
      propsValue: {
        resourceType,
        resourceId: undefined,
        attributes,
        relationships: undefined,
        included: undefined,
      },
    })
  );
}

describe('deserialize -> serialize round trip', () => {
  const doc: JsonApiResourceDocument = {
    data: {
      type: 'customeraddresses',
      id: '1',
      attributes: {
        label: 'Billing',
        types: [{ addressType: 'billing', default: true }],
        options: { validated: true, source: { channel: 'web' } },
        tags: ['a', 'b'],
        emptyList: [],
      },
      relationships: {
        customer: { data: { type: 'customers', id: '5' } },
        country: { data: null },
        regions: { data: [{ type: 'regions', id: 'US-CA' }] },
        salesRepresentatives: { data: [] },
      },
    },
  };

  it('keeps object- and array-valued attributes as attributes', () => {
    const result = serialize({ type: 'customeraddresses', data: deserialize(doc) });

    expect(result.data['attributes']).toEqual({
      label: 'Billing',
      types: [{ addressType: 'billing', default: true }],
      options: { validated: true, source: { channel: 'web' } },
      tags: ['a', 'b'],
      emptyList: [],
    });
    expect(result.data['id']).toBe('1');
  });

  it('keeps _type-marked values as relationships', () => {
    const result = serialize({ type: 'customeraddresses', data: deserialize(doc) });

    expect(result.data['relationships']).toEqual({
      customer: { data: { type: 'customers', id: '5' } },
      country: { data: null },
      regions: { data: [{ type: 'regions', id: 'US-CA' }] },
      salesRepresentatives: { data: [] },
    });
  });

  it('round-trips an empty to-many relationship through the flow JSON boundary', () => {
    const source: JsonApiResourceDocument = {
      data: {
        type: 'customerusers',
        id: '7',
        attributes: { email: 'a@b.c' },
        relationships: {
          userRoles: { data: [] },
          customer: { data: { type: 'customers', id: '5' } },
        },
      },
    };

    const result = serialize({
      type: 'customerusers',
      data: throughFlowJson(deserialize(source)),
    });

    expect(result.data['attributes']).toEqual({ email: 'a@b.c' });
    expect(result.data['relationships']).toEqual({
      userRoles: { data: [] },
      customer: { data: { type: 'customers', id: '5' } },
    });
  });

  it('hoists included resources back into included', () => {
    const flat = deserialize({
      data: {
        type: 'orders',
        id: '9',
        attributes: { currency: 'USD' },
        relationships: { customer: { data: { type: 'customers', id: '5' } } },
      },
      included: [{ type: 'customers', id: '5', attributes: { name: 'Acme' } }],
    });

    const result = serialize({ type: 'orders', data: flat });

    expect(result.data['relationships']).toEqual({
      customer: { data: { type: 'customers', id: '5' } },
    });
    expect(result.included).toEqual([
      { type: 'customers', id: '5', attributes: { name: 'Acme' } },
    ]);
  });
});

describe('serialize classification', () => {
  it('keeps a bare empty array as an attribute', () => {
    const result = serialize({ type: 'customerusers', data: { email: 'a@b.c', emptyList: [] } });

    expect(result.data['attributes']).toEqual({ email: 'a@b.c', emptyList: [] });
    expect(result.data['relationships']).toBeUndefined();
  });

  it('does not duplicate an explicit relationship into attributes', () => {
    const result = serialize({
      type: 'customerusers',
      data: { email: 'a@b.c', userRoles: [] },
      relationships: { userRoles: [] },
    });

    expect(result.data['attributes']).toEqual({ email: 'a@b.c' });
    expect(result.data['relationships']).toEqual({ userRoles: { data: [] } });
  });

  it('treats hand-written raw linkages as relationships', () => {
    const result = serialize({
      type: 'orders',
      data: {
        currency: 'USD',
        lineItems: [
          { type: 'orderlineitems', id: '1' },
          { type: 'orderlineitems', id: '2' },
        ],
        customer: { type: 'customers', id: '5' },
      },
    });

    expect(result.data['attributes']).toEqual({ currency: 'USD' });
    expect(result.data['relationships']).toEqual({
      lineItems: {
        data: [
          { type: 'orderlineitems', id: '1' },
          { type: 'orderlineitems', id: '2' },
        ],
      },
      customer: { data: { type: 'customers', id: '5' } },
    });
    expect(JSON.stringify(result)).not.toContain('_type');
  });

  it('throws on an array that mixes linkages with plain values', () => {
    expect(() =>
      serialize({
        type: 'orders',
        data: { rel: [{ _type: 'a', id: '1' }, { id: '2' }] },
      })
    ).toThrow(/"rel".*index 1/);
  });
});

describe('serialize action document unwrapping', () => {
  const collection: FlatResource = {
    data: [
      { type: 'orders', id: '1', attributes: { currency: 'USD' } },
      { type: 'orders', id: '2', attributes: { currency: 'EUR' } },
    ],
    included: [{ type: 'customers', id: '5', attributes: { name: 'Acme' } }],
  };

  it('rejects a collection document instead of returning an empty one', async () => {
    await expect(runSerializeAction({ resourceType: 'orders', attributes: collection })).rejects.toThrow(
      /collection of 2 resources/
    );
  });

  it('rejects a collection document even when Resource Type is empty', async () => {
    await expect(runSerializeAction({ attributes: collection })).rejects.toThrow(
      /collection of 2 resources/
    );
  });

  it('rejects a document whose data is not a resource object', async () => {
    await expect(
      runSerializeAction({ resourceType: 'orders', attributes: { data: 'nope' } })
    ).rejects.toThrow(/not a resource object/);
  });

  it('still unwraps a single-resource document', async () => {
    const result = await runSerializeAction({
      attributes: {
        data: {
          type: 'orders',
          id: '9',
          attributes: { currency: 'USD' },
          relationships: { customer: { data: { type: 'customers', id: '5' } } },
        },
        included: [{ type: 'customers', id: '5', attributes: { name: 'Acme' } }],
      },
    });

    expect(result).toEqual({
      data: {
        type: 'orders',
        id: '9',
        attributes: { currency: 'USD' },
        relationships: { customer: { data: { type: 'customers', id: '5' } } },
      },
      included: [{ type: 'customers', id: '5', attributes: { name: 'Acme' } }],
    });
  });

  it('leaves a flat object without a data key untouched', async () => {
    const result = await runSerializeAction({
      resourceType: 'orders',
      attributes: { currency: 'USD', poNumber: 'PO-001' },
    });

    expect(result).toEqual({
      data: { type: 'orders', attributes: { currency: 'USD', poNumber: 'PO-001' } },
    });
  });
});
