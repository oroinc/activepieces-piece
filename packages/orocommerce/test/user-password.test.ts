import { describe, expect, it } from 'vitest';
import { createUserAction } from '../src/lib/actions/create-user';
import { createCustomerUserAction } from '../src/lib/actions/create-customer-user';
import { updateUserAction } from '../src/lib/actions/update-user';
import { updateCustomerUserAction } from '../src/lib/actions/update-customer-user';

/**
 * Oro exposes `password` on users and customerusers for create only. A PATCH carrying it is
 * refused as an extra field, so the update actions offered a field that could only ever fail the
 * step, and did so after the rest of the form had been filled in.
 */
describe('password belongs to the create actions only', () => {
  it.each([
    ['Create User', createUserAction],
    ['Create Customer User', createCustomerUserAction],
  ])('%s still offers it', (_name, action) => {
    expect(Object.keys(action.props)).toContain('password');
  });

  it.each([
    ['Update User', updateUserAction],
    ['Update Customer User', updateCustomerUserAction],
  ])('%s does not', (_name, action) => {
    expect(Object.keys(action.props)).not.toContain('password');
  });

  it.each([
    ['Update User', updateUserAction],
    ['Update Customer User', updateCustomerUserAction],
  ])('%s keeps the fields Oro does accept on a PATCH', (_name, action) => {
    expect(Object.keys(action.props)).toEqual(
      expect.arrayContaining(['email', 'firstName', 'lastName', 'enabled'])
    );
  });
});
