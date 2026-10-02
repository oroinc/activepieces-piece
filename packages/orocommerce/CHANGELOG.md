# Changelog

Semantic versioning: https://semver.org/

## 1.0.0

* First release as `@oroinc/piece-orocommerce`.
* 11 actions: Create/Update Customer, Create/Update Customer User, Create/Update User, Create Order,
  Create Invoice, Custom API Call, Serialize JSON:API Request, Unserialize JSON:API Response.
* Serialize JSON:API Request supports `"_meta": {"update": true}` on embedded records.
* Trigger: Oro Webhook Event, signed deliveries on by default; deliveries that cannot be verified
  are discarded.
* TLS certificates are always verified.
* The connection sets the Authorization header; one in Default HTTP Headers or on a step is ignored.
* Custom API Call gets a new token and retries once after a 401.
* Default HTTP Headers that are not valid JSON fail the step instead of being ignored.
* Step errors show the HTTP status and the response body only, and failed requests are not written
  to the engine log, so neither holds the client secret.
* Password is create-only (Create User, Create Customer User).
* English only.
* Requires Activepieces 0.92.0 or later.
* Known limitations: Custom API Call props come from upstream Activepieces.
