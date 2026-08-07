import { createAction, Property } from '@activepieces/pieces-framework';
import {
  deserialize,
  serialize,
  type FlatResource,
  type Linkage,
  type JsonApiResource,
} from '../common/jsonapi';

export const serializeJsonApiAction = createAction({
  name: 'serialize_jsonapi',
  displayName: 'Serialize JSON:API Request',
  description:
    'Builds a JSON:API request body from a plain object, ready for the Request Body of the API Call action.',
  auth: undefined,
  props: {
    resourceType: Property.ShortText({
      displayName: 'Resource Type',
      description: 'e.g. orders, invoices, products. Taken from _type when left empty.',
      required: false,
    }),
    resourceId: Property.ShortText({
      displayName: 'Resource ID',
      description: 'Leave empty to create a record, or when the input carries an id.',
      required: false,
    }),
    attributes: Property.Json({
      displayName: 'Attributes',
      description:
        'A flat object, Unserialize output, or a single-resource JSON:API document. ' +
        'Values marked with _type or shaped like {"type","id"} become relationships.',
      required: true,
      defaultValue: {},
    }),
    relationships: Property.Json({
      displayName: 'Relationships (override)',
      description:
        'Wins over anything detected in Attributes. Example: {"customer":{"type":"customers","id":"42"}}',
      required: false,
      defaultValue: {},
    }),
    included: Property.Json({
      displayName: 'Included',
      description:
        'Extra resources to embed. Forwarded automatically when Attributes already has "included".',
      required: false,
      defaultValue: [],
    }),
  },

  async run(context) {
    const { resourceType, resourceId, attributes, relationships, included } = context.propsValue;

    const input: FlatResource = attributes ?? {};

    const docIncluded = toResourceArray(input['included']);
    const explicitIncluded = toResourceArray(included);
    const mergedIncluded = explicitIncluded.length > 0 ? explicitIncluded : docIncluded;

    const flat = toFlatResource(input);

    const resolvedType =
      (resourceType && resourceType.trim() !== '' ? resourceType.trim() : undefined) ??
      (typeof flat['_type'] === 'string' && flat['_type'].trim() !== ''
        ? flat['_type'].trim()
        : undefined);

    if (!resolvedType) {
      throw new Error(
        'Resource Type is required. Either fill in the "Resource Type" field or ' +
        'pass the output of the Unserialize action (which carries a _type field).'
      );
    }

    return serialize({
      type: resolvedType,
      id: resourceId ?? undefined,
      data: flat,
      relationships: (relationships as Record<string, Linkage | Linkage[] | null>) ?? {},
      included: mergedIncluded,
    });
  },
});

function isResource(value: unknown): value is JsonApiResource {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'type' in value &&
    typeof value['type'] === 'string' &&
    'id' in value &&
    typeof value['id'] === 'string'
  );
}

function toResourceArray(value: unknown): JsonApiResource[] {
  return Array.isArray(value) ? value.filter(isResource) : [];
}

function toFlatResource(input: FlatResource): FlatResource {
  if (!('data' in input)) {
    return Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'included'));
  }

  const data = input['data'];

  if (Array.isArray(data)) {
    throw new Error(
      `The input is a collection of ${data.length} resources - its "data" is an array. ` +
        'Serialize JSON:API Request builds a single resource document. Loop over the items and ' +
        'serialize them one at a time, or select a single element (e.g. body.data[0]) first.'
    );
  }

  if (!isResource(data)) {
    throw new Error(
      'The input has a "data" key, so it is read as a JSON:API document, but its value is not a ' +
        'resource object with string "type" and "id" fields. Pass either a single-resource ' +
        'document ({"data":{"type":"…","id":"…", …}}) or a flat object with no "data" key.'
    );
  }

  return deserialize({ data });
}
