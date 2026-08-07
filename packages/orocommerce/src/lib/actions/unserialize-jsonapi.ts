import { createAction, Property } from '@activepieces/pieces-framework';
import { deserialize, type JsonApiDocument } from '../common/jsonapi';

export const unserializeJsonApiAction = createAction({
  name: 'unserialize_jsonapi',
  displayName: 'Unserialize JSON:API Response',
  description:
    'Flattens a JSON:API response body into a plain object. Included relationships are inlined, and the result stays re-serializable.',
  auth: undefined,
  props: {
    response: Property.Json({
      displayName: 'JSON:API Response',
      description: 'The "body" output of the API Call action. Needs a top-level "data" key.',
      required: true,
      defaultValue: {},
    }),
  },

  async run(context) {
    const doc = context.propsValue.response as JsonApiDocument;
    return deserialize(doc);
  },
});
