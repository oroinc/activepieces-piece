import { createAction, Property } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import {
  oroAuth,
  oroApiCall,
  businessUnitRequiredDropdown,
  organizationDropdown,
  userAuthStatusDropdown,
  additionalAttributesProp,
  additionalRelationsProp,
  additionalHeadersProp,
  toHeaderRecord,
  userRolesMultiDropdown,
  userGroupsMultiDropdown,
  organizationsMultiDropdown,
  businessUnitsMultiDropdown,
} from '../common';
import { jsonApiBodyUtils } from '../common/jsonapi';

export const createUserAction = createAction({
  auth: oroAuth,
  name: 'create_user',
  displayName: 'Create User',
  description: 'Creates a new back-office user in OroCommerce.',
  props: {
    // -- Required attributes ---------------------------------------------------
    username: Property.ShortText({
      displayName: 'Username',
      description: 'Login name for the user. Must be unique.',
      required: true,
    }),
    email: Property.ShortText({
      displayName: 'Email',
      description: 'Email address of the user.',
      required: true,
    }),
    password: Property.ShortText({
      displayName: 'Password',
      description:
        'Password for the new account. Must comply with the system security policy. Stored in clear text in this step and visible to anyone who can open the flow, so prefer a value carried in from a secret store over a literal one.',
      required: true,
    }),
    firstName: Property.ShortText({
      displayName: 'First Name',
      required: true,
    }),
    lastName: Property.ShortText({
      displayName: 'Last Name',
      required: true,
    }),

    // -- Optional attributes ---------------------------------------------------
    namePrefix: Property.ShortText({
      displayName: 'Name Prefix',
      description: 'Honorific (e.g. Mr., Ms., Dr.).',
      required: false,
    }),
    middleName: Property.ShortText({
      displayName: 'Middle Name',
      required: false,
    }),
    nameSuffix: Property.ShortText({
      displayName: 'Name Suffix',
      description: 'Suffix (e.g. PhD, Jr.).',
      required: false,
    }),
    title: Property.ShortText({
      displayName: 'Title',
      description: 'Job title or position.',
      required: false,
    }),
    phone: Property.ShortText({
      displayName: 'Phone',
      required: false,
    }),
    birthday: Property.ShortText({
      displayName: 'Birthday',
      description: 'Birth date in YYYY-MM-DD format.',
      required: false,
    }),
    enabled: Property.Checkbox({
      displayName: 'Enabled',
      description: 'When disabled the user cannot log in. Defaults to true.',
      required: false,
      defaultValue: true,
    }),

    // -- Required relationships ------------------------------------------------
    owner: businessUnitRequiredDropdown,

    // -- Optional relationships ------------------------------------------------
    organization: organizationDropdown,
    businessUnits: businessUnitsMultiDropdown,
    userRoles: userRolesMultiDropdown,
    organizations: organizationsMultiDropdown,
    groups: userGroupsMultiDropdown,
    authStatus: userAuthStatusDropdown,

    additionalAttributes: additionalAttributesProp,
    additionalRelations: additionalRelationsProp,
    additionalHeaders: additionalHeadersProp,
  },

  async run(context) {
    const p = context.propsValue;

    const extraAttrs = jsonApiBodyUtils.parseAdditionalAttributes(
      p.additionalAttributes
    );
    const extraRels = jsonApiBodyUtils.parseAdditionalRelations(
      p.additionalRelations
    );

    const attributes = {
      username: p.username,
      email: p.email,
      password: p.password,
      firstName: p.firstName,
      lastName: p.lastName,
      enabled: p.enabled ?? true,
      ...jsonApiBodyUtils.pickDefined({
        namePrefix: p.namePrefix,
        middleName: p.middleName,
        nameSuffix: p.nameSuffix,
        title: p.title,
        phone: p.phone,
        birthday: p.birthday,
      }),
      ...extraAttrs,
    };

    const relationships = {
      owner: { data: { type: 'businessunits', id: p.owner ?? '' } },
      ...jsonApiBodyUtils.buildRels({
        organization: ['organizations', p.organization],
        businessUnits: ['businessunits', p.businessUnits, true],
        userRoles: ['userroles', p.userRoles, true],
        organizations: ['organizations', p.organizations, true],
        groups: ['usergroups', p.groups, true],
        auth_status: ['userauthstatuses', p.authStatus],
      }),
      ...extraRels,
    };

    const response = await oroApiCall({
      method: HttpMethod.POST,
      resourceUri: '/users',
      auth: context.auth,
      body: {
        data: {
          type: 'users',
          attributes,
          relationships,
        },
      },
      headers: toHeaderRecord({ value: p.additionalHeaders }),
    });

    return response.body;
  },
});

