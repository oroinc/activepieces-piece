# Changelog

Semantic versioning: https://semver.org/

## 1.0.0

* First release as `@oroinc/piece-orocommerce`.
* 11 actions: Create/Update Customer, Create/Update Customer User, Create/Update User, Create Order,
  Create Invoice, Custom API Call, Serialize JSON:API Request, Unserialize JSON:API Response.
* Trigger: Oro Webhook Event, signed deliveries on by default. A delivery that cannot be verified
  is discarded.
* TLS certificates are verified on every request, including when another piece in the same worker
  has turned verification off for the process.
* The connection owns the Authorization header. One set in Default HTTP Headers or on a step is
  ignored.
* Password is a create-only field, on Create User and Create Customer User. Oro rejects it on an
  update.
* English only. Translations may be added in a later minor release.
* Requires Activepieces 0.92.0 or later.
* Known limitations: Custom API Call props come from upstream Activepieces.
