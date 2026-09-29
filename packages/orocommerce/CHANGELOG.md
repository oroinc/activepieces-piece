# Changelog

The package follows semantic versioning https://semver.org/.

## 1.0.0

* BAP-23210: First release of the OroCommerce piece under `@oroinc/piece-orocommerce`.
* Actions: Create Customer, Update Customer, Create Customer User, Update Customer User, Create User, Update User, Create Order, Create Invoice, Custom API Call, Serialize JSON:API Request, Unserialize JSON:API Response.
* Trigger: Oro Webhook Event, with signed deliveries on by default.
* Requires Activepieces 0.92.0 or later.
* Known limitation: the props of the Custom API Call action come from upstream Activepieces at the pinned commit, so a pin bump can change them without a change in this repository.
* Known limitation: the Polish and Ukrainian translation files ship but are never loaded, because upstream Activepieces has no Polish or Ukrainian locale.
* Known limitation: the line-item field labels of Create Order and Create Invoice cannot be translated, because props created inside a dynamic property never reach piece metadata.
