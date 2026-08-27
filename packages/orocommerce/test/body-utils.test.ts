import { describe, expect, it } from 'vitest';
import { jsonApiBodyUtils } from '../src/lib/common/jsonapi';

describe('jsonApiBodyUtils.pickDefined', () => {
  it('drops null and undefined but keeps every other falsy value', () => {
    expect(
      jsonApiBodyUtils.pickDefined({
        keptFalse: false,
        keptZero: 0,
        keptEmptyString: '',
        droppedNull: null,
        droppedUndefined: undefined,
      })
    ).toEqual({ keptFalse: false, keptZero: 0, keptEmptyString: '' });
  });
});

describe('jsonApiBodyUtils.omitEmptyObjects', () => {
  it('drops empty plain objects and keeps everything else', () => {
    expect(
      jsonApiBodyUtils.omitEmptyObjects({
        attributes: {},
        relationships: { customer: { data: { type: 'customers', id: '1' } } },
        emptyArray: [],
        nullValue: null,
        id: '1',
      })
    ).toEqual({
      relationships: { customer: { data: { type: 'customers', id: '1' } } },
      emptyArray: [],
      nullValue: null,
      id: '1',
    });
  });
});

describe('jsonApiBodyUtils.buildRels', () => {
  it('emits a to-one linkage', () => {
    expect(jsonApiBodyUtils.buildRels({ customer: ['customers', '7'] })).toEqual({
      customer: { data: { type: 'customers', id: '7' } },
    });
  });

  it('wraps a single id in an array when the relationship is to-many', () => {
    expect(
      jsonApiBodyUtils.buildRels({ userRoles: ['userroles', '3', true] })
    ).toEqual({ userRoles: { data: [{ type: 'userroles', id: '3' }] } });
  });

  it('emits an array of linkages and drops blank entries', () => {
    expect(
      jsonApiBodyUtils.buildRels({ groups: ['usergroups', ['1', '', '2']] })
    ).toEqual({
      groups: { data: [{ type: 'usergroups', id: '1' }, { type: 'usergroups', id: '2' }] },
    });
  });

  it('omits a relationship whose id is absent, blank or an empty list', () => {
    expect(
      jsonApiBodyUtils.buildRels({
        undefinedId: ['customers', undefined],
        nullId: ['customers', null],
        blankId: ['customers', ''],
        emptyList: ['usergroups', []],
      })
    ).toEqual({});
  });
});

describe('jsonApiBodyUtils.parseAdditionalAttributes', () => {
  it('returns an empty object when nothing was supplied', () => {
    expect(jsonApiBodyUtils.parseAdditionalAttributes(undefined)).toEqual({});
    expect(jsonApiBodyUtils.parseAdditionalAttributes(null)).toEqual({});
  });

  it('accepts a JSON string as well as an object', () => {
    expect(jsonApiBodyUtils.parseAdditionalAttributes('{"myField":"value"}')).toEqual({
      myField: 'value',
    });
    expect(jsonApiBodyUtils.parseAdditionalAttributes({ myField: 'value' })).toEqual({
      myField: 'value',
    });
  });

  it('rejects an array and a scalar', () => {
    expect(() => jsonApiBodyUtils.parseAdditionalAttributes('[1,2]')).toThrow(
      'Additional Attributes must be a flat JSON object, e.g. {"myField": "value"}.'
    );
    expect(() => jsonApiBodyUtils.parseAdditionalAttributes(42)).toThrow(
      /must be a flat JSON object/
    );
  });
});

describe('jsonApiBodyUtils.parseAdditionalRelations', () => {
  it('accepts a well-formed linkage object', () => {
    const value = { myRelation: { data: { type: 'myentities', id: '1' } } };
    expect(jsonApiBodyUtils.parseAdditionalRelations(value)).toEqual(value);
  });

  it('names the offending key when a value is not a linkage object', () => {
    expect(() =>
      jsonApiBodyUtils.parseAdditionalRelations({ myRelation: 'nope' })
    ).toThrow(
      'Additional Relations: "myRelation" must be a JSON:API linkage object with a "data" key, e.g. {"data": {"type": "myentities", "id": "1"}}.'
    );
  });

  it('names the offending key when the "data" wrapper is missing', () => {
    expect(() =>
      jsonApiBodyUtils.parseAdditionalRelations({ myRelation: { type: 'myentities', id: '1' } })
    ).toThrow('Additional Relations: "myRelation" is missing the "data" key.');
  });

  it('rejects a top-level array', () => {
    expect(() => jsonApiBodyUtils.parseAdditionalRelations('[]')).toThrow(
      /must be a JSON object/
    );
  });

  // A bare null used to pass straight through to Oro, which answers
  // 400 "The relationship should have 'data' property" — a request that could never succeed.
  it('rejects a null value and shows the linkage forms', () => {
    expect(() =>
      jsonApiBodyUtils.parseAdditionalRelations({ myRelation: null })
    ).toThrow('Additional Relations: "myRelation" is null.');
  });

  it('accepts an explicit empty linkage', () => {
    const value = { myRelation: { data: null }, myOtherRelation: { data: [] } };
    expect(jsonApiBodyUtils.parseAdditionalRelations(value)).toEqual(value);
  });
});

describe('jsonApiBodyUtils.assertUpdateNotEmpty', () => {
  it('throws only when both containers are empty', () => {
    expect(() =>
      jsonApiBodyUtils.assertUpdateNotEmpty({
        attributes: {},
        relationships: {},
        actionName: 'Update Customer',
      })
    ).toThrow('Update Customer: nothing to update. Fill in at least one field or relationship.');
  });

  it('passes when either container has a key', () => {
    expect(() =>
      jsonApiBodyUtils.assertUpdateNotEmpty({
        attributes: { name: 'Acme' },
        relationships: {},
        actionName: 'Update Customer',
      })
    ).not.toThrow();
    expect(() =>
      jsonApiBodyUtils.assertUpdateNotEmpty({
        attributes: {},
        relationships: { owner: { data: { type: 'users', id: '1' } } },
        actionName: 'Update Customer',
      })
    ).not.toThrow();
  });
});
