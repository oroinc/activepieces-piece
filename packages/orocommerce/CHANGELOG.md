# Changelog

Semantic versioning: https://semver.org/

## 1.0.0

* First release as `@oroinc/piece-orocommerce`.
* 11 actions: Create/Update Customer, Create/Update Customer User, Create/Update User, Create Order,
  Create Invoice, Custom API Call, Serialize JSON:API Request, Unserialize JSON:API Response.
* Trigger: Oro Webhook Event, signed deliveries on by default.
* Requires Activepieces 0.92.0 or later.
* Known limitations: Custom API Call props come from upstream Activepieces; Polish and Ukrainian
  translations are not loaded by Activepieces; line-item labels in Create Order and Create Invoice
  cannot be translated.
