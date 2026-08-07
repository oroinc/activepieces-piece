import { createAction, Property } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import {
  oroAuth,
  oroApiCall,
  attrLabel,
  loadDropdownOptions,
  customerRequiredDropdown,
  customerUserDropdown,
  organizationDropdown,
  userDropdown,
  websiteDropdown,
  orderInternalStatusDropdown,
  orderStatusDropdown,
  orderDropdown,
  paymentTermDropdown,
  warehouseDropdown,
  buildCountryDropdown,
  buildRegionDropdown,
  productDropdown,
  buildIncludedAddress,
  type AddressRow,
  additionalAttributesProp,
  additionalRelationsProp,
  additionalHeadersProp,
} from '../common';
import { jsonApiBodyUtils } from '../common/jsonapi';

export const createOrderAction = createAction({
  auth: oroAuth,
  name: 'create_order',
  displayName: 'Create Order',
  description: 'Creates a new order record in OroCommerce.',
  props: {
    customer: customerRequiredDropdown,
    customerUser: customerUserDropdown(false),

    // -- Optional attributes ---------------------------------------------------
    currency: Property.ShortText({
      displayName: 'Currency',
      description: 'ISO-4217 3-letter currency code (e.g. USD, EUR).',
      required: false,
      defaultValue: 'USD',
    }),
    identifier: Property.ShortText({
      displayName: 'Identifier',
      description: 'Unique order reference (e.g. FR1012401Z).',
      required: false,
    }),
    poNumber: Property.ShortText({
      displayName: 'PO Number',
      description: 'Purchase order number provided by the buyer.',
      required: false,
    }),
    customerNotes: Property.LongText({
      displayName: 'Customer Notes',
      description: 'Notes from the customer (e.g. "Call before delivery").',
      required: false,
    }),
    shipUntil: Property.ShortText({
      displayName: 'Ship Until Date',
      description: 'Latest acceptable ship date in YYYY-MM-DD format.',
      required: false,
    }),
    overriddenShippingCostAmount: Property.Number({
      displayName: 'Overridden Shipping Cost',
      description: 'Custom shipping cost that overrides the calculated value.',
      required: false,
    }),
    estimatedShippingCostAmount: Property.Number({
      displayName: 'Estimated Shipping Cost',
      description:
        'Shipping cost calculated from the selected shipping method.',
      required: false,
    }),
    shippingMethod: Property.ShortText({
      displayName: 'Shipping Method',
      description:
        'The shipping method selected for the order (e.g. "flat_rate_2").',
      required: false,
    }),
    shippingMethodType: Property.ShortText({
      displayName: 'Shipping Method Type',
      description: 'The shipping method type (e.g. "primary").',
      required: false,
    }),
    disablePromotions: Property.Checkbox({
      displayName: 'Disable Promotions',
      description: 'Prevent the promotions engine from running for this order.',
      required: false,
    }),

    // -- Optional relationships ------------------------------------------------
    organization: organizationDropdown,
    owner: userDropdown,
    website: websiteDropdown,
    internalStatus: orderInternalStatusDropdown,
    paymentTerm: paymentTermDropdown,
    warehouse: warehouseDropdown,
    parent: orderDropdown,
    status: orderStatusDropdown,

    // -- Billing Address -------------------------------------------------------
    billingAddressLabel: Property.ShortText({
      displayName: 'Billing: Label',
      description: 'Address label (e.g. "Main Office").',
      required: false,
    }),
    billingAddressFirstName: Property.ShortText({
      displayName: 'Billing: First Name',
      required: false,
    }),
    billingAddressLastName: Property.ShortText({
      displayName: 'Billing: Last Name',
      required: false,
    }),
    billingAddressOrganization: Property.ShortText({
      displayName: 'Billing: Organization',
      required: false,
    }),
    billingAddressPhone: Property.ShortText({
      displayName: 'Billing: Phone',
      required: false,
    }),
    billingAddressStreet: Property.ShortText({
      displayName: 'Billing: Street',
      required: false,
    }),
    billingAddressStreet2: Property.ShortText({
      displayName: 'Billing: Street 2',
      required: false,
    }),
    billingAddressCity: Property.ShortText({
      displayName: 'Billing: City',
      required: false,
    }),
    billingAddressPostalCode: Property.ShortText({
      displayName: 'Billing: Postal Code',
      required: false,
    }),
    billingAddressCountry: buildCountryDropdown({
      required: false,
      displayName: 'Billing: Country',
    }),
    billingAddressRegion: buildRegionDropdown({
      countryRefresher: 'billingAddressCountry',
      required: false,
      displayName: 'Billing: Region / State',
    }),
    billingAddressCustomRegion: Property.ShortText({
      displayName: 'Billing: Custom Region',
      description: 'Free-text region for countries without predefined regions.',
      required: false,
    }),

    // -- Shipping Address ------------------------------------------------------
    shippingAddressLabel: Property.ShortText({
      displayName: 'Shipping: Label',
      description: 'Address label (e.g. "Warehouse East").',
      required: false,
    }),
    shippingAddressFirstName: Property.ShortText({
      displayName: 'Shipping: First Name',
      required: false,
    }),
    shippingAddressLastName: Property.ShortText({
      displayName: 'Shipping: Last Name',
      required: false,
    }),
    shippingAddressOrganization: Property.ShortText({
      displayName: 'Shipping: Organization',
      required: false,
    }),
    shippingAddressPhone: Property.ShortText({
      displayName: 'Shipping: Phone',
      required: false,
    }),
    shippingAddressStreet: Property.ShortText({
      displayName: 'Shipping: Street',
      required: false,
    }),
    shippingAddressStreet2: Property.ShortText({
      displayName: 'Shipping: Street 2',
      required: false,
    }),
    shippingAddressCity: Property.ShortText({
      displayName: 'Shipping: City',
      required: false,
    }),
    shippingAddressPostalCode: Property.ShortText({
      displayName: 'Shipping: Postal Code',
      required: false,
    }),
    shippingAddressCountry: buildCountryDropdown({
      required: false,
      displayName: 'Shipping: Country',
    }),
    shippingAddressRegion: buildRegionDropdown({
      countryRefresher: 'shippingAddressCountry',
      required: false,
      displayName: 'Shipping: Region / State',
    }),
    shippingAddressCustomRegion: Property.ShortText({
      displayName: 'Shipping: Custom Region',
      description: 'Free-text region for countries without predefined regions.',
      required: false,
    }),

    lineItems: Property.DynamicProperties({
      auth: oroAuth,
      displayName: 'Line Items',
      description: 'Order line items.',
      required: true,
      refreshers: [],
      props: async ({ auth }) => {
        const [unitState, warehouseState] = await Promise.all([
          loadDropdownOptions({
            auth,
            resourceUri: '/productunits',
            labelFn: attrLabel('label'),
            exhaustive: true,
          }),
          loadDropdownOptions({
            auth,
            resourceUri: '/warehouses',
            labelFn: attrLabel('name'),
            fieldsParam: 'id,name',
            exhaustive: true,
          }),
        ]);

        return {
          lineItems: Property.Array({
            displayName: 'Line Items',
            required: true,
            properties: {
              // -- Product relationship --------------------------------------
              productId: Property.ShortText({
                displayName: 'Product: Raw ID',
                description:
                  'Numeric Oro product ID. Use the top-level "Product Search" field to look up a product.',
                required: false,
              }),
              // -- Optional attributes ---------------------------------------
              productName: Property.ShortText({
                displayName: 'Product Name',
                description: 'Default name of the ordered product.',
                required: false,
              }),
              freeFormProduct: Property.ShortText({
                displayName: 'Free-Form Product',
                description:
                  'Product name for free-form (non-catalog) line items.',
                required: false,
              }),
              // -- Required --------------------------------------------------
              productSku: Property.ShortText({
                displayName: 'Product SKU',
                description:
                  'Unique human-readable product identifier. Required.',
                required: true,
              }),
              productUnit: Property.StaticDropdown({
                displayName: 'Product Unit',
                description: 'Unit of measurement (e.g. piece, kg, set).',
                required: true,
                options: unitState,
              }),
              quantity: Property.Number({
                displayName: 'Quantity',
                description: 'Quantity of the product ordered.',
                required: true,
              }),
              value: Property.Number({
                displayName: 'Unit Price',
                description: 'Price per unit used in this order. Required.',
                required: true,
              }),
              currency: Property.ShortText({
                displayName: 'Currency',
                description:
                  'ISO-4217 code. Defaults to order-level currency if empty.',
                required: false,
              }),
              comment: Property.LongText({
                displayName: 'Comment',
                description: 'Comments to the line item.',
                required: false,
              }),
              shipBy: Property.ShortText({
                displayName: 'Ship By Date',
                description:
                  'Latest acceptable ship date for this line (YYYY-MM-DD).',
                required: false,
              }),
              priceType: Property.Number({
                displayName: 'Price Type',
                description:
                  'Type of the product price (e.g. 10 = unit price).',
                required: false,
                defaultValue: 10,
              }),
              shippingEstimateAmount: Property.Number({
                displayName: 'Shipping Estimate Amount',
                description: 'Calculated shipping cost for this line item.',
                required: false,
              }),
              shippingMethod: Property.ShortText({
                displayName: 'Shipping Method',
                description: 'Shipping method assigned to this line item.',
                required: false,
              }),
              shippingMethodType: Property.ShortText({
                displayName: 'Shipping Method Type',
                description: 'Shipping method type assigned to this line item.',
                required: false,
              }),
              // -- Warehouse relationship ------------------------------------
              warehouse: Property.StaticDropdown({
                displayName: 'Warehouse',
                description: 'Warehouse this line item ships from.',
                required: false,
                options: warehouseState,
              }),
            },
          }),
        };
      },
    }),

    // -- Product Search helper (top-level, search-enabled) ---------------------
    // Use this to find a product SKU/ID, then paste it into line item "Product SKU or ID".
    productSearch: productDropdown,
    additionalAttributes: additionalAttributesProp,
    additionalRelations: additionalRelationsProp,
    additionalHeaders: additionalHeadersProp,
  },

  async run(context) {
    const p = context.propsValue;

    const billingAddressResource = buildAddressResource({
      localId: 'billing_address',
      fields: {
        label: p.billingAddressLabel,
        firstName: p.billingAddressFirstName,
        lastName: p.billingAddressLastName,
        organization: p.billingAddressOrganization,
        phone: p.billingAddressPhone,
        street: p.billingAddressStreet,
        street2: p.billingAddressStreet2,
        city: p.billingAddressCity,
        postalCode: p.billingAddressPostalCode,
        country: p.billingAddressCountry,
        region: p.billingAddressRegion,
        customRegion: p.billingAddressCustomRegion,
      },
    });

    const shippingAddressResource = buildAddressResource({
      localId: 'shipping_address',
      fields: {
        label: p.shippingAddressLabel,
        firstName: p.shippingAddressFirstName,
        lastName: p.shippingAddressLastName,
        organization: p.shippingAddressOrganization,
        phone: p.shippingAddressPhone,
        street: p.shippingAddressStreet,
        street2: p.shippingAddressStreet2,
        city: p.shippingAddressCity,
        postalCode: p.shippingAddressPostalCode,
        country: p.shippingAddressCountry,
        region: p.shippingAddressRegion,
        customRegion: p.shippingAddressCustomRegion,
      },
    });

    // -- Line items ----------------------------------------------------------
    // DynamicProperties wraps the array in an object keyed by "lineItems"
    const dynamicValue = (p.lineItems ?? {}) as Record<string, unknown>;
    const rawItems = (dynamicValue['lineItems'] ?? []) as Array<
      Record<string, unknown>
    >;

    const lineItems = rawItems.map((item, index) =>
      buildOrderLineItem({ item, index, orderCurrency: p.currency })
    );
    const lineItemResources = lineItems.map((li) => li.resource);
    const lineItemsRelData = lineItems.map((li) => li.ref);

    const extraAttrs = jsonApiBodyUtils.parseAdditionalAttributes(
      p.additionalAttributes
    );
    const extraRels = jsonApiBodyUtils.parseAdditionalRelations(
      p.additionalRelations
    );

    // -- Order attributes ----------------------------------------------------
    const attributes: Record<string, unknown> = {
      external: false,
      ...jsonApiBodyUtils.pickDefined({
        currency: p.currency,
        identifier: p.identifier,
        poNumber: p.poNumber,
        customerNotes: p.customerNotes,
        shipUntil: p.shipUntil,
        overriddenShippingCostAmount: p.overriddenShippingCostAmount,
        estimatedShippingCostAmount: p.estimatedShippingCostAmount,
        shippingMethod: p.shippingMethod,
        shippingMethodType: p.shippingMethodType,
        disablePromotions: p.disablePromotions,
      }),
      ...extraAttrs,
    };

    const relationships: Record<string, unknown> = {
      lineItems: { data: lineItemsRelData },
      ...(billingAddressResource
        ? {
            billingAddress: {
              data: { type: 'orderaddresses', id: 'billing_address' },
            },
          }
        : {}),
      ...(shippingAddressResource
        ? {
            shippingAddress: {
              data: { type: 'orderaddresses', id: 'shipping_address' },
            },
          }
        : {}),
      ...jsonApiBodyUtils.buildRels({
        customer: ['customers', p.customer],
        customerUser: ['customerusers', p.customerUser],
        organization: ['organizations', p.organization],
        owner: ['users', p.owner],
        website: ['websites', p.website],
        internalStatus: ['orderinternalstatuses', p.internalStatus],
        paymentTerm: ['paymentterms', p.paymentTerm],
        warehouse: ['warehouses', p.warehouse],
        parent: ['orders', p.parent],
        status: ['orderstatuses', p.status],
      }),
      ...extraRels,
    };

    const included = [
      ...lineItemResources,
      ...(billingAddressResource ? [billingAddressResource] : []),
      ...(shippingAddressResource ? [shippingAddressResource] : []),
    ];

    const response = await oroApiCall({
      method: HttpMethod.POST,
      resourceUri: '/orders',
      auth: context.auth,
      body: {
        data: {
          type: 'orders',
          attributes,
          relationships,
        },
        included,
      },
      headers: p.additionalHeaders as Record<string, string>,
    });

    return response.body;
  },
});

function buildAddressResource({
  localId,
  fields,
}: {
  localId: string;
  fields: AddressRow;
}): Record<string, unknown> | null {
  return buildIncludedAddress({
    lid: localId,
    type: 'orderaddresses',
    addr: fields,
    extraAttributes: { fromExternalSource: false },
  });
}

function toOrderLineItemRow(item: Record<string, unknown>): OrderLineItemRow {
  const row: OrderLineItemRow = {};
  for (const field of LINE_ITEM_TEXT_FIELDS) {
    const value = item[field];
    if (typeof value === 'string') row[field] = value;
  }
  for (const field of LINE_ITEM_NUMBER_FIELDS) {
    const value = item[field];
    if (typeof value === 'number') row[field] = value;
    else if (typeof value === 'string') row[field] = Number(value);
  }
  return row;
}

function buildOrderLineItem({
  item,
  index,
  orderCurrency,
}: {
  item: Record<string, unknown>;
  index: number;
  orderCurrency: string | null | undefined;
}): { resource: Record<string, unknown>; ref: { type: string; id: string } } {
  const lid = `li_${index + 1}`;
  const row = toOrderLineItemRow(item);

  const attributes: Record<string, unknown> = {
    fromExternalSource: true,
    productSku: row.productSku ?? '',
    quantity: Number(row.quantity),
    value: Number(row.value),
    currency: row.currency || orderCurrency || 'USD',
    priceType: row.priceType ?? 10,

    ...jsonApiBodyUtils.pickDefined({
      productName: row.productName,
      freeFormProduct: row.freeFormProduct,
      comment: row.comment,
      shipBy: row.shipBy,
    }),

    ...(row.shippingEstimateAmount != null
      ? { shippingEstimateAmount: row.shippingEstimateAmount }
      : {}),

    ...(row.shippingMethod ? { shippingMethod: row.shippingMethod } : {}),

    ...(row.shippingMethodType
      ? { shippingMethodType: row.shippingMethodType }
      : {}),
  };

  const relationships: Record<string, unknown> = jsonApiBodyUtils.buildRels({
    productUnit: ['productunits', row.productUnit],
    product: ['products', row.productId?.trim()],
    warehouse: ['warehouses', row.warehouseId?.trim() || row.warehouse?.trim()],
  });

  return {
    resource: { type: 'orderlineitems', id: lid, attributes, relationships },
    ref: { type: 'orderlineitems', id: lid },
  };
}

const LINE_ITEM_TEXT_FIELDS = [
  'productId',
  'productName',
  'freeFormProduct',
  'productSku',
  'productUnit',
  'currency',
  'comment',
  'shipBy',
  'shippingMethod',
  'shippingMethodType',
  'warehouse',
  'warehouseId',
] as const;

const LINE_ITEM_NUMBER_FIELDS = [
  'quantity',
  'value',
  'priceType',
  'shippingEstimateAmount',
] as const;

type OrderLineItemRow = Partial<Record<(typeof LINE_ITEM_TEXT_FIELDS)[number], string>> &
  Partial<Record<(typeof LINE_ITEM_NUMBER_FIELDS)[number], number>>;
