import { describe, expect, it } from 'vitest';
import { createMockActionContext } from '@activepieces/pieces-framework';
import { createInvoiceAction } from '../src/lib/actions/create-invoice';
import { updateCustomerAction } from '../src/lib/actions/update-customer';
import { updateUserAction } from '../src/lib/actions/update-user';
import { updateCustomerUserAction } from '../src/lib/actions/update-customer-user';

function invoiceProps(lineItems: Record<string, unknown>[]) {
  return {
    invoiceDate: '2026-01-01',
    currency: 'USD',
    customerName: 'Acme Inc.',
    totalAmount: 100,
    lineItems: { lineItems },
  };
}

function runInvoice(lineItems: Record<string, unknown>[]) {
  return createInvoiceAction.run(
    createMockActionContext<typeof createInvoiceAction.props>({
      propsValue: invoiceProps(lineItems),
    })
  );
}

describe('create invoice rejects unusable line items before calling Oro', () => {
  it('reports a missing quantity instead of sending null', async () => {
    await expect(
      runInvoice([
        { description: 'Widget', unitPrice: 10, rowTotal: 100 },
      ])
    ).rejects.toThrow('Line Items row 1, "Quantity" must be a number, got no value.');
  });

  it('reports a non-numeric quantity with the offending value', async () => {
    await expect(
      runInvoice([
        { description: 'Widget', quantity: 'ten', unitPrice: 10, rowTotal: 100 },
      ])
    ).rejects.toThrow('Line Items row 1, "Quantity" must be a number, got "ten".');
  });

  it('reports a missing description', async () => {
    await expect(
      runInvoice([{ quantity: 10, unitPrice: 10, rowTotal: 100 }])
    ).rejects.toThrow('Line Items row 1, "Description" is required, got no value.');
  });

  it('reports a total that does not match the row totals', async () => {
    await expect(
      runInvoice([
        { description: 'Widget', quantity: 1, unitPrice: 10, rowTotal: 10 },
      ])
    ).rejects.toThrow(
      '"Total Amount" is 100, but the sum of "Row Total" across 1 row(s) is 10.'
    );
  });

  it('rejects an empty line item list', async () => {
    await expect(runInvoice([])).rejects.toThrow(
      'Line Items: add at least one row before running this step.'
    );
  });
});

// The builder seeds an unset checkbox with `false` and persists it, so before these props became
// three-state dropdowns "Update User, change the last name" also sent enabled: false and disabled
// the account. The empty-request guard is the observable: if the flag still reached `attributes`,
// there would be something to update and no error.
describe('an untouched boolean flag is not sent', () => {
  it('Update User leaves Enabled alone', async () => {
    await expect(
      updateUserAction.run(
        createMockActionContext<typeof updateUserAction.props>({
          propsValue: { userId: '1', enabled: 'unchanged' },
        })
      )
    ).rejects.toThrow('Update User: nothing to update.');
  });

  it('Update User ignores a `false` left behind by the checkbox version of the prop', async () => {
    await expect(
      updateUserAction.run(
        createMockActionContext<typeof updateUserAction.props>({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the prop no longer accepts a boolean; an existing step input still holds one
          propsValue: { userId: '1', enabled: false as any },
        })
      )
    ).rejects.toThrow('Update User: nothing to update.');
  });

  it('Update Customer User leaves Enabled and Confirmed alone', async () => {
    await expect(
      updateCustomerUserAction.run(
        createMockActionContext<typeof updateCustomerUserAction.props>({
          propsValue: { customerUserId: '1', enabled: 'unchanged', confirmed: 'unchanged' },
        })
      )
    ).rejects.toThrow('Update Customer User: nothing to update.');
  });
});

describe('update actions refuse to send an empty request', () => {
  it('Update Customer', async () => {
    await expect(
      updateCustomerAction.run(
        createMockActionContext<typeof updateCustomerAction.props>({
          propsValue: { customerId: '1' },
        })
      )
    ).rejects.toThrow(
      'Update Customer: nothing to update. Fill in at least one field or relationship.'
    );
  });

  it('Update User', async () => {
    await expect(
      updateUserAction.run(
        createMockActionContext<typeof updateUserAction.props>({
          propsValue: { userId: '1' },
        })
      )
    ).rejects.toThrow(
      'Update User: nothing to update. Fill in at least one field or relationship.'
    );
  });

  it('Update Customer User', async () => {
    await expect(
      updateCustomerUserAction.run(
        createMockActionContext<typeof updateCustomerUserAction.props>({
          propsValue: { customerUserId: '1' },
        })
      )
    ).rejects.toThrow(
      'Update Customer User: nothing to update. Fill in at least one field or relationship.'
    );
  });
});
