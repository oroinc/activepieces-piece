import { createOroCommerceWebhookTrigger } from '../common/register-webhook';

export const newOrder = createOroCommerceWebhookTrigger({
  name: 'new_order',
  description: 'Triggered when a new order is created',
  topic: 'order',
  event: 'create',
  displayName: 'New Order',
  sampleData: {
    "event": "create",
    "channel": "order",
    "data": {
      "id": 26,
      "identifier": "26",
      "poNumber": "PONUM111",
      "customerNotes": "Some notes",
      "shipUntil": {
        "date": "2025-11-28 00:00:00.000000",
        "timezone_type": 3,
        "timezone": "UTC"
      },
      "currency": "USD",
      "subtotalWithDiscountsCurrency": "USD",
      "subtotalWithDiscountsValue": 788.95,
      "subtotalWithDiscounts": 788.95,
      "subtotalCurrency": "USD",
      "subtotalValue": 808.95,
      "baseSubtotalValue": 808.95,
      "totalCurrency": "USD",
      "totalValue": 798.95,
      "baseTotalValue": 798.95,
      "shippingMethod": "flat_rate_6",
      "shippingMethodType": "primary",
      "estimatedShippingCostAmount": 10,
      "overriddenShippingCostAmount": null,
      "sourceEntityClass": "Oro\\Bundle\\ShoppingListBundle\\Entity\\ShoppingList",
      "sourceEntityId": 1,
      "sourceEntityIdentifier": "Care Team Reorder",
      "totalDiscountsAmount": null,
      "external": false,
      "createdAt": {
        "date": "2025-11-05 23:15:25.000000",
        "timezone_type": 3,
        "timezone": "UTC"
      },
      "updatedAt": {
        "date": "2025-11-05 23:15:25.000000",
        "timezone_type": 3,
        "timezone": "UTC"
      },
      "ac_last_contact_date": null,
      "ac_last_contact_date_in": null,
      "ac_last_contact_date_out": null,
      "ac_contact_count": null,
      "ac_contact_count_in": null,
      "ac_contact_count_out": null,
      "serialized_data": {
        "internal_status": "order_internal_status.open",
        "shippingStatus": "order_shipping_status.not_shipped"
      },
      "disablePromotions": false
    },
    "timestamp": 1762384555
  }
});
