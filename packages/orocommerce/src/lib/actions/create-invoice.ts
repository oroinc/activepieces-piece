import { createAction, Property } from '@activepieces/pieces-framework';
import { HttpMethod } from '@activepieces/pieces-common';
import {
  oroAuth,
  oroApiCall,
  customerDropdown,
  customerUserDropdown,
  invoiceInternalStatusDropdown,
  organizationDropdown,
  userDropdown,
  websiteDropdown,
  additionalAttributesProp,
  additionalRelationsProp,
  additionalHeadersProp,
  toHeaderRecord,
  lineItemUtils,
} from '../common';
import { jsonApiBodyUtils } from '../common/jsonapi';

export const createInvoiceAction = createAction({
  auth: oroAuth,
  name: 'create_invoice',
  displayName: 'Create Invoice',
  description: 'Creates a new invoice record in OroCommerce.',
  props: {
    invoiceDate: Property.ShortText({
      displayName: 'Invoice Date',
      description: 'Invoice date in YYYY-MM-DD format.',
      required: true,
    }),
    currency: Property.ShortText({
      displayName: 'Currency',
      description: 'ISO-4217 3-letter currency code (e.g. USD, EUR).',
      required: true,
      defaultValue: 'USD',
    }),
    customerName: Property.ShortText({
      displayName: 'Customer Name',
      description:
        'Name of the company being billed. Stored as a plain-text label on the invoice.',
      required: true,
    }),
    customer: customerDropdown,
    customerUser: customerUserDropdown(false),
    refCustomerId: Property.Number({
      displayName: 'External Customer ID',
      description:
        'An optional ID reference to a customer. Can be used for storing an arbitrary external ID.',
      required: false,
    }),
    refCustomerUserId: Property.Number({
      displayName: 'External Customer User ID',
      description:
        'An optional ID reference to a customer user. Can be used for storing an arbitrary external ID.',
      required: false,
    }),
    totalAmount: Property.Number({
      displayName: 'Total Amount',
      description:
        'Total invoice amount. Should equal the sum of all line item row totals.',
      required: true,
    }),
    invoiceNumber: Property.ShortText({
      displayName: 'Invoice Number',
      description:
        'Sequential invoice number (e.g. INV-2026-00001). Auto-generated if left empty.',
      required: false,
    }),
    title: Property.ShortText({
      displayName: 'Title',
      description: 'Alternative invoice title that reflects its nature.',
      required: false,
    }),
    description: Property.LongText({
      displayName: 'Description',
      description: 'Internal description of the invoice.',
      required: false,
    }),
    memo: Property.ShortText({
      displayName: 'Memo',
      description: 'Short memo visible on the invoice (e.g. "Thank you!").',
      required: false,
    }),
    billTo: Property.LongText({
      displayName: 'Bill To',
      description:
        'Billing address HTML string (e.g. <strong>123 Main St</strong>, City, Country).',
      required: false,
    }),
    shipTo: Property.LongText({
      displayName: 'Ship To',
      description: 'Shipping address HTML string.',
      required: false,
    }),
    shippingMethod: Property.ShortText({
      displayName: 'Shipping Method',
      description:
        'Shipping method label (e.g. "International Shipping <em>(Tracking #: 123)</em>").',
      required: false,
    }),
    sellerInfo: Property.LongText({
      displayName: 'Seller Info',
      description: 'Seller contact / address HTML string.',
      required: false,
    }),
    externalPaymentUrl: Property.ShortText({
      displayName: 'External Payment URL',
      description: 'URL for the external payment page.',
      required: false,
    }),
    invoicePdfContent: Property.LongText({
      displayName: 'Invoice PDF (Base64)',
      description:
        'Base64-encoded PDF, with or without a data: prefix. Attached to the invoice as its default PDF.',
      required: false,
    }),
    invoicePdfFilename: Property.ShortText({
      displayName: 'Invoice PDF Filename',
      description: 'Filename for the attached PDF. Defaults to invoice.pdf.',
      required: false,
    }),

    organization: organizationDropdown,
    owner: userDropdown,
    website: websiteDropdown,
    internalStatus: invoiceInternalStatusDropdown,

    // -- Line Items ------------------------------------------------------------
    lineItems: Property.DynamicProperties({
      auth: oroAuth,
      displayName: 'Line Items',
      description:
        'Invoice line items. Each item is sent via JSON:API included.',
      required: true,
      refreshers: [],
      props: async () => {
        return {
          lineItems: Property.Array({
            displayName: 'Line Items',
            required: true,
            properties: {
              lineNumber: Property.ShortText({
                displayName: 'Line Number',
                description: 'Display line number (e.g. 1.1, 1.2).',
                required: false,
              }),
              description: Property.ShortText({
                displayName: 'Description',
                description: 'Line item description (HTML allowed).',
                required: true,
              }),
              quantity: Property.Number({
                displayName: 'Quantity',
                description: 'Quantity of the item.',
                required: true,
              }),
              unitOfQuantity: Property.ShortText({
                displayName: 'Product Unit',
                description:
                  'Unit of measurement (e.g. piece, kg, set). Oro rejects a line item without one.',
                required: true,
              }),
              unitPrice: Property.Number({
                displayName: 'Unit Price',
                description: 'Price per unit.',
                required: true,
              }),
              rowTotal: Property.Number({
                displayName: 'Row Total',
                description:
                  'Total amount for this line (quantity × unit price).',
                required: true,
              }),
              note: Property.ShortText({
                displayName: 'Note',
                description: 'Additional note for this line item.',
                required: false,
              }),
            },
          }),
        };
      },
    }),
    additionalAttributes: additionalAttributesProp,
    additionalRelations: additionalRelationsProp,
    additionalHeaders: additionalHeadersProp,
  },

  async run(context) {
    const p = context.propsValue;

    const rows = lineItemUtils.readRows({
      value: p.lineItems,
      arrayKey: 'lineItems',
      displayName: LINE_ITEMS_DISPLAY_NAME,
    });

    const lineItemResources = rows.map((row, index) => ({
      type: 'invoicelineitems',
      id: `li_${index + 1}`,
      attributes: {
        position: index + 1,
        lineNumber:
          lineItemUtils.optionalString({
            row,
            index,
            field: 'lineNumber',
            label: 'Line Number',
            displayName: LINE_ITEMS_DISPLAY_NAME,
          }) ?? String(index + 1),
        description: lineItemUtils.requiredString({
          row,
          index,
          field: 'description',
          label: 'Description',
          displayName: LINE_ITEMS_DISPLAY_NAME,
        }),
        quantity: lineItemUtils.requiredNumber({
          row,
          index,
          field: 'quantity',
          label: 'Quantity',
          displayName: LINE_ITEMS_DISPLAY_NAME,
          min: 0,
        }),
        unitOfQuantity: lineItemUtils.requiredString({
          row,
          index,
          field: 'unitOfQuantity',
          label: 'Product Unit',
          displayName: LINE_ITEMS_DISPLAY_NAME,
        }),
        unitPrice: lineItemUtils.requiredNumber({
          row,
          index,
          field: 'unitPrice',
          label: 'Unit Price',
          displayName: LINE_ITEMS_DISPLAY_NAME,
          min: 0,
        }),
        rowTotal: lineItemUtils.requiredNumber({
          row,
          index,
          field: 'rowTotal',
          label: 'Row Total',
          displayName: LINE_ITEMS_DISPLAY_NAME,
        }),
        ...jsonApiBodyUtils.pickDefined({
          note: lineItemUtils.optionalString({
            row,
            index,
            field: 'note',
            label: 'Note',
            displayName: LINE_ITEMS_DISPLAY_NAME,
          }),
        }),
      },
    }));

    lineItemUtils.assertSumMatches({
      rows,
      field: 'rowTotal',
      label: 'Row Total',
      displayName: LINE_ITEMS_DISPLAY_NAME,
      total: p.totalAmount,
      totalLabel: 'Total Amount',
      toleranceMinorUnits: 1,
    });

    const lineItemsRelData = lineItemResources.map((li) => ({
      type: 'invoicelineitems',
      id: li.id,
    }));

    const pdfFilename = p.invoicePdfFilename || DEFAULT_PDF_FILENAME;
    const pdfFile = p.invoicePdfContent
      ? {
          type: 'files',
          id: 'invoiceDefaultPdfFile',
          attributes: {
            mimeType: PDF_MIME_TYPE,
            originalFilename: pdfFilename,
            content: readPdfContent({
              content: p.invoicePdfContent,
              filename: pdfFilename,
            }),
          },
        }
      : undefined;

    const included = [...lineItemResources, ...(pdfFile ? [pdfFile] : [])];

    const extraAttrs = jsonApiBodyUtils.parseAdditionalAttributes(p.additionalAttributes);
    const extraRels = jsonApiBodyUtils.parseAdditionalRelations(p.additionalRelations);

    const attributes = {
      invoiceDate: p.invoiceDate,
      currency: p.currency,
      customerName: p.customerName,
      totalAmount: p.totalAmount,
      ...jsonApiBodyUtils.pickDefined({
        refCustomerId: p.refCustomerId,
        refCustomerUserId: p.refCustomerUserId,
        invoiceNumber: p.invoiceNumber,
        title: p.title,
        description: p.description,
        memo: p.memo,
        billTo: p.billTo,
        shipTo: p.shipTo,
        shippingMethod: p.shippingMethod,
        sellerInfo: p.sellerInfo,
        externalPaymentUrl: p.externalPaymentUrl,
      }),
      ...extraAttrs,
    };

    const relationships = {
      lineItems: { data: lineItemsRelData },
      ...jsonApiBodyUtils.buildRels({
        customer: ['customers', p.customer],
        customer_user: ['customerusers', p.customerUser],
        organization: ['organizations', p.organization],
        owner: ['users', p.owner],
        website: ['websites', p.website],
        internal_status: ['invoiceinternalstatuses', p.internalStatus],
        invoiceDefaultPdfFile: [
          'files',
          pdfFile ? 'invoiceDefaultPdfFile' : undefined,
        ],
      }),
      ...extraRels,
    };

    const response = await oroApiCall({
      method: HttpMethod.POST,
      resourceUri: '/invoices',
      auth: context.auth,
      body: {
        data: {
          type: 'invoices',
          attributes,
          relationships
        },
        included,
      },
      headers: toHeaderRecord({ value: p.additionalHeaders }),
    });

    return response.body;
  },
});

const LINE_ITEMS_DISPLAY_NAME = 'Line Items';

const PDF_MIME_TYPE = 'application/pdf';

const PDF_SIGNATURE = '%PDF-';

const DEFAULT_PDF_FILENAME = 'invoice.pdf';

const DATA_URI_PREFIX = /^data:[^;,]*;base64,/;

function readPdfContent({
  content,
  filename,
}: {
  content: string;
  filename: string;
}): string {
  const base64 = content.replace(DATA_URI_PREFIX, '').trim();
  const header = Buffer.from(base64.slice(0, 8), 'base64').toString('latin1');
  if (!header.startsWith(PDF_SIGNATURE)) {
    throw new Error(
      `Invoice PDF: "${filename}" is not a PDF (it does not start with "${PDF_SIGNATURE}"). Oro stores this file as the invoice's default PDF, so pass a base64 PDF or convert the file in an earlier step.`
    );
  }
  return base64;
}
